/**
 * Unit tests for ./vowasia-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the approved design (vowasia-web `src/content/pillars.ts`,
 * team page byline list), parity with the vowasia constants, the never-overwrite
 * planner and the --authors-file parser. Mirrors ./gtp-taxonomy.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";
import {
  VOWASIA_AUTHORS,
  VOWASIA_NEWSLETTERS,
  VOWASIA_PILLARS,
  VOWASIA_SUBSECTIONS,
  VOWASIA_TAGS,
  VOWASIA_TENANT_FIELDS,
  VOWASIA_TENANT_SLUG,
  buildVowasiaFixture,
  diffFields,
  parseAuthorsFile,
  planCounts,
  planVowasia,
  validateVowasiaFixture,
  type VowasiaExisting,
} from "./vowasia-taxonomy";

const EMPTY: VowasiaExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 8 pillars + 27 sub-sections + 2 newsletters + 6 authors + 6 tags. */
const TOTAL_ROWS = 49;

/** The byline list fixed in the launch decisions (13-10-26); content-engine's pool must match it char for char. */
const BYLINES = ["Serene Chia", "Aarti Menon", "Danish Iskandar", "Hanna Pang", "Yumi Nakagawa", "Ishaan Bhatt"];

const kebab = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** An "existing" snapshot that mirrors a fully applied fixture. */
function applied(): VowasiaExisting {
  const f = buildVowasiaFixture();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("vowasia fixture: slug contract (design pillars.ts)", () => {
  it("tenant slug is vowasia; engine drafts never auto-publish; English only", () => {
    assert.equal(VOWASIA_TENANT_SLUG, "vowasia");
    assert.equal(VOWASIA_TENANT_FIELDS.slug, "vowasia");
    assert.equal(VOWASIA_TENANT_FIELDS.autoPublishEngineDrafts, false);
    assert.deepEqual(VOWASIA_TENANT_FIELDS.supportedLanguages, ["en"]);
    assert.equal(VOWASIA_TENANT_FIELDS.timezone, "Asia/Singapore");
    assert.equal(VOWASIA_TENANT_FIELDS.frontendUrl, "");
    assert.equal(VOWASIA_TENANT_FIELDS.domain, "");
  });
  it("8 pillars in order 1..8 with the exact design slugs and titles", () => {
    assert.deepEqual(
      VOWASIA_PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["real-weddings", "Real Weddings", 1],
        ["venues", "Venues", 2],
        ["directory", "The Directory", 3],
        ["destination-weddings", "Destination Weddings", 4],
        ["style", "Style", 5],
        ["planning", "Planning", 6],
        ["wedding-business", "The Wedding Business", 7],
        ["press-room", "Press Room", 8],
      ],
    );
    assert.equal(new Set(VOWASIA_PILLARS.map((p) => p.order)).size, 8);
    assert.equal(new Set(VOWASIA_PILLARS.map((p) => p.slug)).size, 8);
    for (const p of VOWASIA_PILLARS) {
      assert.equal(p.heading, p.title);
      assert.equal(p.color, "var(--accent)");
      assert.ok(p.description.length > 20, p.slug);
    }
  });
  it("27 sub-sections (4+4+3+4+5+4+3+0) matching the design `subs` without an href", () => {
    const per = (s: string) => VOWASIA_SUBSECTIONS.filter((r) => r.pillarSlug === s).length;
    assert.equal(VOWASIA_SUBSECTIONS.length, 27);
    assert.deepEqual(
      VOWASIA_PILLARS.map((p) => per(p.slug)),
      [4, 4, 3, 4, 5, 4, 3, 0],
    );
  });
  it("exact sub-section slugs and titles per pillar", () => {
    const by = (p: string) => VOWASIA_SUBSECTIONS.filter((s) => s.pillarSlug === p).map((s) => [s.slug, s.title]);
    assert.deepEqual(by("real-weddings"), [
      ["grand-celebrations", "Grand Celebrations"],
      ["intimate-elopements", "Intimate & Elopements"],
      ["traditions", "Traditions"],
      ["society-celebrity", "Society & Celebrity"],
    ]);
    assert.deepEqual(by("venues"), [
      ["hotels-resorts", "Hotels & Resorts"],
      ["by-destination", "By Destination"],
      ["venue-spotlights", "Venue Spotlights"],
      ["packages-price-guides", "Packages & Price Guides"],
    ]);
    assert.deepEqual(by("directory"), [
      ["by-category", "By Category"],
      ["by-city", "By City"],
      ["vowasia-vetted", "VowAsia Vetted"],
    ]);
    assert.deepEqual(by("destination-weddings"), [
      ["destination-guides", "Destination Guides"],
      ["legal-logistics", "Legal & Logistics"],
      ["pre-wedding-shoots", "Pre-Wedding Shoots"],
      ["honeymoons", "Honeymoons"],
    ]);
    assert.deepEqual(by("style"), [
      ["gowns-attire", "Gowns & Attire"],
      ["rings-jewellery", "Rings & Jewellery"],
      ["beauty", "Beauty"],
      ["flowers-decor", "Flowers & Décor"],
      ["trend-reports", "Trend Reports"],
    ]);
    assert.deepEqual(by("planning"), [
      ["checklists-timelines", "Checklists & Timelines"],
      ["budgets-real-costs", "Budgets & Real Costs"],
      ["expert-advice", "Expert Advice"],
      ["etiquette-traditions", "Etiquette & Traditions"],
    ]);
    assert.deepEqual(by("wedding-business"), [
      ["industry-news", "Industry News"],
      ["data-insights", "Data & Insights"],
      ["people-planners", "People & Planners"],
    ]);
    assert.deepEqual(by("press-room"), []);
  });
  it("sub-section slugs follow the gtp convention: kebab-case title, `&` and accents dropped", () => {
    const conv = (t: string) =>
      t
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    for (const s of VOWASIA_SUBSECTIONS) assert.equal(s.slug, conv(s.title), s.title);
  });
  it("every sub-section has an existing pillar, a 1-based order per pillar, and a tenant-unique slug", () => {
    const pillars = new Set(VOWASIA_PILLARS.map((p) => p.slug));
    for (const s of VOWASIA_SUBSECTIONS) assert.ok(pillars.has(s.pillarSlug), s.slug);
    for (const p of VOWASIA_PILLARS) {
      const orders = VOWASIA_SUBSECTIONS.filter((s) => s.pillarSlug === p.slug).map((s) => s.order);
      assert.deepEqual(orders, orders.map((_, i) => i + 1), p.slug);
    }
    assert.equal(new Set(VOWASIA_SUBSECTIONS.map((s) => s.slug)).size, VOWASIA_SUBSECTIONS.length);
    for (const s of VOWASIA_SUBSECTIONS) assert.equal(pillars.has(s.slug), false, `sub-section ${s.slug} shadows a pillar slug`);
  });
  it(`${TOTAL_ROWS} owner-script rows = 8 pillars + 27 sub-sections + 2 newsletters + 6 authors + 6 tags`, () => {
    const f = buildVowasiaFixture();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [8, 27, 2, 6, 6]);
    assert.equal(planVowasia(f, EMPTY).length, TOTAL_ROWS);
  });
  it("newsletters: the-vow (weekly) and wedding-business-brief (twice a month)", () => {
    assert.deepEqual(
      VOWASIA_NEWSLETTERS.map((n) => [n.slug, n.name, n.cadence, n.order, n.active]),
      [
        ["the-vow", "The Vow", "Once a week", 1, true],
        ["wedding-business-brief", "The Wedding Business Brief", "Twice a month", 2, true],
      ],
    );
  });
  it("authors: exactly the six design bylines, kebab-case slugs, ranks 1..6, general roles, short plain bios, no city", () => {
    assert.deepEqual(VOWASIA_AUTHORS.map((a) => a.name), BYLINES);
    assert.deepEqual(VOWASIA_AUTHORS.map((a) => a.slug), BYLINES.map(kebab));
    assert.deepEqual(VOWASIA_AUTHORS.map((a) => a.rank), [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(VOWASIA_AUTHORS.map((a) => a.slug)).size, 6);
    const GENERAL = new Set(["Editor", "Senior Reporter", "Reporter", "Senior Writer", "Contributing Writer", "Contributing Editor"]);
    for (const a of VOWASIA_AUTHORS) {
      assert.ok(GENERAL.has(a.role), `${a.name}: role ${a.role} is not a general role`);
      assert.ok(a.bio && a.bio.length > 20 && a.bio.length < 300, `${a.name} must have a short bio`);
      assert.ok(a.bio!.startsWith(a.name.split(" ")[0]!), `${a.name}: bio must open with the first name`);
      assert.doesNotMatch(a.bio!, /[\u2013\u2014]|\d/, `${a.name}: bio has a dash or a number`);
      assert.equal(a.city, undefined, `${a.name} must have no city`);
    }
    assert.equal(VOWASIA_AUTHORS.find((a) => a.name === "Serene Chia")?.role, "Editor");
  });
  it("tags: the six exact slugs; no probe tag", () => {
    assert.deepEqual(VOWASIA_TAGS.map((t) => [t.slug, t.title]), [
      ["indian-weddings", "Indian Weddings"],
      ["elopements", "Elopements"],
      ["honeymoons", "Honeymoons"],
      ["wedding-venues", "Wedding Venues"],
      ["bridal-fashion", "Bridal Fashion"],
      ["wedding-industry", "Wedding Industry"],
    ]);
    assert.equal(VOWASIA_TAGS.some((t) => t.slug.startsWith("zz-")), false);
  });
  it("tenant contact and SEO sheet", () => {
    assert.deepEqual(VOWASIA_TENANT_FIELDS.contact, {
      editorial: "editor@vowasia.com",
      general: "info@vowasia.com",
      advertising: "info@asiapresscentre.com",
      partnerships: "info@asiapresscentre.com",
    });
    assert.equal(VOWASIA_TENANT_FIELDS.seo.titleSuffix, "- VowAsia");
  });
  it("no em dash or en dash anywhere in the fixture", () => {
    const all = JSON.stringify({ VOWASIA_PILLARS, VOWASIA_SUBSECTIONS, VOWASIA_NEWSLETTERS, VOWASIA_AUTHORS, VOWASIA_TAGS, VOWASIA_TENANT_FIELDS });
    assert.equal(/[–—]/.test(all), false);
  });
  it("validateVowasiaFixture accepts the default fixture and flags a duplicate sub-section slug", () => {
    assert.deepEqual(validateVowasiaFixture(), []);
    const f = buildVowasiaFixture();
    f.subSections.push({ pillarSlug: "planning", slug: "traditions", title: "Traditions", order: 5 });
    assert.ok(validateVowasiaFixture(f).some((e) => e.includes("duplicate sub-section slug: traditions")));
  });
});

