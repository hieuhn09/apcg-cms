import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHubTagUsageQuery, compareByUsage, mapHubTagRows, usesOf } from "./hub-tags-usage";
import { hubBlock } from "./hub-taxonomy-blocks";
import { sanitizeHubTag } from "./hub-sanitize";

test("usesOf: bigint strings, numbers, junk", () => {
  assert.equal(usesOf("12"), 12);
  assert.equal(usesOf(3), 3);
  assert.equal(usesOf(-1), 0);
  assert.equal(usesOf("x"), 0);
  assert.equal(usesOf(null), 0);
  assert.equal(usesOf(""), 0);
});

test("mapHubTagRows orders uses desc, then slug, then id", () => {
  const { docs, totalDocs } = mapHubTagRows([
    { id: 5, slug: "b", title: "B", uses: "2", total: "4" },
    { id: 2, slug: "a", title: "A", uses: "0", total: "4" },
    { id: 9, slug: "z", title: "Z", uses: "7", total: "4" },
    { id: 1, slug: "b", title: "B1", uses: "2", total: "4" },
  ]);
  assert.deepEqual(docs.map((d) => d.id), [9, 1, 5, 2]);
  assert.equal(totalDocs, 4);
});

test("empty rows", () => {
  assert.deepEqual(mapHubTagRows(undefined), { docs: [], totalDocs: 0 });
});

test("truncation keeps the most used", () => {
  const rows = [
    { id: 1, slug: "aaa", title: null, uses: "0", total: "3" },
    { id: 2, slug: "zzz", title: null, uses: "9", total: "3" },
    { id: 3, slug: "mmm", title: null, uses: "4", total: "3" },
  ];
  const { docs, totalDocs } = mapHubTagRows(rows);
  const b = hubBlock(docs, totalDocs, 2, sanitizeHubTag);
  assert.deepEqual(b.items.map((t) => t.slug), ["zzz", "mmm"]);
  assert.equal(b.truncated, true);
  assert.equal(b.items[0]?.uses, 9);
});

test("sanitizeHubTag keeps only a non-negative integer uses", () => {
  assert.deepEqual(sanitizeHubTag({ id: 1, slug: "a", title: "A", uses: 3 }), { id: 1, slug: "a", title: "A", uses: 3 });
  assert.equal("uses" in sanitizeHubTag({ id: 1, slug: "a", title: "A" }), false);
  assert.equal("uses" in sanitizeHubTag({ id: 1, slug: "a", title: "A", uses: -2 }), false);
  assert.equal("uses" in sanitizeHubTag({ id: 1, slug: "a", title: "A", uses: 1.5 }), false);
  assert.equal("uses" in sanitizeHubTag({ id: 1, slug: "a", title: "A", uses: "4" }), false);
  assert.equal("secret" in sanitizeHubTag({ id: 1, slug: "a", title: "A", secret: "x" }), false);
});

test("compareByUsage tie-break by id", () => {
  assert.ok(compareByUsage({ uses: 1, slug: "a", id: 1 }, { uses: 1, slug: "a", id: 2 }) < 0);
});

test("query: one statement, tenant bound twice, ordered by usage", () => {
  const q = buildHubTagUsageQuery(7, 3001) as unknown as { queryChunks: unknown[] };
  const text = JSON.stringify(q.queryChunks);
  assert.match(text, /ORDER BY COALESCE\(c\.cnt, 0\) DESC, t\.slug ASC, t\.id ASC/);
  assert.match(text, /a\.tenant_id = /);
  assert.match(text, /WHERE t\.tenant_id = /);
});
