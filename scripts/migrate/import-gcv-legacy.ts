/**
 * Import the legacy "Global Chic Voyage" custom CMS (plain Postgres, NOT a
 * Payload site — so import-central.ts and its NDJSON pipeline do not apply)
 * into the Central CMS as tenant `gcv`. Spec: global-chic-voyage/MIGRATION.md.
 *
 *   LEGACY_GCV_DB_URL=postgres://user:pass@host:5432/gcv \
 *   npm run migrate:gcv-legacy -- [--dry-run] [--limit N]
 *
 * Prereq: `npm run db:seed` (tenant gcv + its 5 pillars must exist).
 *
 * Source tables (verified 13/08/2026 — MIGRATION.md §1):
 *   posts (516; body = HTML, sometimes entity-encoded; no slug column)
 *   post_category → categories (pillar), post_tag_news (free-text tags),
 *   video (5 YouTube Shorts → podcasts).
 *
 * Mapping highlights (MIGRATION.md §2):
 *   status Published→workflowStatus published, Draft→draft, Deleted→SKIP
 *   type_post HighLights → deepDive=true
 *   project_name || short_content || title → dek (required field)
 *   created_name → authors (find-or-create; fallback "Global Chic Voyage")
 *   web_source → engineSourceName; created_at → publishedAt
 *   country (free text) → global `countries` by name/slug (skip "Global")
 *   category recommend → OPEN QUESTION (§5.1): provisionally mapped to
 *     trends-inspiration PLUS tag "Recommend"; flagged in the report.
 *
 * HTML→Lexical: `convertHTMLToLexical` + `editorConfigFactory.default` from
 * @payloadcms/richtext-lexical (present in the installed 3.85.1; requires a
 * JSDOM constructor — jsdom added as a devDependency). Inline <img> handling
 * deliberately does NOT rely on the converter's img import path (a bare <img>
 * becomes a *pending* upload node that only resolves inside a live editor).
 * Instead the body HTML is split into segments around images; each image is
 * downloaded + created as a gcv media doc, and a fully-formed serialized
 * upload node (type "upload", version 3 — matches UploadServerNode.exportJSON
 * in 3.85.1) referencing THAT central media id is spliced between converted
 * segments. Never the legacy URL, never a foreign id — see the BA inline-body
 * upload-id bug (12/08) and remapUploadNodes in import-central.ts.
 *
 * Media: created through the document API with file buffers (same as
 * import-central's uploadMedia) so the storage adapter (R2 in prod, local in
 * dev) and the tenant `prefix` hook apply. Filenames are stable per source
 * URL (short hash + basename) which makes media idempotent by
 * (tenant, filename); an in-run cache dedupes repeated URLs. Note: uploads
 * are capped at 4MB by payload.config — an oversized legacy image fails that
 * one media doc and is listed in the report, the article still imports.
 *
 * Idempotent: articles/authors/tags/podcasts upsert-or-skip by natural key
 * within the tenant (slug / name); re-runs do not duplicate. Slug dedupe
 * (-2, -3…) is stable because posts are processed in legacy-id order.
 *
 * --dry-run: reads the legacy DB + central taxonomy, runs every transform
 * (including HTML→Lexical) and HEAD-checks every image URL, writes NOTHING,
 * then prints the full report.
 */
import "../lib/env";
import { DRY_RUN } from "../lib/env";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { JSDOM } from "jsdom";
import { getPayload } from "payload";
import { convertHTMLToLexical, editorConfigFactory } from "@payloadcms/richtext-lexical";
import type { SanitizedServerEditorConfig } from "@payloadcms/richtext-lexical";
import config from "../../payload.config";
import { pFind, pCreate } from "../lib/payload-loose";
import { slugify } from "../../src/lib/http";

