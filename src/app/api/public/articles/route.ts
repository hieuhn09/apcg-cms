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

  // One-flag feeds (deep dive / sponsored / pinned to latest).
  const flag = url.searchParams.get("flag");
  if (flag === "deepDive") and.push({ deepDive: { equals: true } });
  if (flag === "sponsored") and.push({ sponsored: { equals: true } });
  if (flag === "pinnedToLatest") and.push({ pinnedToLatest: { equals: true } });

  const pillarSlug = url.searchParams.get("pillar");
  if (pillarSlug) {
    const p = await scopedFind({ payload, collection: "pillars", tenantId: tenant.id, where: { slug: { equals: pillarSlug } }, limit: 1, depth: 0 });
    const id = (p.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ or: [{ pillar: { equals: id } }, { sections: { in: [id] } }] });
  }

  const tagSlug = url.searchParams.get("tag");
  if (tagSlug) {
    const t = await scopedFind({ payload, collection: "tags", tenantId: tenant.id, where: { slug: { equals: tagSlug } }, limit: 1, depth: 0 });
    const id = (t.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }, 200);
    and.push({ tags: { in: [id] } });
  }

  const countryCode = url.searchParams.get("country");
  if (countryCode) {
    const c = await payload.find({ collection: "countries", where: { code: { equals: countryCode.toLowerCase() } }, limit: 1, depth: 0, overrideAccess: true });
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
