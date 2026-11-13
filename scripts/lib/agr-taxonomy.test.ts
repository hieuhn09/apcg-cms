/**
 * Unit tests for ./agr-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the agr-launch plan delta §2 (design taxonomy), parity
 * with the agr constants (engine-blocked, single-home press-room), the
 * never-overwrite planner and the --authors-file parser. Mirrors
 * ./aer-taxonomy.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS, isEngineBlockedPillar } from "../../src/lib/constants";
import { isSingleHomePillar } from "../../src/lib/single-home-pillars";
import {
  AGR_AUTHORS as AUTHORS,
  AGR_NEWSLETTERS as NEWSLETTERS,
  AGR_PILLARS as PILLARS,
  AGR_SUBSECTIONS as SUBS,
  AGR_TAGS as TAGS,
  AGR_TENANT_FIELDS as TENANT,
  AGR_TENANT_SLUG as SLUG,
  buildAgrFixture as build,
  diffFields,
  parseAuthorsFile,
  planCounts,
  planAgr as plan,
  validateAgrFixture as validate,
  type AgrExisting,
} from "./agr-taxonomy";

const EMPTY: AgrExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 7 pillars + 29 sub-sections + 2 newsletters + 5 authors + 7 tags. */
const TOTAL_ROWS = 50;
const BYLINES = ["Rachel Lim", "Arjun Mehta", "Kenji Sato", "Ha Tran", "Daniel Wong"];
const kebab = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function applied(): AgrExisting {
  const f = build();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("agr fixture: tenant sheet", () => {
  it("slug, name, English only, Singapore, no domain/frontend, no auto-publish", () => {
    assert.equal(SLUG, "agr");
    assert.equal(TENANT.slug, SLUG);
    assert.equal(TENANT.name, "AsiaGolfReview");
    assert.equal(TENANT.status, "active");
    assert.equal(TENANT.defaultLanguage, "en");
    assert.deepEqual(TENANT.supportedLanguages, ["en"]);
    assert.equal(TENANT.timezone, "Asia/Singapore");
    assert.equal(TENANT.domain, "");
    assert.deepEqual(TENANT.additionalDomains, []);
    assert.equal(TENANT.frontendUrl, "");
    assert.equal(TENANT.autoPublishEngineDrafts, false);
  });
  it("features: articles, newsletters, corrections on; everything else (incl. translations) off", () => {
    const on = Object.entries(TENANT.features).filter(([, v]) => v).map(([k]) => k).sort();
    assert.deepEqual(on, ["articles", "corrections", "newsletters"]);
    assert.equal(TENANT.features.translations, false);
  });
  it("contacts", () => {
    assert.deepEqual(TENANT.contact, {
      editorial: "editor@asiagolfreview.com",
      general: "info@asiagolfreview.com",
      advertising: "info@asiapresscentre.com",
      partnerships: "info@asiapresscentre.com",
    });
  });
});

describe("agr fixture: taxonomy (plan delta §2)", () => {
  it("7 pillars in design menu order with exact slugs, titles and descriptions (American spelling)", () => {
    assert.deepEqual(
      PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["course-reviews", "Course Reviews", 1],
        ["rankings", "Rankings", 2],
        ["golf-travel", "Golf Travel", 3],
        ["the-game", "The Game", 4],
        ["gear-style", "Gear & Style", 5],
        ["golf-business", "Golf Business", 6],
        ["press-room", "Press Room", 7],
      ],
    );
    const d = Object.fromEntries(PILLARS.map((p) => [p.slug, p.description]));
    assert.equal(d["course-reviews"], "Independent reviews written from on-site play, with a standardized fact file and an AGR Score against published criteria.");
    assert.equal(d.rankings, "Asia's Top 100 and country Top 10s, judged by a named panel to a published methodology.");
    assert.equal(d["golf-travel"], "Where to play, where to stay and how to plan it: the practical craft of the Asian golf trip.");
    assert.equal(d["the-game"], "Selected tournament coverage with an Asian vantage point: the tours, the opens and the players who matter here.");
    assert.equal(d["gear-style"], "Equipment and apparel reviewed in the conditions you'll actually play in: Asia's heat, humidity and rain.");
    assert.equal(d["golf-business"], "The industry behind the game: development, management, people and data, reported for professionals.");
    assert.equal(d["press-room"], "Announcements from the golf industry, published in full and clearly labeled, separate from our editorial coverage.");
    for (const p of PILLARS) {
      assert.equal(p.heading, p.title);
      assert.doesNotMatch(p.description, /[’‘]|standardised|labelled|travelling/, p.slug);
    }
  });
  it("29 sub-sections under the right pillars; press-room has none", () => {
    const by = (p: string) => SUBS.filter((s) => s.pillarSlug === p).map((s) => [s.slug, s.title]);
    assert.equal(SUBS.length, 29);
    assert.deepEqual(by("course-reviews"), [
      ["vietnam", "Vietnam"],
      ["thailand", "Thailand"],
      ["japan", "Japan"],
      ["south-korea", "South Korea"],
      ["malaysia", "Malaysia"],
      ["indonesia", "Indonesia"],
      ["philippines", "Philippines"],
      ["china-hainan", "China & Hainan"],
      ["singapore", "Singapore"],
    ]);
    assert.deepEqual(by("rankings"), [
      ["asia-top-100", "Asia Top 100"],
      ["country-top-10", "Country Top 10s"],
      ["best-new-courses", "Best New Courses"],
    ]);
    assert.deepEqual(by("golf-travel"), [
      ["destinations", "Destinations"],
      ["itineraries", "Itineraries"],
      ["resorts-stays", "Resorts & Stays"],
      ["the-practical-game", "The Practical Game"],
    ]);
    assert.deepEqual(by("the-game"), [
      ["tournament-news", "Tournament News"],
      ["players", "Players"],
      ["watch-prize-money", "Watch & Prize Money"],
      ["national-opens", "National Opens"],
    ]);
    assert.deepEqual(by("gear-style"), [
      ["clubs", "Clubs"],
      ["balls", "Balls"],
      ["apparel", "Apparel"],
      ["shoes", "Shoes"],
      ["bags-accessories", "Bags & Accessories"],
    ]);
    assert.deepEqual(by("golf-business"), [
      ["development-design", "Development & Design"],
      ["club-management", "Club Management"],
      ["people", "People"],
      ["data-insights", "Data & Insights"],
    ]);
    assert.deepEqual(by("press-room"), []);
    // methodology is a static page, hidden-gems / new-renovated are tags: none is a sub-section.
    for (const s of ["methodology", "hidden-gems", "new-renovated"]) assert.equal(SUBS.some((x) => x.slug === s), false, s);
  });
  it("slugs unique within the tenant (all entities) and sub-sections never shadow a pillar", () => {
    const f = build();
    const all = [...f.pillars.map((p) => p.slug), ...f.subSections.map((s) => s.slug)];
    assert.equal(new Set(all).size, all.length);
    assert.equal(new Set(f.tags.map((t) => t.slug)).size, f.tags.length);
    assert.equal(new Set(f.authors.map((a) => a.slug)).size, f.authors.length);
  });
  it("two newsletters: sunday-round, golf-business-brief", () => {
    assert.deepEqual(NEWSLETTERS.map((n) => [n.slug, n.name, n.order, n.active]), [
      ["sunday-round", "The Sunday Round", 1, true],
      ["golf-business-brief", "Asia Golf Business Brief", 2, true],
    ]);
  });
  it("authors: exactly the five Team names, verbatim bios, general roles, no city", () => {
    assert.deepEqual(AUTHORS.map((a) => a.name), BYLINES);
    assert.deepEqual(AUTHORS.map((a) => a.slug), BYLINES.map(kebab));
    assert.deepEqual(AUTHORS.map((a) => [a.rank, a.role]), [
      [1, "Editor"],
      [2, "Senior Writer"],
      [3, "Senior Writer"],
      [4, "Senior Reporter"],
      [5, "Contributing Editor"],
    ]);
    for (const a of AUTHORS) {
      assert.ok(a.bio!.startsWith(`${a.name} is `), a.name);
      assert.equal(a.city, undefined);
    }
    assert.deepEqual(AUTHORS.map((a) => a.bio), [
      "Rachel Lim is an editor at AsiaGolfReview. She plans the trips she writes about and plays the courses on them, often in the first group out.",
      "Arjun Mehta is a senior writer at AsiaGolfReview. He moves between review rounds, tour events and the test bench, often in the same week.",
      "Kenji Sato is a senior writer at AsiaGolfReview. He writes about how courses are built and run, and about the players and events that fill them.",
      "Ha Tran is a senior reporter at AsiaGolfReview. She follows Vietnam's course boom from groundbreaking to first tee, and the trips that come after.",
      "Daniel Wong is a contributing editor at AsiaGolfReview. He writes features and interviews, plus the occasional itinerary when a good story needs a long weekend.",
    ]);
  });
  it("no shared newsroom/editorial byline anywhere", () => {
    for (const a of AUTHORS) assert.doesNotMatch(a.name, /newsroom|editorial|team|desk|editors/i);
    assert.doesNotMatch(JSON.stringify(AUTHORS), /editorial team|Newsroom|AGR Editors/i);
  });
  it("7 tags (D6)", () => {
    assert.deepEqual(TAGS.map((t) => [t.slug, t.title]), [
      ["courses", "Courses"],
      ["development", "Development"],
      ["travel", "Travel"],
      ["gear", "Gear"],
      ["tournaments", "Tournaments"],
      ["hidden-gems", "Hidden Gems"],
      ["new-renovated", "New & Renovated"],
    ]);
  });
  it(`${TOTAL_ROWS} rows; validator clean; no em/en dash`, () => {
    const f = build();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [7, 29, 2, 5, 7]);
    assert.equal(plan(f, EMPTY).length, TOTAL_ROWS);
    assert.deepEqual(validate(), []);
    assert.equal(/[–—]/.test(JSON.stringify({ PILLARS, SUBS, NEWSLETTERS, AUTHORS, TAGS, TENANT })), false);
  });
  it("validator refuses a sub-section under the single-home press-room", () => {
    const f = build();
    f.subSections.push({ pillarSlug: "press-room", slug: "press-releases", title: "Press Releases", order: 1 });
    assert.ok(validate(f).some((e) => /single-home pillar press-room/.test(e)));
  });
});

