/**
 * Unit tests for ./reassign-authors (Node's built-in runner; pure, no DB).
 *
 *   npm run test:reassign-authors
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_POOLS } from "./prune-authors";
import {
  GCV_RULES,
  PLAN_KIND,
  PLAN_VERSION,
  buildReassignPlan,
  countByOp,
  parsePlan,
  reconcilePlan,
  toCsv,
  type ArticleRow,
  type AuthorRow,
  type ReassignAuthorsPlan,
  type ReassignInput,
  type ReassignRules,
  type RelRow,
  type VersionRow,
} from "./reassign-authors";

/* ── Fixture: a small GCV ────────────────────────────────────────────────── */

const POOL = ENGINE_POOLS.gcv ?? [];
// ids 1-7 pool (in ENGINE_POOLS order), 10-15 keep/merge, 20+ remove
const poolRows: AuthorRow[] = POOL.map((name, i) => ({ id: i + 1, name, rank: null, userId: null }));
const keepRows: AuthorRow[] = [
  { id: 10, name: "Alexandre Rodrigues", rank: 1, userId: 3 },
  { id: 11, name: "Amelia Tan", rank: null, userId: null },
  { id: 12, name: "Simon Ng", rank: null, userId: null },
  { id: 13, name: "Valerie Nguyen", rank: null, userId: null },
  { id: 14, name: "Valerie Nguyen ", rank: null, userId: null },
  { id: 15, name: "Tu C. Nguyen ", rank: null, userId: null },
];
const OLD = { id: 20, name: "Sofia I. Anders", rank: null, userId: null };
const LEGACY_A = { id: 21, name: "Legacy Writer A", rank: null, userId: null };
const LEGACY_B = { id: 22, name: "Global Chic Voyage", rank: null, userId: null };

function art(id: number, authorId: number | null, over: Partial<ArticleRow> = {}): ArticleRow {
  return { id, tenant: "gcv", authorId, origin: "import", slug: `s-${id}`, title: `T ${id}`, ...over };
}
const ver = (id: number, articleId: number | null, authorId: number | null): VersionRow => ({ id, articleId, authorId });

function base(over: Partial<ReassignInput> = {}): ReassignInput {
  return {
    authors: [...poolRows, ...keepRows, OLD, LEGACY_A, LEGACY_B],
    articles: [
      // pool live counts: Isabelle 3, Camille 2, Hugo 1, others 0
      art(100, 1, { origin: "engine" }), art(101, 1), art(102, 1),
      art(103, 2), art(104, 2, { origin: "engine" }),
      art(105, 3),
      // manual articles of real writers
      art(110, 10, { origin: "manual" }), art(111, 14, { origin: "manual" }), art(112, 15, { origin: "manual" }),
      // legacy-archive articles to reassign (ids deliberately out of order)
      art(205, 21), art(201, 22), art(203, 21),
    ],
    versions: [
      ver(1000, 101, 20), // stale draft naming an old name, main row is pool #1 -> sync
      ver(1001, 103, 20), // -> sync to #2
      ver(1002, 201, 22), // reassigned article: follows
      ver(1003, 203, 3), // reassigned article, but version names a pool author: untouched
      ver(1004, 111, 14), // merge source on a version
      ver(1005, 111, 20), // REMOVE on version whose article is on the merge source -> sync to the target
      ver(1006, 110, 10), // nothing to do
    ],
    rels: [],
    ...over,
  };
}

const run = (input: ReassignInput, rules: ReassignRules = GCV_RULES) => buildReassignPlan(input, rules);

/* ── Set resolution ─────────────────────────────────────────────────────── */

describe("GCV_RULES", () => {
  it("takes the pool from ENGINE_POOLS.gcv and names the approved sets exactly", () => {
    assert.deepEqual(GCV_RULES.pool, ENGINE_POOLS.gcv);
    assert.equal(GCV_RULES.pool.length, 7);
    assert.equal(GCV_RULES.tenant, "gcv");
    assert.deepEqual(GCV_RULES.merge, { from: "Valerie Nguyen ", to: "Valerie Nguyen" });
    assert.deepEqual(GCV_RULES.rename, { from: "Tu C. Nguyen ", to: "Tu C. Nguyen" });
    for (const n of ["Alexandre Rodrigues", "Amelia Tan", "Simon Ng", "Valerie Nguyen", "Tu C. Nguyen "]) assert.ok(GCV_RULES.keep.includes(n), n);
    assert.equal(GCV_RULES.expectedRemove, 55);
  });
});

