/**
 * Helpers for GET /api/public/tags (per-tenant tag usage counts).
 *
 * Kept separate from the route so the parsing, SQL shape and row mapping are
 * small, pure and easy to read. The route only wires auth, gate and response.
 *
 * Rules (plan gtp-public-tags-route_PLAN_21-10-26):
 *   - counts only PUBLISHED articles (`workflow_status = 'published'`, never
 *     `_status`, same visibility predicate as /api/public/articles);
 *   - tenant isolation is enforced TWICE (article side and tag side), so a
 *     corrupted cross-tenant relationship row can neither be counted nor leak
 *     another tenant's tag;
 *   - `count(DISTINCT parent_id)` so a duplicated relationship row cannot
 *     inflate a count;
 *   - every value is a bound parameter; `'tags'` and `'published'` are
 *     literals (an enum column is never compared to a bound text value).
 */
import { sql } from "@payloadcms/db-postgres";

export const MIN_COUNT_DEFAULT = 1;
export const MIN_COUNT_MAX = 1000;
export const LIMIT_DEFAULT = 500;
export const LIMIT_MAX = 2000;

/** null/blank -> null; non-finite -> null; otherwise Math.floor(Number(raw)). */
function parseIntLenient(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

/** `minCount`: default 1, clamp [1, 1000]. Never throws, never 400s. */
export function parseMinCount(raw: string | null): number {
  const n = parseIntLenient(raw);
  if (n === null) return MIN_COUNT_DEFAULT;
  return Math.min(MIN_COUNT_MAX, Math.max(1, n));
}

/** `limit`: default 500; floored value < 1 -> 500; else clamp [1, 2000]. */
export function parseLimit(raw: string | null): number {
  const n = parseIntLenient(raw);
  if (n === null || n < 1) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, n);
}

export interface TagCountQueryInput {
  tenantId: number | string;
  minCount: number;
  limit: number;
  locale: string;
  defaultLocale: string;
}

/** One aggregate statement: tag usage counts for one tenant's published articles. */
export function buildTagCountQuery(input: TagCountQueryInput) {
  const { tenantId, minCount, limit, locale, defaultLocale } = input;
  return sql`
    SELECT t.slug, COALESCE(l.title, d.title) AS title, c.cnt, count(*) OVER () AS total
    FROM (
      SELECT r.tags_id, count(DISTINCT r.parent_id) AS cnt
      FROM articles_rels r
      JOIN articles a ON a.id = r.parent_id
      WHERE r.path = 'tags' AND r.tags_id IS NOT NULL
        AND a.tenant_id = ${tenantId} AND a.workflow_status = 'published'
      GROUP BY r.tags_id
      HAVING count(DISTINCT r.parent_id) >= ${minCount}
    ) c
    JOIN tags t ON t.id = c.tags_id AND t.tenant_id = ${tenantId}
    LEFT JOIN tags_locales l ON l._parent_id = t.id AND l._locale = ${locale}::"_locales"
    LEFT JOIN tags_locales d ON d._parent_id = t.id AND d._locale = ${defaultLocale}::"_locales"
    ORDER BY c.cnt DESC, t.slug ASC, t.id ASC
    LIMIT ${limit}
  `;
}

export interface PublicTag {
  slug: string;
  title: string;
  count: number;
}

/** Map raw rows to the response body. Missing `rows` = empty result. */
export function mapTagRows(rows: Record<string, unknown>[] | undefined | null): { docs: PublicTag[]; totalDocs: number } {
  const list = rows ?? [];
  const docs = list.map((r) => {
    const slug = String(r.slug ?? "");
    const title = typeof r.title === "string" && r.title !== "" ? r.title : slug;
    return { slug, title, count: Number(r.cnt) };
  });
  const totalDocs = list.length > 0 ? Number(list[0]?.total) : 0;
  return { docs, totalDocs };
}