describe("vowasia fixture: parity with the constants", () => {
  it("SINGLE_HOME_PILLARS.vowasia is [press-room]; ENGINE_BLOCKED_PILLARS.vowasia is [press-room, real-weddings, directory]", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS.vowasia, ["press-room"]);
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.vowasia, ["press-room", "real-weddings", "directory"]);
  });
  it("exactly 5 engine-writable pillars (press-room, real-weddings, directory are editor-only)", () => {
    assert.deepEqual(
      VOWASIA_PILLARS.filter((p) => p.engineWritable).map((p) => p.slug),
      ["venues", "destination-weddings", "style", "planning", "wedding-business"],
    );
    assert.deepEqual(VOWASIA_PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug), ["real-weddings", "directory", "press-room"]);
  });
  it("engineWritable agrees with ENGINE_BLOCKED_PILLARS.vowasia for every pillar", () => {
    const blocked = new Set(ENGINE_BLOCKED_PILLARS.vowasia ?? []);
    for (const p of VOWASIA_PILLARS) assert.equal(p.engineWritable, !blocked.has(p.slug), p.slug);
  });
  it("every SINGLE_HOME_PILLARS.vowasia / ENGINE_BLOCKED_PILLARS.vowasia slug exists in the fixture", () => {
    const slugs = new Set(VOWASIA_PILLARS.map((p) => p.slug));
    for (const s of [...(SINGLE_HOME_PILLARS.vowasia ?? []), ...(ENGINE_BLOCKED_PILLARS.vowasia ?? [])]) assert.ok(slugs.has(s), s);
    assert.deepEqual(VOWASIA_PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["press-room"]);
  });
  it("press-room has zero sub-sections; a fixture that adds one is invalid", () => {
    assert.equal(VOWASIA_SUBSECTIONS.filter((s) => s.pillarSlug === "press-room").length, 0);
    const f = buildVowasiaFixture();
    f.subSections.push({ pillarSlug: "press-room", slug: "x", title: "X", order: 1 });
    assert.ok(validateVowasiaFixture(f).some((e) => e.includes("single-home")));
  });
});

