import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_TABLES, ALLOWED_TABLE_NAMES, LegacyReadOnlyDb, LegacySqlError, SQL_MESSAGES, assertCreatedAtOrdering,
  assertLexicallySafe, assertSafeQuery, catalogColumns, catalogTables, countRows, cursorOf, distribution,
  effectiveAllowList, keysetPage, sampleRows, siteAuthorsRows, siteRow, slugPlanRows, type SafeQuery, type MinimalPgClient,
} from "./legacy-sql";

const SITE = "00000000-0000-0000-0000-00000000f001";
const S = "public";

/** Every builder variant (the allowed corpus). */
function allBuilt(): SafeQuery[] {
  const out: SafeQuery[] = [catalogTables(S, ALLOWED_TABLE_NAMES), catalogColumns(S, ALLOWED_TABLE_NAMES), slugPlanRows(S, SITE), siteRow(S, SITE), siteAuthorsRows(S, SITE)];
  for (const t of ALLOWED_TABLE_NAMES) {
    const spec = ALLOWED_TABLES[t];
    const k = spec.keyColumns[0] as string;
    out.push(countRows(S, t, SITE));
    out.push(distribution(S, t, k, SITE));
    out.push(keysetPage(S, t, [k], SITE, null, 100));
    const cur = spec.hasCreatedAt ? ["2026-01-01T00:00:00.000Z", ...spec.keyColumns.map(() => "x")] : spec.keyColumns.map(() => "x");
    out.push(keysetPage(S, t, [k], SITE, cur, 100));
    out.push(sampleRows(S, t, [k], SITE, ["a", "b"]));
  }
  return out;
}

test("C1/G45: every allow-listed table has a site column and key columns; 9 tables, no review queue", () => {
  assert.equal(ALLOWED_TABLE_NAMES.length, 9);
  assert.ok(!ALLOWED_TABLE_NAMES.includes("article_review_queue" as never));
  for (const t of ALLOWED_TABLE_NAMES) {
    const spec = ALLOWED_TABLES[t];
    assert.ok(spec.siteColumn.length > 0, t);
    assert.ok(spec.keyColumns.length > 0, t);
  }
  assert.equal(ALLOWED_TABLES.events.hasCreatedAt, false);
  assert.deepEqual([...ALLOWED_TABLES.press_submissions.personalColumns], ["contact_name", "contact_email"]);
});

test("C1/G45: every builder variant passes assertSafeQuery and carries the site predicate", () => {
  for (const sq of allBuilt()) {
    assertSafeQuery(sq);
    if (!sq.id.startsWith("catalog")) assert.match(sq.text, / WHERE "(site_id|id)" = \$1\) AS t/);
    else assert.match(sq.text, /table_name = ANY\(\$2::text\[\]\)/);
  }
});

test("C1/G45: builders refuse non-allow-listed tables, bad identifiers and created_at ordering on hasCreatedAt:false", () => {
  for (const t of ["secret_table_a", "article_review_queue", "pg_indexes", "pg_class", "pg_total_relation_size", "Articles", "articles;"]) {
    assert.throws(() => countRows(S, t, SITE), LegacySqlError, t);
    assert.throws(() => keysetPage(S, t, ["id"], SITE, null, 10), LegacySqlError, t);
  }
  assert.throws(() => keysetPage(S, "articles", ['id"; DROP'], SITE, null, 10), LegacySqlError);
  assert.throws(() => distribution(S, "articles", "ID", SITE), LegacySqlError);
  assert.throws(() => assertCreatedAtOrdering("events"), { message: SQL_MESSAGES.noCreatedAt });
  assert.throws(() => assertCreatedAtOrdering("sites"), { message: SQL_MESSAGES.noCreatedAt });
  assertCreatedAtOrdering("articles");
  assert.throws(() => countRows(S, "articles", SITE, ["events"]), LegacySqlError); // narrowed list excludes it
});

test("C1/G45 (A13-R08): source.tableAllowList can only narrow the constant", () => {
  assert.deepEqual(effectiveAllowList(["events", "articles"]), ["articles", "events"]);
  assert.equal(effectiveAllowList(undefined).length, 9);
  assert.throws(() => effectiveAllowList(["articles", "secret_table_a"]), { message: SQL_MESSAGES.allowListForeign });
  assert.throws(() => effectiveAllowList([]), { message: SQL_MESSAGES.allowListEmpty });
});

