import { test } from "node:test";
import assert from "node:assert/strict";
import { VOWASIA_PILLARS, VOWASIA_SUBSECTIONS } from "../../../lib/vowasia-taxonomy";
import {
  C8_LEGACY_PAIRS, C8_PILLARS, C8_SUBSECTION_RENAMES, MAPPING_MESSAGES, MappingError, defaultVowasiaMapping, isAllowedMediaUrl, mapTaxonomy, newArticlePath,
  oldArticleUrl, parseVowasiaMapping,
} from "./vowasia-mapping";

// The approved C8 table of LEGACY (section, subsection) pairs with the expected target. It is inferred from the
// per-column totals of discover (Amendment 3, 3.2 / 3.3); the (section, subsection) cross table itself is NOT
// measured yet (KB-2, measured by B-0b on the owner's snapshot).
const OBSERVED: [string, string, string, string | null][] = [
  ["wedding-business", "industry-news", "wedding-business", "industry-news"],
  ["wedding-business", "people", "wedding-business", "people-planners"],
  ["wedding-business", "data-insights", "wedding-business", "data-insights"],
  ["venues", "hotels-resorts", "venues", "hotels-resorts"],
  ["venues", "by-destination", "venues", "by-destination"],
  ["venues", "", "venues", null],
  ["style", "rings-jewelry", "style", "rings-jewellery"],
  ["style", "flowers-decor", "style", "flowers-decor"],
  ["style", "trends", "style", "trend-reports"],
  ["style", "beauty", "style", "beauty"],
  ["style", "gowns-attire", "style", "gowns-attire"],
  ["destination-weddings", "honeymoons", "destination-weddings", "honeymoons"],
  ["destination-weddings", "guides", "destination-weddings", "destination-guides"],
  ["destination-weddings", "pre-wedding-shoots", "destination-weddings", "pre-wedding-shoots"],
  ["planning", "budgets-costs", "planning", "budgets-real-costs"],
  ["planning", "expert-advice", "planning", "expert-advice"],
  ["planning", "checklists", "planning", "checklists-timelines"],
  ["planning", "etiquette-traditions", "planning", "etiquette-traditions"],
];

test("should map the 6 renamed sub-sections and reject an unknown (section, subsection) pair", () => {
  assert.deepEqual(C8_SUBSECTION_RENAMES, {
    people: "people-planners",
    "rings-jewelry": "rings-jewellery",
    trends: "trend-reports",
    guides: "destination-guides",
    "budgets-costs": "budgets-real-costs",
    checklists: "checklists-timelines",
  });
  for (const [s, ss, p, t] of OBSERVED) assert.deepEqual(mapTaxonomy(s, ss), { ok: true, pillar: p, subSection: t }, `${s}/${ss}`);
  // a sub-section that exists, but under ANOTHER pillar
  assert.equal(mapTaxonomy("venues", "honeymoons").ok, false);
  assert.equal(mapTaxonomy("style", "industry-news").ok, false);
  // a section that is not one of the 5 C8 pillars (even if a VowAsia pillar exists by that name)
  assert.equal(mapTaxonomy("real-weddings", "").ok, false);
  assert.equal(mapTaxonomy("press-room", "").ok, false);
  assert.equal(mapTaxonomy("news", "").ok, false);
  // unknown sub-section, and the renamed SOURCE name is not accepted as a target name in reverse
  assert.equal(mapTaxonomy("style", "rings-jewellery-x").ok, false);
  // N1: only LEGACY names are accepted as input; a new (renamed) taxonomy slug is not a legacy subsection
  for (const target of Object.values(C8_SUBSECTION_RENAMES)) {
    const owner = OBSERVED.find(([, , , t]) => t === target)?.[0] as string;
    assert.equal(mapTaxonomy(owner, target).ok, false, `${owner}/${target} (new name as legacy input)`);
  }
  // a taxonomy sub-section that exists under the pillar but is not in the approved legacy table
  const extra = VOWASIA_SUBSECTIONS.find((x) => (C8_PILLARS as readonly string[]).includes(x.pillarSlug) && !OBSERVED.some(([s, , , t]) => s === x.pillarSlug && t === x.slug));
  if (extra) assert.equal(mapTaxonomy(extra.pillarSlug, extra.slug).ok, false, `${extra.pillarSlug}/${extra.slug} is not an approved legacy pair`);
  // the approved table is exactly the 18 pairs above (17 with a sub-section + venues with an empty one)
  const table = Object.entries(C8_LEGACY_PAIRS).flatMap(([p, subs]) => subs.map((x) => `${p}|${x}`)).sort();
  assert.deepEqual(table, OBSERVED.map(([s, ss]) => `${s}|${ss}`).filter((k) => !k.endsWith("|")).sort());
  // never guess: case / spaces / null section
  assert.equal(mapTaxonomy("Style", "beauty").ok, false);
  assert.equal(mapTaxonomy(" style", "beauty").ok, false);
  assert.equal(mapTaxonomy(null, "beauty").ok, false);
  const r = mapTaxonomy("style", "honeymoons");
  assert.ok(!r.ok && r.reason.length > 0);
});

