/**
 * Remap inline body upload references on MIGRATED articles.
 *
 *   FIX_TENANT_SLUG=brief-asia npm run migrate:fix-body-uploads -- [--dry-run]
 *   FIX_TENANT_SLUG=brief-asia FIX_ARTICLE_SLUG=<slug> npm run migrate:fix-body-uploads -- [--dry-run]
 *
 * WHY THIS EXISTS
 *
 * import-central.ts remaps every relationship FIELD (heroImage, author, tags…)
 * through idMaps, but the localized `body` richtext is copied VERBATIM — upload
 * nodes inside the Lexical tree keep their SOURCE-site media ids. Central's
 * media table is shared across tenants, so a source id like 251 resolves to
 * whatever doc holds that serial in Central — for brief-asia that was WTB
 * imagery (found 12-08-2026: the EHG interview rendered a World Cup crowd and a
 * Qantas A350 where the La Siesta pool/suite photos belonged).
 *
 * WHAT IT DOES
 *
 * For every article the import created (ids from article-id-map.json, or the
 * single FIX_ARTICLE_SLUG), for every locale that has a body: walk the Lexical
 * tree, and for each upload node remap
 *
 *   source media id → filename (from migration-data/<tenant>/media.ndjson)
 *                   → central media id (find by filename, scoped to tenant)
 *
 * — the exact same natural-key resolution the importer used for heroImage.
 *
 * SAFETY RULES (an upload node is REWRITTEN only when ALL hold):
 *  - the article is one the import created (or explicitly named via FIX_ARTICLE_SLUG);
 *  - the node's current id exists in the source media export;
 *  - the node's current id resolves to NO media doc, or to a media doc of a
 *    DIFFERENT tenant (the visibly-broken class). A node already pointing at
 *    this tenant's media is left alone: if its filename matches the source
 *    export it is already correct, otherwise it is logged as SUSPECT for a
 *    human to review — never auto-changed;
 *  - the remapped filename resolves to exactly one media doc of this tenant.
 *
 * Writes go through the Payload API with `context.systemWrite` (no version
 * bump, no editedByHuman flip, no translation-outdated marking) and WITHOUT
 * disableRevalidate, so the tenant frontend's cache is busted per change.
 * Re-running is a no-op: fixed nodes now resolve to this tenant and are skipped.
 */
import "../lib/env";
import { DRY_RUN } from "../lib/env";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../payload.config";
import { pFind } from "../lib/payload-loose";

const TENANT_SLUG = process.env.FIX_TENANT_SLUG || "brief-asia";
const ARTICLE_SLUG = process.env.FIX_ARTICLE_SLUG || "";
const APPLY_SUSPECTS = process.env.FIX_APPLY_SUSPECTS === "true";
// Deliberately NOT the importer's IMPORT_DIR: .env.local often still carries
// that from the last migration run, and a stale value here silently pairs one
// tenant's id map with another tenant's articles. FIX_IMPORT_DIR to override.
const IMPORT_DIR = process.env.FIX_IMPORT_DIR || path.resolve(process.cwd(), "migration-data", TENANT_SLUG);

type Doc = Record<string, unknown>;

