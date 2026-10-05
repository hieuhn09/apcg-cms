/**
 * One taxonomy block of `GET /api/hub/taxonomy` (APCGHub P4 / CMS-2 shape, reused
 * by the P5.1 composer kinds). Pure — no I/O.
 *
 * NEVER SILENTLY CUT: the route queries `limit: CAP + 1`; more than CAP rows ⇒
 * the list is cut to CAP and `truncated: true`; `totalDocs` is the true count.
 */

export interface HubBlock<T> {
  items: T[];
  count: number;
  totalDocs: number;
  truncated: boolean;
  /** Only on `cities` when the tenant does not have `citiesMap` (then `items` is empty). */
  disabled?: true;
}

export function hubBlock<T>(
  docs: Record<string, unknown>[],
  totalDocs: number,
  cap: number,
  sanitize: (d: Record<string, unknown>) => T,
): HubBlock<T> {
  const items = docs.slice(0, cap).map(sanitize);
  return { items, count: items.length, totalDocs, truncated: docs.length > cap || totalDocs > cap };
}

/** The block of a feature-disabled kind (`cities` without `citiesMap`). */
export function disabledBlock<T>(): HubBlock<T> {
  return { items: [], count: 0, totalDocs: 0, truncated: false, disabled: true };
}
