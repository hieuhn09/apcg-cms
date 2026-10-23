/**
 * Unit tests for ./abb-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the canonical ABB taxonomy (abb-taxonomy_22-10-26.json,
 * from the approved design), parity with the abb constants (pressroom single-home
 * + engine-blocked; `press-room` NOT blocked on abb), the never-overwrite
 * planner and the --authors-file parser. Mirrors ./vowasia-taxonomy.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_BLOCKED_PILLARS,
  FEATURE_COLLECTIONS,
  FEATURE_KEYS,
  SINGLE_HOME_PILLARS,
  isEngineBlockedPillar,
} from "../../src/lib/constants";
import { isSingleHomePillar } from "../../src/lib/single-home-pillars";
import {
  ABB_AUTHORS,
  ABB_EXHIBITION_HALLS,
  ABB_NEWSLETTERS,
  ABB_PILLARS,
  ABB_SUBSECTIONS,
  ABB_TAGS,
  ABB_TENANT_FIELDS,
  ABB_TENANT_SLUG,
  buildAbbFixture,
  parseAuthorsFile,
  planAbb,
  planCounts,
  validateAbbFixture,
  type AbbExisting,
} from "./abb-taxonomy";

const EMPTY: AbbExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 6 pillars + 22 sub-sections + 3 newsletters + 5 authors + 57 tags. */
const TOTAL_ROWS = 93;

function applied(): AbbExisting {
  const f = buildAbbFixture();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("abb fixture: slug contract (design)", () => {
  it("tenant slug is abb; engine drafts never auto-publish; English only; exhibition on", () => {
    assert.equal(ABB_TENANT_SLUG, "abb");
    assert.equal(ABB_TENANT_FIELDS.slug, "abb");
    assert.equal(ABB_TENANT_FIELDS.autoPublishEngineDrafts, false);
    assert.deepEqual(ABB_TENANT_FIELDS.supportedLanguages, ["en"]);
    assert.equal(ABB_TENANT_FIELDS.features.exhibition, true);
    assert.equal(ABB_TENANT_FIELDS.features.articles, true);
    assert.equal(ABB_TENANT_FIELDS.features.newsletters, true);
  });
  it("6 pillars in order 1..6 with the exact design slugs and titles", () => {
    assert.deepEqual(
      ABB_PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["briefing", "Briefing", 1],
        ["markets", "Markets", 2],
        ["supply", "Supply Side", 3],
        ["trends", "Trends & Consumer", 4],
        ["professional", "Professional & Aesthetics", 5],
        ["pressroom", "Press Room", 6],
      ],
    );
    for (const p of ABB_PILLARS) assert.ok(p.description.length > 20, p.slug);
  });
  it("22 sub-sections (4+6+5+4+3+0), contiguous 1-based order, unique slugs, none shadow a pillar", () => {
    assert.equal(ABB_SUBSECTIONS.length, 22);
    assert.deepEqual(ABB_PILLARS.map((p) => ABB_SUBSECTIONS.filter((s) => s.pillarSlug === p.slug).length), [4, 6, 5, 4, 3, 0]);
    assert.equal(new Set(ABB_SUBSECTIONS.map((s) => s.slug)).size, 22);
    const pillars = new Set(ABB_PILLARS.map((p) => p.slug));
    for (const s of ABB_SUBSECTIONS) assert.equal(pillars.has(s.slug), false, s.slug);
    assert.deepEqual(
      ABB_SUBSECTIONS.filter((s) => s.pillarSlug === "trends").map((s) => s.slug),
      ["trend-radar", "science-of-beauty", "new-noteworthy", "beauty-culture"],
    );
  });
  it("57 tags with unique kebab slugs; each points at a known pillar/sub-section pair", () => {
    assert.equal(ABB_TAGS.length, 57);
    assert.equal(new Set(ABB_TAGS.map((t) => t.slug)).size, 57);
    const pairs = new Set(ABB_SUBSECTIONS.map((s) => `${s.pillarSlug}/${s.slug}`));
    for (const t of ABB_TAGS) assert.ok(pairs.has(`${t.pillar}/${t.subSection}`), t.slug);
  });
  it(`${TOTAL_ROWS} owner-script rows = 6 + 22 + 3 + 5 + 57`, () => {
    const f = buildAbbFixture();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [6, 22, 3, 5, 57]);
    assert.equal(planAbb(f, EMPTY).length, TOTAL_ROWS);
  });
  it("3 newsletters and 5 authors from the design, no city", () => {
    assert.deepEqual(ABB_NEWSLETTERS.map((n) => n.slug), ["the-beauty-brief", "regulatory-radar", "trend-pulse"]);
    assert.deepEqual(ABB_AUTHORS.map((a) => a.name), ["Joanne Lau", "Kim Seo-yeon", "Kavita Rao", "Emi Fujita", "Nathan Leong"]);
    assert.deepEqual(ABB_AUTHORS.map((a) => a.rank), [1, 2, 3, 4, 5]);
    for (const a of ABB_AUTHORS) assert.equal(a.city, undefined, a.name);
  });
  it("6 exhibition halls", () => {
    assert.deepEqual(ABB_EXHIBITION_HALLS.map((h) => h.slug), [
      "manufacturers",
      "ingredients-fragrance",
      "packaging-machinery",
      "brands-for-distribution",
      "distributors-retail",
      "services",
    ]);
  });
  it("validateAbbFixture accepts the default fixture (no dashes, valid slugs)", () => {
    assert.deepEqual(validateAbbFixture(), []);
  });
});

