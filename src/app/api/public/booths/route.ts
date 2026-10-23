/**
 * GET /api/public/booths?hall=&article=<articleSlug>&page=&limit= — published
 * booths of The Beauty Exhibition (AsiaBeautyBrief) for the token's tenant.
 * Feature-gated on `exhibition` (404 `{ ok:false, status:"not_found" }` when
 * off, like every feature-gated public route). Returns the same list envelope
 * as /api/public/articles (docs, totalDocs, limit, page, totalPages, hasNextPage,
 * hasPrevPage, nextPage, prevPage, pagingCounter); an unknown hall/article gives
 * the empty envelope `{ docs:[], totalDocs:0, page:1, totalPages:0, hasNextPage:false }`.
 * Rows are summaries built by an allowlist (src/lib/public-booths.ts).
 */
import { getPayload } from "payload";
import config from "@payload-config";
import type { Where } from "payload";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";
import { BOOTH_HALLS } from "@/collections/Booths";
import { boothSummary, EMPTY_BOOTH_LIST, mediaIdsOf, type MediaMap } from "@/lib/public-booths";
import { loadBoothMedia } from "@/lib/public-booths-media";

export function OPTIONS(request: Request) {
  return preflight(request);
}

const HALLS = new Set<string>(BOOTH_HALLS.map((h) => h.value));

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "exhibition")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "24") || 24));

  const and: Where[] = [{ published: { equals: true } }];

  const hall = url.searchParams.get("hall");
  if (hall && hall !== "all") {
    if (!HALLS.has(hall)) return jsonPublic(request, EMPTY_BOOTH_LIST, 200);
    and.push({ hall: { equals: hall } });
  }

  const articleSlug = url.searchParams.get("article");
  if (articleSlug) {
    const a = await scopedFind({
      payload,
      collection: "articles",
      tenantId: tenant.id,
      where: { and: [{ slug: { equals: articleSlug } }, { workflowStatus: { equals: "published" } }] },
      limit: 1,
      depth: 0,
      select: { slug: true },
    });
    const id = (a.docs[0] as { id?: number | string } | undefined)?.id;
    if (id == null) return jsonPublic(request, EMPTY_BOOTH_LIST, 200);
    and.push({ articles: { in: [id] } });
  }

  const res = await scopedFind({
    payload,
    collection: "booths" as never,
    tenantId: tenant.id,
    where: { and },
    page,
    limit,
    sort: ["name", "id"],
    depth: 0,
  });
  const docs = res.docs as unknown as Array<Record<string, unknown>>;
  const media: MediaMap = await loadBoothMedia(payload, tenant.id, mediaIdsOf(docs, ["logo"]));

  const { docs: _omit, ...envelope } = res;
  void _omit;
  return jsonPublic(request, { ...envelope, docs: docs.map((d) => boothSummary(d, media)) }, 200);
}
