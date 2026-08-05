/**
 * GET /api/public/articles — published article list for the token's tenant.
 *   Query: locale, pillar (slug), country (code), tag (slug), page, limit, sort.
 * Returns the Payload list envelope (docs, totalDocs, page, hasNextPage, …).
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";
import type { Where } from "payload";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "articles")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
  const sort = url.searchParams.get("sort") ?? "-publishedAt";

  const and: Where[] = [{ workflowStatus: { equals: "published" } }];

  // Resolve a set of articles by id (account Saved / History rails).
  const idsParam = url.searchParams.get("ids");
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ id: { in: ids } });
  }

  // Free-text-ish search on title + dek.
  const q = url.searchParams.get("q");
  if (q && q.trim()) and.push({ or: [{ title: { like: q.trim() } }, { dek: { like: q.trim() } }] });

  // One-flag feeds (deep dive / sponsored / pinned to latest / breaking).
  const flag = url.searchParams.get("flag");
  if (flag === "deepDive") and.push({ deepDive: { equals: true } });
  if (flag === "sponsored") and.push({ sponsored: { equals: true } });
  if (flag === "pinnedToLatest") {
    and.push({ pinnedToLatest: { equals: true } });
    // Time-boxed pins: an empty pinnedUntil means "pinned until manually
    // unticked"; a past one means the pin has lapsed even if the hourly
    // unpin-expired cron has not swept the checkbox yet.
    and.push({ or: [{ pinnedUntil: { exists: false } }, { pinnedUntil: { greater_than: new Date().toISOString() } }] });
  }
  if (flag === "breaking") and.push({ breaking: { equals: true } });

  const pillarSlug = url.searchParams.get("pillar");
  let pillarId: number | string | undefined;
  if (pillarSlug) {
    const p = await scopedFind({ payload, collection: "pillars", tenantId: tenant.id, where: { slug: { equals: pillarSlug } }, limit: 1, depth: 0 });
    pillarId = (p.docs[0] as { id?: number | string } | undefined)?.id;
    if (pillarId == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ or: [{ pillar: { equals: pillarId } }, { "secondarySections.pillar": { in: [pillarId] } }] });
  }

  // Sub-section filter (slug; pillar-scoped when ?pillar= is also given).
  const subSectionSlug = url.searchParams.get("subsection");
  if (subSectionSlug) {
    const subWhere: Where = pillarId != null
      ? { and: [{ slug: { equals: subSectionSlug } }, { pillar: { equals: pillarId } }] }
      : { slug: { equals: subSectionSlug } };
    const s = await scopedFind({ payload, collection: "subsections", tenantId: tenant.id, where: subWhere, limit: 1, depth: 0 });
    const id = (s.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ or: [{ subSection: { equals: id } }, { "secondarySections.subSection": { in: [id] } }] });
  }

  // Keyset ("load more") pagination: return only rows strictly older than the
  // caller's last row, ordered by (publishedAt, id) — the same compound key the
  // sort uses, so the tie-break is stable when several articles share a timestamp.
  //
  // Offset paging cannot serve an infinite-scroll list: anything published while
  // the reader is scrolling shifts every later page by one and silently
  // duplicates or skips an article. DTW's pillar feed reads from here, so the
  // cursor lives in the API rather than being emulated client-side (which would
  // break as soon as the cursor moves past the first `limit` rows).
  const afterPublishedAt = url.searchParams.get("after_published_at");
  const afterId = url.searchParams.get("after_id");
  if (afterPublishedAt && afterId) {
    and.push({
      or: [
        { publishedAt: { less_than: afterPublishedAt } },
        { and: [{ publishedAt: { equals: afterPublishedAt } }, { id: { less_than: afterId } }] },
      ],
    });
  }

  // Author byline page (/author/<slug>). Resolved by slug like every other
  // taxonomy filter here, so the reader never has to know internal ids.
  const authorSlug = url.searchParams.get("author");
  if (authorSlug) {
    const a = await scopedFind({ payload, collection: "authors", tenantId: tenant.id, where: { slug: { equals: authorSlug } }, limit: 1, depth: 0 });
    const id = (a.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    // An article carries one primary `author` plus optional `coAuthors`; the
    // byline page must list both or a co-authored piece vanishes from its own
    // author's page.
    and.push({ or: [{ author: { equals: id } }, { coAuthors: { in: [id] } }] });
  }

  const tagSlug = url.searchParams.get("tag");
  if (tagSlug) {
    const t = await scopedFind({ payload, collection: "tags", tenantId: tenant.id, where: { slug: { equals: tagSlug } }, limit: 1, depth: 0 });
    const id = (t.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ tags: { in: [id] } });
  }

  // Country hub. Accepts EITHER the ISO code ("sg") or the slug ("singapore",
  // "south-korea") — brief-asia's /country/[slug] routes are addressed by slug and
  // its reader passes that straight through, while the code form is what this
  // endpoint originally documented. Matching both keeps one filter for both
  // conventions instead of a per-site slug→code table that silently drops any
  // country added later.
  const country = url.searchParams.get("country");
  if (country) {
    const c = await payload.find({
      collection: "countries",
      where: { or: [{ slug: { equals: country } }, { code: { equals: country.toLowerCase() } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    const id = (c.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ or: [{ country: { equals: id } }, { countries: { in: [id] } }] });
  }

  const result = await scopedFind({
    payload,
    collection: "articles",
    tenantId: tenant.id,
    where: { and },
    locale,
    page,
    limit,
    sort,
    depth: 1,
  });

  return jsonPublic(request, result, 200);
}
