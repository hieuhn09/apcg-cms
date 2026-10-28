/**
 * Unit tests for ./amb-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the amb-launch plan delta §2 (design taxonomy), parity
 * with the amb constants (engine-blocked + single-home press-room), the
 * never-overwrite planner and the --authors-file parser. Mirrors
 * ./agr-taxonomy.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS, isEngineBlockedPillar } from "../../src/lib/constants";
import { isSingleHomePillar } from "../../src/lib/single-home-pillars";
import {
  AMB_AUTHORS as AUTHORS,
  AMB_ENGINE_EXCLUDED_SUBSECTIONS as EXCLUDED,
  AMB_EXHIBITION_HALLS as HALLS,
  AMB_NEWSLETTERS as NEWSLETTERS,
  AMB_PILLARS as PILLARS,
  AMB_SUBSECTIONS as SUBS,
  AMB_TAGS as TAGS,
  AMB_TENANT_FIELDS as TENANT,
  AMB_TENANT_SLUG as SLUG,
  buildAmbFixture as build,
  diffFields,
  parseAuthorsFile,
  planCounts,
  planAmb as plan,
  validateAmbFixture as validate,
  type AmbExisting,
} from "./amb-taxonomy";

const EMPTY: AmbExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 6 pillars + 18 sub-sections + 3 newsletters + 6 authors + 6 tags. */
const TOTAL_ROWS = 39;
const BYLINES = ["Rachel Tan", "Marcus Lim", "Siriporn Chaiyasit", "Dimas Prasetyo", "Lin Wei", "Aisyah Rahman"];
const kebab = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function applied(): AmbExisting {
  const f = build();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("amb fixture: tenant sheet", () => {
  it("slug, name, English only, Singapore, no domain/frontend, no auto-publish", () => {
    assert.equal(SLUG, "amb");
    assert.equal(TENANT.slug, SLUG);
    assert.equal(TENANT.name, "AsiaMaterialsBrief");
    assert.equal(TENANT.status, "active");
    assert.equal(TENANT.defaultLanguage, "en");
    assert.deepEqual(TENANT.supportedLanguages, ["en"]);
    assert.equal(TENANT.timezone, "Asia/Singapore");
    assert.equal(TENANT.domain, "");
    assert.deepEqual(TENANT.additionalDomains, []);
    assert.equal(TENANT.frontendUrl, "");
    assert.equal(TENANT.autoPublishEngineDrafts, false);
  });
  it("features: articles, newsletters, corrections, exhibition on; everything else (incl. translations) off", () => {
    const on = Object.entries(TENANT.features).filter(([, v]) => v).map(([k]) => k).sort();
    assert.deepEqual(on, ["articles", "corrections", "exhibition", "newsletters"]);
    assert.equal(TENANT.features.translations, false);
  });
  it("contacts (the design's mailboxes)", () => {
    assert.deepEqual(TENANT.contact, {
      editorial: "info@asiamaterialsbrief.com",
      general: "info@asiamaterialsbrief.com",
      advertising: "info@asiapresscentre.com",
      partnerships: "info@asiapresscentre.com",
    });
  });
});

describe("amb fixture: taxonomy (plan delta §2)", () => {
  it("6 pillars in design menu order with exact slugs, titles and design descriptions (American spelling)", () => {
    assert.deepEqual(
      PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["briefing", "Briefing", 1],
        ["materials", "Materials", 2],
        ["interiors-ffe", "Interiors & FF&E", 3],
        ["lighting-tech", "Lighting & Tech", 4],
        ["projects", "Projects & Inspiration", 5],
        ["press-room", "Press Room", 6],
      ],
    );
    const d = Object.fromEntries(PILLARS.map((p) => [p.slug, p.description]));
    assert.equal(d.briefing, "The business of building and furnishing Asia, companies, projects, policy, and people, reported and checked by our newsroom.");
    assert.equal(d.materials, "The materials Asia builds with, covered with specs, sources, and honest assessment of what's new.");
    assert.equal(d["interiors-ffe"], "Everything a project buys to furnish itself, from Asia's factories and the world's brands.");
    assert.equal(d["lighting-tech"], "Lighting, smart systems, and building technology, the layer that turns a structure into a working project.");
    assert.equal(d.projects, "What got built, what's in it, and who made it, from hotel case studies to the apartment ideas readers take home.");
    assert.equal(d["press-room"], "Official press releases, published in full, clearly labeled, and kept separate from our editorial coverage.");
    for (const p of PILLARS) {
      assert.equal(p.heading, p.title);
      assert.doesNotMatch(p.description, /[’‘]|labelled|centres|Aluminium/, p.slug);
    }
  });
  it("18 sub-sections under the right pillars, with the design's descriptions; press-room has none", () => {
    const by = (p: string) => SUBS.filter((s) => s.pillarSlug === p).map((s) => [s.slug, s.title, s.description]);
    assert.equal(SUBS.length, 18);
    assert.deepEqual(by("briefing"), [
      ["industry-news", "Industry News", "Factories, brands, retailers, and showrooms, who is expanding, investing, and winning orders."],
      ["projects-pipeline", "Projects & Pipeline", "The hotels, towers, and communities being built across Asia, and what they will buy."],
      ["policy-trade", "Policy & Trade", "Tariffs, green standards, and timber rules, checked against official sources."],
      ["people-firms", "People & Firms", "Appointments, studio moves, and the people shaping the industry."],
    ]);
    assert.deepEqual(by("materials"), [
      ["surfaces", "Surfaces", "Tile, stone, quartz, and flooring, the surfaces that define a project."],
      ["wood-panels", "Wood & Panels", "Asia's wood economy from forest to finished panel."],
      ["architectural", "Architectural", "The building envelope and what goes on it."],
      ["new-sustainable-materials", "New & Sustainable Materials", "The materials that didn't exist five years ago, assessed honestly, one a week."],
    ]);
    assert.deepEqual(by("interiors-ffe"), [
      ["furniture", "Furniture", "Asia makes the world's furniture. Here is who, where, and what's next."],
      ["soft-ffe", "Soft FF&E", "The soft layer that guests actually touch."],
      ["kitchen-bath", "Kitchen & Bath", "The two rooms that sell every home and rate every hotel."],
      ["decor-ose", "Decor & OS&E", "The finishing layer of hospitality."],
    ]);
    assert.deepEqual(by("lighting-tech"), [
      ["lighting", "Lighting", "From Guzhen's factories to the world's lobbies."],
      ["smart-building-home", "Smart Building & Home", "The connected layer of hotels and homes."],
      ["building-systems", "Building Systems", "The systems specified once and lived with for decades."],
    ]);
    assert.deepEqual(by("projects"), [
      ["specified", "Specified", "A project opens; we tell you what's in it. The suppliers, named."],
      ["home-renovation", "Home & Renovation", "The best of Asia's materials and design, brought home."],
      ["design-voices", "Design Voices", "The architects and interior designers shaping Asia's projects."],
    ]);
    assert.deepEqual(by("press-room"), []);
    // Intelligence, The Exhibition and Events & Fairs are pages; the design's third-level labels are display text only.
    for (const s of ["intelligence", "exhibition", "events-awards", "hotel-projects", "tile-ceramic"]) assert.equal(SUBS.some((x) => x.slug === s), false, s);
    for (const s of ["intelligence", "exhibition", "events-awards"]) assert.equal(PILLARS.some((x) => x.slug === s), false, s);
  });
  it("engine-excluded sub-sections: exactly specified and design-voices, both under projects", () => {
    assert.deepEqual([...EXCLUDED], ["specified", "design-voices"]);
    for (const s of EXCLUDED) assert.equal(SUBS.find((x) => x.slug === s)?.pillarSlug, "projects", s);
    // 16 sub-sections remain for the engine.
    assert.equal(SUBS.filter((s) => !EXCLUDED.includes(s.slug)).length, 16);
  });
  it("slugs unique within the tenant (all entities) and sub-sections never shadow a pillar", () => {
    const f = build();
    const all = [...f.pillars.map((p) => p.slug), ...f.subSections.map((s) => s.slug)];
    assert.equal(new Set(all).size, all.length);
    assert.equal(new Set(f.tags.map((t) => t.slug)).size, f.tags.length);
    assert.equal(new Set(f.authors.map((a) => a.slug)).size, f.authors.length);
  });
  it("three newsletters: the-materials-brief, pipeline-alert, home-design-ideas (design copy)", () => {
    assert.deepEqual(NEWSLETTERS.map((n) => [n.slug, n.name, n.cadence, n.order, n.active]), [
      ["the-materials-brief", "The Materials Brief", "Every Tuesday", 1, true],
      ["pipeline-alert", "Pipeline Alert", "Weekly", 2, true],
      ["home-design-ideas", "Home & Design Ideas", "Twice a month", 3, true],
    ]);
    assert.deepEqual(NEWSLETTERS.map((n) => n.description), [
      "The industry's week every Tuesday: the news that mattered, one new material worth knowing, one project worth studying, and the fair dates ahead.",
      "Projects before they buy, weekly: the hotels and residences approaching procurement across Asia, with scope and timeline where confirmed.",
      "The best of Asian materials and design, brought home, twice a month: apartment ideas, material guides, and the products worth the money.",
    ]);
  });
  it("authors: exactly the six Team names (Rachel Tan first), verbatim bios, design roles, no city", () => {
    assert.deepEqual(AUTHORS.map((a) => a.name), BYLINES);
    assert.deepEqual(AUTHORS.map((a) => a.slug), BYLINES.map(kebab));
    assert.deepEqual(AUTHORS.map((a) => [a.rank, a.role]), [
      [1, "Editor"],
      [2, "Deputy Editor"],
      [3, "Senior Reporter"],
      [4, "Reporter"],
      [5, "Reporter"],
      [6, "Contributing Writer"],
    ]);
    for (const a of AUTHORS) {
      assert.ok(a.bio!.startsWith(`${a.name} `), a.name);
      assert.equal(a.city, undefined);
    }
    assert.deepEqual(AUTHORS.map((a) => a.bio), [
      "Rachel Tan edits AsiaMaterialsBrief from Singapore. She reads the editorial inbox first and decides what the newsroom covers each day.",
      "Marcus Lim is deputy editor at AsiaMaterialsBrief. He runs daily news and the Briefing section, and spends much of the year at the region's trade fairs.",
      "Siriporn Chaiyasit is a senior reporter at AsiaMaterialsBrief. She writes about hotel projects, interiors and the buyers behind them.",
      "Dimas Prasetyo is a reporter at AsiaMaterialsBrief. He covers furniture, rattan and timber, from the workshop floor to the export order.",
      "Lin Wei is a reporter at AsiaMaterialsBrief. She covers lighting, ceramics and building products, and the factories that make them.",
      "Aisyah Rahman is a contributing writer at AsiaMaterialsBrief. She writes the Home & Renovation pieces, with an eye on what materials cost and how they wear.",
    ]);
  });
  it("no shared newsroom/editorial byline anywhere", () => {
    for (const a of AUTHORS) assert.doesNotMatch(a.name, /newsroom|editorial|team|desk|editors/i);
    assert.doesNotMatch(JSON.stringify(AUTHORS.map((a) => a.name)), /AMB Newsroom|AMB Editors/i);
  });
  it("6 tags (D6)", () => {
    assert.deepEqual(TAGS.map((t) => [t.slug, t.title]), [
      ["material-of-the-week", "Material of the Week"],
      ["inside-the-factory", "Inside the Factory"],
      ["pipeline-watch", "Pipeline Watch"],
      ["sourcing-route", "The Sourcing Route"],
      ["fairs", "Fairs"],
      ["sustainability", "Sustainability"],
    ]);
  });
  it("6 exhibition halls in the website's order (Hall 01..06), design titles; not taxonomy rows", () => {
    assert.deepEqual(HALLS.map((h) => [h.slug, h.title]), [
      ["manufacturers", "Manufacturers & Factories"],
      ["brands", "Brands"],
      ["design-studios", "Design Studios"],
      ["distributors-showrooms", "Distributors & Showrooms"],
      ["services", "Services"],
      ["country-pavilions", "Country Pavilions"],
    ]);
    for (const h of HALLS) assert.ok(h.description.length > 0, h.slug);
    assert.equal(/[–—]/.test(JSON.stringify(HALLS)), false);
  });
  it(`${TOTAL_ROWS} rows; validator clean; no em/en dash`, () => {
    const f = build();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [6, 18, 3, 6, 6]);
    assert.equal(plan(f, EMPTY).length, TOTAL_ROWS);
    assert.deepEqual(validate(), []);
    assert.equal(/[–—]/.test(JSON.stringify({ PILLARS, SUBS, NEWSLETTERS, AUTHORS, TAGS, TENANT })), false);
  });
  it("validator refuses a sub-section under the single-home press-room, and a sub-section without description", () => {
    const f = build();
    f.subSections.push({ pillarSlug: "press-room", slug: "press-releases", title: "Press Releases", order: 1, description: "x" });
    assert.ok(validate(f).some((e) => /single-home pillar press-room/.test(e)));
    const g = build();
    g.subSections[0] = { ...g.subSections[0]!, description: " " };
    assert.ok(validate(g).some((e) => /missing design description/.test(e)));
  });
});

