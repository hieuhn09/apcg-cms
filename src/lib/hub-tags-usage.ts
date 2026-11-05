/**
 * Hub taxonomy `tags` block ordered by usage (owner request 05-11-26: the
 * composer's tag suggestions must show the most used tags first, not A→Z).
 *
 * ONE aggregate statement per tenant (no N+1):
 *   - `uses` = number of DISTINCT articles of the tenant referencing the tag,
 *     ANY workflow status (drafts included: an editor wants the tags the desk
 *     actually uses, not only what is live). Tenant isolation is enforced on
 *     both the article side and the tag side, like `public-tags.ts`;
 *   - order: uses DESC, slug ASC, id ASC — so when the list is cut at the cap
 *     the MOST used tags are kept (the route asks `cap + 1` rows; `total` is
 *     the true tag count of the tenant, via a window count);
 *   - title is the `en` locale row (the route answers `locale: "en"`).
 * Every value is a bound parameter; `'tags'` and `'en'` are literals.
 */
import { sql } from "@payloadcms/db-postgres";

export function buildHubTagUsageQuery(tenantId: number | string, limit: number) {
  return sql`
    SELECT t.id, t.slug, l.title, COALESCE(c.cnt, 0) AS uses, count(*) OVER () AS total
    FROM tags t
    LEFT JOIN (
      SELECT r.tags_id, count(DISTINCT r.parent_id) AS cnt
      FROM articles_rels r
      JOIN articles a ON a.id = r.parent_id
      WHERE r.path = 'tags' AND r.tags_id IS NOT NULL AND a.tenant_id = ${tenantId}
      GROUP BY r.tags_id
    ) c ON c.tags_id = t.id
    LEFT JOIN tags_locales l ON l._parent_id = t.id AND l._locale = 'en'
    WHERE t.tenant_id = ${tenantId}
    ORDER BY COALESCE(c.cnt, 0) DESC, t.slug ASC, t.id ASC
    LIMIT ${limit}
  `;
}

/** Non-negative integer or 0 (bigint counts arrive as strings from pg). */
export function usesOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Raw rows -> docs for `hubBlock` (+ true total). Re-sorts defensively with the
 * same key as the SQL so the order contract holds even if a driver reorders.
 */
export function mapHubTagRows(rows: Record<string, unknown>[] | null | undefined): {
  docs: Record<string, unknown>[];
  totalDocs: number;
} {
  const list = rows ?? [];
  const docs = list.map((r) => ({ id: r.id, slug: r.slug, title: r.title, uses: usesOf(r.uses) }));
  docs.sort(compareByUsage);
  const totalDocs = list.length > 0 ? usesOf(list[0]?.total) : 0;
  return { docs, totalDocs };
}

export function compareByUsage(
  a: { uses: number; slug: unknown; id: unknown },
  b: { uses: number; slug: unknown; id: unknown },
): number {
  if (a.uses !== b.uses) return b.uses - a.uses;
  const as = String(a.slug ?? "");
  const bs = String(b.slug ?? "");
  if (as !== bs) return as < bs ? -1 : 1;
  return Number(a.id) - Number(b.id);
}
