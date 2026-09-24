/**
 * scopedFindMultiTenant — read the SAME collection across several tenants in one
 * call, for the read-only `/api/hub/*` routes (APCGHub P4 / CMS-1).
 *
 * WHY IT LOOPS `scopedFind` INSTEAD OF ONE `tenant: { in: [...] }` QUERY:
 * `src/lib/scoped.ts:9-10` states the rule for this repo — a route handler must
 * not call `payload.find` directly; every machine/public read goes through
 * `scopedFind`, whose whole job is to make the tenant filter impossible to
 * forget. Hand-writing an `in` clause here would mean calling `payload.find`
 * directly and re-implementing that filter, i.e. exactly the omission the rule
 * exists to prevent. So this helper imports `scopedFind` and calls it once per
 * tenant. Nothing in this file constructs a tenant filter of its own.
 *
 * COST, stated rather than assumed: one hub request = N in-process Payload
 * queries (N = number of tenants read, 5 today). They share the process and the
 * DB pool — this is not N network round-trips — but it is still N queries where
 * a single `IN` would be one, and `process/general-plans/active/
 * cms-cost-remediation_09-09-26/` is an ACTIVE programme trying to reduce this
 * repo's read cost. The trade is deliberate (rule-compliance over a
 * micro-optimisation on a low-traffic internal route) and must be re-measured on
 * real traffic rather than declared cheap here.
 *
 * PAGINATION is merge-sorted, not delegated: with N independent result sets there
 * is no way to ask Postgres for "page 3 of the union" through N separate
 * queries, so each tenant is over-fetched to `page * limit` rows, the union is
 * sorted by the requested key, and the requested window is sliced out. That is
 * correct, and it is why `maxOverFetch` exists — deep paging across N tenants
 * would otherwise pull N * page * limit rows into memory.
 */

import type { Payload, Where } from "payload";
import { scopedFind } from "@/lib/scoped";

type CollectionSlug = Parameters<Payload["find"]>[0]["collection"];

/** Internal marker carrying the owning tenant id through the merge. Callers map
 *  it to whatever they want to expose and MUST strip it before serialising. */
/** Default reachable window for offset paging across tenants. Deeper browsing
 *  needs keyset (cursor) pagination — see gap `hub1-deep-browse-needs-keyset`. */
export const HUB_MAX_REACHABLE = 500;

export const HUB_TENANT_ID_KEY = "__hubTenantId" as const;

export interface MultiTenantFindArgs {
  payload: Payload;
  collection: CollectionSlug;
  /** Tenants to read. Already authorised by the caller — this helper does not
   *  check permission, it only fans the query out. */
  tenantIds: (number | string)[];
  where?: Where;
  limit: number;
  page: number;
  /** Sort key(s), Payload syntax (`-publishedAt` or `["-views","-publishedAt","-id"]`).
   *  The SAME list is sent to every per-tenant query and used by the merge, so the
   *  two can never disagree. End the list with `id`/`-id` for a total order. */
  sort?: string | string[];
  /** Locale for localized fields. Hub routes pass `"en"` explicitly. */
  locale?: string;
  depth?: number;
  select?: Parameters<Payload["find"]>[0]["select"];
  /** Hard ceiling on rows pulled PER TENANT, guarding deep paging. */
  maxOverFetch?: number;
}

export interface MultiTenantFindResult<T> {
  docs: T[];
  totalDocs: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  /** Per-tenant totals — lets a caller show "gcv 12 / wad 3" without re-querying. */
  totalsByTenant: { tenantId: number | string; totalDocs: number }[];
  /** True when `totalDocs` exceeds the reachable window (`maxOverFetch`):
   *  rows beyond that global position cannot be served by offset paging. */
  truncated: boolean;
  /** Global positions `< reachable` are servable; `totalPages` is derived from it. */
  reachable: number;
}

/**
 * Thrown when a requested window STARTS at or beyond the reachable limit.
 * Each tenant was cut at its own top-`maxOverFetch`, so only the union's top
 * `maxOverFetch` is guaranteed to be in correct global order; anything past it
 * may be mis-ordered or missing entirely. Returning it — or an empty page — would
 * be a silent lie, so the helper refuses instead. Callers map this to a 4xx.
 */
export class HubPageOutOfRangeError extends Error {
  constructor(readonly maxOverFetch: number) {
    super(
      `requested window starts beyond the reachable limit of ${maxOverFetch} rows across tenants; narrow with ?tenants= or use a filter`,
    );
    this.name = "HubPageOutOfRangeError";
  }
}

