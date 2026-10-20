import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_SLUGS, limitPlan, planSlugs } from "./vowasia-slug-plan";

const it = (legacyId: string, slug: string, createdAt: string | null = "2026-01-01T00:00:00Z") => ({ legacyId, slug, createdAt });

test("keep slug; deterministic order by (created_at, id)", () => {
  const p = planSlugs([it("2", "b-post", "2026-01-02T00:00:00Z"), it("1", "a-post", "2026-01-02T00:00:00Z"), it("3", "c-post", "2026-01-01T00:00:00Z")], []);
  assert.deepEqual(p.plan.map((x) => x.slug), ["c-post", "a-post", "b-post"]);
  assert.deepEqual(p.rejects, []);
});

test("should reject slug page and a clash with a non-marker article", () => {
  assert.ok(RESERVED_SLUGS.includes("page"));
  const p = planSlugs([it("1", "page"), it("2", "taken"), it("3", "ours"), it("4", "fine")], [
    { id: 10, slug: "taken", marker: false },
    { id: 11, slug: "ours", marker: true },
  ]);
  assert.deepEqual(p.rejects.map((r) => [r.legacyId, r.reason]).sort(), [["1", "slugReserved"], ["2", "slugClash"]]);
  assert.deepEqual(p.existing.map((e) => [e.legacyId, e.articleId]), [["3", 11]]);
  assert.deepEqual(p.plan.map((x) => x.legacyId), ["4"]);
});

test("unsafe and duplicate slugs are rejected (later one), never renamed", () => {
  const p = planSlugs([it("1", "Bad Slug!"), it("2", "dup", "2026-01-01T00:00:00Z"), it("3", "dup", "2026-01-02T00:00:00Z"), it("4", "")], []);
  assert.deepEqual(p.rejects.map((r) => [r.legacyId, r.reason]).sort(), [["1", "slugUnsafe"], ["3", "slugDuplicate"], ["4", "slugUnsafe"]]);
  assert.deepEqual(p.plan.map((x) => x.slug), ["dup"]);
});

test("deterministic --limit order", () => {
  const items = Array.from({ length: 10 }, (_, i) => it(String(i), `s-${i}`, `2026-01-${String(10 - i).padStart(2, "0")}T00:00:00Z`));
  const p = planSlugs(items, []);
  const a = limitPlan(p.plan, 3).map((x) => x.legacyId);
  const b = limitPlan(planSlugs([...items].reverse(), []).plan, 3).map((x) => x.legacyId);
  assert.deepEqual(a, ["9", "8", "7"]);
  assert.deepEqual(a, b);
  assert.equal(limitPlan(p.plan, undefined).length, 10);
});
