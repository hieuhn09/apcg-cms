/**
 * Hub article id — the ONE check for "can this URL segment be an article id?"
 * used by both hub article routes (APCGHub P4 / CMS-4b):
 *
 *   GET  /api/hub/articles/{id}?tenant=   (CMS-4 read)
 *   POST /api/hub/articles/{id}/status    (CMS-3 write)
 *
 * `articles.id` is a Postgres `int4` serial (max 2147483647). The routes used to
 * check SHAPE only (`^[1-9][0-9]{0,15}$`), so an id like 2147483648 reached
 * Postgres, which raised, and the route answered 500 `internal_error` + an
 * `integration_error` log row (gap `hub-id-over-int4-returns-500`). Checking
 * RANGE here as well means every such id gets the route's ordinary 404
 * `not_found` body — the same one a missing, malformed or other-tenant id gets —
 * and never reaches the database.
 *
 * Any future route that takes a raw numeric Postgres id from a request should
 * reuse this instead of writing its own regex (gap
 * `hub-int4-bound-not-generalized-beyond-hub-routes`).
 *
 * Pure: no I/O, so it can be checked in isolation (`hub-probe.ts --check5 --unit-only`).
 */

/** Largest value a Postgres `int4` column can hold. */
export const PG_INT4_MAX = 2147483647;

/**
 * Shape: ASCII digits only, no sign, no leading zero, no whitespace. Length is
 * deliberately NOT capped here — the numeric comparison below is the one range
 * guard (a 23-digit string parses to ~1e22, a huge one to Infinity: both > max).
 */
const SHAPE = /^[1-9][0-9]*$/;

export function isHubArticleId(id: string): boolean {
  return SHAPE.test(id) && Number(id) <= PG_INT4_MAX;
}