describe("set resolution", () => {
  it("REMOVE is every other tenant author; merge source and keep names are excluded", () => {
    const r = run(base());
    assert.deepEqual(r.aborts, []);
    assert.deepEqual(r.remove.map((x) => x.id).sort(), [20, 21, 22]);
    assert.deepEqual(r.pool.map((p) => p.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(r.keep.map((k) => k.id).sort((a, b) => a - b), [10, 11, 12, 13, 15]);
    assert.deepEqual(r.mergeFrom, { id: 14, name: "Valerie Nguyen " });
    assert.deepEqual(r.mergeTo, { id: 13, name: "Valerie Nguyen" });
  });

  it("names match exactly: a trailing-space variant of a keep name is REMOVE (and flagged)", () => {
    const r = run(base({ authors: [...base().authors, { id: 30, name: "Simon Ng ", rank: null, userId: null }] }));
    assert.ok(r.remove.some((x) => x.id === 30));
    assert.ok(r.warnings.some((w) => w.includes("#30") && w.includes("looks like kept author #12")));
  });

  it("reports per-REMOVE usage counts", () => {
    const r = run(base());
    const byId = new Map(r.remove.map((x) => [x.id, x]));
    assert.deepEqual(byId.get(20), { id: 20, name: "Sofia I. Anders", importArticles: 0, otherArticles: 0, coAuthorRels: 0, latestVersionRefs: 3 });
    assert.equal(byId.get(21)?.importArticles, 2);
    assert.equal(byId.get(22)?.latestVersionRefs, 1);
  });

  it("aborts on a missing or duplicated pool name", () => {
    const missing = run(base({ authors: base().authors.filter((a) => a.id !== 4) }));
    assert.ok(missing.aborts.some((a) => a.includes(`POOL author ${JSON.stringify(POOL[3])} not found`)));
    const dup = run(base({ authors: [...base().authors, { id: 40, name: POOL[0] as string, rank: null, userId: null }] }));
    assert.ok(dup.aborts.some((a) => a.includes("ambiguous")));
  });

  it("aborts when the merge target is missing but the source exists", () => {
    const r = run(base({ authors: base().authors.filter((a) => a.id !== 13), versions: [], articles: [] }));
    assert.ok(r.aborts.some((a) => a.includes("MERGE target")));
  });

  it("nothing to merge (source already gone) is not an error", () => {
    const r = run(base({ authors: base().authors.filter((a) => a.id !== 14), articles: base().articles.filter((a) => a.authorId !== 14), versions: [] }));
    assert.deepEqual(r.aborts, []);
    assert.equal(r.mergeFrom, null);
    assert.ok(!r.changes.some((c) => c.op === "merge"));
  });
});

/* ── Abort rules ────────────────────────────────────────────────────────── */

describe("abort rules", () => {
  const withRemove = (over: Partial<AuthorRow>) =>
    run(base({ authors: base().authors.map((a) => (a.id === 21 ? { ...a, ...over } : a)) }));

  it("REMOVE author with a masthead rank (0 included)", () => {
    assert.ok(withRemove({ rank: 0 }).aborts.some((a) => a.includes("#21") && a.includes("masthead rank 0")));
  });

  it("REMOVE author linked to a user", () => {
    assert.ok(withRemove({ userId: 9 }).aborts.some((a) => a.includes("#21") && a.includes("CMS user #9")));
  });

  it("REMOVE author with a live engine or manual article", () => {
    for (const origin of ["engine", "manual", null]) {
      const r = run(base({ articles: [...base().articles, art(300, 22, { origin })] }));
      assert.ok(r.aborts.some((a) => a.includes("#22") && a.includes("1 live engine/manual")), String(origin));
      assert.ok(!r.changes.some((c) => c.rowId === 300), "a non-import article is never reassigned");
    }
  });

  it("co-author rel on a REMOVE author, live or latest version", () => {
    for (const table of ["articles_rels", "_articles_v_rels"] as const) {
      const rel: RelRow = { table, id: 77, parentId: table === "articles_rels" ? 110 : 1006, articleId: 110, authorId: 20 };
      const r = run(base({ rels: [rel] }));
      assert.ok(r.aborts.some((a) => a.includes(`${table} #77`) && a.includes("REMOVE author #20")), table);
      assert.equal(r.remove.find((x) => x.id === 20)?.coAuthorRels, 1);
    }
  });

  it("sync with nothing safe to copy: main row has no author or an outside author", () => {
    const noAuthor = run(base({ articles: [...base().articles, art(400, null, { origin: "manual" })], versions: [ver(2000, 400, 20)] }));
    assert.ok(noAuthor.aborts.some((a) => a.includes("#2000") && a.includes("no author")));
    const outside = run(base({ articles: [...base().articles, art(401, 999, { origin: "manual" })], versions: [ver(2001, 401, 20)] }));
    assert.ok(outside.aborts.some((a) => a.includes("#2001") && a.includes("author #999 outside gcv")));
  });

  it("merge that would duplicate a co-author on the same row", () => {
    const rels: RelRow[] = [
      { table: "articles_rels", id: 50, parentId: 110, articleId: 110, authorId: 14 },
      { table: "articles_rels", id: 51, parentId: 110, articleId: 110, authorId: 13 },
    ];
    const r = run(base({ rels }));
    assert.ok(r.aborts.some((a) => a.includes("articles_rels #50") && a.includes("twice")));
  });

  it("rename target already exists", () => {
    const r = run(base({ authors: [...base().authors, { id: 16, name: "Tu C. Nguyen", rank: null, userId: null }] }));
    assert.ok(r.aborts.some((a) => a.includes("cannot rename #15")));
    assert.deepEqual(r.renames, []);
  });

  it("a clean fixture has no abort", () => {
    assert.deepEqual(run(base()).aborts, []);
  });
});

/* ── Changes ────────────────────────────────────────────────────────────── */

describe("changes", () => {
  it("sync copies the main row's author onto a stale latest version", () => {
    const r = run(base());
    const sync = r.changes.filter((c) => c.op === "sync").map((c) => [c.rowId, c.from, c.to]);
    assert.deepEqual(sync, [
      [1000, 20, 1],
      [1001, 20, 2],
      [1005, 20, 13], // main row is on the merge source: sync goes to the merge target
    ]);
  });

  it("merge moves the source everywhere it is used in the tenant", () => {
    const rels: RelRow[] = [
      { table: "articles_rels", id: 60, parentId: 112, articleId: 112, authorId: 14 },
      { table: "_articles_v_rels", id: 61, parentId: 1006, articleId: 110, authorId: 14 },
    ];
    const r = run(base({ rels }));
    const merge = r.changes.filter((c) => c.op === "merge").map((c) => [c.table, c.rowId, c.from, c.to, c.parentId]);
    assert.deepEqual(merge, [
      ["articles", 111, 14, 13, null],
      ["_articles_v", 1004, 14, 13, null],
      ["articles_rels", 60, 14, 13, null],
      ["_articles_v_rels", 61, 14, 13, 1006],
    ]);
  });

  it("rename trims the trailing space", () => {
    assert.deepEqual(run(base()).renames, [{ authorId: 15, from: "Tu C. Nguyen ", to: "Tu C. Nguyen" }]);
  });

  it("rename is skipped (not an error) once done", () => {
    const authors = base().authors.map((a) => (a.id === 15 ? { ...a, name: "Tu C. Nguyen" } : a));
    const r = run(base({ authors }));
    assert.deepEqual(r.aborts, []);
    assert.deepEqual(r.renames, []);
    assert.ok(r.keep.some((k) => k.id === 15));
  });

  it("versions with a pool author, a keep author or history are untouched", () => {
    const touched = new Set(run(base()).changes.map((c) => `${c.table}:${c.rowId}`));
    assert.ok(!touched.has("_articles_v:1003"));
    assert.ok(!touched.has("_articles_v:1006"));
  });

  it("another tenant's references are left alone and reported", () => {
    const r = run(
      base({
        articles: [...base().articles, art(500, 21, { tenant: "wad" }), art(501, 14, { tenant: "wad", origin: "manual" })],
        versions: [...base().versions, ver(3000, 500, 20)],
      }),
    );
    assert.deepEqual(r.aborts, []);
    assert.ok(!r.changes.some((c) => c.rowId === 500 || c.rowId === 501 || c.rowId === 3000));
    assert.equal(r.warnings.filter((w) => w.includes("left alone")).length, 3);
  });

  it("an empty tenant yields nothing", () => {
    const r = run({ authors: poolRows, articles: [], versions: [], rels: [] });
    assert.deepEqual([r.changes, r.renames, r.remove, r.aborts], [[], [], [], []]);
  });

  it("countByOp groups by op and table", () => {
    assert.deepEqual(countByOp(run(base()).changes), {
      "reassign articles": 3,
      "merge articles": 1,
      "sync _articles_v": 3,
      "reassign _articles_v": 1,
      "merge _articles_v": 1,
    });
  });
});

/* ── Deterministic balanced assignment ──────────────────────────────────── */

describe("reassign", () => {
  it("sorts articles by id and round-robins over the pool, least-used first, then name", () => {
    const r = run(base());
    // counts: #1 3, #2 2, #3 1, #4..#7 0 -> zero-count authors first, by name
    const zero = POOL.slice(3).map((n, i) => ({ n, id: i + 4 })).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    const expected = [201, 203, 205].map((id, i) => [id, zero[i]?.id]);
    assert.deepEqual(r.changes.filter((c) => c.op === "reassign" && c.table === "articles").map((c) => [c.rowId, c.to]), expected);
    // the reassigned article's stale version follows the same author
    const v = r.changes.find((c) => c.table === "_articles_v" && c.rowId === 1002);
    assert.equal(v?.op, "reassign");
    assert.equal(v?.to, expected[0]?.[1]);
  });

  it("is balanced: final counts differ by at most one when starting even", () => {
    const articles = Array.from({ length: 66 }, (_, i) => art(1000 + i, i % 2 === 0 ? 21 : 22));
    const r = run({ authors: base().authors, articles, versions: [], rels: [] });
    const after = r.poolCounts.map((p) => p.after);
    assert.equal(after.reduce((a, b) => a + b, 0), 66);
    assert.ok(Math.max(...after) - Math.min(...after) <= 1, after.join(","));
    assert.ok(r.poolCounts.every((p) => p.before === 0));
  });

  it("is reproducible regardless of input order", () => {
    const a = run(base());
    const shuffled = base();
    shuffled.articles.reverse();
    shuffled.authors.reverse();
    shuffled.versions.reverse();
    assert.deepEqual(run(shuffled).changes, a.changes);
  });

  it("reports before/after per pool author", () => {
    const r = run(base());
    const total = (k: "before" | "after") => r.poolCounts.reduce((s, p) => s + p[k], 0);
    assert.equal(total("before"), 6);
    assert.equal(total("after"), 9);
    assert.equal(r.poolCounts.length, 7);
  });
});

/* ── Plan file + apply-time reconcile ───────────────────────────────────── */

function planFrom(input: ReassignInput): ReassignAuthorsPlan {
  const r = run(input);
  return { kind: PLAN_KIND, version: PLAN_VERSION, createdAt: "x", database: "h:5432/neondb", tenant: "gcv", remove: r.remove.map(({ id, name }) => ({ id, name })), changes: r.changes, renames: r.renames };
}

describe("parsePlan", () => {
  it("round-trips a plan", () => {
    const p = planFrom(base());
    assert.deepEqual(parsePlan(JSON.stringify(p)), p);
  });

  it("rejects junk, wrong kind, bad ids, no-op and duplicate changes, bad renames", () => {
    const p = planFrom(base());
    const first = p.changes[0];
    assert.ok(first);
    assert.throws(() => parsePlan("{"), /JSON/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, kind: "prune-authors-plan" })), /not a/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, database: "" })), /database/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, tenant: "" })), /tenant/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, changes: [{ ...first, op: "delete" }] })), /bad op/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, changes: [{ ...first, table: "authors" }] })), /bad op or table/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, changes: [{ ...first, to: 0 }] })), /bad id/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, changes: [{ ...first, to: first.from }] })), /does not change/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, changes: [first, first] })), /twice/);
    assert.throws(() => parsePlan(JSON.stringify({ ...p, renames: [{ authorId: 15, from: "a", to: " " }] })), /bad rename/);
  });
});

