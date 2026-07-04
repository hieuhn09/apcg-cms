/**
 * Import a source site's exported NDJSON into the Central CMS as one tenant.
 * Dependency-ordered; remaps relationships by natural key; preserves slugs,
 * provenance, and every exported locale; re-uploads hero media from the source
 * URL. Idempotent-ish (skips taxonomy/articles whose slug already exists for the
 * tenant). Bulk writes set disableRevalidate.
 *
 *   IMPORT_TENANT_SLUG=brief-asia IMPORT_DIR=migration-data/brief-asia \
 *   npm run migrate:import -- [--dry-run]
 *
 * Run after the tenant exists (seed) and export-source.ts has produced NDJSON.
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../payload.config";
import { pFind, pCreate, pUpdate } from "../lib/payload-loose";
import { LOCALE_CODES } from "../../src/lib/locales";

const TENANT_SLUG = requireEnv("IMPORT_TENANT_SLUG");
const IMPORT_DIR = process.env.IMPORT_DIR || path.resolve(process.cwd(), "migration-data", TENANT_SLUG);
const SOURCE_MEDIA_BASE = (process.env.SOURCE_MEDIA_BASE || process.env.SOURCE_URL || "").replace(/\/$/, "");

type Doc = Record<string, unknown>;
const idMaps: Record<string, Map<unknown, number | string>> = {};
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };

function read(coll: string): Doc[] {
  const file = path.join(IMPORT_DIR, `${coll}.ndjson`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Doc);
}

/** Pull a localized field's value for a given locale (handles {en,vi,...} or plain). */
function localeValue(v: unknown, locale: string): unknown {
  // Legacy brief-asia rows sometimes store a localized value as a JSON-string
  // blob ('{"en":"Asia","vi":...}') — parse it before the locale-object check.
  if (typeof v === "string" && v.startsWith("{")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && LOCALE_CODES.some((c) => c in (parsed as Record<string, unknown>))) {
        return (parsed as Record<string, unknown>)[locale];
      }
    } catch {
      // not JSON — fall through and treat as a plain string
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (LOCALE_CODES.some((c) => c in obj)) return obj[locale];
  }
  return locale === "en" ? v : undefined;
}

function remapRel(coll: string, sourceVal: unknown): unknown {
  const map = idMaps[coll];
  if (!map) return undefined;
  if (Array.isArray(sourceVal)) return sourceVal.map((x) => map.get(idOf(x))).filter((x) => x != null);
  const mapped = map.get(idOf(sourceVal));
  return mapped ?? undefined;
}

function idOf(v: unknown): unknown {
  if (v && typeof v === "object" && "id" in (v as Record<string, unknown>)) return (v as { id: unknown }).id;
  return v;
}

interface Plan {
  coll: string;
  key: string; // natural key field for idempotency/skip
  localized: string[];
  upload?: boolean;
  remap?: Record<string, string>; // field -> target collection in idMaps
  drop?: string[]; // source fields never copied (dangling rels, superseded shapes)
  keyFields?: string[]; // compound natural key (rel members resolved via remap first)
  transform?: (source: Doc, base: Doc) => void; // final fix-up before create
}

const PLAN: Plan[] = [
  { coll: "pillars", key: "slug", localized: ["title", "heading", "description"] },
  {
    coll: "subsections",
    key: "slug",
    keyFields: ["slug", "pillar"], // slug is unique within tenant + pillar
    localized: ["title"],
    remap: { pillar: "pillars" },
  },
  { coll: "sectors", key: "slug", localized: ["title", "description"] },
  { coll: "tags", key: "slug", localized: ["title"] },
  // `user` links point at source-site user ids — dropped; migrate:users re-links by email.
  { coll: "authors", key: "name", localized: ["bio"], drop: ["user"] },
  { coll: "media", key: "filename", localized: ["alt", "caption"], upload: true },
  {
    coll: "articles",
    key: "slug",
    localized: ["title", "slug", "dek", "body", "imageLabel"],
    remap: {
      pillar: "pillars",
      subSection: "subsections",
      author: "authors",
      coAuthors: "authors",
      tags: "tags",
      sectors: "sectors",
      country: "countries",
      countries: "countries",
      heroImage: "media",
    },
    // `sections` is the retired cross-post shape (rels → pillars); replaced by
    // secondarySections below. secondarySections is rebuilt by the transform
    // (rows carry Payload row ids + source rel ids that must not be copied raw).
    drop: ["sections", "secondarySections"],
    transform: (source, base) => {
      const rows = Array.isArray(source.secondarySections) ? source.secondarySections : [];
      const rebuilt = rows
        .map((r) => {
          const row = r as { pillar?: unknown; subSection?: unknown };
          const pillar = remapRel("pillars", row.pillar);
          if (pillar == null) return null;
          return { pillar, subSection: remapRel("subsections", row.subSection) ?? null };
        })
        .filter(Boolean);
      if (rebuilt.length) base.secondarySections = rebuilt;
    },
  },
  { coll: "newsletters", key: "slug", localized: ["name", "description"], remap: { vertical: "pillars" } },
  { coll: "podcasts", key: "slug", localized: ["title", "description"] },
  // `editor` points at a source-site user id — dropped (correction text carries the signoff).
  { coll: "corrections", key: "summary", localized: ["summary", "wasText", "nowText"], remap: { article: "articles" }, drop: ["editor"] },
  { coll: "wireDrops", key: "text", localized: ["text"] },
  { coll: "marketSnapshots", key: "market", localized: [] },
  { coll: "fxRates", key: "pair", localized: [] },
  { coll: "trendingBlocks", key: "term", localized: [] },
  // NOTE: `slot` is a weak natural key (one row per slot assumed) — fine for the
  // current 3-slot model; re-runs keep the first-imported row per slot.
  { coll: "sponsorSlots", key: "slot", localized: [], remap: { article: "articles" } },
];

