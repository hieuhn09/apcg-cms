/**
 * GET /api/public/site?locale= — the token's tenant settings the frontend needs:
 * brand, SEO defaults, contact, socials, languages, enabled features, pillars
 * (for nav). No secrets (tokens/domains/engine config are stripped).
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);

  // Re-fetch with depth so logo/og images resolve, in the requested locale.
  const full = await payload.findByID({ collection: "tenants", id: tenant.id, depth: 1, locale, overrideAccess: true });
  const t = full as Record<string, unknown>;

  const pillars = await scopedFind({ payload, collection: "pillars", tenantId: tenant.id, locale, sort: "order", limit: 100, depth: 0 });

  return jsonPublic(
    request,
    {
      site: {
        name: t.name,
        slug: t.slug,
        defaultLanguage: t.defaultLanguage,
        supportedLanguages: t.supportedLanguages,
        timezone: t.timezone,
        logo: t.logo,
        brandColor: t.brandColor,
        brand: t.brand,
        seo: t.seo,
        contact: t.contact,
        socials: t.socials,
        features: t.features,
      },
      pillars: pillars.docs,
    },
    200,
  );
}
