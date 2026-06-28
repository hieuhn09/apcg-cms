/**
 * GET /api/public/preview?token=&locale= — returns the DRAFT of an article for a
 * valid signed preview token. The token carries {tenant slug, slug, exp}. Used by
 * a frontend's draft-mode /preview route. No read token needed — the signed
 * preview token is the authorization.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { verifySigned } from "@/lib/crypto";
import { findTenantBySlug, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";
import { jsonPublic, preflight } from "@/lib/public";

export function OPTIONS(request: Request) {
  return preflight(request);
}

interface PreviewClaims {
  [key: string]: unknown;
  tenant: string;
  slug: string;
  draft: boolean;
  exp: number;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return jsonPublic(request, { ok: false, status: "bad_request" }, 400);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = verifySigned<PreviewClaims>(token, nowSeconds);
  if (!claims) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);

  const payload = await getPayload({ config });
  const tenant = await findTenantBySlug(payload, claims.tenant);
  if (!tenant) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);

  const result = await payload.find({
    collection: "articles",
    where: { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: claims.slug } }] },
    draft: true, // return the latest draft version
    locale,
    limit: 1,
    depth: 2,
    overrideAccess: true,
  });

  const doc = result.docs[0];
  if (!doc) return jsonPublic(request, { ok: false, status: "not_found" }, 404);
  return jsonPublic(request, { doc, preview: true }, 200);
}