// ── Env / flags ──────────────────────────────────────────────────────────────
const TENANT_SLUG = process.env.IMPORT_TENANT_SLUG || "gcv";
const LEGACY_DB_URL = process.env.LEGACY_GCV_DB_URL || "";
// Legacy media host — thumbnails/inline images live on the wad file server.
const LEGACY_MEDIA_BASE = (process.env.LEGACY_GCV_MEDIA_BASE || "https://files.worldarchidesign.com").replace(/\/$/, "");
const FETCH_TIMEOUT_MS = 30_000;

function parseLimit(): number | undefined {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--limit="));
  if (eq) return Number(eq.split("=")[1]) || undefined;
  const i = argv.indexOf("--limit");
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]) || undefined;
  return undefined;
}
const LIMIT = parseLimit();

if (!LEGACY_DB_URL) {
  console.error("Missing required env var: LEGACY_GCV_DB_URL (postgres connection string to the legacy gcv database)");
  process.exit(1);
}

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;
// Same write discipline as seed.ts / import-central.ts: no revalidate storms,
// no translation enqueue during a bulk import.
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };

// ── Legacy row shapes (columns verified in MIGRATION.md §1) ─────────────────
interface LegacyPost {
  id: number;
  title: string | null;
  body: string | null;
  short_content: string | null;
  project_name: string | null;
  category_name: string | null;
  country: string | null;
  thumbnail: string | null;
  created_name: string | null;
  type_post: string | null;
  web_source: string | null;
  status: string | null;
  created_at: Date | string | null;
}

// ── Pillar mapping (MIGRATION.md §2) ────────────────────────────────────────
// Keys are slugify()'d forms of BOTH the legacy category slug (camelCase, e.g.
// "trendsInspiration" → "trendsinspiration") and the display name
// ("Trends & Inspiration" → "trends-inspiration"), so either source resolves.
const PILLAR_MAP: Record<string, string> = {
  "trendsinspiration": "trends-inspiration",
  "trends-inspiration": "trends-inspiration",
  "styleculture": "style-culture",
  "style-culture": "style-culture",
  "destinations": "destinations",
  "retreat": "retreat",
  "dining": "dining",
  // DECIDED 14/08/2026 (MIGRATION.md §5.1): `recommend` has no pillar in the
  // 5-pillar nav → lands in trends-inspiration and carries the tag "Recommend".
  "recommend": "trends-inspiration",
};
const FALLBACK_PILLAR = "destinations"; // MIGRATION.md §1: 4 posts without category
const RECOMMEND_KEY = "recommend";
const RECOMMEND_TAG_TITLE = "Recommend";
const DEFAULT_AUTHOR_NAME = "Global Chic Voyage";

// Legacy free-text country spellings → canonical seed names (scripts/seed.ts).
const COUNTRY_ALIASES: Record<string, string> = {
  "hongkong": "hong kong",
  "uk": "united kingdom",
  "usa": "united states",
  "uae": "united arab emirates",
};