/**
 * Build the in-memory merge comparator for one or more sort keys, matching the
 * order Postgres produces for the same keys.
 *
 * WHY THE NULL RULE: `@payloadcms/drizzle` builds ORDER BY with plain
 * `asc()`/`desc()` (buildOrderBy.js — no NULLS FIRST/LAST anywhere), and
 * Postgres puts NULL FIRST under DESC and LAST under ASC. Each per-tenant query
 * is therefore cut at its own top-N in THAT order; if the merge ordered NULLs
 * differently (the CMS-1 version put them last in both directions), a tenant
 * with many NULL rows would return only NULL rows, the merge would push them
 * down, and that tenant's dated rows would be missing from page 1. So: a
 * descending key puts NULL first, an ascending key puts NULL last.
 *
 * WHY MULTIPLE KEYS: Payload silently appends `-createdAt` to the SQL order,
 * which is not unique, and the old merge had no tiebreak at all — the two sides
 * could disagree on ties. Callers pass a list ending in `id` (the primary key),
 * so both sides share one total order.
 *
 * Numbers compare numerically; anything else as strings (`publishedAt` is an
 * ISO timestamp in one fixed format from both DB and Payload, so string order
 * is time order).
 */
export function comparatorFor(sort: string | string[] | undefined) {
  const keys = (Array.isArray(sort) ? sort : [sort ?? "-publishedAt"]).map((k) => ({
    field: k.replace(/^-/, ""),
    desc: k.startsWith("-"),
  }));
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const { field, desc } of keys) {
      const av = a[field];
      const bv = b[field];
      const an = av == null;
      const bn = bv == null;
      if (an && bn) continue;
      if (an) return desc ? -1 : 1;
      if (bn) return desc ? 1 : -1;
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") cmp = av === bv ? 0 : av < bv ? -1 : 1;
      else {
        const as = String(av);
        const bs = String(bv);
        cmp = as === bs ? 0 : as < bs ? -1 : 1;
      }
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return 0;
  };
}

export async function scopedFindMultiTenant<T = Record<string, unknown>>(
  args: MultiTenantFindArgs,
): Promise<MultiTenantFindResult<T>> {
  const {
    payload,
    collection,
    tenantIds,
    where,
    limit,
    page,
    sort = "-publishedAt",
    locale,
    depth,
    select,
    maxOverFetch = HUB_MAX_REACHABLE,
  } = args;

  // The helper guards its own invariant (it does not trust the route to):
  // integer page/limit, and no window may start past the reachable limit.
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`page must be a positive integer, got ${page}`);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  const start = (page - 1) * limit;
  if (start >= maxOverFetch) throw new HubPageOutOfRangeError(maxOverFetch);

  // Never fetch past the reachable limit: rows there could not be served in
  // correct global order anyway.
  const end = Math.min(start + limit, maxOverFetch);
  const perTenant = end;

  const results = await Promise.all(
    tenantIds.map((tenantId) =>
      scopedFind({
        payload,
        collection,
        tenantId,
        where,
        limit: perTenant,
        page: 1,
        sort,
        locale,
        depth,
        select,
      }),
    ),
  );

  const totalsByTenant = results.map((res, i) => ({
    tenantId: tenantIds[i] as number | string,
    totalDocs: res.totalDocs,
  }));
  const totalDocs = totalsByTenant.reduce((sum, t) => sum + t.totalDocs, 0);

  // Stamp the owning tenant id onto each row BEFORE merging. The union loses
  // which query a row came from, and the alternative — asking Payload to
  // populate the `tenant` relationship — would pull the whole Tenants document
  // into the response path, which is precisely the shape that leaked
  // `readTokens` before (`Tenants.ts:15-18,52-54` now denies it via
  // `defaultPopulate`, but a custom `select` can bypass that). An internal id
  // stamp keeps the relationship unpopulated; the route maps it to a bare slug
  // and strips the marker.
  const merged = results
    .flatMap((res, i) =>
      (res.docs as unknown as Record<string, unknown>[]).map((doc) => ({
        ...doc,
        [HUB_TENANT_ID_KEY]: tenantIds[i] as number | string,
      })),
    )
    .sort(comparatorFor(sort));

  // Slice is clipped at `end` (≤ maxOverFetch): the last reachable page is CUT,
  // never padded with rows whose global position is unknown.
  const docs = merged.slice(start, end) as unknown as T[];

  const reachable = Math.min(totalDocs, maxOverFetch);
  const totalPages = Math.ceil(reachable / limit);
  return {
    docs,
    totalDocs,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    totalsByTenant,
    truncated: totalDocs > maxOverFetch,
    reachable,
  };
}
