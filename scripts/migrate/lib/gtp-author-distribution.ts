/**
 * Byline distribution for the GTP legacy import (plan gtp-mapping-final,
 * Amendment 3, owner decision 14-10-26).
 *
 * Every imported item (articles AND events-awards industry-calendar listings)
 * gets one of the 5 web authors; nothing is credited to "GTP Newsroom" and the
 * legacy bylines are not kept (they were very skewed: 705/569/143/91/...).
 *
 * Pure and deterministic. Hard rules:
 *   - independent of input order (items are sorted by publishedAt, then legacyId);
 *   - final per-author counts differ by at most `maxSpread` (1) over the whole
 *     item set when keepLegacy is false;
 *   - related items stay together where possible: group = first country slug +
 *     calendar quarter of publishedAt; items with no country are singletons that
 *     fill the remaining capacity round-robin by date;
 *   - pillar / sub-section are NOT inputs (owner: never one author per pillar);
 *   - never returns a name outside the pool.
 *
 * Callers compute the map ONCE per run from the COMPLETE planned set, never from
 * the rows still to import, so resumed runs and rollback + re-import agree.
 */

export interface DistributeConfig {
  pool: readonly string[];
  keepLegacy: boolean;
  groupBy: "country" | "none";
  maxSpread: number;
}

export interface AuthorItem {
  legacyId: string;
  slug: string;
  publishedAt: string | null;
  countries: readonly string[];
  legacyByline?: string | null;
  kind: "article" | "event";
}

const byDate = (a: AuthorItem, b: AuthorItem): number => {
  const pa = a.publishedAt ?? "";
  const pb = b.publishedAt ?? "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0;
};

function quarterOf(iso: string | null): string {
  if (!iso) return "nodate";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "nodate";
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Final per-author targets: water-fill the free items onto the lowest counts (ties: pool order). */
function targetsFor(pool: readonly string[], kept: Map<string, number>, free: number): Map<string, number> {
  const t = new Map(pool.map((n) => [n, kept.get(n) ?? 0]));
  for (let i = 0; i < free; i++) {
    let best = pool[0] as string;
    for (const n of pool) if ((t.get(n) as number) < (t.get(best) as number)) best = n;
    t.set(best, (t.get(best) as number) + 1);
  }
  return t;
}

export function assignAuthors(items: readonly AuthorItem[], cfg: DistributeConfig, bylineMap: Readonly<Record<string, string>> = {}): Map<string, string> {
  const pool = [...cfg.pool];
  if (!pool.length) throw new Error("authors.distribute: pool is empty.");
  const out = new Map<string, string>();
  const sorted = [...items].sort(byDate);

  const free: AuthorItem[] = [];
  const kept = new Map<string, number>();
  for (const it of sorted) {
    const b = (it.legacyByline ?? "").replace(/\s+/g, " ").trim();
    const target = cfg.keepLegacy && b ? bylineMap[b] : undefined;
    if (target && pool.includes(target)) {
      out.set(it.legacyId, target);
      kept.set(target, (kept.get(target) ?? 0) + 1);
    } else free.push(it);
  }

  const targets = targetsFor(pool, kept, free.length);
  const remaining = new Map(pool.map((n) => [n, (targets.get(n) as number) - (kept.get(n) ?? 0)]));
  const most = (): string => {
    let best = pool[0] as string;
    for (const n of pool) if ((remaining.get(n) as number) > (remaining.get(best) as number)) best = n;
    return best;
  };
  const give = (it: AuthorItem, n: string) => {
    out.set(it.legacyId, n);
    remaining.set(n, (remaining.get(n) as number) - 1);
  };

  // Groups (country + quarter); items without a country are singletons.
  const groups = new Map<string, AuthorItem[]>();
  const singles: AuthorItem[] = [];
  for (const it of free) {
    const c = cfg.groupBy === "country" ? it.countries[0]?.trim().toLowerCase() : undefined;
    if (!c) {
      singles.push(it);
      continue;
    }
    const k = `${c}|${quarterOf(it.publishedAt)}`;
    (groups.get(k) ?? groups.set(k, []).get(k) as AuthorItem[]).push(it);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [, members] of ordered) {
    let rest = members; // already date-ordered
    while (rest.length) {
      // the author with the most capacity that fits the whole remainder, else spill
      const fits = pool.filter((n) => (remaining.get(n) as number) >= rest.length);
      const n = fits.length ? fits.reduce((b, x) => ((remaining.get(x) as number) > (remaining.get(b) as number) ? x : b)) : most();
      const take = Math.min(rest.length, remaining.get(n) as number);
      for (const it of rest.slice(0, take)) give(it, n);
      rest = rest.slice(take);
    }
  }

  // Singletons: round-robin by date over authors that still have capacity.
  let ptr = 0;
  for (const it of singles) {
    for (let i = 0; i < pool.length; i++) {
      const n = pool[(ptr + i) % pool.length] as string;
      if ((remaining.get(n) as number) > 0) {
        give(it, n);
        ptr = (ptr + i + 1) % pool.length;
        break;
      }
    }
  }
  return out;
}

/** Per-author totals (pool order, zeros included) and spread (max - min). */
export function authorTotals(assign: ReadonlyMap<string, string>, pool: readonly string[]): { totals: Record<string, number>; spread: number } {
  const totals: Record<string, number> = Object.fromEntries(pool.map((n) => [n, 0]));
  for (const n of assign.values()) totals[n] = (totals[n] ?? 0) + 1;
  const v = Object.values(totals);
  return { totals, spread: v.length ? Math.max(...v) - Math.min(...v) : 0 };
}

/** Pillars (given by the caller, AFTER assignment) credited to fewer than 2 distinct authors. Informational. */
export function pillarsUnderTwoAuthors(assign: ReadonlyMap<string, string>, pillarOf: ReadonlyMap<string, string>): string[] {
  const by = new Map<string, Set<string>>();
  for (const [id, n] of assign) {
    const p = pillarOf.get(id);
    if (!p) continue;
    (by.get(p) ?? by.set(p, new Set()).get(p) as Set<string>).add(n);
  }
  return [...by.entries()].filter(([, s]) => s.size < 2).map(([p]) => p).sort();
}
