/**
 * Unit tests for ./gtp-taxonomy (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * Fixture parity with the gtp-launch P1 slug contract (plan section 3), parity
 * with the gtp constants, the never-overwrite planner and the --authors-file
 * parser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";
import {
  GTP_AUTHORS,
  GTP_NEWSLETTERS,
  GTP_PILLARS,
  GTP_SUBSECTIONS,
  GTP_TAGS,
  GTP_TENANT_FIELDS,
  GTP_TENANT_SLUG,
  buildGtpFixture,
  diffFields,
  gtpSubSections,
  parseAuthorsFile,
  planCounts,
  planGtp,
  validateGtpFixture,
  type GtpExisting,
} from "./gtp-taxonomy";

const EMPTY: GtpExisting = { pillars: [], subSections: [], newsletters: [], authors: [], tags: [] };

/** An "existing" snapshot that mirrors a fully applied fixture. */
function applied(): GtpExisting {
  const f = buildGtpFixture();
  return {
    pillars: f.pillars.map((p) => ({ ...p })),
    subSections: f.subSections.map((s) => ({ ...s })),
    newsletters: f.newsletters.map((n) => ({ ...n })),
    authors: f.authors.map((a) => ({ ...a })),
    tags: f.tags.map((t) => ({ ...t })),
  };
}

describe("gtp fixture: slug contract (plan section 3)", () => {
  it("tenant slug is gtp", () => {
    assert.equal(GTP_TENANT_SLUG, "gtp");
    assert.equal(GTP_TENANT_FIELDS.slug, "gtp");
    assert.equal(GTP_TENANT_FIELDS.autoPublishEngineDrafts, false);
    assert.deepEqual(GTP_TENANT_FIELDS.supportedLanguages, ["en"]);
  });
  it("6 pillars in order 1..6 with the exact slugs", () => {
    assert.deepEqual(
      GTP_PILLARS.map((p) => [p.slug, p.title, p.order]),
      [
        ["news", "News", 1],
        ["destinations", "Destinations", 2],
        ["business-of-travel", "Business of Travel", 3],
        ["experiences-luxury", "Experiences & Luxury", 4],
        ["press-room", "Press Room", 5],
        ["events-awards", "Events & Awards", 6],
      ],
    );
    assert.equal(new Set(GTP_PILLARS.map((p) => p.order)).size, 6);
    for (const p of GTP_PILLARS) {
      assert.equal(p.heading, p.title);
      assert.equal(p.color, "var(--gtp-red)");
    }
  });
  it("20 base sub-sections (5+4+5+5+0+1), 21 with the optional gtp-events", () => {
    const per = (rows: { pillarSlug: string }[], s: string) => rows.filter((r) => r.pillarSlug === s).length;
    const base = gtpSubSections();
    assert.equal(base.length, 20);
    assert.equal(gtpSubSections({ includeGtpEvents: true }).length, 21);
    assert.equal(GTP_SUBSECTIONS.length, 21);
    assert.deepEqual(
      ["news", "destinations", "business-of-travel", "experiences-luxury", "press-room", "events-awards"].map((s) => per(base, s)),
      [5, 4, 5, 5, 0, 1],
    );
    assert.equal(base.some((s) => s.slug === "gtp-events"), false);
    assert.deepEqual(GTP_SUBSECTIONS.find((s) => s.slug === "gtp-events"), {
      pillarSlug: "events-awards",
      slug: "gtp-events",
      title: "GTP Events",
      order: 2,
      optional: true,
    });
  });
  it("exact sub-section slugs per pillar", () => {
    const by = (p: string) => GTP_SUBSECTIONS.filter((s) => s.pillarSlug === p).map((s) => s.slug);
    assert.deepEqual(by("news"), ["aviation", "hotels", "visa-entry", "destinations-news", "travel-tech"]);
    assert.deepEqual(by("destinations"), ["asia", "world", "guides", "trip-planning"]);
    assert.deepEqual(by("business-of-travel"), ["hospitality-business", "aviation-business", "destination-marketing", "people", "data-insights"]);
    assert.deepEqual(by("experiences-luxury"), ["luxury-stays", "food-drink", "wellness", "journeys", "style"]);
    assert.deepEqual(by("press-room"), []);
    assert.deepEqual(by("events-awards"), ["industry-calendar", "gtp-events"]);
  });
  it("every sub-section has an existing pillar, a 1-based order per pillar, and a tenant-unique slug", () => {
    const pillars = new Set(GTP_PILLARS.map((p) => p.slug));
    for (const s of GTP_SUBSECTIONS) assert.ok(pillars.has(s.pillarSlug), s.slug);
    for (const p of GTP_PILLARS) {
      const orders = GTP_SUBSECTIONS.filter((s) => s.pillarSlug === p.slug).map((s) => s.order);
      assert.deepEqual(orders, orders.map((_, i) => i + 1), p.slug);
    }
    assert.equal(new Set(GTP_SUBSECTIONS.map((s) => s.slug)).size, GTP_SUBSECTIONS.length);
  });
  it("40 owner-script rows = 6 pillars + 20 sub-sections + 2 newsletters + 6 authors + 6 tags", () => {
    const f = buildGtpFixture();
    assert.deepEqual([f.pillars.length, f.subSections.length, f.newsletters.length, f.authors.length, f.tags.length], [6, 20, 2, 6, 6]);
    assert.equal(planGtp(f, EMPTY).length, 40);
  });
  it("newsletters copy and order", () => {
    assert.deepEqual(
      GTP_NEWSLETTERS.map((n) => [n.slug, n.name, n.cadence, n.order, n.active]),
      [
        ["the-post", "The Post", "Three mornings a week", 1, true],
        ["business-of-travel-weekly", "Business of Travel Weekly", "Fridays", 2, true],
      ],
    );
  });
  it("authors: exactly the five editors plus GTP Newsroom; ranks and slugs unique; collective has no rank", () => {
    assert.deepEqual(
      GTP_AUTHORS.map((a) => a.name),
      ["Daniel Cheong", "Priya Nair", "Marcus Tan", "Natalie Ong", "Yuki Hamada", "GTP Newsroom"],
    );
    assert.deepEqual(GTP_AUTHORS.map((a) => a.rank), [1, 2, 3, 4, 5, undefined]);
    assert.equal(new Set(GTP_AUTHORS.map((a) => a.slug)).size, 6);
    assert.equal(GTP_AUTHORS.find((a) => a.name === "Yuki Hamada")?.role, "Japan Correspondent");
    assert.equal(GTP_AUTHORS.find((a) => a.name === "GTP Newsroom")?.role, "Newsroom");
  });
  it("tags: the six exact slugs; every pr-* title minus 'PR: ' is a P3 press-room chip", () => {
    assert.deepEqual(GTP_TAGS.map((t) => t.slug), [
      "partner-content",
      "pr-hotels-hospitality",
      "pr-aviation",
      "pr-destinations-dmo",
      "pr-travel-tech-business",
      "pr-people-on-the-move",
    ]);
    const chips = ["Hotels & Hospitality", "Aviation", "Destinations & DMOs", "Travel Tech & Business", "People on the Move"];
    assert.deepEqual(
      GTP_TAGS.filter((t) => t.slug.startsWith("pr-")).map((t) => t.title.replace(/^PR: /, "")),
      chips,
    );
  });
  it("no em dash or en dash anywhere in the fixture", () => {
    const all = JSON.stringify({ GTP_PILLARS, GTP_SUBSECTIONS, GTP_NEWSLETTERS, GTP_AUTHORS, GTP_TAGS, GTP_TENANT_FIELDS });
    assert.equal(/[–—]/.test(all), false);
  });
  it("validateGtpFixture accepts the default fixture and the gtp-events variant", () => {
    assert.deepEqual(validateGtpFixture(), []);
    assert.deepEqual(validateGtpFixture(buildGtpFixture({ includeGtpEvents: true })), []);
  });
});

