/**
 * GET /api/public/tags?locale=&minCount=&limit= — the token's tenant's tags with
 * how many PUBLISHED articles use each one.
 *
 * Built for tag chips: a frontend shows a chip only when a tag has at least
 * `minCount` articles, without paging the whole article list.
 *
 * Rules:
 *   - Tenant comes ONLY from the read token (no tenant parameter). The SQL also
 *     filters by tenant on BOTH the article and the tag side, so a corrupted
 *     cross-tenant relationship row cannot be counted or leak a foreign tag.
 *   - Visibility is `workflowStatus === "published"` only, the same predicate
 *     as /api/public/articles (`_status` is deliberately not used; see
 *     src/lib/scoped.ts).
 *   - Raw SQL (one aggregate statement through Payload's own pool) because
 *     Payload's Local API has no group-by: counting per tag through `find`
 *     would be N+1 or pull the whole archive.
 *   - Bad query values fall back to defaults (never 400): `minCount` default 1,
 *     clamp [1,1000]; `limit` default 500, hard cap 2000. `totalDocs` is the
 *     number of matching tags before the cap, so a caller can detect truncation.
 *   - Gated on `features.articles` (tags are article taxonomy), 404 when off.
 *
 * Response: `{ docs: [{ slug, title, count }], totalDocs }`, ordered
 * count desc, slug asc, id asc.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";
import { buildTagCountQuery, mapTagRows, parseLimit, parseMinCount, pgErrorCode, rowsOrThrow } from "@/lib/public-tags";

type RawDb = { drizzle: { execute: (q: unknown) => Promise<unknown> } };

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "articles")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const supported = supportedLanguages(tenant);
  const locale = clampLocale(url.searchParams.get("locale"), supported, tenant.defaultLanguage);
  const defaultLocale = clampLocale(tenant.defaultLanguage, supported, "en");
  const minCount = parseMinCount(url.searchParams.get("minCount"));
  const limit = parseLimit(url.searchParams.get("limit"));

  try {
    const db = (payload.db as unknown as RawDb).drizzle;
    const res = await db.execute(buildTagCountQuery({ tenantId: tenant.id, minCount, limit, locale, defaultLocale }));
    return jsonPublic(request, mapTagRows(rowsOrThrow(res)), 200);
  } catch (err) {
    // Error name + Postgres code only: never the message, SQL, params, tenant or token.
    const name = err instanceof Error ? err.name : typeof err;
    console.error("[public/tags] tag count query failed", { name, code: pgErrorCode(err) ?? null });
    return jsonPublic(request, { ok: false, status: "internal_error" }, 500);
  }
}