test("a null / whitespace-free empty sub-section maps to the pillar only", () => {
  assert.deepEqual(mapTaxonomy("venues", null), { ok: true, pillar: "venues", subSection: null });
  assert.deepEqual(mapTaxonomy("planning", undefined), { ok: true, pillar: "planning", subSection: null });
});

test("every C8 target exists in scripts/lib/vowasia-taxonomy.ts under the right pillar", () => {
  const pillars = new Set(VOWASIA_PILLARS.map((p) => p.slug));
  assert.deepEqual([...C8_PILLARS].sort(), ["destination-weddings", "planning", "style", "venues", "wedding-business"]);
  for (const p of C8_PILLARS) assert.ok(pillars.has(p), p);
  for (const [s, , p, t] of OBSERVED) {
    if (t === null) continue;
    assert.ok(VOWASIA_SUBSECTIONS.some((x) => x.pillarSlug === p && x.slug === t), `${s} -> ${p}/${t}`);
  }
  for (const target of Object.values(C8_SUBSECTION_RENAMES)) assert.ok(VOWASIA_SUBSECTIONS.some((x) => x.slug === target), target);
});

test("URL rules: old /article/{slug} on https://vowasia.com, new /{pillar}/{slug}", () => {
  const m = defaultVowasiaMapping();
  assert.equal(m.urls.oldOrigin, "https://vowasia.com");
  assert.equal(m.urls.articlePathTemplate, "/article/{slug}");
  assert.equal(m.urls.targetPathTemplate, "/{pillar}/{slug}");
  assert.equal(oldArticleUrl(m, "a-b-c"), "https://vowasia.com/article/a-b-c");
  assert.equal(newArticlePath(m, "venues", "a-b-c"), "/venues/a-b-c");
  assert.throws(() => newArticlePath(m, "venues", "../x"), MappingError);
  assert.throws(() => oldArticleUrl(m, "A B"), MappingError);
});

test("mapping is zod strict; media.hostAllowlist comes from the overlay; other hosts are refused", () => {
  const m = parseVowasiaMapping({ media: { hostAllowlist: ["img.example.invalid"] } });
  assert.equal(isAllowedMediaUrl(m, "https://img.example.invalid/a.jpg"), true);
  assert.equal(isAllowedMediaUrl(m, "https://IMG.example.invalid/a.jpg"), true);
  assert.equal(isAllowedMediaUrl(m, "http://img.example.invalid/a.jpg"), false);
  assert.equal(isAllowedMediaUrl(m, "https://other.example.invalid/a.jpg"), false);
  assert.equal(isAllowedMediaUrl(m, "https://img.example.invalid.evil.invalid/a.jpg"), false);
  assert.equal(isAllowedMediaUrl(m, "not a url"), false);
  assert.equal(isAllowedMediaUrl(defaultVowasiaMapping(), "https://img.example.invalid/a.jpg"), false, "no overlay -> nothing allowed");
  assert.throws(() => parseVowasiaMapping({ media: { hostAllowlist: ["img.example.invalid"] }, extra: 1 }), { message: MAPPING_MESSAGES.invalid });
  assert.throws(() => parseVowasiaMapping({ media: { hostAllowlist: ["https://img.example.invalid/"] } }), { message: MAPPING_MESSAGES.invalid });
  assert.throws(() => parseVowasiaMapping({ urls: { oldOrigin: "https://evil.invalid" } }), { message: MAPPING_MESSAGES.invalid }, "C3 values are fixed");
  assert.throws(() => parseVowasiaMapping({ media: { hostAllowlist: ["TODO"] } }), { message: MAPPING_MESSAGES.todo });
});

test("_provisional + requireFinal", () => {
  assert.deepEqual(defaultVowasiaMapping()._provisional, []);
  const p = parseVowasiaMapping({ _provisional: ["urls.oldOrigin"] });
  assert.deepEqual(p._provisional, ["urls.oldOrigin"]);
  assert.throws(() => parseVowasiaMapping({ _provisional: ["urls.oldOrigin"] }, { requireFinal: true }), { message: MAPPING_MESSAGES.provisional });
  assert.throws(() => parseVowasiaMapping({ _provisional: ["media.hostAllowlist"] }), { message: MAPPING_MESSAGES.invalid });
  assert.doesNotThrow(() => parseVowasiaMapping({}, { requireFinal: true }));
});
