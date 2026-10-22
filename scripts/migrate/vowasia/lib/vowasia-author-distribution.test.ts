import { test } from "node:test";
import assert from "node:assert/strict";
import { VOWASIA_AUTHORS } from "../../../lib/vowasia-taxonomy";
import { POOL, assertAuthorsPresent, assignAuthors, authorTotals } from "./vowasia-author-distribution";

const item = (legacyId: string, pillar: string, createdAt: string | null) => ({ legacyId, pillar, createdAt });

test("pool is the 6 VowAsia authors in rank order", () => {
  assert.deepEqual(POOL, [...VOWASIA_AUTHORS].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((a) => a.name));
  assert.equal(POOL.length, 6);
});

test("order by (created_at, id) inside each pillar, independent of input order", () => {
  const items = [item("b", "style", "2026-01-02T00:00:00Z"), item("a", "style", "2026-01-02T00:00:00Z"), item("c", "style", "2026-01-01T00:00:00Z"), item("d", "style", null)];
  const m1 = assignAuthors(items);
  const m2 = assignAuthors([...items].reverse());
  assert.deepEqual([...m1.entries()].sort(), [...m2.entries()].sort());
  // d (null -> earliest), c, a, b
  assert.equal(m1.get("d"), POOL[0]);
  assert.equal(m1.get("c"), POOL[1]);
  assert.equal(m1.get("a"), POOL[2]);
  assert.equal(m1.get("b"), POOL[3]);
});

test("should keep author spread within 1 per pillar on the full set", () => {
  const pillars = ["wedding-business", "venues", "style", "destination-weddings", "planning"];
  const sizes = [149, 93, 70, 50, 8];
  const items = pillars.flatMap((p, pi) => Array.from({ length: sizes[pi] as number }, (_, i) => item(`${p}-${i}`, p, `2025-0${(i % 9) + 1}-01T00:00:00Z`)));
  const m = assignAuthors(items);
  for (const p of pillars) {
    const t = authorTotals(m, items.filter((x) => x.pillar === p));
    assert.ok(t.spread <= 1, `${p} spread ${t.spread}`);
  }
  assert.ok(authorTotals(m, items).spread <= 1, "full set spread");
  // two runs (A = first 50 by order, B = rest) see the same plan because it is computed on the full set
  const again = assignAuthors([...items].reverse());
  for (const it of items) assert.equal(again.get(it.legacyId), m.get(it.legacyId));
});

test("missing author -> throw (the importer never creates authors)", () => {
  assert.doesNotThrow(() => assertAuthorsPresent(new Set(POOL)));
  assert.throws(() => assertAuthorsPresent(new Set(POOL.slice(1))), /missing in Central/);
});