// ── Report ───────────────────────────────────────────────────────────────────
const report = {
  postsSeen: 0,
  deletedSkipped: 0,
  imported: 0,
  importedDrafts: 0,
  skippedExisting: 0,
  failed: [] as string[],
  perPillar: new Map<string, number>(),
  recommendRemapped: 0, // pending final decision — see PILLAR_MAP note
  postsWithoutCategory: [] as number[],
  slugCollisions: [] as string[],
  authorsCreated: [] as string[],
  tagsCreated: [] as string[],
  mediaCreated: 0,
  mediaReused: 0,
  mediaFailed: [] as string[],
  heroMissing: 0, // no thumbnail OR download failed — article imported without heroImage
  inlineImages: 0,
  bodyConversionFailed: [] as string[],
  countriesUnmatched: new Map<string, number>(),
  podcastsCreated: 0,
  podcastsSkipped: 0,
  notes: [] as string[],
};
function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ── Small utils ──────────────────────────────────────────────────────────────
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const firstNonEmpty = (...vals: unknown[]): string => vals.map(str).find(Boolean) ?? "";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decode entity-encoded HTML fragments ("&lt;h2&gt;…") — some legacy bodies are stored encoded. */
function decodeEntitiesIfNeeded(html: string): string {
  let out = html;
  for (let i = 0; i < 2 && !out.includes("<") && /&(lt|gt|amp|#\d+);/.test(out); i++) {
    const ta = sharedDom.window.document.createElement("textarea");
    ta.innerHTML = out;
    out = ta.value;
  }
  return out;
}
const sharedDom = new JSDOM("<!doctype html><body></body>");

/**
 * Some engine-era Skysoft bodies use NBSP (U+00A0 family) as the word
 * separator — browsers can't line-break those, so paragraphs overflow the
 * article column (found on prod 15/08/2026; fix-gcv-nbsp-bodies.ts patched the
 * already-imported rows). Normalize before conversion so delta imports are
 * clean at the source.
 */
function normalizeLegacyText(s: string): string {
  return s.replace(/[   ]/g, " ").replace(/ {2,}/g, " ");
}

function absoluteMediaUrl(raw: string): string {
  // The wad file server 301s http→https; normalize up front so the URL cache
  // never holds both spellings of the same image.
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  return `${LEGACY_MEDIA_BASE}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/** Stable, sanitized filename per source URL → media idempotency key within the tenant. */
function stableFilename(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  let base = "image";
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    base = p.split("/").filter(Boolean).pop() || "image";
  } catch {
    /* keep default */
  }
  base = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(-60);
  if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) base += ".jpg";
  return `gcv-${hash}-${base}`;
}

async function fetchWithTimeout(url: string, method: "GET" | "HEAD"): Promise<Response> {
  return fetch(url, { method, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
}

// ── Media (download → central media doc; cached by source URL) ──────────────
const mediaByUrl = new Map<string, number | string | null>(); // null = known-failed

async function ensureMedia(
  payload: P,
  tenantId: number | string,
  rawUrl: string,
  meta: { alt: string; credit?: string },
): Promise<number | string | undefined> {
  const url = absoluteMediaUrl(rawUrl);
  if (mediaByUrl.has(url)) return mediaByUrl.get(url) ?? undefined;

  const filename = stableFilename(url);
  try {
    // Idempotency across runs: a doc with this stable filename already belongs
    // to the tenant → adopt it. (Filenames are hash-unique per URL, so Payload
    // never had to rename on create and the lookup stays reliable.)
    const existing = ((await pFind(payload, "media", {
      where: { and: [{ tenant: { equals: tenantId } }, { filename: { equals: filename } }] },
      limit: 1,
    })) as unknown as { docs: Doc[] }).docs[0];
    if (existing) {
      mediaByUrl.set(url, existing.id as number | string);
      report.mediaReused += 1;
      return existing.id as number | string;
    }

    if (DRY_RUN) {
      // No writes — but verify the URL is alive so the report lists broken
      // images. The wad file server answers 404 to HEAD, so probe with GET and
      // discard the body.
      const probe = await fetchWithTimeout(url, "GET");
      await probe.body?.cancel().catch(() => {});
      if (!probe.ok) throw new Error(`GET ${probe.status}`);
      mediaByUrl.set(url, 0); // placeholder id, never persisted
      report.mediaCreated += 1;
      return 0;
    }

    const res = await fetchWithTimeout(url, "GET");
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const created = (await pCreate(
      payload,
      "media",
      { tenant: tenantId, alt: meta.alt || filename, credit: meta.credit || undefined },
      { file: { data: buffer, mimetype, name: filename, size: buffer.length }, context: ctx },
    )) as unknown as Doc;
    const id = created.id as number | string;
    mediaByUrl.set(url, id);
    report.mediaCreated += 1;
    return id;
  } catch (err) {
    mediaByUrl.set(url, null);
    report.mediaFailed.push(`${url} — ${(err as Error).message}`);
    return undefined;
  }
}

// ── Authors / tags (find-or-create within tenant) ────────────────────────────
const authorIds = new Map<string, number | string>();

async function ensureAuthor(payload: P, tenantId: number | string, rawName: string): Promise<number | string> {
  const name = str(rawName) || DEFAULT_AUTHOR_NAME;
  const cached = authorIds.get(name);
  if (cached != null) return cached;
  const existing = ((await pFind(payload, "authors", {
    where: { and: [{ tenant: { equals: tenantId } }, { name: { equals: name } }] },
    limit: 1,
  })) as unknown as { docs: Doc[] }).docs[0];
  if (existing) {
    authorIds.set(name, existing.id as number | string);
    return existing.id as number | string;
  }
  report.authorsCreated.push(name);
  if (DRY_RUN) {
    authorIds.set(name, 0);
    return 0;
  }
  const created = (await pCreate(payload, "authors", { tenant: tenantId, name, slug: slugify(name) }, { context: ctx })) as unknown as Doc;
  authorIds.set(name, created.id as number | string);
  return created.id as number | string;
}

const tagIds = new Map<string, number | string>(); // by slug

async function ensureTag(payload: P, tenantId: number | string, displayTitle: string): Promise<number | string | undefined> {
  const title = str(displayTitle);
  if (!title) return undefined;
  const slug = slugify(title);
  if (!slug) return undefined;
  const cached = tagIds.get(slug);
  if (cached != null) return cached;
  const existing = ((await pFind(payload, "tags", {
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
    limit: 1,
  })) as unknown as { docs: Doc[] }).docs[0];
  if (existing) {
    tagIds.set(slug, existing.id as number | string);
    return existing.id as number | string;
  }
  report.tagsCreated.push(`${slug} ("${title}")`);
  if (DRY_RUN) {
    tagIds.set(slug, 0);
    return 0;
  }
  const created = (await pCreate(payload, "tags", { tenant: tenantId, slug, title }, { context: ctx })) as unknown as Doc;
  tagIds.set(slug, created.id as number | string);
  return created.id as number | string;
}

// ── Body HTML → Lexical ──────────────────────────────────────────────────────
type Seg = { kind: "html"; html: string } | { kind: "img"; src: string; alt?: string };

/**
 * Split body HTML into html/img segments, walking top-level nodes. An <img>
 * nested inside a block (p/figure) is extracted; the block's remaining text
 * (if any) stays as an html segment BEFORE the image — an upload node is a
 * block-level Lexical node, so a mid-paragraph image cannot keep its exact
 * inline position anyway. Fine for this corpus (h2/p/blockquote/img fragments).
 */
function segmentBody(html: string): Seg[] {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const body = dom.window.document.body;
  const segs: Seg[] = [];
  let buf: string[] = [];
  const flush = () => {
    const joined = buf.join("");
    if (joined.trim()) segs.push({ kind: "html", html: joined });
    buf = [];
  };
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 1) {
      const el = node as Element;
      const imgs = el.tagName === "IMG" ? [el] : Array.from(el.querySelectorAll("img"));
      if (imgs.length) {
        const extracted = imgs.map((img) => ({
          src: img.getAttribute("src") ?? "",
          alt: img.getAttribute("alt") ?? undefined,
        }));
        for (const img of imgs) img.remove();
        if (el.tagName !== "IMG" && (el.textContent ?? "").trim()) buf.push(el.outerHTML);
        flush();
        for (const e of extracted) if (e.src) segs.push({ kind: "img", ...e });
        continue;
      }
      buf.push(el.outerHTML);
    } else if (node.nodeType === 3 && (node.textContent ?? "").trim()) {
      // Stray top-level text → wrap as a paragraph.
      buf.push(`<p>${escapeHtml(node.textContent ?? "")}</p>`);
    }
  }
  flush();
  return segs;
}

/** Serialized upload node — shape matches UploadServerNode.exportJSON (version 3) in 3.85.1. */
function uploadNode(mediaId: number | string): Doc {
  return {
    type: "upload",
    version: 3,
    format: "",
    id: randomBytes(12).toString("hex"), // unique node id (ObjectID-style hex)
    fields: {},
    relationTo: "media",
    value: mediaId,
  };
}

interface LexicalState {
  root: { type: string; children: unknown[]; direction: null | string; format: string; indent: number; version: number };
}

async function htmlBodyToLexical(
  payload: P,
  tenantId: number | string,
  editorConfig: SanitizedServerEditorConfig,
  rawHtml: string,
  post: { title: string; credit?: string },
): Promise<LexicalState | undefined> {
  const html = normalizeLegacyText(decodeEntitiesIfNeeded(rawHtml)).trim();
  if (!html) return undefined;
  const children: unknown[] = [];
  for (const seg of segmentBody(html)) {
    if (seg.kind === "html") {
      const state = convertHTMLToLexical({ editorConfig, html: seg.html, JSDOM }) as unknown as LexicalState;
      children.push(...(state?.root?.children ?? []));
    } else {
      report.inlineImages += 1;
      const id = await ensureMedia(payload, tenantId, seg.src, { alt: seg.alt || post.title, credit: post.credit });
      // Failed/missing image → dropped from the body (never a foreign URL or id).
      if (id !== undefined) children.push(uploadNode(id));
    }
  }
  // Legacy double-<br>/<p>&nbsp;</p> spacing converts to empty paragraphs that
  // double the vertical rhythm vs the design — drop them.
  const kept = children.filter((n) => {
    const node = n as { type?: string; children?: { type?: string; text?: string }[] };
    if (node.type !== "paragraph") return true;
    const kids = node.children ?? [];
    return kids.length > 0 && !kids.every((k) => k.type === "text" && !(k.text ?? "").trim());
  });
  if (!kept.length) return undefined;
  return { root: { type: "root", children: kept, direction: null, format: "", indent: 0, version: 1 } };
}

// ── Legacy DB readers ────────────────────────────────────────────────────────
/**
 * post_category / post_tag_news join-column names were not captured in the
 * schema survey, so detect them from the live table (any column matching
 * /post/ + /categor/, and for tags the first non-id string column). The
 * detected names are printed so a wrong guess is visible immediately.
 */
async function fetchCategoryMap(client: pg.Client): Promise<Map<number, { slug: string; name: string }>> {
  const map = new Map<number, { slug: string; name: string }>();
  const sample = await client.query("SELECT * FROM post_category LIMIT 1");
  const cols = sample.fields.map((f) => f.name);
  const postCol = cols.find((c) => /post/i.test(c) && /id/i.test(c)) ?? cols.find((c) => /post/i.test(c));
  const catCol = cols.find((c) => /categor/i.test(c));
  if (!postCol || !catCol) throw new Error(`post_category: cannot detect join columns (saw: ${cols.join(", ")})`);
  console.log(`[gcv] post_category join columns: ${postCol} / ${catCol}`);
  const res = await client.query(
    `SELECT pc."${postCol}" AS post_id, c.slug AS slug, c.name AS name
       FROM post_category pc JOIN categories c ON c.id = pc."${catCol}"
      ORDER BY pc."${postCol}", pc."${catCol}"`,
  );
  for (const row of res.rows as { post_id: number | string; slug: string | null; name: string | null }[]) {
    // pg returns bigint as string — normalize so lookups by Number(post.id) hit.
    const pid = Number(row.post_id);
    if (!map.has(pid)) map.set(pid, { slug: str(row.slug), name: str(row.name) }); // first category wins (~1 per post)
  }
  return map;
}

async function fetchTagMap(client: pg.Client): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  const res = await client.query("SELECT * FROM post_tag_news");
  if (!res.rows.length) return map;
  const cols = res.fields.map((f) => f.name);
  const postCol = cols.find((c) => /post/i.test(c) && /id/i.test(c)) ?? cols.find((c) => /post/i.test(c));
  const firstRow = res.rows[0] as Doc;
  const tagCol =
    cols.find((c) => c !== postCol && /tag|name|title/i.test(c) && !/id$/i.test(c) && typeof firstRow[c] === "string") ??
    cols.find((c) => c !== postCol && !/^id$/i.test(c) && typeof firstRow[c] === "string");
  if (!postCol || !tagCol) throw new Error(`post_tag_news: cannot detect columns (saw: ${cols.join(", ")})`);
  console.log(`[gcv] post_tag_news columns: ${postCol} / ${tagCol}`);
  for (const row of res.rows as Doc[]) {
    const postId = Number(row[postCol]);
    const tag = str(row[tagCol]);
    if (!Number.isFinite(postId) || !tag) continue;
    const list = map.get(postId) ?? [];
    // trim + dedupe case-insensitively, first spelling wins as display title
    if (!list.some((t) => t.toLowerCase() === tag.toLowerCase())) list.push(tag);
    map.set(postId, list);
  }
  return map;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const legacy = new pg.Client({ connectionString: LEGACY_DB_URL });
  await legacy.connect();

  const payload = await getPayload({ config });
  const editorConfig = await editorConfigFactory.default({ config: payload.config });

  // Tenant + pillars must exist (seed first).
  const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
  if (!tenant) throw new Error(`Tenant ${TENANT_SLUG} not found — run \`npm run db:seed\` first.`);
  const tenantId = tenant.id as number | string;

  const pillarDocs = ((await pFind(payload, "pillars", { where: { tenant: { equals: tenantId } }, limit: 100 })) as unknown as { docs: Doc[] }).docs;
  const pillarIdBySlug = new Map<string, number | string>();
  for (const p of pillarDocs) pillarIdBySlug.set(String(p.slug), p.id as number | string);
  for (const s of new Set(Object.values(PILLAR_MAP))) {
    if (!pillarIdBySlug.has(s)) throw new Error(`Pillar "${s}" missing for tenant ${TENANT_SLUG} — run \`npm run db:seed\` first.`);
  }

  // Global countries → name/slug (lowercased) → id, for free-text matching.
  const countryDocs = ((await pFind(payload, "countries", { limit: 1000 })) as unknown as { docs: Doc[] }).docs;
  const countryIdByKey = new Map<string, number | string>();
  for (const c of countryDocs) {
    if (typeof c.name === "string") countryIdByKey.set(c.name.trim().toLowerCase(), c.id as number | string);
    if (typeof c.slug === "string") countryIdByKey.set(c.slug.trim().toLowerCase(), c.id as number | string);
  }

  console.log(`[gcv] tenant ${TENANT_SLUG} (id ${tenantId}); dry-run=${DRY_RUN}; limit=${LIMIT ?? "none"}; media base ${LEGACY_MEDIA_BASE}`);

  // ── Read legacy source ──
  const deleted = await legacy.query("SELECT count(*)::int AS n FROM posts WHERE status = 'Deleted'");
  report.deletedSkipped = (deleted.rows[0] as { n: number } | undefined)?.n ?? 0;

  const postsRes = await legacy.query(
    `SELECT id, title, body, short_content, project_name, category_name, country, thumbnail,
            created_name, type_post, web_source, status, created_at
       FROM posts
      WHERE status <> 'Deleted'
      ORDER BY id ASC
      ${LIMIT ? `LIMIT ${LIMIT}` : ""}`,
  );
  const posts = postsRes.rows as LegacyPost[];
  const categoryByPost = await fetchCategoryMap(legacy);
  const tagsByPost = await fetchTagMap(legacy);
  const videosRes = await legacy.query("SELECT * FROM video ORDER BY id ASC");

  console.log(`[gcv] source: ${posts.length} posts to process, ${report.deletedSkipped} Deleted skipped, ${videosRes.rows.length} videos`);

  // ── Articles ──
  const usedSlugs = new Set<string>();
  for (const post of posts) {
    report.postsSeen += 1;
    const title = firstNonEmpty(post.title) || `Untitled ${post.id}`;
    try {
      // slug: slugify(title), stable -2/-3 dedupe in legacy-id order
      const base = slugify(title) || `post-${post.id}`;
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
      if (slug !== base) report.slugCollisions.push(`${slug} (legacy id ${post.id})`);
      usedSlugs.add(slug);

      // pillar (legacy category slug, then category_name fallback, then destinations)
      // pg returns posts.id (bigint) as a string — both join maps key by Number.
      const cat = categoryByPost.get(Number(post.id));
      const key = slugify(cat?.slug || cat?.name || "") || slugify(str(post.category_name));
      if (!cat && !str(post.category_name)) report.postsWithoutCategory.push(post.id);
      const isRecommend = key === RECOMMEND_KEY;
      if (isRecommend) report.recommendRemapped += 1;
      const pillarSlug = PILLAR_MAP[key] ?? FALLBACK_PILLAR;
      bump(report.perPillar, isRecommend ? `${pillarSlug} (from recommend)` : pillarSlug);
      const pillarId = pillarIdBySlug.get(pillarSlug);
      if (pillarId == null) throw new Error(`pillar ${pillarSlug} missing`);

      // Idempotency: skip if this tenant already has the slug.
      const existing = ((await pFind(payload, "articles", {
        where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
        limit: 1,
        draft: true,
      })) as unknown as { docs: Doc[] }).docs[0];
      if (existing) {
        report.skippedExisting += 1;
        continue;
      }

      const credit = str(post.web_source) || undefined;
      const authorId = await ensureAuthor(payload, tenantId, str(post.created_name));

      // tags (trimmed/deduped) + provisional "Recommend" tag
      const tagList = [...(tagsByPost.get(Number(post.id)) ?? [])];
      if (isRecommend) tagList.push(RECOMMEND_TAG_TITLE);
      const articleTagIds: (number | string)[] = [];
      for (const t of tagList) {
        const id = await ensureTag(payload, tenantId, t);
        if (id !== undefined && !articleTagIds.includes(id)) articleTagIds.push(id);
      }

      // country: free text → global countries by name/slug; skip "Global"/empty
      let countryId: number | string | undefined;
      const countryName = str(post.country);
      if (countryName && countryName.toLowerCase() !== "global") {
        const countryKey = countryName.toLowerCase();
        countryId = countryIdByKey.get(COUNTRY_ALIASES[countryKey] ?? countryKey);
        if (countryId == null) bump(report.countriesUnmatched, countryName);
      }

      // heroImage
      let heroId: number | string | undefined;
      if (str(post.thumbnail)) {
        heroId = await ensureMedia(payload, tenantId, str(post.thumbnail), { alt: title, credit });
      }
      if (heroId === undefined) report.heroMissing += 1;

      // body HTML → Lexical (inline images become tenant-gcv upload nodes)
      let body: LexicalState | undefined;
      if (str(post.body)) {
        try {
          body = await htmlBodyToLexical(payload, tenantId, editorConfig, str(post.body), { title, credit });
        } catch (err) {
          report.bodyConversionFailed.push(`legacy id ${post.id} ("${slug}") — ${(err as Error).message}`);
        }
      }

      const published = str(post.status) === "Published";
      const publishedAt = post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString();

      if (!DRY_RUN) {
        await pCreate(
          payload,
          "articles",
          {
            tenant: tenantId,
            title,
            slug,
            dek: firstNonEmpty(post.project_name, post.short_content, post.title),
            ...(body ? { body } : {}),
            workflowStatus: published ? "published" : "draft",
            publishedAt,
            pillar: pillarId,
            author: authorId,
            ...(articleTagIds.length ? { tags: articleTagIds } : {}),
            ...(countryId != null ? { country: countryId } : {}),
            ...(heroId !== undefined && heroId !== 0 ? { heroImage: heroId } : {}),
            deepDive: str(post.type_post) === "HighLights",
            origin: "import",
            engineSourceName: credit,
          },
          { context: ctx, draft: !published },
        );
      }
      report.imported += 1;
      if (!published) report.importedDrafts += 1;
    } catch (err) {
      report.failed.push(`legacy id ${post.id} ("${title}") — ${(err as Error).message}`);
    }
  }

  // ── Videos → podcasts ──
  // Podcasts has no video/external-URL field; `audioUrl` ("Audio file URL") is
  // the closest existing field and carries the YouTube URL. Collection schema
  // deliberately NOT modified — noted in the report.
  report.notes.push('podcasts: legacy video.url stored in `audioUrl` (no dedicated video-URL field on Podcasts) — frontend must treat it as an external/YouTube link.');
  report.notes.push(`recommend posts land in trends-inspiration + tag "${RECOMMEND_TAG_TITLE}" (decided 14/08/2026, MIGRATION.md §5.1).`);
  for (const row of videosRes.rows as Doc[]) {
    const title = firstNonEmpty(row.title) || `Video ${String(row.id)}`;
    const slug = slugify(title) || `video-${String(row.id)}`;
    const url = firstNonEmpty(row.url);
    const existing = ((await pFind(payload, "podcasts", {
      where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
      limit: 1,
    })) as unknown as { docs: Doc[] }).docs[0];
    if (existing) {
      report.podcastsSkipped += 1;
      continue;
    }
    let posterId: number | string | undefined;
    const thumb = firstNonEmpty(row.thumbnail_url, row.thumbnail);
    if (thumb) posterId = await ensureMedia(payload, tenantId, thumb, { alt: title });
    if (!DRY_RUN) {
      await pCreate(
        payload,
        "podcasts",
        {
          tenant: tenantId,
          title,
          slug,
          ...(url ? { audioUrl: url } : {}),
          ...(posterId !== undefined && posterId !== 0 ? { poster: posterId } : {}),
        },
        { context: ctx },
      );
    }
    report.podcastsCreated += 1;
  }

  await legacy.end();
  printReport();
  process.exit(0);
}