function readNdjson(name: string): Doc[] {
  const file = path.join(IMPORT_DIR, `${name}.ndjson`);
  if (!existsSync(file)) throw new Error(`missing export: ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Doc);
}

/** Upload-node ids arrive as number | string | {id}. Normalize to a number key. */
function nodeId(value: unknown): number | null {
  const raw = value && typeof value === "object" ? (value as { id?: unknown }).id : value;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function main() {
  const sourceMedia = new Map<number, string>();
  for (const m of readNdjson("media")) {
    const id = nodeId(m.id);
    if (id != null && typeof m.filename === "string") sourceMedia.set(id, m.filename);
  }
  console.log(`[fix] source media export: ${sourceMedia.size} rows`);

  const payload = await getPayload({ config });

  const tenants = await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 });
  const tenant = tenants.docs[0] as { id: number | string } | undefined;
  if (!tenant) throw new Error(`tenant not found: ${TENANT_SLUG}`);

  // Which central article ids the import created.
  const idMapFile = path.join(IMPORT_DIR, "article-id-map.json");
  if (!existsSync(idMapFile)) throw new Error(`missing ${idMapFile}`);
  const importedIds = new Set<number>(
    Object.values(JSON.parse(readFileSync(idMapFile, "utf8")) as Record<string, number>),
  );

  let targetIds: number[];
  if (ARTICLE_SLUG) {
    const r = await pFind(payload, "articles", {
      where: { and: [{ slug: { equals: ARTICLE_SLUG } }, { tenant: { equals: tenant.id } }] },
      limit: 1,
    });
    const doc = r.docs[0] as { id: number } | undefined;
    if (!doc) throw new Error(`article not found for tenant ${TENANT_SLUG}: ${ARTICLE_SLUG}`);
    if (!importedIds.has(doc.id)) {
      console.warn(`[fix] WARNING: article ${doc.id} is not in article-id-map.json (not import-created?) — proceeding because it was named explicitly.`);
    }
    targetIds = [doc.id];
  } else {
    targetIds = [...importedIds];
  }
  console.log(`[fix] tenant=${TENANT_SLUG} (${tenant.id}) — ${targetIds.length} article(s) to scan${DRY_RUN ? " [DRY RUN]" : ""}`);

  // Caches so the bulk run doesn't re-query per node.
  const mediaById = new Map<number, { tenant: number | string; filename: string } | null>();
  const centralIdByFilename = new Map<string, number | null>();

  async function lookupMedia(id: number) {
    if (!mediaById.has(id)) {
      const r = await pFind(payload, "media", { where: { id: { equals: id } }, limit: 1 });
      const d = r.docs[0] as { tenant?: unknown; filename?: string } | undefined;
      mediaById.set(
        id,
        d ? { tenant: nodeId(d.tenant) ?? (d.tenant as number | string), filename: d.filename ?? "" } : null,
      );
    }
    return mediaById.get(id) ?? null;
  }

  async function resolveByFilename(filename: string): Promise<number | null> {
    if (!centralIdByFilename.has(filename)) {
      const r = await pFind(payload, "media", {
        where: { and: [{ filename: { equals: filename } }, { tenant: { equals: tenant!.id } }] },
        limit: 2,
      });
      if (r.docs.length !== 1) {
        console.warn(`[fix]   filename "${filename}" resolves to ${r.docs.length} docs for tenant — skipping`);
        centralIdByFilename.set(filename, null);
      } else {
        centralIdByFilename.set(filename, (r.docs[0] as { id: number }).id);
      }
    }
    return centralIdByFilename.get(filename) ?? null;
  }

  /** Walk a Lexical tree; call fn on every upload node. */
  function walkUploads(node: unknown, fn: (n: Record<string, unknown>) => void) {
    if (Array.isArray(node)) {
      for (const c of node) walkUploads(c, fn);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "upload") fn(obj);
    if (obj.root) walkUploads(obj.root, fn);
    if (Array.isArray(obj.children)) walkUploads(obj.children, fn);
  }

  let articlesChanged = 0;
  let nodesRemapped = 0;
  let suspects = 0;

  for (const articleId of targetIds) {
    // locale:"all" → localized body arrives keyed by locale, ONLY for locales
    // that exist (no fallback copies — writing a fallback would fabricate a
    // translation that was never made).
    const doc = (await payload.findByID({
      collection: "articles",
      id: articleId,
      locale: "all",
      depth: 0,
      overrideAccess: true,
    })) as { slug?: unknown; tenant?: unknown; body?: Record<string, unknown> | null };
    // Belt-and-braces: the id map must only ever name THIS tenant's articles.
    if (String(nodeId(doc.tenant) ?? doc.tenant) !== String(tenant.id)) {
      console.warn(`[fix]   article ${articleId} belongs to tenant ${String(nodeId(doc.tenant) ?? doc.tenant)}, not ${String(tenant.id)} — id map/tenant mismatch, skipping`);
      continue;
    }
    const bodyByLocale = doc.body && typeof doc.body === "object" && !("root" in doc.body)
      ? (doc.body as Record<string, unknown>)
      : doc.body
        ? { en: doc.body as unknown }
        : {};
    const slug = typeof doc.slug === "object" && doc.slug ? (doc.slug as Record<string, unknown>).en : doc.slug;

    for (const [locale, body] of Object.entries(bodyByLocale)) {
      if (!body || typeof body !== "object") continue;

      // Collect the async work first (walk is sync), then apply.
      const uploadNodes: Record<string, unknown>[] = [];
      walkUploads(body, (n) => uploadNodes.push(n));
      if (!uploadNodes.length) continue;

      let changed = false;
      for (const n of uploadNodes) {
        const currentId = nodeId(n.value);
        if (currentId == null) continue;
        const sourceFilename = sourceMedia.get(currentId);
        if (!sourceFilename) continue; // id not in source export → post-migration insert; leave

        const current = await lookupMedia(currentId);
        const sameTenant = current != null && String(current.tenant) === String(tenant!.id);
        if (sameTenant) {
          if (current!.filename === sourceFilename) continue; // already correct
          // Same-tenant + filename mismatch: usually the same collision bug
          // (the source id landed on an unrelated doc of this tenant), but it
          // COULD be a deliberate post-migration edit. Default: report only.
          // FIX_APPLY_SUSPECTS=true remaps these too — run it scoped via
          // FIX_ARTICLE_SLUG after eyeballing each reported node.
          if (!APPLY_SUSPECTS) {
            console.warn(`[fix]   SUSPECT ${slug} [${locale}] node ${currentId}: same-tenant but filename "${current!.filename}" != source "${sourceFilename}" — left for manual review (FIX_APPLY_SUSPECTS=true to remap)`);
            suspects += 1;
            continue;
          }
        }

        const mapped = await resolveByFilename(sourceFilename);
        if (mapped == null) continue;
        console.log(`[fix]   ${slug} [${locale}]: upload ${currentId} (${current ? "tenant " + String(current.tenant) : "dangling"}) → ${mapped} (${sourceFilename})`);
        n.value = mapped;
        changed = true;
        nodesRemapped += 1;
      }

      if (changed && !DRY_RUN) {
        await payload.update({
          collection: "articles",
          id: articleId,
          locale: locale as never,
          data: { body } as never,
          depth: 0,
          overrideAccess: true,
          context: { systemWrite: true },
        });
        console.log(`[fix]   updated article ${articleId} (${slug}) [${locale}]`);
      }
      if (changed) articlesChanged += 1;
    }
  }

  console.log(`[fix] done — ${nodesRemapped} node(s) remapped across ${articlesChanged} article-locale write(s); ${suspects} suspect(s) left alone${DRY_RUN ? " [DRY RUN — nothing written]" : ""}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
