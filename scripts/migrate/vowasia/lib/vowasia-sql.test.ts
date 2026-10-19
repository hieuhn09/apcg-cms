import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeOverlay, parseSourceConfig, type SourceConfig } from "./vowasia-config";
import {
  CURSOR_COLUMN, SQL_MESSAGES, VowasiaReadOnlyDb, VowasiaSqlError, assertCreatedAtOrdering, assertLexicallySafe, assertSafeQuery,
  catalogColumns, catalogTables, countRows, createSqlRegistry, cursorOf, distribution, isIssuedFor, keysetPage, sampleRows, setCatalog,
  siteRow, slugPlanRows, type MinimalPgClient, type SafeQuery, type SqlRegistry,
} from "./vowasia-sql";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = JSON.parse(readFileSync(path.resolve(HERE, "..", "legacy-source.vowasia.json"), "utf8"));
const UUID_SITE = "00000000-0000-0000-0000-00000000f002";

function cfg(patch: Record<string, unknown> = {}): SourceConfig {
  return parseSourceConfig(mergeOverlay(BASE, { source: patch }));
}
const REG = createSqlRegistry(cfg());
const INT_REG = createSqlRegistry(cfg({ siteIdKind: "integer" }));
const TXT_REG = createSqlRegistry(cfg({ siteIdKind: "text-safe" }));

function allBuilt(reg: SqlRegistry, site: string): SafeQuery[] {
  return [
    catalogTables(reg),
    catalogColumns(reg),
    countRows(reg, "articles", site),
    countRows(reg, "sites", site),
    distribution(reg, "articles", "status", site),
    keysetPage(reg, "articles", ["id", "title"], site, null, 100),
    keysetPage(reg, "articles", ["id"], site, ["2026-01-01 00:00:00.123456+00", "x"], 100),
    keysetPage(reg, "sites", ["id"], site, ["x"], 100),
    sampleRows(reg, "articles", ["id", "body_sections"], site, ["a", "b"]),
    slugPlanRows(reg, ["id", "created_at", "slug"], site),
    siteRow(reg, site),
  ];
}

test("AC-A2: should refuse any statement that is not a site-scoped SELECT on an allow-listed table (every builder passes, all scoped)", () => {
  for (const sq of allBuilt(REG, UUID_SITE)) {
    assertSafeQuery(sq, REG);
    assert.ok(sq.text.startsWith("SELECT "));
    if (sq.id.startsWith("catalog")) assert.match(sq.text, /table_name = ANY\(\$2::text\[\]\)/);
    else assert.match(sq.text, / WHERE "(site_id|id)" = \$1\) AS t/);
  }
});

test("AC-A2: exact templates (keyset text carries the DB-rendered cursor column)", () => {
  assert.equal(
    keysetPage(REG, "articles", ["id", "title"], UUID_SITE, null, 2).text,
    `SELECT "id", "title", coalesce("created_at", $2::timestamptz)::text AS "${CURSOR_COLUMN}" FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t ORDER BY coalesce("created_at", $2::timestamptz), "id" LIMIT $3`,
  );
  assert.equal(
    keysetPage(REG, "articles", ["id"], UUID_SITE, ["2026-01-01 00:00:00.123456+00", "k"], 2).text,
    `SELECT "id", coalesce("created_at", $2::timestamptz)::text AS "${CURSOR_COLUMN}" FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t WHERE (coalesce("created_at", $2::timestamptz), "id") > ($3::timestamptz, $4) ORDER BY coalesce("created_at", $2::timestamptz), "id" LIMIT $5`,
  );
  assert.equal(siteRow(REG, UUID_SITE).text, `SELECT "id", "slug", "name" FROM (SELECT * FROM "public"."sites" WHERE "id" = $1) AS t`);
  assert.equal(countRows(REG, "articles", UUID_SITE).text, `SELECT count(*) AS n FROM (SELECT * FROM "public"."articles" WHERE "site_id" = $1) AS t`);
  assert.deepEqual(catalogColumns(REG).params, ["public", ["articles", "sites"]]);
});

