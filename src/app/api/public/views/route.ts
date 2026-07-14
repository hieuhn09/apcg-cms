/**
 * POST /api/public/views  body: { slug } — increment an article's view counter
 * for the token's tenant. Read-token authed (the token implies the tenant).
 *
 * The increment is a RAW SQL UPDATE on `articles.views` on purpose: going through
 * the Local API would fire the article hooks (version bump, activity log, revalidate
 * webhook, translation enqueue) on every page view. A view counter must not do any
 * of that, so we bump the column directly and skip the hooks entirely.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "articles")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  // Accept either { id } (fast path — the frontend already has the central id) or
  // { slug } (resolved to an id). Both are tenant-scoped by the UPDATE below.
  let body: { id?: number | string; slug?: string } = {};
  try {
    body = (await request.json()) as { id?: number | string; slug?: string };
  } catch {
    /* fall through to bad_request */
  }

  let articleId = body.id;
  if (articleId == null && typeof body.slug === "string" && body.slug) {
    const res = await scopedFind({
      payload,
      collection: "articles",
      tenantId: tenant.id,
      where: { and: [{ slug: { equals: body.slug } }, { workflowStatus: { equals: "published" } }] },
      limit: 1,
      depth: 0,
    });
    articleId = (res.docs[0] as { id?: number | string } | undefined)?.id;
  }
  if (articleId == null) return jsonPublic(request, { ok: false, status: "bad_request" }, 400);

  const pool = (
    payload.db as unknown as {
      pool?: { query: (q: string, p: unknown[]) => Promise<{ rows: { views: number }[] }> };
    }
  ).pool;
  if (!pool) return jsonPublic(request, { ok: false, status: "unavailable" }, 503);

  // Raw UPDATE (tenant-scoped) — bypasses the article hooks entirely.
  const out = await pool.query(
    `UPDATE "articles" SET "views" = COALESCE("views", 0) + 1 WHERE "id" = $1 AND "tenant_id" = $2 RETURNING "views"`,
    [articleId, tenant.id],
  );
  if (out.rows.length === 0) return jsonPublic(request, { ok: false, status: "not_found" }, 404);
  return jsonPublic(request, { ok: true, views: out.rows[0]?.views }, 200);
}
