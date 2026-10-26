/**
 * Unit tests for ./aer-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the aer-launch plan delta §2 (design taxonomy), parity
 * with the aer constants (engine-blocked, NO single-home), the
 * never-overwrite planner and the --authors-file parser. Mirrors
 * ./vowasia-taxonomy.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS, isEngineBlockedPillar } from "../../src/lib/constants";
import { isSingleHomePillar } from "../../src/lib/single-home-pillars";
import {
  AER_AUTHORS as AUTHORS,
  AER_NEWSLETTERS as NEWSLETTERS,
  AER_PILLARS as PILLARS,
  AER_SUBSECTIONS as SUBS,
  AER_TAGS as TAGS,
  AER_TENANT_FIELDS as TENANT,
  AER_TENANT_SLUG as SLUG,
  buildAerFixture as build,
  diffFields,
  parseAuthorsFile,
  planCounts,
  planAer as plan,
  validateAerFixture as validate,
  type AerExisting,
} from "./aer-taxonomy";

const EMPTY: AerExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 6 pillars + 12 sub-sections + 1 newsletter + 4 authors + 6 tags. */
const TOTAL_ROWS = 29;
const BYLINES = ["Lena Ho", "Arjun Menon", "Mei Fong Chua", "Rahul Sethi"];
const kebab = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function applied(): AerExisting {
  const f = build();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("aer fixture: tenant sheet", () => {
  it("slug, name, English only, Singapore, no domain/frontend, no auto-publish", () => {
    assert.equal(SLUG, "aer");
    assert.equal(TENANT.slug, SLUG);
    assert.equal(TENANT.name, "Asia Economic Review");
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
      editorial: "editor@asiaeconomicreview.com",
      general: "info@asiaeconomicreview.com",
      advertising: "info@asiapresscentre.com",
      partnerships: "info@asiapresscentre.com",
    });
  });
});

describe("aer fixture: taxonomy (plan delta §2)", () => {
  it("6 pillars in design menu order with exact slugs, titles and descriptions", () => {
    assert.deepEqual(
      PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["asia-watch", "Asia Watch", 1],
        ["briefings", "Briefings", 2],
        ["corporate-asia", "Corporate Asia", 3],
        ["interviews", "The Review Interview", 4],
        ["long-view", "The Long View", 5],
        ["in-focus", "In Focus", 6],
      ],
    );
    const d = Object.fromEntries(PILLARS.map((p) => [p.slug, p.description]));
    assert.equal(d["asia-watch"], "News and reporting on policy, trade, finance, industry and energy, and on the people and places behind the numbers.");
    assert.equal(d.briefings, "One question, one evidenced answer, published through the week.");
    assert.equal(d["corporate-asia"], "The companies that move the region's economy, analysed at strategy level.");
    assert.equal(d.interviews, "Extended conversations, on the record, with the people running Asia's economy.");
    assert.equal(d["long-view"], "Long-form analysis of Asia's economy: one argument, made well, with the evidence to check it.");
    assert.equal(d["in-focus"], "Quarterly files that examine one country or industry properly, built essay by essay into a durable reference.");
    for (const p of PILLARS) assert.equal(p.heading, p.title);
  });
  it("12 sub-sections under the right pillars", () => {
    const by = (p: string) => SUBS.filter((s) => s.pillarSlug === p).map((s) => [s.slug, s.title]);
    assert.equal(SUBS.length, 12);
    assert.deepEqual(by("asia-watch"), [
      ["growth-policy", "Growth & Policy"],
      ["trade-supply-chains", "Trade & Supply Chains"],
      ["money-finance", "Money & Finance"],
      ["technology-industry", "Technology & Industry"],
      ["energy-climate", "Energy & Climate"],
    ]);
    assert.deepEqual(by("briefings"), [
      ["policy", "Policy"],
      ["markets", "Markets"],
      ["industry", "Industry"],
      ["companies", "Companies"],
    ]);
    assert.deepEqual(by("corporate-asia"), [
      ["capital", "Capital"],
      ["strategy", "Strategy"],
      ["leadership", "Leadership"],
    ]);
    for (const p of ["interviews", "long-view", "in-focus"]) assert.deepEqual(by(p), []);
  });
  it("slugs unique within the tenant (all entities) and sub-sections never shadow a pillar", () => {
    const f = build();
    const all = [...f.pillars.map((p) => p.slug), ...f.subSections.map((s) => s.slug)];
    assert.equal(new Set(all).size, all.length);
    assert.equal(new Set(f.tags.map((t) => t.slug)).size, f.tags.length);
    assert.equal(new Set(f.authors.map((a) => a.slug)).size, f.authors.length);
  });
  it("one newsletter: weekly-review / The Weekly Review", () => {
    assert.deepEqual(NEWSLETTERS.map((n) => [n.slug, n.name, n.order, n.active]), [["weekly-review", "The Weekly Review", 1, true]]);
  });
  it("authors: exactly the four Team names, verbatim bios, general roles, no city", () => {
    assert.deepEqual(AUTHORS.map((a) => a.name), BYLINES);
    assert.deepEqual(AUTHORS.map((a) => a.slug), BYLINES.map(kebab));
    assert.deepEqual(AUTHORS.map((a) => [a.rank, a.role]), [
      [1, "Editor"],
      [2, "Senior Writer"],
      [3, "Senior Writer"],
      [4, "Contributing Editor"],
    ]);
    for (const a of AUTHORS) {
      assert.ok(a.bio!.startsWith(`${a.name} is `), a.name);
      assert.equal(a.city, undefined);
    }
    assert.equal(
      AUTHORS[0]!.bio,
      "Lena Ho is an editor at Asia Economic Review. She looks at how decisions on interest rates, regulation and trade change the costs and choices facing businesses in the region.",
    );
  });
  it("no shared newsroom/editorial byline anywhere", () => {
    for (const a of AUTHORS) assert.doesNotMatch(a.name, /newsroom|editorial|team|desk/i);
    assert.doesNotMatch(JSON.stringify(AUTHORS), /editorial team|Newsroom/i);
  });
  it("6 country tags", () => {
    assert.deepEqual(TAGS.map((t) => t.slug), ["china", "india", "japan", "south-korea", "indonesia", "vietnam"]);
  });
  it(`${TOTAL_ROWS} rows; validator clean; no em/en dash`, () => {
    const f = build();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [6, 12, 1, 4, 6]);
    assert.equal(plan(f, EMPTY).length, TOTAL_ROWS);
    assert.deepEqual(validate(), []);
    assert.equal(/[–—]/.test(JSON.stringify({ PILLARS, SUBS, NEWSLETTERS, AUTHORS, TAGS, TENANT })), false);
  });
});