test("AC-A3: should validate site id per siteIdKind and read column roles from the overlay", () => {
  // overlay renames the createdAt column and uses a view schema + integer ids
  const reg = createSqlRegistry(cfg({ schema: "vowasia_ro", siteIdKind: "integer", tables: { articles: { name: "posts", createdAtColumn: "inserted_at", keyColumns: ["post_id"] } }, columnRoles: { createdAt: "inserted_at" } }));
  const t = keysetPage(reg, "articles", ["post_id"], "42", null, 10).text;
  assert.match(t, /coalesce\("inserted_at", \$2::timestamptz\)::text AS "__cursor_ts"/);
  assert.match(t, /FROM "vowasia_ro"\."posts" WHERE "site_id" = \$1/);
  assert.ok(!t.includes('"created_at"'));
  assert.throws(() => countRows(reg, "articles", UUID_SITE), VowasiaSqlError); // uuid on an integer registry
  // integer kind
  for (const sq of allBuilt(INT_REG, "123456789012345678")) assertSafeQuery(sq, INT_REG);
  for (const bad of ["-1", "1.5", "12a", "1234567890123456789", "", "1 OR 1=1", UUID_SITE]) assert.throws(() => countRows(INT_REG, "articles", bad), VowasiaSqlError, bad);
  // text-safe kind
  for (const sq of allBuilt(TXT_REG, "vowasia_site-1")) assertSafeQuery(sq, TXT_REG);
  for (const bad of ["a'b", "a;b", "a b", "x".repeat(65), "a\\b", "é"]) assert.throws(() => countRows(TXT_REG, "articles", bad), VowasiaSqlError, bad);
  // uuid kind
  for (const bad of ["42", "vowasia", `${UUID_SITE}'`, `${UUID_SITE};`]) assert.throws(() => countRows(REG, "articles", bad), VowasiaSqlError, bad);
  assert.throws(() => countRows(REG, "articles", 42 as unknown as string), VowasiaSqlError);
});

test("AC-A3: identifiers outside lower snake_case are refused with the fixed amendment message", () => {
  for (const bad of ["Title", "createdAt", "my col", 'a"b', "a;b"]) {
    assert.throws(() => distribution(REG, "articles", bad, UUID_SITE), { message: SQL_MESSAGES.ident }, bad);
    assert.throws(() => keysetPage(REG, "articles", [bad], UUID_SITE, null, 10), { message: SQL_MESSAGES.ident }, bad);
  }
  assert.throws(() => createSqlRegistry(cfg(), "Public"), { message: SQL_MESSAGES.ident });
  assert.throws(() => keysetPage(REG, "articles", [CURSOR_COLUMN], UUID_SITE, null, 10), { message: SQL_MESSAGES.ident });
});

test("AC-A2: tables outside the configured registry (incl. decoys and catalog tables) are refused", () => {
  for (const t of ["secret_table_a", "secret_table_b", "secret_table_c", "secret_table_d", "pg_class", "pg_roles", "Articles", "articles;", "posts", "constructor", "__proto__"]) {
    assert.throws(() => countRows(REG, t, UUID_SITE), VowasiaSqlError, t);
    assert.throws(() => keysetPage(REG, t, ["id"], UUID_SITE, null, 10), VowasiaSqlError, t);
  }
});

test("keyset by created-at on a table without one is refused; cursor shape and limits are checked", () => {
  assert.throws(() => assertCreatedAtOrdering(REG, "sites"), { message: SQL_MESSAGES.noCreatedAt });
  assertCreatedAtOrdering(REG, "articles");
  assert.ok(!keysetPage(REG, "sites", ["id"], UUID_SITE, null, 10).text.includes("coalesce"));
  assert.throws(() => keysetPage(REG, "articles", ["id"], UUID_SITE, ["x"], 10), { message: SQL_MESSAGES.badCursor });
  assert.throws(() => keysetPage(REG, "articles", ["id"], UUID_SITE, [new Date(), "x"], 10), { message: SQL_MESSAGES.badCursor });
  for (const n of [0, -1, 1.5, 10_001]) assert.throws(() => keysetPage(REG, "articles", ["id"], UUID_SITE, null, n), { message: SQL_MESSAGES.badLimit });
});