describe("abb constants", () => {
  it("SINGLE_HOME_PILLARS.abb and ENGINE_BLOCKED_PILLARS.abb are exactly [pressroom]", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS.abb, ["pressroom"]);
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.abb, ["pressroom"]);
    assert.deepEqual(ABB_PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["pressroom"]);
    assert.deepEqual(ABB_PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug), ["pressroom"]);
  });
  it("pressroom is engine-blocked and single-home on abb; press-room and events-awards are NOT", () => {
    assert.equal(isEngineBlockedPillar("abb", "pressroom"), true);
    assert.equal(isEngineBlockedPillar("abb", "press-room"), false);
    assert.equal(isEngineBlockedPillar("abb", "events-awards"), false);
    assert.equal(isEngineBlockedPillar("abb", "briefing"), false);
    assert.equal(isSingleHomePillar("abb", "pressroom"), true);
    assert.equal(isSingleHomePillar("abb", "press-room"), false);
  });
  it("feature key exhibition gates the booths collection", () => {
    assert.ok((FEATURE_KEYS as readonly string[]).includes("exhibition"));
    assert.deepEqual(FEATURE_COLLECTIONS.exhibition, ["booths"]);
  });
});

describe("planAbb (pure, never overwrites)", () => {
  it(`empty tenant: ${TOTAL_ROWS} x create; applied tenant: ${TOTAL_ROWS} x exists, no diffs`, () => {
    assert.deepEqual(planCounts(planAbb(buildAbbFixture(), EMPTY)), { create: TOTAL_ROWS, exists: 0, refuse: 0 });
    const items = planAbb(buildAbbFixture(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: TOTAL_ROWS, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("refuses an existing pressroom pillar with sub-sections, and a fixture sub-section under pressroom", () => {
    const ex = applied();
    ex.pillars = ex.pillars.map((p) => (p.slug === "pressroom" ? { ...p, subSectionCount: 1 } : p));
    assert.equal(planAbb(buildAbbFixture(), ex).find((i) => i.key === "pressroom")!.action.kind, "refuse");
    const f = buildAbbFixture();
    f.subSections.push({ pillarSlug: "pressroom", slug: "pr-x", title: "X", order: 1, description: "" });
    assert.equal(planAbb(f, EMPTY).find((i) => i.key === "pressroom/pr-x")!.action.kind, "refuse");
  });
  it("authors file rejects unknown slugs", () => {
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "serene-chia": { role: "x" } })), /unknown author slug/);
    const ov = parseAuthorsFile(JSON.stringify({ "nathan-leong": { role: "Senior Reporter" } }));
    assert.equal(buildAbbFixture({ authorOverrides: ov }).authors.find((a) => a.slug === "nathan-leong")!.role, "Senior Reporter");
  });
});