describe("amb fixture: parity with the constants", () => {
  it("ENGINE_BLOCKED_PILLARS.amb = [press-room], present in the fixture", () => {
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.amb, ["press-room"]);
    assert.deepEqual(PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug), ["press-room"]);
    for (const p of PILLARS) assert.equal(isEngineBlockedPillar(SLUG, p.slug), !p.engineWritable, p.slug);
  });
  it("negative: briefing, materials, interiors-ffe, lighting-tech, projects are engine-writable", () => {
    for (const s of ["briefing", "materials", "interiors-ffe", "lighting-tech", "projects"]) assert.equal(isEngineBlockedPillar(SLUG, s), false, s);
  });
  it("SINGLE_HOME_PILLARS.amb = [press-room]; only press-room is single-home", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS.amb, ["press-room"]);
    assert.deepEqual(PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["press-room"]);
    for (const p of PILLARS) assert.equal(isSingleHomePillar(SLUG, p.slug), p.slug === "press-room", p.slug);
  });
  it("negative: unhyphenated pressroom is neither single-home nor engine-blocked for amb", () => {
    assert.equal(isSingleHomePillar(SLUG, "pressroom"), false);
    assert.equal(isEngineBlockedPillar(SLUG, "pressroom"), false);
    assert.equal(PILLARS.some((p) => p.slug === "pressroom"), false);
  });
});