test("cursorOf uses the DB-rendered text (microseconds kept), never a Date", () => {
  const row = { id: "k1", created_at: new Date("2026-01-01T00:00:00.123Z"), [CURSOR_COLUMN]: "2026-01-01 00:00:00.123456+00" };
  assert.deepEqual(cursorOf(REG, "articles", row), ["2026-01-01 00:00:00.123456+00", "k1"]);
  assert.throws(() => cursorOf(REG, "articles", { id: "k1", created_at: new Date() }), { message: SQL_MESSAGES.badCursor });
  assert.deepEqual(cursorOf(REG, "sites", { id: "s" }), ["s"]);
});

test("catalog: unknown columns refused once a catalog is set", () => {
  const reg = createSqlRegistry(cfg());
  setCatalog(reg, new Map([["articles", new Set(["id", "created_at", "title"])]]));
  keysetPage(reg, "articles", ["id", "title"], UUID_SITE, null, 5);
  assert.throws(() => keysetPage(reg, "articles", ["status"], UUID_SITE, null, 5), { message: SQL_MESSAGES.unknownColumn });
  setCatalog(reg, undefined);
  keysetPage(reg, "articles", ["status"], UUID_SITE, null, 5);
});

test("AC-A2: adversarial corpus is refused by the lexical line", () => {
  const corpus = [
    "SELECT * FROM articles; DROP TABLE articles",
    "SELECT * FROM articles -- c",
    "SELECT * FROM articles /* c */",
    "SELECT 'x' FROM articles",
    "SELECT $$x$$ FROM articles",
    "SELECT E'x' FROM articles",
    "SELECT * FROM articles JOIN sites ON true",
    "SELECT * FROM articles, secret_table_a",
    "SELECT * FROM articles a, sites s",
    "SELECT * FROM secret_table_a",
    "SELECT * FROM public.secret_table_b",
    "SELECT * FROM other.articles",
    "SELECT pg_read_file(x) FROM articles",
    "SELECT * FROM articles WHERE id = 1 UNION SELECT * FROM secret_table_c",
    "SELECT * FROM LATERAL secret_table_d",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "INSERT INTO articles VALUES (1)",
    "UPDATE articles SET title = x",
    "DELETE FROM articles",
    "SELECT * FROM articles WHERE id = 1 OR 1 = 1",
    "SELECT \\x FROM articles",
    "SELECT é FROM articles",
    "SELECT * FROM pg_catalog.pg_class",
    "SELECT * FROM information_schema.role_table_grants",
    "SELECT * FROM information_schema.columns",
    "SELECT \"Bad\" FROM articles",
    "SELECT set_config(a, b, c) FROM articles",
    "SELECT * FROM \"articles\" t, \"sites\"",
  ];
  for (const s of corpus) assert.throws(() => assertLexicallySafe(s, REG), VowasiaSqlError, s);
});

test("AC-A2: forged or tampered SafeQueries are refused (template, args, params)", () => {
  const good = countRows(REG, "articles", UUID_SITE);
  const tamper = (x: Partial<SafeQuery>) => assert.throws(() => assertSafeQuery({ ...good, ...x } as SafeQuery, REG), VowasiaSqlError);
  tamper({ text: good.text.replace("count(*)", "count(*), max(\"body_sections\")") });
  tamper({ args: { table: "secret_table_a" } });
  tamper({ params: ["not-a-uuid"] });
  tamper({ id: "nope" as SafeQuery["id"] });
  tamper({ params: "x" as unknown as unknown[] });
  // a SafeQuery from another registry is refused by the other registry's text/params check or the db
  const cat = catalogTables(REG);
  assert.throws(() => assertSafeQuery({ ...cat, params: ["public", ["secret_table_a"]] }, REG), VowasiaSqlError);
  assert.throws(() => assertSafeQuery({ ...cat, params: ["other", ["articles"]] }, REG), VowasiaSqlError);
  assert.ok(isIssuedFor(good, REG));
  assert.ok(!isIssuedFor(good, INT_REG));
});

class FakeClient implements MinimalPgClient {
  constructor(private readonly ev: string[]) {}
  async connect() {
    this.ev.push("connect");
  }
  async query(text: string) {
    this.ev.push(text.startsWith("SELECT") ? "SELECT" : text);
    return { rows: [{ n: 1, d: new Date("2026-01-01T00:00:00Z") }] };
  }
  async end() {
    this.ev.push("end");
  }
}

