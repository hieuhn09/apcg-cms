/**
 * Unit tests for ./prune-authors (Node's built-in runner; pure, no DB).
 *
 *   npm run test:prune-authors
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_POOLS,
  PLAN_KIND,
  PLAN_VERSION,
  classifyAuthor,
  parsePlan,
  reconcilePlan,
  summarise,
  toCsv,
  type AuthorUsage,
  type PruneAuthorsPlan,
} from "./prune-authors";

const NOW = new Date("2026-11-06T00:00:00Z");
const OPTS = { now: NOW, keepRecentDays: 30 };

function author(over: Partial<AuthorUsage> = {}): AuthorUsage {
  return {
    id: 1,
    tenant: "gcv",
    name: "Ghost Writer",
    role: "Staff Writer",
    rank: null,
    slug: null,
    userId: null,
    avatarId: null,
    hasBio: false,
    createdAt: "2026-08-01T00:00:00Z",
    engineArticles: 0,
    manualArticles: 0,
    importArticles: 0,
    coAuthorArticles: 0,
    draftRefs: 0,
    historyRefs: 0,
    lastPublishedAt: null,
    ...over,
  };
}

describe("classifyAuthor", () => {
  it("an unused, uncurated, old row is a delete candidate", () => {
    assert.deepEqual(classifyAuthor(author(), OPTS), { verdict: "delete", reasons: [] });
  });

  it("old-revision references alone do not keep a row", () => {
    assert.equal(classifyAuthor(author({ historyRefs: 12 }), OPTS).verdict, "delete");
  });

  const keeps: [string, Partial<AuthorUsage>, string][] = [
    ["engine article", { engineArticles: 1 }, "articles"],
    ["manual article", { manualArticles: 1 }, "articles"],
    ["imported article", { importArticles: 1 }, "articles"],
    ["co-author", { coAuthorArticles: 1 }, "articles"],
    ["open draft", { draftRefs: 1 }, "draft"],
    ["masthead rank", { rank: 3 }, "masthead"],
    ["rank zero", { rank: 0 }, "masthead"],
    ["linked user", { userId: 9 }, "user"],
    ["engine pool name", { name: "Camille Dubois" }, "engine"],
    ["created this week", { createdAt: "2026-11-03T00:00:00Z" }, "recent"],
    ["unreadable date", { createdAt: "" }, "recent"],
    ["slug", { slug: "jane" }, "profile"],
    ["avatar", { avatarId: 4 }, "profile"],
    ["bio", { hasBio: true }, "profile"],
  ];
  for (const [label, over, reason] of keeps) {
    it(`keeps: ${label}`, () => {
      const c = classifyAuthor(author(over), OPTS);
      assert.equal(c.verdict, "keep");
      assert.ok(c.reasons.includes(reason as never), `${c.reasons.join(",")} should include ${reason}`);
    });
  }

  it("engine pool is per tenant and exact", () => {
    assert.equal(classifyAuthor(author({ tenant: "wad", name: "Camille Dubois" }), OPTS).verdict, "delete");
    assert.equal(classifyAuthor(author({ name: "camille dubois" }), OPTS).verdict, "delete");
    assert.equal(classifyAuthor(author({ tenant: "brief-asia", name: "Tran Quoc Bao" }), OPTS).verdict, "keep");
    assert.equal(classifyAuthor(author({ tenant: null, name: "Camille Dubois" }), OPTS).verdict, "delete");
  });

  it("a blank slug is not a profile", () => {
    assert.equal(classifyAuthor(author({ slug: "  " }), OPTS).verdict, "delete");
  });

  it("keepRecentDays 0 disables the recent rule", () => {
    assert.equal(classifyAuthor(author({ createdAt: "2026-11-05T23:00:00Z" }), { now: NOW, keepRecentDays: 0 }).verdict, "delete");
  });
});

describe("ENGINE_POOLS", () => {
  it("covers the eleven engine tenants with no duplicate names inside a pool", () => {
    assert.equal(Object.keys(ENGINE_POOLS).length, 11);
    for (const [t, names] of Object.entries(ENGINE_POOLS)) assert.equal(new Set(names).size, names.length, t);
  });
});

describe("summarise", () => {
  it("counts per tenant and reasons", () => {
    const rows = [author({ id: 1 }), author({ id: 2, rank: 1, engineArticles: 3 }), author({ id: 3, tenant: "wad" })].map((usage) => ({
      usage,
      c: classifyAuthor(usage, OPTS),
    }));
    assert.deepEqual(summarise(rows), [
      { tenant: "gcv", total: 2, keep: 1, delete: 1, byReason: { articles: 1, masthead: 1 } },
      { tenant: "wad", total: 1, keep: 0, delete: 1, byReason: {} },
    ]);
  });
});

function plan(candidates: PruneAuthorsPlan["candidates"]): PruneAuthorsPlan {
  return { kind: PLAN_KIND, version: PLAN_VERSION, createdAt: "x", database: "h:5432/neondb", keepRecentDays: 30, tenants: null, candidates };
}

describe("parsePlan", () => {
  it("round-trips a valid plan", () => {
    const p = plan([{ id: 5, tenant: "gcv", name: "A" }]);
    assert.deepEqual(parsePlan(JSON.stringify(p)), p);
  });
  it("rejects junk, wrong kind, bad ids and duplicates", () => {
    assert.throws(() => parsePlan("{"), /JSON/);
    assert.throws(() => parsePlan(JSON.stringify({ ...plan([]), kind: "other" })), /not a/);
    assert.throws(() => parsePlan(JSON.stringify(plan([{ id: -1, tenant: "gcv", name: "A" }]))), /bad id/);
    assert.throws(() => parsePlan(JSON.stringify(plan([{ id: 1.5, tenant: "gcv", name: "A" }]))), /bad id/);
    assert.throws(() => parsePlan(JSON.stringify(plan([{ id: 2, tenant: "gcv", name: "A" }, { id: 2, tenant: "gcv", name: "A" }]))), /twice/);
    assert.throws(() => parsePlan(JSON.stringify({ ...plan([]), database: "" })), /database/);
  });
});

describe("reconcilePlan", () => {
  it("deletes only ids still unused with the same name and tenant", () => {
    const now = new Map(
      [author({ id: 1 }), author({ id: 2, manualArticles: 1 }), author({ id: 3, name: "Renamed" }), author({ id: 4, tenant: "wad" })].map((usage) => [
        usage.id,
        { usage, c: classifyAuthor(usage, OPTS) },
      ]),
    );
    const r = reconcilePlan(
      plan([
        { id: 1, tenant: "gcv", name: "Ghost Writer" },
        { id: 2, tenant: "gcv", name: "Ghost Writer" },
        { id: 3, tenant: "gcv", name: "Ghost Writer" },
        { id: 4, tenant: "gcv", name: "Ghost Writer" },
        { id: 99, tenant: "gcv", name: "Gone" },
      ]),
      now,
    );
    assert.deepEqual(r.ids, [1]);
    assert.deepEqual(
      r.skipped.map((s) => [s.id, s.why]),
      [
        [2, "now kept (articles)"],
        [3, "name or tenant changed"],
        [4, "name or tenant changed"],
        [99, "no longer exists"],
      ],
    );
  });
});

describe("toCsv", () => {
  it("quotes commas and quotes", () => {
    const usage = author({ name: 'O"Neil, Jr', role: null });
    const csv = toCsv([{ usage, c: classifyAuthor(usage, OPTS) }]);
    const line = csv.split("\n")[1] ?? "";
    assert.ok(line.startsWith('gcv,1,"O""Neil, Jr",,delete,,'), line);
  });
});
