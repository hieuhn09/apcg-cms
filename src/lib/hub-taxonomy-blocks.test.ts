/**
 * Unit tests for `markBlockedPillars` (./hub-taxonomy-blocks, hub docx import phase A,
 * PA-11 / AC8) and the route's pillar key set. Node's built-in runner; no DB.
 *
 *   npm run test:hub-direct-upload
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ENGINE_BLOCKED_PILLARS } from "./constants";
import { sanitizeHubPillar } from "./hub-sanitize";
import { hubBlock, markBlockedPillars } from "./hub-taxonomy-blocks";

const pillar = (id: number, slug: string | null) => sanitizeHubPillar({ id, slug, title: `T${id}`, order: id });

describe("markBlockedPillars (PA-11)", () => {
  it("every tenant in ENGINE_BLOCKED_PILLARS: listed pillars true, others false", () => {
    for (const [tenant, blocked] of Object.entries(ENGINE_BLOCKED_PILLARS)) {
      const items = [...blocked.map((s, i) => pillar(i + 1, s)), pillar(100, "plain-pillar")];
      const out = markBlockedPillars(items, tenant);
      assert.deepEqual(out.map((p) => [p.slug, p.blocked]), [...blocked.map((s) => [s, true]), ["plain-pillar", false]], tenant);
    }
  });
  it("gcv: pressroom and exclusive blocked; wad: pressroom (OP-A5 expectation)", () => {
    const gcv = markBlockedPillars([pillar(1, "pressroom"), pillar(2, "exclusive"), pillar(3, "travel")], "gcv");
    assert.deepEqual(gcv.map((p) => p.blocked), [true, true, false]);
    const wad = markBlockedPillars([pillar(1, "pressroom"), pillar(2, "exclusive")], "wad");
    assert.deepEqual(wad.map((p) => p.blocked), [true, false]);
  });
  it("tenant not listed ⇒ all false; null slug ⇒ false; case/space-insensitive like the engine gate", () => {
    assert.deepEqual(markBlockedPillars([pillar(1, "pressroom")], "dtw").map((p) => p.blocked), [false]);
    assert.deepEqual(markBlockedPillars([pillar(1, null)], "gcv").map((p) => p.blocked), [false]);
    assert.deepEqual(markBlockedPillars([pillar(1, " PressRoom ")], "gcv").map((p) => p.blocked), [true]);
  });
  it("adds ONLY `blocked`; keeps every other key and the order; does not mutate the input", () => {
    const items = [pillar(2, "b"), pillar(1, "pressroom")];
    const before = JSON.stringify(items);
    const out = markBlockedPillars(items, "gcv");
    assert.equal(JSON.stringify(items), before);
    assert.deepEqual(out.map((p) => p.id), [2, 1]);
    assert.deepEqual(Object.keys(out[0]!).sort(), ["blocked", "color", "description", "heading", "icon", "id", "navLabel", "order", "slug", "title"]);
  });
  it("works on a hubBlock's items without touching count / totalDocs / truncated", () => {
    const b = hubBlock([{ id: 1, slug: "pressroom" }, { id: 2, slug: "x" }], 5, 1, sanitizeHubPillar);
    const marked = { ...b, items: markBlockedPillars(b.items, "gcv") };
    assert.deepEqual([marked.count, marked.totalDocs, marked.truncated, marked.items.length, marked.items[0]!.blocked], [1, 5, true, 1, true]);
  });
  it("the taxonomy route applies it to the pillars block", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/api/hub/taxonomy/route.ts"), "utf8");
    assert.match(src, /entry\.pillars = \{ \.\.\.pb, items: markBlockedPillars\(pb\.items, t\.slug\) \};/);
  });
});