test("read-only db: BEGIN READ ONLY / QUERY / COMMIT order, unbranded and foreign-registry queries refused, log has no params", async () => {
  const ev: string[] = [];
  const db = new VowasiaReadOnlyDb(REG, () => new FakeClient(ev));
  const rows = await db.query(countRows(REG, "articles", UUID_SITE));
  assert.equal(rows[0]?.d, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(db.events, ["BEGIN", "QUERY", "COMMIT"]);
  assert.ok(ev.indexOf("BEGIN READ ONLY") < ev.indexOf("SELECT") && ev.indexOf("SELECT") < ev.indexOf("COMMIT"));
  assert.deepEqual(Object.keys(db.log[0] ?? {}).sort(), ["id", "text"]);
  assert.ok(!JSON.stringify(db.log).includes(UUID_SITE));
  const forged = { ...countRows(REG, "articles", UUID_SITE) };
  await assert.rejects(db.query(forged as SafeQuery), { message: SQL_MESSAGES.notBranded });
  await assert.rejects(db.query(countRows(INT_REG, "articles", "1")), { message: SQL_MESSAGES.notBranded });
  assert.throws(() => new VowasiaReadOnlyDb({ ...REG } as SqlRegistry, () => new FakeClient([])), { message: SQL_MESSAGES.badRegistry });
});

// Amendment 2 (19-10-26): owner SQL 02 allows EXACTLY two Supabase pg_net relations and
// self-checks the role's default_transaction_read_only setting; 01e labels them.
const SQL_DIR = path.resolve(HERE, "..", "sql");
const ALLOWED_PUBLIC_RELATIONS = ["net._http_response", "net.http_request_queue"];

test("Amendment 2: 02 allow-list is exactly the two pg_net relations, matched by schema.name AND relkind r", () => {
  const tpl = readFileSync(path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"), "utf8");
  const code = tpl.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const decl = code.match(/allow_public_relations constant text\[\] := ARRAY\[([^\]]*)\];/g) ?? [];
  assert.equal(decl.length, 1, "exactly one allow_public_relations declaration");
  const names = [...(decl[0] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ALLOWED_PUBLIC_RELATIONS, "allow-list holds exactly the two names, schema-qualified");
  assert.match(code, /NOT \(c\.relkind = 'r' AND n\.nspname \|\| '\.' \|\| c\.relname = ANY \(allow_public_relations\)\)/, "exact schema+name+relkind r exclusion inside the table check");
  assert.ok(!/nspname\s*(=|<>|NOT IN|IN)\s*\(?\s*'net'/.test(code), "no whole-schema exemption for net");
});

test("Amendment 2: 02 sets default_transaction_read_only once and self-checks it via pg_db_role_setting", () => {
  const tpl = readFileSync(path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"), "utf8");
  const code = tpl.split("\n").filter((l) => !/^\s*--/.test(l));
  assert.equal(code.filter((l) => /default_transaction_read_only/.test(l) && /ALTER ROLE/.test(l)).length, 1, "one ALTER ROLE line");
  assert.ok(code.includes("ALTER ROLE vowasia_migrator SET default_transaction_read_only = on;"));
  const body = code.join("\n");
  assert.match(body, /pg_db_role_setting/);
  assert.match(body, /'default_transaction_read_only=on' = ANY \(s\.setconfig\)/);
  assert.match(body, /SELF-CHECK STOP: vowasia_migrator default_transaction_read_only is not set to on/);
});

test("Amendment 2: 01e 5f labels the allow-listed relations and shows PUBLIC table privileges, still one statement", () => {
  const sql = readFileSync(path.join(SQL_DIR, "01e-inspect-single-result.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  assert.match(code, /\(allowed by 02 allow-list\)/);
  for (const n of ALLOWED_PUBLIC_RELATIONS) assert.ok(code.includes(`'${n}'`), `01e names ${n}`);
  assert.match(code, /c\.relkind = 'r' AND n\.nspname \|\| '\.' \|\| c\.relname IN \('net\._http_response', 'net\.http_request_queue'\)/);
  assert.match(code, /PUBLIC privileges=/);
  assert.ok(!/5f PUBLIC-readable relations \(02 stops on any\)/.test(code), "5f title no longer claims 02 stops on any row");
  assert.equal((code.match(/;/g) ?? []).length, 1, "01e stays one statement");
});