async function ensureTenant(payload: Awaited<ReturnType<typeof getPayload>>): Promise<number | string> {
  const res = await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 });
  const t = (res as unknown as { docs: Doc[] }).docs[0];
  if (!t) throw new Error(`Tenant ${TENANT_SLUG} not found — run seed first.`);
  return t.id as number | string;
}

/** Map global Countries by ISO code (create missing, incl. localized name/description). */
async function importCountries(payload: Awaited<ReturnType<typeof getPayload>>) {
  idMaps.countries = new Map();
  for (const c of read("countries")) {
    const code = String(c.code ?? "").toLowerCase();
    if (!code) continue;
    let central = ((await pFind(payload, "countries", { where: { code: { equals: code } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
    if (!central && !DRY_RUN) {
      central = (await pCreate(payload, "countries", { code, name: localeValue(c.name, "en") ?? code, slug: c.slug ?? code, region: c.region, description: localeValue(c.description, "en"), order: c.order }, { context: ctx })) as unknown as Doc;
      for (const locale of LOCALE_CODES) {
        if (locale === "en") continue;
        const patch: Doc = {};
        const name = localeValue(c.name, locale);
        const description = localeValue(c.description, locale);
        if (name != null) patch.name = name;
        if (description != null) patch.description = description;
        if (Object.keys(patch).length) {
          try {
            await pUpdate(payload, "countries", central.id as number | string, patch, { locale, context: ctx });
          } catch (err) {
            console.warn(`[import] country ${code} locale ${locale} failed: ${(err as Error).message}`);
          }
        }
      }
    }
    if (central) idMaps.countries.set(c.id, central.id as number | string);
  }
  console.log(`[import] countries mapped: ${idMaps.countries.size}`);
}

async function uploadMedia(payload: Awaited<ReturnType<typeof getPayload>>, tenantId: number | string, d: Doc): Promise<number | string | undefined> {
  const rawUrl = (d.url as string) || "";
  const url = rawUrl.startsWith("http") ? rawUrl : `${SOURCE_MEDIA_BASE}${rawUrl}`;
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`media fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get("content-type")?.split(";")[0]?.trim() || (d.mimeType as string) || "image/jpeg";
    const created = await pCreate(
      payload,
      "media",
      { tenant: tenantId, alt: localeValue(d.alt, "en") ?? (d.filename as string) ?? "image", credit: d.credit },
      { file: { data: buffer, mimetype, name: (d.filename as string) || `media-${d.id}.jpg`, size: buffer.length }, context: ctx },
    );
    return (created as unknown as Doc).id as number | string;
  } catch (err) {
    console.warn(`[import] media ${d.id} skipped: ${(err as Error).message}`);
    return undefined;
  }
}

async function importPlan(payload: Awaited<ReturnType<typeof getPayload>>, tenantId: number | string, plan: Plan) {
  const docs = read(plan.coll);
  const map = idMaps[plan.coll] ?? (idMaps[plan.coll] = new Map());
  let created = 0;
  for (const d of docs) {
    // Skip if a doc with the same natural key already exists for the tenant.
    // keyFields (compound keys) resolve rel members through the id maps first.
    const keyVal = localeValue(d[plan.key], "en") ?? d[plan.key];
    const keyClauses: Record<string, unknown>[] = [];
    let keyResolvable = true;
    for (const kf of plan.keyFields ?? [plan.key]) {
      let kv: unknown;
      if (plan.remap && kf in plan.remap) {
        kv = remapRel(plan.remap[kf] as string, d[kf]);
        if (kv == null) {
          keyResolvable = false;
          break;
        }
      } else {
        kv = localeValue(d[kf], "en") ?? d[kf];
      }
      keyClauses.push({ [kf]: { equals: kv } });
    }
    if (!keyResolvable) {
      console.warn(`[import] ${plan.coll} "${String(keyVal)}" skipped: unresolved key rel`);
      continue;
    }
    const existing = ((await pFind(payload, plan.coll, { where: { and: [{ tenant: { equals: tenantId } }, ...keyClauses] }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
    if (existing) {
      map.set(d.id, existing.id as number | string);
      continue;
    }
    if (DRY_RUN) {
      created += 1;
      continue;
    }

    if (plan.upload) {
      const newId = await uploadMedia(payload, tenantId, d);
      if (newId != null) map.set(d.id, newId);
      continue;
    }

    // Publish state: sources use only Payload's native `_status`. Central keys
    // public visibility on `workflowStatus`, so derive it — otherwise every
    // migrated article lands as an invisible draft.
    const published = plan.coll === "articles" && d._status === "published";
    const asDraft = plan.coll === "articles" ? !published : undefined;

    // Base (en) data: non-localized fields verbatim + remapped rels + en localized values.
    const base: Doc = { tenant: tenantId };
    for (const [k, v] of Object.entries(d)) {
      if (["id", "createdAt", "updatedAt", "sizes", "url", "thumbnailURL", "_status"].includes(k)) continue;
      if (plan.drop?.includes(k)) continue;
      if (plan.remap && k in plan.remap) {
        const mapped = remapRel(plan.remap[k] as string, v);
        if (mapped !== undefined) base[k] = mapped;
        continue;
      }
      if (plan.localized.includes(k)) {
        base[k] = localeValue(v, "en");
        continue;
      }
      base[k] = v;
    }
    if (plan.coll === "articles") {
      base.workflowStatus = published ? "published" : "draft";
      base.origin = base.origin ?? "import";
    }
    plan.transform?.(d, base);

    let newDoc: Doc;
    try {
      newDoc = (await pCreate(payload, plan.coll, base, { context: ctx, draft: asDraft })) as unknown as Doc;
    } catch (err) {
      console.warn(`[import] ${plan.coll} "${String(keyVal)}" failed: ${(err as Error).message}`);
      continue;
    }
    map.set(d.id, newDoc.id as number | string);
    created += 1;

    // Write each non-en locale present. Published articles are re-published per
    // locale write (draft:false) so the localized values live on the published
    // version, not a trailing draft.
    for (const locale of LOCALE_CODES) {
      if (locale === "en") continue;
      const patch: Doc = {};
      for (const f of plan.localized) {
        const val = localeValue(d[f], locale);
        if (val !== undefined && val !== null) patch[f] = val;
      }
      if (Object.keys(patch).length) {
        try {
          await pUpdate(payload, plan.coll, newDoc.id as number | string, patch, { locale, context: ctx, draft: asDraft });
        } catch (err) {
          console.warn(`[import] ${plan.coll} ${String(keyVal)} locale ${locale} failed: ${(err as Error).message}`);
        }
      }
    }
  }
  console.log(`[import] ${plan.coll}: ${created} created (${docs.length} in source)`);
}

async function main() {
  const payload = await getPayload({ config });
  const tenantId = await ensureTenant(payload);
  console.log(`[import] tenant ${TENANT_SLUG} (id ${tenantId}); dir ${IMPORT_DIR}; dry-run=${DRY_RUN}`);

  await importCountries(payload);
  for (const plan of PLAN) await importPlan(payload, tenantId, plan);

  // Persist the source→central article id map for the reader-id backfill.
  if (!DRY_RUN && idMaps.articles) {
    const mapFile = path.join(IMPORT_DIR, "article-id-map.json");
    const obj: Record<string, number | string> = {};
    for (const [src, dest] of idMaps.articles.entries()) obj[String(src)] = dest;
    writeFileSync(mapFile, JSON.stringify(obj, null, 2), "utf8");
    console.log(`[import] wrote article id map → ${mapFile}`);
  }

  console.log("[import] done. Review in admin, then warm caches / verify parity.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[import] failed", err);
  process.exit(1);
});