describe("planVowasia (pure, never overwrites)", () => {
  it(`empty tenant: ${TOTAL_ROWS} x create`, () => {
    assert.deepEqual(planCounts(planVowasia(buildVowasiaFixture(), EMPTY)), { create: TOTAL_ROWS, exists: 0, refuse: 0 });
  });
  it(`idempotent: an applied tenant plans ${TOTAL_ROWS} x exists with no diffs`, () => {
    const items = planVowasia(buildVowasiaFixture(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: TOTAL_ROWS, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("never overwrites: an edited pillar description is reported as a diff, kind stays exists", () => {
    const ex = applied();
    ex.pillars[0] = { ...ex.pillars[0]!, description: "Edited by an editor." };
    const item = planVowasia(buildVowasiaFixture(), ex).find((i) => i.entity === "pillars" && i.key === "real-weddings")!;
    assert.equal(item.action.kind, "exists");
    assert.deepEqual(item.action.kind === "exists" ? item.action.diffs.map((d) => d.field) : [], ["description"]);
  });
  it("refuses an existing press-room pillar that has sub-sections or secondary references", () => {
    const ex = applied();
    ex.pillars = ex.pillars.map((p) => (p.slug === "press-room" ? { ...p, subSectionCount: 1 } : p));
    assert.equal(planVowasia(buildVowasiaFixture(), ex).find((i) => i.key === "press-room")!.action.kind, "refuse");
    ex.pillars = ex.pillars.map((p) => (p.slug === "press-room" ? { ...p, subSectionCount: 0, secondaryRefCount: 2 } : p));
    assert.equal(planVowasia(buildVowasiaFixture(), ex).find((i) => i.key === "press-room")!.action.kind, "refuse");
  });
  it("refuses a fixture sub-section under press-room", () => {
    const f = buildVowasiaFixture();
    f.subSections.push({ pillarSlug: "press-room", slug: "pr-x", title: "X", order: 1 });
    assert.equal(planVowasia(f, EMPTY).find((i) => i.key === "press-room/pr-x")!.action.kind, "refuse");
  });
  it("refuses an author present by name with a different (or no) slug", () => {
    const ex: VowasiaExisting = { ...EMPTY, authors: [{ name: "Hanna Pang", slug: "hpang" }] };
    assert.equal(planVowasia(buildVowasiaFixture(), ex).find((i) => i.key === "Hanna Pang")!.action.kind, "refuse");
    const ghost: VowasiaExisting = { ...EMPTY, authors: [{ name: "Hanna Pang", slug: null }] };
    assert.equal(planVowasia(buildVowasiaFixture(), ghost).find((i) => i.key === "Hanna Pang")!.action.kind, "refuse");
  });
  it("refuses when an existing different author already owns a requested rank or slug", () => {
    const rank: VowasiaExisting = { ...EMPTY, authors: [{ name: "Someone Else", slug: "someone-else", rank: 1 }] };
    assert.equal(planVowasia(buildVowasiaFixture(), rank).find((i) => i.key === "Serene Chia")!.action.kind, "refuse");
    const slug: VowasiaExisting = { ...EMPTY, authors: [{ name: "Someone Else", slug: "ishaan-bhatt" }] };
    assert.equal(planVowasia(buildVowasiaFixture(), slug).find((i) => i.key === "Ishaan Bhatt")!.action.kind, "refuse");
  });
  it("refuses a same-slug tag with a different title; same title is exists", () => {
    const ex: VowasiaExisting = { ...EMPTY, tags: [{ slug: "elopements", title: "Eloping" }, { slug: "honeymoons", title: "Honeymoons" }] };
    const items = planVowasia(buildVowasiaFixture(), ex);
    assert.equal(items.find((i) => i.key === "elopements")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "honeymoons")!.action.kind, "exists");
  });
  it("diffFields ignores empty fixture fields and treats empty as equal", () => {
    assert.deepEqual(diffFields({ bio: "", role: "Senior Writer" }, { bio: "Long bio", role: "Senior Writer" }, ["bio", "role"]), []);
    assert.deepEqual(diffFields({ role: "Senior Writer" }, { role: "Editor" }, ["role"]), [{ field: "role", current: "Editor", fixture: "Senior Writer" }]);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs with string fields and applies them in buildVowasiaFixture", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "hanna-pang": { role: "Editor", bio: "Bio.", city: "Singapore", slug: "hanna" } }));
    const a = buildVowasiaFixture({ authorOverrides: ov }).authors.find((x) => x.name === "Hanna Pang")!;
    assert.deepEqual([a.role, a.bio, a.city, a.slug], ["Editor", "Bio.", "Singapore", "hanna"]);
  });
  it("rejects gtp author slugs, unknown fields, non-strings, empty, over 2000 chars, bad slug, prototype keys, non-object", () => {
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "hanna-pang": { beats: "x" } })), /not an allowed field/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "hanna-pang": { role: 5 } })), /must be a string/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "hanna-pang": { role: "  " } })), /is empty/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "hanna-pang": { bio: "x".repeat(2001) } })), /over 2000/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "hanna-pang": { slug: "Bad Slug" } })), /kebab-case/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile('{"hanna-pang": {"__proto__": {"x": 1}}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile('{"constructor": {}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile("[]"), /top level/);
    assert.throws(() => parseAuthorsFile("{nope"), /not valid JSON/);
    assert.equal(({} as Record<string, unknown>).role, undefined);
  });
});
