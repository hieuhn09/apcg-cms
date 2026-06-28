/**
 * GET /api/public/:module?locale= — feature-gated content modules for the token's
 * tenant. A disabled feature returns 404 (indistinguishable from non-existent),
 * never an empty 200. Static sibling routes (articles, menus, site, preview)
 * take precedence over this dynamic one.
 *
 *   podcasts | newsletters | corrections | wire | market
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";
import type { FeatureKey } from "@/lib/constants";

type CollSlug = Parameters<typeof scopedFind>[0]["collection"];

const MODULES: Record<
  string,
  { feature: FeatureKey; collections: { slug: CollSlug; sort: string; key: string }[] }
> = {
  podcasts: { feature: "podcasts", collections: [{ slug: "podcasts", sort: "-publishedAt", key: "podcasts" }] },
  newsletters: { feature: "newsletters", collections: [{ slug: "newsletters", sort: "order", key: "newsletters" }] },
  corrections: { feature: "corrections", collections: [{ slug: "corrections", sort: "-correctionDate", key: "corrections" }] },
  wire: { feature: "wireDrops", collections: [{ slug: "wireDrops", sort: "-publishedAt", key: "wireDrops" }] },
  market: {
    feature: "marketData",
    collections: [
      { slug: "marketSnapshots", sort: "order", key: "marketSnapshots" },
      { slug: "fxRates", sort: "order", key: "fxRates" },
    ],
  },
};

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
): Promise<Response> {
  const { module } = await params;
  const def = MODULES[module];
  if (!def) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, def.feature)) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);

  const data: Record<string, unknown> = {};
  for (const c of def.collections) {
    const res = await scopedFind({ payload, collection: c.slug, tenantId: tenant.id, locale, sort: c.sort, limit: 100, depth: 1 });
    data[c.key] = res.docs;
  }
  return jsonPublic(request, { data }, 200);
}