describe("gtp fixture: parity with the constants", () => {
  it("exactly 4 engine-writable pillars (the P2 engine taxonomy list)", () => {
    assert.deepEqual(
      GTP_PILLARS.filter((p) => p.engineWritable).map((p) => p.slug),
      ["news", "destinations", "business-of-travel", "experiences-luxury"],
    );
    assert.deepEqual(GTP_PILLARS.filter((p) => !(ENGINE_BLOCKED_PILLARS.gtp ?? []).includes(p.slug)).length, 4);
  });
  it("every SINGLE_HOME_PILLARS.gtp / ENGINE_BLOCKED_PILLARS.gtp slug exists in the fixture", () => {
    const slugs = new Set(GTP_PILLARS.map((p) => p.slug));
    for (const s of [...(SINGLE_HOME_PILLARS.gtp ?? []), ...(ENGINE_BLOCKED_PILLARS.gtp ?? [])]) assert.ok(slugs.has(s), s);
    assert.deepEqual(GTP_PILLARS.filter((p) => p.singleHome).map((p) => p.slug), ["press-room"]);
  });
  it("press-room has zero sub-sections; a fixture that adds one is invalid", () => {
    assert.equal(GTP_SUBSECTIONS.filter((s) => s.pillarSlug === "press-room").length, 0);
    const f = buildGtpFixture();
    f.subSections.push({ pillarSlug: "press-room", slug: "x", title: "X", order: 1 });
    assert.ok(validateGtpFixture(f).some((e) => e.includes("single-home")));
  });
});

