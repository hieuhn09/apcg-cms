/**
 * GET /api/public/articles/:slug?locale= — single published article by slug for
 * the token's tenant, in the requested (clamped) locale.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "articles")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);

  const result = await scopedFind({
    payload,
    collection: "articles",
    tenantId: tenant.id,
    where: { and: [{ slug: { equals: slug } }, { workflowStatus: { equals: "published" } }] },
    locale,
    limit: 1,
    depth: 2,
  });

  const doc = result.docs[0];
  if (!doc) return jsonPublic(request, { ok: false, status: "not_found" }, 404);
  return jsonPublic(request, { doc }, 200);
}