describe("aer fixture: parity with the constants", () => {
  it("ENGINE_BLOCKED_PILLARS.aer = [long-view, interviews, in-focus], all present in the fixture", () => {
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.aer, ["long-view", "interviews", "in-focus"]);
    assert.deepEqual(PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug).sort(), ["in-focus", "interviews", "long-view"]);
    for (const p of PILLARS) assert.equal(isEngineBlockedPillar(SLUG, p.slug), !p.engineWritable, p.slug);
  });
  it("negative: asia-watch, briefings, corporate-asia are engine-writable", () => {
    for (const s of ["asia-watch", "briefings", "corporate-asia"]) assert.equal(isEngineBlockedPillar(SLUG, s), false, s);
  });
  it("no single-home pillar: no SINGLE_HOME_PILLARS key; pressroom/press-room mean nothing here", () => {
    assert.equal(Object.hasOwn(SINGLE_HOME_PILLARS, SLUG), false);
    assert.equal(PILLARS.some((p) => p.singleHome), false);
    for (const s of ["pressroom", "press-room"]) {
      assert.equal(isSingleHomePillar(SLUG, s), false, s);
      assert.equal(isEngineBlockedPillar(SLUG, s), false, s);
      assert.equal(PILLARS.some((p) => p.slug === s), false, s);
    }
    for (const p of PILLARS) assert.equal(isSingleHomePillar(SLUG, p.slug), false, p.slug);
  });
});

describe("planAer (pure, never overwrites)", () => {
  it(`empty tenant: ${TOTAL_ROWS} x create; applied tenant: ${TOTAL_ROWS} x exists with no diffs`, () => {
    assert.deepEqual(planCounts(plan(build(), EMPTY)), { create: TOTAL_ROWS, exists: 0, refuse: 0 });
    const items = plan(build(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: TOTAL_ROWS, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("edited description is a diff, not a write; author slug clash and tag title clash refuse", () => {
    const ex = applied();
    ex.pillars[0] = { ...ex.pillars[0]!, description: "Edited." };
    const it0 = plan(build(), ex).find((i) => i.key === "asia-watch")!;
    assert.equal(it0.action.kind, "exists");
    const a: AerExisting = { ...EMPTY, authors: [{ name: "Lena Ho", slug: "lena" }], tags: [{ slug: "china", title: "PRC" }] };
    const items = plan(build(), a);
    assert.equal(items.find((i) => i.key === "Lena Ho")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "china")!.action.kind, "refuse");
  });
  it("diffFields ignores empty fixture fields", () => {
    assert.deepEqual(diffFields({ bio: "" }, { bio: "x" }, ["bio"]), []);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs, rejects other titles' authors and prototype keys", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "rahul-sethi": { role: "Editor" } }));
    assert.equal(build({ authorOverrides: ov }).authors.find((x) => x.name === "Rahul Sethi")!.role, "Editor");
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "serene-chia": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
  });
});
