/**
 * Byline distribution of the VowAsia legacy import (Amendment 3 Q8, Amendment 4 B-4). Pure.
 *
 * Round-robin over the 6 VowAsia authors (rank order of scripts/lib/vowasia-taxonomy.ts).
 * Items are grouped by pillar (C8 order, then any other pillar by name) and ordered inside a
 * pillar by (created_at, legacy id); ONE running counter continues across pillars, so every
 * pillar and the full set differ by at most 1 between authors. The plan is computed on the
 * FULL importable set, never on the rows of one run, so run A and run B agree.
 */
import { VOWASIA_AUTHORS } from "../../../lib/vowasia-taxonomy";
import { C8_PILLARS } from "./vowasia-mapping";

export const POOL: readonly string[] = Object.freeze([...VOWASIA_AUTHORS].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((a) => a.name));

export interface AuthorItem {
  legacyId: string;
  pillar: string;
  createdAt: string | null;
}

export const orderKey = (a: { createdAt: string | null; legacyId: string }, b: { createdAt: string | null; legacyId: string }): number => {
  const ca = a.createdAt ?? "";
  const cb = b.createdAt ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0;
};

export function assignAuthors(items: readonly AuthorItem[], pool: readonly string[] = POOL): Map<string, string> {
  const known = C8_PILLARS as readonly string[];
  const pillars = [...new Set(items.map((i) => i.pillar))].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out = new Map<string, string>();
  let n = 0;
  for (const p of pillars) {
    for (const it of items.filter((x) => x.pillar === p).sort(orderKey)) out.set(it.legacyId, pool[n++ % pool.length] as string);
  }
  return out;
}

/** Totals per author over the given items and the spread (max - min over the whole pool). */
export function authorTotals(assign: ReadonlyMap<string, string>, items: readonly { legacyId: string }[], pool: readonly string[] = POOL): { totals: Record<string, number>; spread: number } {
  const totals: Record<string, number> = Object.fromEntries(pool.map((n) => [n, 0]));
  for (const it of items) {
    const a = assign.get(it.legacyId);
    if (a !== undefined) totals[a] = (totals[a] ?? 0) + 1;
  }
  const v = Object.values(totals);
  return { totals, spread: v.length ? Math.max(...v) - Math.min(...v) : 0 };
}

/** Throws when any pool author is missing in Central (the importer never creates authors). */
export function assertAuthorsPresent(present: ReadonlySet<string>, pool: readonly string[] = POOL): void {
  const missing = pool.filter((n) => !present.has(n));
  if (missing.length) throw new Error(`import: author(s) missing in Central tenant vowasia: ${missing.join(", ")} (the importer never creates authors).`);
}