function printReport() {
  const fmtMap = (m: Map<string, number>) => [...m.entries()].map(([k, v]) => `    ${k}: ${v}`).join("\n") || "    (none)";
  const fmtList = (l: string[], max = 50) =>
    l.length ? l.slice(0, max).map((x) => `    - ${x}`).join("\n") + (l.length > max ? `\n    … +${l.length - max} more` : "") : "    (none)";
  console.log(`
════════ GCV legacy import report ${DRY_RUN ? "(DRY RUN — nothing written)" : ""} ════════
  posts processed:        ${report.postsSeen}
  imported:               ${report.imported} (${report.importedDrafts} as draft)
  skipped (already exist):${report.skippedExisting}
  skipped (Deleted):      ${report.deletedSkipped}
  failed:                 ${report.failed.length}
${fmtList(report.failed)}
  per-pillar distribution:
${fmtMap(report.perPillar)}
  recommend remapped:     ${report.recommendRemapped}  (→ trends-inspiration + tag Recommend)
  posts without category: ${report.postsWithoutCategory.length} ${report.postsWithoutCategory.length ? `(legacy ids: ${report.postsWithoutCategory.join(", ")})` : ""}
  slug collisions (deduped):
${fmtList(report.slugCollisions)}
  authors created:        ${report.authorsCreated.length}
${fmtList(report.authorsCreated)}
  tags created:           ${report.tagsCreated.length}
${fmtList(report.tagsCreated, 100)}
  media created:          ${report.mediaCreated} (reused existing: ${report.mediaReused}; inline body images: ${report.inlineImages})
  media failed:           ${report.mediaFailed.length}
${fmtList(report.mediaFailed, 100)}
  articles without hero:  ${report.heroMissing}
  body conversion failed: ${report.bodyConversionFailed.length}
${fmtList(report.bodyConversionFailed)}
  countries unmatched:
${fmtMap(report.countriesUnmatched)}
  podcasts:               ${report.podcastsCreated} created, ${report.podcastsSkipped} skipped (existing)
  notes:
${fmtList(report.notes)}
`);
}

main().catch((err) => {
  console.error("[gcv] import failed", err);
  process.exit(1);
});
