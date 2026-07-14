/**
 * GET /api/public/cities?locale=&slug=&region= — the tenant's city directory
 * (WTB "The Map" / /place pages). Feature-gated on `citiesMap` (404 when off, e.g.
 * for Brief Asia / DTW). `slug` returns a single city; `region` filters; default
 * returns all, sorted by name. Response: `{ data: { cities: [...] } }`.
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
  if (!featureEnabled(tenant, "citiesMap")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);
  const slug = url.searchParams.get("slug");
  const region = url.searchParams.get("region");

  const and: Where[] = [];
  if (slug) and.push({ slug: { equals: slug } });
  if (region && region !== "all") and.push({ region: { equals: region } });

  const res = await scopedFind({
    payload,
    collection: "cities",
    tenantId: tenant.id,
    locale,
    where: and.length ? { and } : undefined,
    sort: "name",
    limit: slug ? 1 : 200,
    depth: 0,
  });

  return jsonPublic(request, { data: { cities: res.docs } }, 200);
}