describe("planAmb (pure, never overwrites)", () => {
  it(`empty tenant: ${TOTAL_ROWS} x create; applied tenant: ${TOTAL_ROWS} x exists with no diffs`, () => {
    assert.deepEqual(planCounts(plan(build(), EMPTY)), { create: TOTAL_ROWS, exists: 0, refuse: 0 });
    const items = plan(build(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: TOTAL_ROWS, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("a sub-section row read back from Central (no description) is still exists with no diffs", () => {
    const ex = applied();
    ex.subSections = ex.subSections.map((row) => {
      const rest: Record<string, unknown> & { pillarSlug: string; slug: string } = { ...row };
      delete rest.description;
      return rest;
    });
    for (const i of plan(build(), ex).filter((x) => x.entity === "subsections")) {
      assert.equal(i.action.kind, "exists", i.key);
      if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
    }
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
    const it0 = plan(build(), ex).find((i) => i.key === "briefing")!;
    assert.equal(it0.action.kind, "exists");
    assert.equal(it0.action.kind === "exists" ? it0.action.diffs[0]?.field : null, "description");
    const a: AmbExisting = { ...EMPTY, authors: [{ name: "Rachel Tan", slug: "rachel" }], tags: [{ slug: "fairs", title: "Trade Fairs" }] };
    const items = plan(build(), a);
    assert.equal(items.find((i) => i.key === "Rachel Tan")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "fairs")!.action.kind, "refuse");
  });
  it("diffFields ignores empty fixture fields", () => {
    assert.deepEqual(diffFields({ bio: "" }, { bio: "x" }, ["bio"]), []);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs, rejects other titles' authors and prototype keys", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "aisyah-rahman": { role: "Reporter" } }));
    assert.equal(build({ authorOverrides: ov }).authors.find((x) => x.name === "Aisyah Rahman")!.role, "Reporter");
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "rachel-lim": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
  });
});
