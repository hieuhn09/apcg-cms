/**
 * GET /api/public/booths/:slug — one published booth (The Beauty Exhibition,
 * AsiaBeautyBrief) for the token's tenant: `{ doc }`, or 404
 * `{ ok:false, status:"not_found" }` (unknown slug, unpublished, or tenant
 * without the `exhibition` feature). Allowlist shape: src/lib/public-booths.ts.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";
import { boothDetail, mediaIdsOf } from "@/lib/public-booths";
import { loadBoothMedia } from "@/lib/public-booths-media";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "exhibition")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const res = await scopedFind({
    payload,
    collection: "booths" as never,
    tenantId: tenant.id,
    where: { and: [{ slug: { equals: slug } }, { published: { equals: true } }] },
    limit: 1,
    depth: 0,
  });
  const doc = res.docs[0] as unknown as Record<string, unknown> | undefined;
  if (!doc) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const media = await loadBoothMedia(payload, tenant.id, mediaIdsOf([doc], ["logo", "catalog"]));
  return jsonPublic(request, { doc: boothDetail(doc, media) }, 200);
}