const CORPUS: string[] = [
  "TABLE secret_table_a",
  "VALUES (1)",
  'SELECT * FROM "secret_table_a"',
  "SELECT * FROM public.secret_table_a",
  "SELECT * FROM pg_catalog.pg_shadow",
  "SELECT * FROM articles a, secret_table_a",
  "SELECT * FROM articles a JOIN LATERAL (SELECT * FROM secret_table_b) x ON true",
  "SELECT query_to_xml('select 1',true,true,'')",
  "SELECT xpath('/a', x) FROM articles",
  "SELECT table_to_xml('secret_table_a', true, true, '')",
  "SELECT cursor_to_xml(c, 1, true, true, '')",
  "SELECT pg_sleep(10)",
  'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1 OR true) AS t',
  'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" /* WHERE "site_id" = $1 */) AS t',
  'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles") AS t -- WHERE "site_id" = $1',
  'SELECT count(*) AS n FROM (SELECT * FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS x) AS t',
  "SELECT table_name FROM information_schema.columns",
  'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t; DELETE FROM articles',
  "SELECT * INTO x FROM articles",
  "WITH x AS (DELETE FROM articles RETURNING *) SELECT * FROM x",
  "COPY articles TO STDOUT",
  "DO $$ BEGIN PERFORM 1; END $$",
  "SELECT pg_terminate_backend(1)",
  "SELECT set_config('a','b',false)",
  "SELECT nextval('s')",
  "SELECT * FROM dblink('x','y') AS t(a int)",
  "SELECT lo_import('/etc/passwd')",
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT * FROM аrticles", // Cyrillic a
  "SELECT E'\\x41'",
  "SELECT * FROM article_review_queue",
  "SELECT * FROM pg_indexes",
  "SELECT pg_total_relation_size('articles')",
];

test("C1/G33: the adversarial corpus is refused (forged SafeQuery objects, fixed message)", () => {
  for (const text of CORPUS) {
    for (const forged of [
      { id: "countRows", text, params: [SITE], args: { schema: S, table: "articles" } },
      { id: "keysetPage", text, params: [SITE, "e", 1], args: { schema: S, table: "articles", columns: ["id"], withCursor: false } },
      { id: "catalogColumns", text, params: [S, ["articles"]], args: { schema: S } },
    ]) {
      assert.throws(() => assertSafeQuery(forged as unknown as SafeQuery), { message: SQL_MESSAGES.refused }, text);
    }
  }
});

test("C1/G33: the lexer alone refuses every corpus entry it can see (comments, ;, strings, write keywords, foreign relations, functions)", () => {
  const lexerSeen = CORPUS.filter((t) => !t.includes("WHERE \"site_id\" = $1) AS x) AS t"));
  for (const text of lexerSeen) assert.throws(() => assertLexicallySafe(text), LegacySqlError, text);
  for (const sq of allBuilt()) assertLexicallySafe(sq.text);
});

test("C1: a raw string or forged object never reaches the driver", async () => {
  const seen: string[] = [];
  const fake: MinimalPgClient = { connect: async () => {}, query: async (t: string) => { seen.push(t); return { rows: [] }; }, end: async () => {} };
  const db = new LegacyReadOnlyDb(() => fake);
  const forged = { id: "countRows", text: 'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t', params: [SITE], args: { schema: S, table: "articles" } };
  await assert.rejects(db.query(forged as unknown as SafeQuery), { message: SQL_MESSAGES.notBranded });
  await assert.rejects(db.query("SELECT 1" as unknown as SafeQuery));
  assert.equal(seen.length, 0);
  await db.query(countRows(S, "articles", SITE));
  assert.deepEqual(seen.slice(1), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '30s'", 'SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t', "COMMIT"]);
  for (const t of seen) assert.doesNotMatch(t, /\b(INSERT|UPDATE|DELETE|DROP)\b/);
});

test("C1/A11-S08: every batch is BEGIN READ ONLY..COMMIT on a fresh connection; reconnect on server termination", async () => {
  let made = 0;
  let failOnce = true;
  const db = new LegacyReadOnlyDb(() => {
    made++;
    return {
      connect: async () => {},
      query: async (t: string) => {
        if (failOnce && t.startsWith("SELECT count")) {
          failOnce = false;
          throw Object.assign(new Error("terminated"), { code: "57P01" });
        }
        return { rows: [{ n: 1, d: new Date("2026-01-01T00:00:00Z") }] };
      },
      end: async () => {},
    };
  }, { backoffMs: 1 });
  const [r1] = await db.batch([countRows(S, "articles", SITE)]);
  assert.equal(made, 2);
  assert.equal(r1?.[0]?.d, "2026-01-01T00:00:00.000Z");
  await db.batch([countRows(S, "events", SITE)]);
  assert.equal(made, 3);
  assert.deepEqual(db.events, ["BEGIN", "QUERY", "BEGIN", "QUERY", "COMMIT", "BEGIN", "QUERY", "COMMIT"]);
});

test("keyset cursor helper", () => {
  assert.deepEqual(cursorOf("articles", { id: "u1", created_at: null }), ["1970-01-01T00:00:00.000Z", "u1"]);
  assert.deepEqual(cursorOf("events", { id: "e1" }), ["e1"]);
});
