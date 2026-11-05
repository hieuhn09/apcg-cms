/**
 * Unit tests for ./asn-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the asn-launch plan delta §2 (design taxonomy), parity
 * with the asn constants (engine-blocked the-brief / columns / explainers /
 * press-room, single-home press-room), the never-overwrite planner and the
 * --authors-file parser. Mirrors ./amb-taxonomy.test.ts (no exhibition halls).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS, isEngineBlockedPillar } from "../../src/lib/constants";
import { isSingleHomePillar } from "../../src/lib/single-home-pillars";
import * as ASN from "./asn-taxonomy";
import {
  ASN_AUTHORS as AUTHORS,
  ASN_NEWSLETTERS as NEWSLETTERS,
  ASN_PILLARS as PILLARS,
  ASN_SUBSECTIONS as SUBS,
  ASN_TAGS as TAGS,
  ASN_TENANT_FIELDS as TENANT,
  ASN_TENANT_SLUG as SLUG,
  buildAsnFixture as build,
  diffFields,
  parseAuthorsFile,
  planCounts,
  planAsn as plan,
  validateAsnFixture as validate,
  type AsnExisting,
} from "./asn-taxonomy";

const EMPTY: AsnExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** 9 pillars + 17 sub-sections + 2 newsletters + 6 authors + 6 tags. */
const TOTAL_ROWS = 40;
const BYLINES = ["Mark Chen", "Anna Lee", "Linh Tran", "Ken Mori", "Grace Ong", "Ryan Cruz"];
const BLOCKED = ["the-brief", "columns", "explainers", "press-room"];
const WRITABLE = ["economies", "markets", "banking-fintech", "industries", "wealth"];
const kebab = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function applied(): AsnExisting {
  const f = build();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("asn fixture: tenant sheet", () => {
  it("slug, name, English only, Singapore, no domain/frontend yet, no auto-publish", () => {
    assert.equal(SLUG, "asn");
    assert.equal(TENANT.slug, SLUG);
    assert.equal(TENANT.name, "Asianomist");
    assert.equal(TENANT.status, "active");
    assert.equal(TENANT.defaultLanguage, "en");
    assert.deepEqual(TENANT.supportedLanguages, ["en"]);
    assert.equal(TENANT.timezone, "Asia/Singapore");
    assert.equal(TENANT.domain, "");
    assert.deepEqual(TENANT.additionalDomains, []);
    assert.equal(TENANT.frontendUrl, "");
    assert.equal(TENANT.autoPublishEngineDrafts, false);
  });
  it("features: articles, newsletters, corrections on; everything else off (no exhibition, no marketData, no translations)", () => {
    const on = Object.entries(TENANT.features).filter(([, v]) => v).map(([k]) => k).sort();
    assert.deepEqual(on, ["articles", "corrections", "newsletters"]);
    assert.equal(TENANT.features.exhibition, false);
    assert.equal(TENANT.features.marketData, false);
    assert.equal(TENANT.features.translations, false);
  });
  it("contacts (the design's mailboxes)", () => {
    assert.deepEqual(TENANT.contact, {
      editorial: "info@asianomist.com",
      general: "info@asianomist.com",
      advertising: "info@asiapresscentre.com",
      partnerships: "info@asiapresscentre.com",
    });
  });
  it("no exhibition halls exported (asn has no booths)", () => {
    assert.equal(Object.keys(ASN).some((k) => /HALL|EXHIBITION|BOOTH/i.test(k)), false);
    assert.equal(Object.keys(ASN).some((k) => /EXCLUDED/i.test(k)), false);
  });
});

describe("asn fixture: taxonomy (plan delta §2)", () => {
  it("9 pillars in design menu order (Press Room last) with exact slugs, titles and design descriptions (British spelling)", () => {
    assert.deepEqual(
      PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["the-brief", "The Brief", 1],
        ["economies", "Economies", 2],
        ["markets", "Markets", 3],
        ["banking-fintech", "Banking & Fintech", 4],
        ["industries", "Industries", 5],
        ["wealth", "Wealth", 6],
        ["columns", "Columns", 7],
        ["explainers", "Explainers", 8],
        ["press-room", "Press Room", 9],
      ],
    );
    const d = Object.fromEntries(PILLARS.map((p) => [p.slug, p.description]));
    assert.equal(d["the-brief"], "Our flagship daily newsletter, archived here in full. Asia's economy in five minutes, every weekday morning.");
    assert.equal(d.economies, "Growth, inflation and economic policy across Asia, reported country by country and connected region-wide.");
    assert.equal(d.markets, "The Asian trading day as it happens: currencies, stocks, bonds and deals, with context.");
    assert.equal(d["banking-fintech"], "Banks, digital lenders and payments across Asia, and the technology behind them.");
    assert.equal(d.industries, "Asia's real economy, sector by sector: manufacturing, energy, retail and property.");
    assert.equal(d.wealth, "Personal finance for professionals in Asia, covering investing, saving, property and pay, reported to the same standards as our news.");
    assert.equal(d.columns, "Signed opinion on Asia's economy and markets, sourced and clearly labelled.");
    assert.equal(d.explainers, "Short guides to how Asia's economies and markets work, each readable in five minutes.");
    assert.equal(d["press-room"], "Announcements from companies and institutions, published in full and clearly labelled, separate from our editorial coverage.");
    for (const p of PILLARS) {
      assert.equal(p.heading, p.title);
      assert.doesNotMatch(p.description, /[’‘]|labeled|center\b/, p.slug);
    }
    // The legacy combined pillar is gone (split into columns + explainers).
    assert.equal(PILLARS.some((p) => p.slug === "columns-explainers"), false);
  });
  it("17 sub-sections under the right pillars, with the design's descriptions; five pillars have none", () => {
    const by = (p: string) => SUBS.filter((s) => s.pillarSlug === p).map((s) => [s.slug, s.title, s.description]);
    assert.equal(SUBS.length, 17);
    assert.deepEqual(by("the-brief"), [
      ["week-ahead", "The Week Ahead", "The Sunday edition: the data releases, central-bank meetings and earnings that will shape the week in Asia."],
      ["weekend-read", "Weekend Read", "One story worth your Saturday: the week's best analysis, chosen and introduced by our editors."],
    ]);
    assert.deepEqual(by("economies"), [
      ["southeast-asia", "Southeast Asia", "Our home beat: Indonesia, Vietnam, Thailand, the Philippines, Malaysia and Singapore, covered with the depth the region rarely gets in English."],
      ["china", "China", "The region's largest economy, covered for what it means to business: demand, supply chains, policy and prices."],
      ["japan-korea", "Japan & Korea", "North Asia's industrial economies: the yen, the won and the companies built on both."],
      ["india-south-asia", "India & South Asia", "The fastest-growing large economy and its neighbours, from manufacturing incentives to market flows."],
      ["asia-world", "Asia & the World", "Trade, investment and capital flows between Asia and the rest of the world, measured in costs and volumes."],
    ]);
    assert.deepEqual(by("markets"), [
      ["markets-today", "Markets Today", "The daily close across Asia's markets: what moved, why, and what to watch tomorrow."],
      ["central-banks-currencies", "Central Banks & Currencies", "Every rate decision and major currency in the region, from the MAS to the BOJ, previewed, reported and explained."],
      ["stocks-bonds", "Stocks & Bonds", "Asia's equity and debt markets: the movers, the flows and the numbers behind them."],
      ["ipo-deals", "IPO & Deals", "Listings, mergers and funding rounds across the region, with the terms of each deal."],
      ["crypto-digital-assets", "Crypto & Digital Assets", "Digital assets covered like any other market: prices, regulation, licences and the businesses being built."],
    ]);
    assert.deepEqual(by("industries"), [
      ["supply-chain", "Supply Chain & the China+1 Shift", "Where factories, orders and investment are moving across Asia, tracked through company announcements, incentives and costs."],
      ["tech-semiconductors", "Tech & Semiconductors", "The chips, hardware and technology companies at the centre of Asia's economy and the world's."],
      ["energy-commodities", "Energy & Commodities", "The fuels, metals and crops that power the region, and the prices that discipline them."],
      ["consumer-retail", "Consumer & Retail", "Consumer companies, e-commerce and spending data across Asia."],
      ["real-estate-infrastructure", "Real Estate & Infrastructure", "Property markets and infrastructure projects: offices, housing, logistics parks, ports and power."],
    ]);
    for (const p of ["banking-fintech", "wealth", "columns", "explainers", "press-room"]) assert.deepEqual(by(p), [], p);
    // Legacy-only sub-sections are NOT in the new taxonomy (handled by the migration mapping).
    for (const s of ["morning-brief", "greater-china", "banks", "payments-lending", "insurtech-wealthtech", "investing", "savings-rates", "property-investment", "expat-money", "press-releases", "company-announcements", "market-notices"]) {
      assert.equal(SUBS.some((x) => x.slug === s), false, s);
    }
  });
  it("engine-writable sub-sections: 15 (the two The Brief editions are engine-blocked with their pillar)", () => {
    const writable = SUBS.filter((s) => PILLARS.find((p) => p.slug === s.pillarSlug)!.engineWritable);
    assert.equal(writable.length, 15);
  });
  it("slugs unique within the tenant (all entities) and sub-sections never shadow a pillar", () => {
    const f = build();
    const all = [...f.pillars.map((p) => p.slug), ...f.subSections.map((s) => s.slug)];
    assert.equal(new Set(all).size, all.length);
    assert.equal(new Set(f.tags.map((t) => t.slug)).size, f.tags.length);
    assert.equal(new Set(f.authors.map((a) => a.slug)).size, f.authors.length);
  });
  it("two newsletters: the-brief, the-week-ahead (design copy)", () => {
    assert.deepEqual(NEWSLETTERS.map((n) => [n.slug, n.name, n.cadence, n.order, n.active]), [
      ["the-brief", "The Brief", "Every weekday morning", 1, true],
      ["the-week-ahead", "The Week Ahead", "Sunday evenings", 2, true],
    ]);
    assert.deepEqual(NEWSLETTERS.map((n) => n.description), [
      "Asia's economy in five minutes, every weekday morning: what moved overnight, what it means, and one chart worth your attention. Written for people who make decisions about Asia before lunch.",
      "The Sunday edition: every data release, central-bank meeting and earnings date that matters in Asia next week, with a line on why.",
    ]);
  });
  it("authors: exactly the six Team names (Mark Chen first), design roles, 1-2 sentence bios naming Asianomist, no city", () => {
    assert.deepEqual(AUTHORS.map((a) => a.name), BYLINES);
    assert.deepEqual(AUTHORS.map((a) => a.slug), BYLINES.map(kebab));
    assert.deepEqual(AUTHORS.map((a) => [a.rank, a.role]), [
      [1, "Editor"],
      [2, "Deputy Editor"],
      [3, "Senior Reporter"],
      [4, "Senior Reporter"],
      [5, "Reporter"],
      [6, "Copy Editor"],
    ]);
    for (const a of AUTHORS) {
      assert.ok(a.bio!.startsWith(`${a.name} `), a.name);
      assert.match(a.bio!, /Asianomist/, a.name);
      const sentences = a.bio!.split(/(?<=\.)\s+/).filter(Boolean);
      assert.ok(sentences.length >= 1 && sentences.length <= 2, a.name);
      assert.equal(a.city, undefined);
    }
  });
  it("no shared newsroom/desk byline anywhere", () => {
    for (const a of AUTHORS) assert.doesNotMatch(a.name, /newsroom|editorial|team|desk|editors/i);
    assert.doesNotMatch(JSON.stringify(AUTHORS), /Asianomist Desk|Newsroom/i);
  });
  it("6 tags (D6)", () => {
    assert.deepEqual(TAGS.map((t) => [t.slug, t.title]), [
      ["china-plus-one-tracker", "China+1 Tracker"],
      ["chart-of-the-day", "Chart of the Day"],
      ["central-banks", "Central Banks"],
      ["ipo", "IPO"],
      ["supply-chain", "Supply Chain"],
      ["asean", "ASEAN"],
    ]);
  });
  it(`${TOTAL_ROWS} rows; validator clean; no em/en dash`, () => {
    const f = build();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [9, 17, 2, 6, 6]);
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

describe("asn fixture: parity with the constants", () => {
  it("ENGINE_BLOCKED_PILLARS.asn = [the-brief, columns, explainers, press-room], all present in the fixture", () => {
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.asn, BLOCKED);
    assert.deepEqual(PILLARS.filter((p) => !p.engineWritable).map((p) => p.slug), BLOCKED);
    for (const p of PILLARS) assert.equal(isEngineBlockedPillar(SLUG, p.slug), !p.engineWritable, p.slug);
  });
  it("negative: economies, markets, banking-fintech, industries, wealth are engine-writable", () => {
    assert.deepEqual(PILLARS.filter((p) => p.engineWritable).map((p) => p.slug), WRITABLE);
    for (const s of WRITABLE) assert.equal(isEngineBlockedPillar(SLUG, s), false, s);
  });
  it("SINGLE_HOME_PILLARS.asn = [press-room]; only press-room is single-home", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS.asn, ["press-room"]);
    assert.deepEqual(PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["press-room"]);
    for (const p of PILLARS) assert.equal(isSingleHomePillar(SLUG, p.slug), p.slug === "press-room", p.slug);
  });
  it("negative: unhyphenated pressroom is neither single-home nor engine-blocked for asn", () => {
    assert.equal(isSingleHomePillar(SLUG, "pressroom"), false);
    assert.equal(isEngineBlockedPillar(SLUG, "pressroom"), false);
    assert.equal(PILLARS.some((p) => p.slug === "pressroom"), false);
  });
});

describe("planAsn (pure, never overwrites)", () => {
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
    ex.pillars[1] = { ...ex.pillars[1]!, description: "Edited." };
    const it0 = plan(build(), ex).find((i) => i.key === "economies")!;
    assert.equal(it0.action.kind, "exists");
    assert.equal(it0.action.kind === "exists" ? it0.action.diffs[0]?.field : null, "description");
    const a: AsnExisting = { ...EMPTY, authors: [{ name: "Mark Chen", slug: "mark" }], tags: [{ slug: "ipo", title: "IPOs" }] };
    const items = plan(build(), a);
    assert.equal(items.find((i) => i.key === "Mark Chen")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "ipo")!.action.kind, "refuse");
  });
  it("diffFields ignores empty fixture fields", () => {
    assert.deepEqual(diffFields({ bio: "" }, { bio: "x" }, ["bio"]), []);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs, rejects other titles' authors and prototype keys", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "ryan-cruz": { role: "Sub-Editor" } }));
    assert.equal(build({ authorOverrides: ov }).authors.find((x) => x.name === "Ryan Cruz")!.role, "Sub-Editor");
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "rachel-tan": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
  });
});
