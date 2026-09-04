/**
 * GET /api/public/:module?locale= — feature-gated content modules for the token's
 * tenant. A disabled feature returns 404 (indistinguishable from non-existent),
 * never an empty 200. Static sibling routes (articles, menus, site, preview)
 * take precedence over this dynamic one.
 *
 *   podcasts | newsletters | corrections | wire | market | dashboards | sponsors
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";
import type { FeatureKey } from "@/lib/constants";
import type { Where } from "payload";

type CollSlug = Parameters<typeof scopedFind>[0]["collection"];

const MODULES: Record<
  string,
  { feature: FeatureKey; collections: { slug: CollSlug; sort: string; key: string; depth?: number; where?: () => Where }[] }
> = {
  podcasts: { feature: "podcasts", collections: [{ slug: "podcasts", sort: "-publishedAt", key: "podcasts" }] },
  newsletters: { feature: "newsletters", collections: [{ slug: "newsletters", sort: "order", key: "newsletters" }] },
  corrections: { feature: "corrections", collections: [{ slug: "corrections", sort: "-correctionDate", key: "corrections" }] },
  wire: {
    feature: "wireDrops",
    collections: [
      {
        slug: "wireDrops",
        sort: "-publishedAt",
        key: "wireDrops",
        // Expired drops auto-hide from the public wire.
        where: () => ({ or: [{ expiresAt: { exists: false } }, { expiresAt: { greater_than: new Date().toISOString() } }] }),
      },
    ],
  },
  market: {
    feature: "marketData",
    collections: [
      { slug: "marketSnapshots", sort: "order", key: "marketSnapshots" },
      { slug: "fxRates", sort: "order", key: "fxRates" },
      // FEATURE_COLLECTIONS in lib/constants.ts already counts trendingBlocks as
      // part of marketData; it was simply missing here, so the collection was
      // gated behind the feature yet unreachable through the public API.
      // brief-asia renders it on the homepage, so the omission would have
      // surfaced as an empty band rather than an error.
      { slug: "trendingBlocks", sort: "order", key: "trendingBlocks" },
    ],
  },
  dashboards: {
    feature: "dashboards",
    collections: [
      { slug: "fundingRows", sort: "order", key: "fundingRows" },
      { slug: "aiLeaderboardRows", sort: "rank", key: "aiLeaderboardRows" },
    ],
  },
  // Sponsor placements. The reader picks the slot it wants client-side
  // (`?slot=` narrows it server-side); rows outside their startsAt/endsAt
  // window are dropped here so a lapsed booking can never render.
  sponsors: {
    feature: "sponsorSlots",
    collections: [
      {
        slug: "sponsorSlots",
        sort: "-updatedAt",
        key: "sponsorSlots",
        // depth 2: the reader renders the sponsored article as a full card, so
        // `article.pillar` / `article.author` / `article.heroImage` must be
        // populated objects, not bare ids. At depth 1 `article` resolves but its
        // own relationships stay ids and the card loses its pillar tag + byline.
        depth: 2,
        where: () => {
          const now = new Date().toISOString();
          return {
            and: [
              { or: [{ startsAt: { exists: false } }, { startsAt: { less_than_equal: now } }] },
              { or: [{ endsAt: { exists: false } }, { endsAt: { greater_than_equal: now } }] },
            ],
          };
        },
      },
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

  // `?slot=` narrows the sponsors module server-side. Ignored elsewhere.
  const slot = url.searchParams.get("slot");

  const data: Record<string, unknown> = {};
  for (const c of def.collections) {
    let where = c.where?.();
    if (module === "sponsors" && slot) {
      where = where ? { and: [where, { slot: { equals: slot } }] } : { slot: { equals: slot } };
    }
    const res = await scopedFind({
      payload,
      collection: c.slug,
      tenantId: tenant.id,
      locale,
      sort: c.sort,
      limit: 100,
      depth: c.depth ?? 1,
      where,
    });
    data[c.key] = res.docs;
  }

  // Dashboard methodology/disclaimer copy lives on the TENANT, not in a
  // collection (it is one blob per site), so it rides along with the rows the
  // page renders it under — one fetch, not two.
  if (module === "dashboards") {
    const t = tenant as unknown as { dashboards?: unknown };
    data.methodology = t.dashboards ?? null;
  }

  return jsonPublic(request, { data }, 200);
}