describe("planGtp (pure, never overwrites)", () => {
  it("empty tenant: 40 x create", () => {
    assert.deepEqual(planCounts(planGtp(buildGtpFixture(), EMPTY)), { create: 40, exists: 0, refuse: 0 });
  });
  it("idempotent: an applied tenant plans 40 x exists with no diffs", () => {
    const items = planGtp(buildGtpFixture(), applied());
    assert.deepEqual(planCounts(items), { create: 0, exists: 40, refuse: 0 });
    for (const i of items) if (i.action.kind === "exists") assert.deepEqual(i.action.diffs, [], i.key);
  });
  it("never overwrites: an edited pillar description is reported as a diff, kind stays exists", () => {
    const ex = applied();
    ex.pillars[0] = { ...ex.pillars[0]!, description: "Edited by an editor." };
    const item = planGtp(buildGtpFixture(), ex).find((i) => i.entity === "pillars" && i.key === "news")!;
    assert.equal(item.action.kind, "exists");
    assert.deepEqual(item.action.kind === "exists" ? item.action.diffs.map((d) => d.field) : [], ["description"]);
  });
  it("refuses an existing press-room pillar that has sub-sections or secondary references", () => {
    const ex = applied();
    ex.pillars = ex.pillars.map((p) => (p.slug === "press-room" ? { ...p, subSectionCount: 1 } : p));
    assert.equal(planGtp(buildGtpFixture(), ex).find((i) => i.key === "press-room")!.action.kind, "refuse");
    ex.pillars = ex.pillars.map((p) => (p.slug === "press-room" ? { ...p, subSectionCount: 0, secondaryRefCount: 2 } : p));
    assert.equal(planGtp(buildGtpFixture(), ex).find((i) => i.key === "press-room")!.action.kind, "refuse");
  });
  it("refuses a fixture sub-section under press-room", () => {
    const f = buildGtpFixture();
    f.subSections.push({ pillarSlug: "press-room", slug: "pr-x", title: "X", order: 1 });
    assert.equal(planGtp(f, EMPTY).find((i) => i.key === "press-room/pr-x")!.action.kind, "refuse");
  });
  it("refuses an author present by name with a different (or no) slug", () => {
    const ex: GtpExisting = { ...EMPTY, authors: [{ name: "Priya Nair", slug: "pnair" }] };
    assert.equal(planGtp(buildGtpFixture(), ex).find((i) => i.key === "Priya Nair")!.action.kind, "refuse");
    const ghost: GtpExisting = { ...EMPTY, authors: [{ name: "Priya Nair", slug: null }] };
    assert.equal(planGtp(buildGtpFixture(), ghost).find((i) => i.key === "Priya Nair")!.action.kind, "refuse");
  });
  it("refuses when an existing different author already owns a requested rank or slug", () => {
    const rank: GtpExisting = { ...EMPTY, authors: [{ name: "Someone Else", slug: "someone-else", rank: 1 }] };
    assert.equal(planGtp(buildGtpFixture(), rank).find((i) => i.key === "Daniel Cheong")!.action.kind, "refuse");
    const slug: GtpExisting = { ...EMPTY, authors: [{ name: "Someone Else", slug: "marcus-tan" }] };
    assert.equal(planGtp(buildGtpFixture(), slug).find((i) => i.key === "Marcus Tan")!.action.kind, "refuse");
  });
  it("refuses a same-slug tag with a different title; same title is exists", () => {
    const ex: GtpExisting = { ...EMPTY, tags: [{ slug: "pr-aviation", title: "Aviation PR" }, { slug: "partner-content", title: "Partner Content" }] };
    const items = planGtp(buildGtpFixture(), ex);
    assert.equal(items.find((i) => i.key === "pr-aviation")!.action.kind, "refuse");
    assert.equal(items.find((i) => i.key === "partner-content")!.action.kind, "exists");
  });
  it("diffFields ignores empty fixture fields and treats empty as equal", () => {
    assert.deepEqual(diffFields({ bio: "", role: "Staff Writer" }, { bio: "Long bio", role: "Staff Writer" }, ["bio", "role"]), []);
    assert.deepEqual(diffFields({ role: "Staff Writer" }, { role: "Editor" }, ["role"]), [{ field: "role", current: "Editor", fixture: "Staff Writer" }]);
  });
});

describe("parseAuthorsFile", () => {
  it("accepts known slugs with string fields and applies them in buildGtpFixture", () => {
    const ov = parseAuthorsFile(JSON.stringify({ "priya-nair": { role: "Asia Editor", bio: "Bio.", city: "Singapore", slug: "priya" } }));
    const a = buildGtpFixture({ authorOverrides: ov }).authors.find((x) => x.name === "Priya Nair")!;
    assert.deepEqual([a.role, a.bio, a.city, a.slug], ["Asia Editor", "Bio.", "Singapore", "priya"]);
  });
  it("rejects unknown slugs, unknown fields, non-strings, empty, over 2000 chars, bad slug, prototype keys, non-object", () => {
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "zed-nobody": { role: "x" } })), /unknown author slug/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { beats: "x" } })), /not an allowed field/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { role: 5 } })), /must be a string/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { role: "  " } })), /is empty/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { bio: "x".repeat(2001) } })), /over 2000/);
    assert.throws(() => parseAuthorsFile(JSON.stringify({ "priya-nair": { slug: "Bad Slug" } })), /kebab-case/);
    assert.throws(() => parseAuthorsFile('{"__proto__": {"role": "x"}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile('{"priya-nair": {"__proto__": {"x": 1}}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile('{"constructor": {}}'), /forbidden key/);
    assert.throws(() => parseAuthorsFile("[]"), /top level/);
    assert.throws(() => parseAuthorsFile("{nope"), /not valid JSON/);
    assert.equal(({} as Record<string, unknown>).role, undefined);
  });
});