describe("agr fixture: parity with the constants", () => {
  it("ENGINE_BLOCKED_PILLARS.agr = [course-reviews, rankings, press-room], all present in the fixture", () => {
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.agr, ["course-reviews", "rankings", "press-room"]);
    assert.deepEqual(PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug).sort(), ["course-reviews", "press-room", "rankings"]);
    for (const p of PILLARS) assert.equal(isEngineBlockedPillar(SLUG, p.slug), !p.engineWritable, p.slug);
  });
  it("negative: golf-travel, the-game, gear-style, golf-business are engine-writable", () => {
    for (const s of ["golf-travel", "the-game", "gear-style", "golf-business"]) assert.equal(isEngineBlockedPillar(SLUG, s), false, s);
  });
  it("SINGLE_HOME_PILLARS.agr = [press-room]; only press-room is single-home", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS.agr, ["press-room"]);
    assert.deepEqual(PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["press-room"]);
    for (const p of PILLARS) assert.equal(isSingleHomePillar(SLUG, p.slug), p.slug === "press-room", p.slug);
  });
  it("negative: unhyphenated pressroom is neither single-home nor engine-blocked for agr", () => {
    assert.equal(isSingleHomePillar(SLUG, "pressroom"), false);
    assert.equal(isEngineBlockedPillar(SLUG, "pressroom"), false);
    assert.equal(PILLARS.some((p) => p.slug === "pressroom"), false);
  });
});

