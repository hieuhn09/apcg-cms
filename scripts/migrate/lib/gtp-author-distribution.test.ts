import { test } from "node:test";
import assert from "node:assert/strict";
import { assignAuthors, authorTotals, pillarsUnderTwoAuthors, type AuthorItem, type DistributeConfig } from "./gtp-author-distribution";

const POOL = ["Daniel Cheong", "Priya Nair", "Marcus Tan", "Natalie Ong", "Yuki Hamada"];
const CFG: DistributeConfig = { pool: POOL, keepLegacy: false, groupBy: "country", maxSpread: 1 };
const COUNTRIES = ["sg", "th", "jp", "vn", "my", "id", ""];

/** Deterministic pseudo-random corpus (LCG), no Math.random. */
function corpus(n: number, seed = 7): AuthorItem[] {
  let s = seed;
  const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, (_, i) => {
    const c = COUNTRIES[Math.floor(r() * COUNTRIES.length)] as string;
    const day = Math.floor(r() * 900);
    return {
      legacyId: `id-${String(i).padStart(5, "0")}`,
      slug: `s-${i}`,
      publishedAt: r() < 0.05 ? null : new Date(Date.UTC(2023, 0, 1) + day * 86400000).toISOString(),
      countries: c ? [c] : [],
      legacyByline: r() < 0.6 ? "Daniel Cheong" : "Simon Ng",
      kind: r() < 0.1 ? "event" : "article",
    } as AuthorItem;
  });
}

test("A3: spread <= 1 for N = 0..13 and larger N (every N mod 5), names only from the pool", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 97, 1637, 1649]) {
    const a = assignAuthors(corpus(n), CFG);
    assert.equal(a.size, n);
    for (const v of a.values()) assert.ok(POOL.includes(v), v);
    const { totals, spread } = authorTotals(a, POOL);
    assert.ok(spread <= 1, `N=${n} spread ${spread} ${JSON.stringify(totals)}`);
    assert.equal(Object.values(totals).reduce((x, y) => x + y, 0), n);
  }
});

test("A3: deterministic and independent of input order", () => {
  const items = corpus(400, 11);
  const a = [...assignAuthors(items, CFG).entries()].sort();
  const b = [...assignAuthors([...items].reverse(), CFG).entries()].sort();
  const shuffled = [...items].sort((x, y) => (x.slug.length - y.slug.length) || (x.slug < y.slug ? 1 : -1));
  const c = [...assignAuthors(shuffled, CFG).entries()].sort();
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("A3: related items (same country + quarter) mostly land on one author", () => {
  const items = corpus(1637, 3);
  const a = assignAuthors(items, CFG);
  const groups = new Map<string, string[]>();
  for (const it of items) {
    if (!it.countries[0] || !it.publishedAt) continue;
    const d = new Date(it.publishedAt);
    const k = `${it.countries[0]}|${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / 3)}`;
    (groups.get(k) ?? groups.set(k, []).get(k) as string[]).push(a.get(it.legacyId) as string);
  }
  let together = 0;
  let total = 0;
  for (const names of groups.values()) {
    const top = Math.max(...POOL.map((p) => names.filter((n) => n === p).length));
    together += top;
    total += names.length;
  }
  assert.ok(together / total >= 0.9, `only ${together}/${total} grouped`);
});

test("A3: not by pillar: each pillar dominated by one country still gets >= 2 authors; no pillar input", () => {
  const pillars = ["news", "destinations", "business-of-travel", "experiences-luxury", "press-room", "events-awards"];
  const items: AuthorItem[] = [];
  const pillarOf = new Map<string, string>();
  pillars.forEach((p, pi) => {
    for (let i = 0; i < 60; i++) {
      const id = `${p}-${String(i).padStart(3, "0")}`;
      items.push({ legacyId: id, slug: id, publishedAt: new Date(Date.UTC(2022, 0, 1) + i * 15 * 86400000).toISOString(), countries: [COUNTRIES[pi] || "sg"], kind: "article" });
      pillarOf.set(id, p);
    }
  });
  const a = assignAuthors(items, CFG);
  assert.deepEqual(pillarsUnderTwoAuthors(a, pillarOf), []);
  assert.ok(authorTotals(a, POOL).spread <= 1);
  // the signature has no pillar parameter (items, config, optional byline map only)
  assert.equal(assignAuthors.length, 2);
});

test("A3: keepLegacy false ignores bylines; keepLegacy true keeps mapped bylines and balances the rest", () => {
  const items = corpus(50, 5);
  const off = assignAuthors(items, CFG, { "Daniel Cheong": "Daniel Cheong" });
  assert.ok(authorTotals(off, POOL).spread <= 1);
  const on = assignAuthors(items, { ...CFG, keepLegacy: true }, { "Daniel Cheong": "Daniel Cheong", "Simon Ng": "Not In Pool" });
  for (const it of items) if (it.legacyByline === "Daniel Cheong") assert.equal(on.get(it.legacyId), "Daniel Cheong");
  for (const v of on.values()) assert.ok(POOL.includes(v));
  const { totals } = authorTotals(on, POOL);
  const others = POOL.filter((n) => n !== "Daniel Cheong").map((n) => totals[n] as number);
  assert.ok(Math.max(...others) - Math.min(...others) <= 1, JSON.stringify(totals));
});

test("A3: empty pool is refused", () => {
  assert.throws(() => assignAuthors(corpus(3), { ...CFG, pool: [] }));
});

test("A5: empty `fixed` gives exactly the first-run plan", () => {
  const items = corpus(500, 5);
  assert.deepEqual([...assignAuthors(items, CFG, {}, new Map()).entries()], [...assignAuthors(items, CFG).entries()]);
});

test("A5: second run keeps the real Central author of existing items and balances only the new ones", () => {
  const all = corpus(1649, 13);
  const first = assignAuthors(all.slice(0, 1600), CFG);
  // Central drifted after run 1 (an editor re-credited some articles): fixed = the REAL author, not the plan.
  const fixed = new Map([...first.entries()].map(([id, n], i) => [id, i % 9 === 0 ? (POOL[0] as string) : n]));
  for (const fresh of [1, 2, 3, 4, 49]) {
    const items = all.slice(0, 1600 + fresh);
    const a = assignAuthors(items, CFG, {}, fixed);
    for (const [id, n] of fixed) assert.equal(a.get(id), n, `existing ${id} keeps its Central author`);
    const totals = authorTotals(a, POOL);
    // best possible spread: water-filling the new items onto the existing counts
    const ex = authorTotals(fixed, POOL).totals;
    const best = [...Array(fresh)].reduce((t: number[]) => {
      const i = t.indexOf(Math.min(...t));
      t[i] = (t[i] as number) + 1;
      return t;
    }, POOL.map((n) => ex[n] as number));
    assert.equal(totals.spread, Math.max(...best) - Math.min(...best), `fresh ${fresh}`);
    const order = [...a.entries()].sort();
    assert.deepEqual([...assignAuthors([...items].reverse(), CFG, {}, new Map([...fixed].reverse())).entries()].sort(), order, "order independent");
  }
});

test("A5: with balanced existing items the overall spread stays <= 1", () => {
  const all = corpus(1700, 21);
  const first = assignAuthors(all.slice(0, 1650), CFG);
  for (const fresh of [1, 2, 5, 50]) {
    const a = assignAuthors(all.slice(0, 1650 + fresh), CFG, {}, first);
    assert.ok(authorTotals(a, POOL).spread <= 1, `fresh ${fresh}`);
    for (const [id, n] of first) assert.equal(a.get(id), n);
  }
});