describe("reconcilePlan", () => {
  it("an unchanged state applies the whole plan", () => {
    const p = planFrom(base());
    const r = reconcilePlan(p, run(base()));
    assert.equal(r.changes.length, p.changes.length);
    assert.deepEqual(r.renames, p.renames);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.newSinceDryRun, 0);
  });

  it("re-running after a successful apply writes nothing", () => {
    const p = planFrom(base());
    const done = base();
    const to = new Map(p.changes.map((c) => [`${c.table}:${c.rowId}`, c.to]));
    done.articles = done.articles.map((a) => ({ ...a, authorId: to.get(`articles:${a.id}`) ?? a.authorId }));
    done.versions = done.versions.map((v) => ({ ...v, authorId: to.get(`_articles_v:${v.id}`) ?? v.authorId }));
    done.authors = done.authors.map((a) => (a.id === 15 ? { ...a, name: "Tu C. Nguyen" } : a));
    const now = run(done);
    assert.deepEqual([now.changes, now.renames, now.aborts], [[], [], []]);
    const r = reconcilePlan(p, now);
    assert.deepEqual([r.changes.length, r.renames.length], [0, 0]);
    assert.equal(r.skipped.length, p.changes.length + p.renames.length);
  });

  it("skips a row whose old value changed, and a gone row", () => {
    const p = planFrom(base());
    const cur = base();
    cur.versions = cur.versions.map((v) => (v.id === 1000 ? { ...v, authorId: 1 } : v)); // someone fixed it by hand
    cur.versions = cur.versions.filter((v) => v.id !== 1001); // gone
    const r = reconcilePlan(p, run(cur));
    assert.deepEqual(r.skipped.map((s) => s.what).sort(), ["sync _articles_v #1000", "sync _articles_v #1001"]);
    assert.equal(r.changes.length, p.changes.length - 2);
  });

  it("skips a sync whose target changed", () => {
    const p = planFrom(base());
    const cur = base();
    cur.articles = cur.articles.map((a) => (a.id === 101 ? { ...a, authorId: 5 } : a));
    const r = reconcilePlan(p, run(cur));
    assert.deepEqual(r.skipped, [{ what: "sync _articles_v #1000", why: `target is now #5 ${POOL[4]}` }]);
  });

  it("keeps the reviewed pool target when the balanced rotation shifted", () => {
    const p = planFrom(base());
    const cur = base();
    cur.articles = cur.articles.filter((a) => a.id !== 201); // first legacy article deleted meanwhile
    const now = run(cur);
    const r = reconcilePlan(p, now);
    const planned203 = p.changes.find((c) => c.table === "articles" && c.rowId === 203);
    const now203 = now.changes.find((c) => c.table === "articles" && c.rowId === 203);
    assert.notEqual(planned203?.to, now203?.to, "rotation did shift");
    assert.equal(r.changes.find((c) => c.table === "articles" && c.rowId === 203)?.to, planned203?.to);
    assert.ok(r.skipped.some((s) => s.what === "reassign articles #201"));
    assert.ok(r.skipped.some((s) => s.what === "reassign _articles_v #1002"));
  });

  it("does not reassign a version row without its article row", () => {
    const p = planFrom(base());
    const cur = base();
    // the article row was moved to a pool author by hand; only its version still names the old author
    cur.articles = cur.articles.map((a) => (a.id === 201 ? { ...a, authorId: 6 } : a));
    const r = reconcilePlan(p, run(cur));
    assert.ok(r.skipped.some((s) => s.what === "reassign articles #201"));
    assert.ok(r.skipped.some((s) => s.what === "reassign _articles_v #1002"));
    assert.ok(!r.changes.some((c) => c.rowId === 1002 || c.rowId === 201));
  });

  it("drops a reassigned version row when its article row is skipped", () => {
    const p = planFrom(base());
    const cur = base();
    // article 201 moved to another REMOVE author meanwhile: its row is skipped,
    // while its version (still on #22) would otherwise match the plan
    cur.articles = cur.articles.map((a) => (a.id === 201 ? { ...a, authorId: 21 } : a));
    const r = reconcilePlan(p, run(cur));
    assert.ok(r.skipped.some((s) => s.what === "reassign articles #201" && s.why.startsWith("now reassign from #21")));
    assert.ok(r.skipped.some((s) => s.what === "reassign _articles_v #1002" && s.why.includes("not written to the same author")));
  });

  it("does not write changes the plan does not list", () => {
    const p = planFrom(base());
    const cur = base();
    cur.versions = [...cur.versions, ver(1100, 102, 20)];
    const r = reconcilePlan(p, run(cur));
    assert.equal(r.newSinceDryRun, 1);
    assert.ok(!r.changes.some((c) => c.rowId === 1100));
  });

  it("skips the rename when a twin appeared", () => {
    const p = planFrom(base());
    const now = run(base({ authors: [...base().authors, { id: 16, name: "Tu C. Nguyen", rank: null, userId: null }] }));
    assert.ok(now.aborts.length > 0, "the script refuses before reconcile; reconcile also skips it");
    assert.deepEqual(reconcilePlan(p, now).renames, []);
  });
});

describe("toCsv", () => {
  it("one line per change with article slug/title, plus the rename; quotes commas", () => {
    const input = base({ articles: base().articles.map((a) => (a.id === 101 ? { ...a, title: 'Paris, "chic"' } : a)) });
    const r = run(input);
    const lines = toCsv(r, input.articles).trimEnd().split("\n");
    assert.equal(lines[0], "article_id,slug,title,old_author,new_author,operation,table,row_id");
    assert.equal(lines.length, 1 + r.changes.length + 1);
    assert.ok(lines.includes(`101,s-101,"Paris, ""chic""",Sofia I. Anders,${POOL[0]},sync,_articles_v,1000`));
    assert.equal(lines.at(-1), ",,,Tu C. Nguyen ,Tu C. Nguyen,rename,authors,15");
  });
});