describe("planAgr (pure, never overwrites)", () => {
  it(`empty tenant: ${TOTAL_ROWS} x create; applied tenant: ${TOTAL_ROWS} x exists with no diffs`, () => {
    assert.deepEqual(planCounts(plan(build(), EMPTY)), { create: TOTAL_ROWS, exists: 0, refuse: 0 });
    const items = plan(build(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: TOTAL_ROWS, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("an existing press-room with a sub-section or a secondary-section reference is refused", () => {
    for (const extra of [{ subSectionCount: 1 }, { secondaryRefCount: 2 }]) {
      const ex = applied();
      ex.pillars = ex.pillars.map((p) => (p.slug === "press-room" ? { ...p, ...extra } : p));
      assert.equal(plan(build(), ex).find((i) => i.key === "press-room")!.action.kind, "refuse");
    }
  });
  it("edited description is a diff, not a write; author slug clash and tag title clash refuse", () => {
    const ex = applied();
    ex.pillars[0] = { ...ex.pillars[0]!, description: "Edited." };
    const it0 = plan(build(), ex).find((i) => i.key === "course-reviews")!;
    assert.equal(it0.action.kind, "exists");
    const a: AgrExisting = { ...EMPTY, authors: [{ name: "Rachel Lim", slug: "rachel" }], tags: [{ slug: "gear", title: "Equipment" }] };
    const items = plan(build(), a);
    assert.equal(items.find((i) => i.key === "Rachel Lim")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "gear")!.action.kind, "refuse");
  });
  it("diffFields ignores empty fixture fields", () => {
    assert.deepEqual(diffFields({ bio: "" }, { bio: "x" }, ["bio"]), []);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs, rejects other titles' authors and prototype keys", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "daniel-wong": { role: "Editor" } }));
    assert.equal(build({ authorOverrides: ov }).authors.find((x) => x.name === "Daniel Wong")!.role, "Editor");
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "lena-ho": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
  });
});
