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
}

const PLAN: Plan[] = [
  { coll: "pillars", key: "slug", localized: ["title", "heading", "description"] },
  { coll: "sectors", key: "slug", localized: ["title", "description"] },
  { coll: "tags", key: "slug", localized: ["title"] },
  { coll: "authors", key: "name", localized: ["bio"] },
  { coll: "media", key: "filename", localized: ["alt", "caption"], upload: true },
  {
    coll: "articles",
    key: "slug",
    localized: ["title", "slug", "dek", "body", "imageLabel"],
    remap: {
      pillar: "pillars",
      sections: "pillars",
      author: "authors",
      coAuthors: "authors",
      tags: "tags",
      sectors: "sectors",
      country: "countries",
      countries: "countries",
      heroImage: "media",
    },
  },
  { coll: "newsletters", key: "slug", localized: ["name", "description"], remap: { vertical: "pillars" } },
  { coll: "podcasts", key: "slug", localized: ["title", "description"] },
  { coll: "corrections", key: "summary", localized: ["summary", "wasText", "nowText"], remap: { article: "articles" } },
  { coll: "wireDrops", key: "text", localized: ["text"] },
];

async function ensureTenant(payload: Awaited<ReturnType<typeof getPayload>>): Promise<number | string> {
  const res = await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 });
  const t = (res as { docs: Doc[] }).docs[0];
  if (!t) throw new Error(`Tenant ${TENANT_SLUG} not found — run seed first.`);
  return t.id as number | string;
}

/** Map global Countries by ISO code (create missing). */
async function importCountries(payload: Awaited<ReturnType<typeof getPayload>>) {
  idMaps.countries = new Map();
  for (const c of read("countries")) {
    const code = String(c.code ?? "").toLowerCase();
    if (!code) continue;
    let central = ((await pFind(payload, "countries", { where: { code: { equals: code } }, limit: 1 })) as { docs: Doc[] }).docs[0];
    if (!central && !DRY_RUN) {
      central = (await pCreate(payload, "countries", { code, name: localeValue(c.name, "en") ?? code, slug: c.slug ?? code, region: c.region }, { context: ctx })) as Doc;
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
    return (created as Doc).id as number | string;
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
    const keyVal = localeValue(d[plan.key], "en") ?? d[plan.key];
    const existing = ((await pFind(payload, plan.coll, { where: { and: [{ tenant: { equals: tenantId } }, { [plan.key]: { equals: keyVal } }] }, limit: 1 })) as { docs: Doc[] }).docs[0];
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

    // Base (en) data: non-localized fields verbatim + remapped rels + en localized values.
    const base: Doc = { tenant: tenantId };
    for (const [k, v] of Object.entries(d)) {
      if (["id", "createdAt", "updatedAt", "sizes", "url", "thumbnailURL"].includes(k)) continue;
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

    let newDoc: Doc;
    try {
      newDoc = (await pCreate(payload, plan.coll, base, { context: ctx, draft: plan.coll === "articles" })) as Doc;
    } catch (err) {
      console.warn(`[import] ${plan.coll} "${String(keyVal)}" failed: ${(err as Error).message}`);
      continue;
    }
    map.set(d.id, newDoc.id as number | string);
    created += 1;

    // Write each non-en locale present.
    for (const locale of LOCALE_CODES) {
      if (locale === "en") continue;
      const patch: Doc = {};
      for (const f of plan.localized) {
        const val = localeValue(d[f], locale);
        if (val !== undefined && val !== null) patch[f] = val;
      }
      if (Object.keys(patch).length) {
        try {
          await pUpdate(payload, plan.coll, newDoc.id as number | string, patch, { locale, context: ctx, draft: plan.coll === "articles" });
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
