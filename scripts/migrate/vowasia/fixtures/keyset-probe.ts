/**
 * VowAsia phase A probe body (Hybrid gate G6), started ONLY by keyset-probe.sh
 * against the throwaway PostgreSQL 16 it created (127.0.0.1, port 54331-54339).
 *
 *   A. keyset reads on real PG, uuid site ids: same millisecond / different
 *      microseconds at page boundaries, identical created-at with different ids,
 *      NULL created-at, 1970; page sizes 1/2/3; another site interleaved.
 *   B. the same with integer (bigint) site ids.
 *   C0. 01 runs to the end as a login role WITHOUT write rights (pg_read_all_data).
 *   C. owner SQL: 02 refuses when not filled; a wrong site id / slug makes the
 *      in-transaction self-check STOP and roll back (nothing created); 02 filled
 *      applies, self-check OK, role has VALID UNTIL;
 *      the role reads only the vowasia rows through the views, cannot read the
 *      base tables, cannot write or create anything; RLS/policies/grants of the
 *      base tables unchanged.
 *   D. discover through the role (overlay fixture): exit 0, report written,
 *      query-log only site-scoped SELECTs, no site id / password / body / title
 *      in stdout, stderr or any output file, out dir 700, files 600; discover
 *      on the other site is refused (exit 2).
 *   E. 03 removes schema + role, prints CLEANUP OK and is re-runnable.
 *   F. 02 + 03 run by a NON-superuser table owner that has CREATEROLE (the
 *      Supabase/Neon-style owner), on a copy database.
 *   C also: wrong legacy DB name / 'neondb' -> DB NAME STOP (02 and 03); a
 *      PUBLIC-callable SECURITY DEFINER function outside public -> STOP; 03
 *      without / with a wrong -v legacy_db drops nothing.
 *   H. Amendment 1 (Supabase SQL Editor variants): 01e returns ONE result set in a
 *      read-only transaction as a non-superuser; 02 pasted as one string ends in
 *      SELF-CHECK OK; 02p stops without role/schema/views, generates the password in
 *      SQL (shown only in the last cell), SCRAM login works; 03e refuses unfilled / wrong name /
 *      neondb (with and without ON_ERROR_STOP) and cleans up when filled.
 *   G. 02b: the in-SQL guard refuses (nothing changed) while another login role
 *      or a NOLOGIN role can use the shared tables; then the filled 02b applies
 *      (RLS SETUP OK, NOINHERIT, VALID UNTIL); manual removal then 03 restores
 *      RLS off; 03 directly after 02b is recorded (policies dropped, RLS on).
 * The generated role password is never printed and never written to sql/*.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { mergeOverlay, parseSourceConfig } from "../lib/vowasia-config";
import { LiveVowasiaReader } from "../lib/vowasia-reader";
import { VowasiaReadOnlyDb, createSqlRegistry, type MinimalPgClient } from "../lib/vowasia-sql";

const PORT = Number(process.env.VOWASIA_PROBE_PORT);
const DIR = process.env.VOWASIA_PROBE_DIR ?? "";
if (!(PORT >= 54331 && PORT <= 54339) || !DIR.startsWith("/tmp/vowasia-probe-")) {
  console.error("[probe] must be started by keyset-probe.sh (local throwaway server only); refusing.");
  process.exit(2);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const SQL_DIR = path.resolve(HERE, "..", "sql");
const OVERLAY = path.resolve(HERE, "overlay.fixture.json");
const BASE = JSON.parse(readFileSync(path.resolve(HERE, "..", "legacy-source.vowasia.json"), "utf8"));
const SITE_V = "00000000-0000-0000-0000-00000000f002";
const SITE_O = "00000000-0000-0000-0000-00000000f001";
const BODY_MARK = "BODYSAMPLEMARK7f3a";
const TITLE_MARK = "TITLESAMPLEMARK9c1e";
const PASSWORD = randomBytes(18).toString("base64url");
/** Every secret this probe holds; failure messages are redacted against all of them. */
const SECRETS: string[] = [PASSWORD];
const ARTICLE_COLUMNS = `"id", "site_id", "inserted_at", "published_at", "status", "category", "slug", "title", "body_html", "hero_url"`;

const url = (db: string, user = "postgres", pw?: string) => `postgres://${user}${pw ? `:${encodeURIComponent(pw)}` : ""}@127.0.0.1:${PORT}/${db}`;
const log = (s: string) => console.log(`[probe] ${s}`);

async function withClient<T>(db: string, fn: (c: pg.Client) => Promise<T>, user = "postgres", pw?: string): Promise<T> {
  const c = new pg.Client({ connectionString: url(db, user, pw) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Same flags as the owner commands in VOWASIA-LEGACY.md: -X -q -t -A -v ON_ERROR_STOP=1 (stop=false drops ON_ERROR_STOP). */
function psql(db: string, file: string, user = "postgres", extra: string[] = [], stop = true): { status: number; out: string; err: string } {
  const r = spawnSync("psql", ["-X", "-q", "-t", "-A", ...(stop ? ["-v", "ON_ERROR_STOP=1"] : []), ...extra, "-h", "127.0.0.1", "-p", String(PORT), "-U", user, "-d", db, "-f", file], { encoding: "utf8" });
  return { status: r.status ?? -1, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** 03 with the mandatory -v legacy_db (defaults to the database actually connected). */
function drop03(db: string, user = "postgres", legacyDb: string | null = db): { status: number; out: string; err: string } {
  return psql(db, path.join(SQL_DIR, "03-drop-role-and-views.sql"), user, legacyDb === null ? [] : ["-v", `legacy_db=${legacyDb}`]);
}

/** Seed one site-id kind; returns the expected vowasia order (DB ORDER BY). */
async function seed(db: string, kind: "uuid" | "bigint"): Promise<{ siteV: string; siteO: string; expected: string[] }> {
  await withClient("postgres", (c) => c.query(`CREATE DATABASE ${db}`));
  const siteV = kind === "uuid" ? SITE_V : "2";
  const siteO = kind === "uuid" ? SITE_O : "1";
  let n = 1000;
  const id = () => (kind === "uuid" ? randomUUID() : String(n--)); // bigint ids DESCEND with time on purpose
  return withClient(db, async (c) => {
    await c.query(`CREATE TABLE public.sites (id ${kind} PRIMARY KEY, slug text NOT NULL, name text, contact_email text)`);
    await c.query(`CREATE TABLE public.articles (id ${kind} PRIMARY KEY, site_id ${kind} NOT NULL, inserted_at timestamptz, published_at timestamptz, status text, category text, slug text, title text, body_html text, hero_url text, author_email text)`);
    for (const d of ["a", "b", "c", "d"]) await c.query(`CREATE TABLE public.secret_table_${d} (id serial PRIMARY KEY, payload text)`);
    await c.query("INSERT INTO public.sites VALUES ($1, 'gtp', 'Other', 'a@example.invalid'), ($2, 'vowasia', 'VowAsia', 'b@example.invalid')", [siteO, siteV]);
    const stamps: (string | null)[] = [
      "2026-03-01 10:00:00.123900+00", "2026-03-01 10:00:00.123400+00", "2026-03-01 10:00:00.123900+00", "2026-03-01 10:00:00.123001+00",
      "2026-04-01 00:00:00+00", "2026-04-01 00:00:00+00", "2026-04-01 00:00:00+00",
      null, null, "1970-01-01 00:00:00+00",
      "2025-12-31 23:59:59.999999+00", "2026-01-01 00:00:00+00", "2026-05-05 05:05:05.5+07", "2024-02-29 12:00:00+00",
    ];
    let i = 0;
    for (const ts of stamps) {
      for (const site of [siteV, siteO]) {
        i++;
        await c.query(
          "INSERT INTO public.articles VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [id(), site, ts, i % 3 ? ts : null, i % 4 ? "published" : "draft", i % 2 ? "Weddings" : "Venues", `post-${i}`, `${TITLE_MARK} ${i}`, `<p>${BODY_MARK} ${i}</p>`, i % 5 ? `https://img${i % 2}.example.invalid/a${i}.jpg` : null, `author${i}@example.invalid`],
        );
      }
    }
    // ORDER BY the typed column a.id (not the text alias): numeric order for bigint ids.
    const r = await c.query("SELECT a.id::text AS k FROM public.articles a WHERE a.site_id = $1 ORDER BY coalesce(a.inserted_at, '1970-01-01T00:00:00.000Z'::timestamptz), a.id", [siteV]);
    return { siteV, siteO, expected: r.rows.map((x) => String(x.k)) };
  });
}

async function keysetCheck(db: string, kind: "uuid" | "integer", siteV: string, expected: string[]): Promise<void> {
  const cfg = parseSourceConfig(mergeOverlay(mergeOverlay(BASE, JSON.parse(readFileSync(OVERLAY, "utf8"))), { source: { siteIdKind: kind, siteFilter: siteV } }), { requireSiteFilter: true });
  const reg = createSqlRegistry(cfg, "public");
  for (const size of [1, 2, 3]) {
    const db2 = new VowasiaReadOnlyDb(reg, () => new pg.Client({ connectionString: url(db) }) as unknown as MinimalPgClient);
    const reader = new LiveVowasiaReader(db2, siteV);
    await reader.loadCatalog();
    const got: string[] = [];
    for await (const page of reader.pages("articles", ["id", "title"], size)) for (const r of page) got.push(String(r.id));
    reader.close();
    assert.deepEqual(got, expected, `${kind} pageSize ${size}: order/completeness`);
    assert.equal(new Set(got).size, got.length, `${kind} pageSize ${size}: no duplicate`);
    assert.equal(reader.duplicatesSkipped, 0);
    assert.ok(db2.log.every((e) => e.text.startsWith("SELECT ")));
  }
  log(`A/B keyset ${kind}: ${expected.length} rows read exactly once, in DB order, page sizes 1/2/3`);
}

const BASE_STATE_SQL = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, '') AS acl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
async function baseState(db: string): Promise<string> {
  return withClient(db, async (c) => JSON.stringify([(await c.query(BASE_STATE_SQL)).rows, (await c.query("SELECT * FROM pg_policies ORDER BY policyname")).rows]));
}

function fill(template: string, site: string, db: string, slug = "vowasia"): string {
  return template.split("__VOWASIA_SITE_ID__").join(site).split("__VOWASIA_SITE_SLUG__").join(slug).split("__ARTICLE_COLUMNS__").join(ARTICLE_COLUMNS).split("__LEGACY_DB_NAME__").join(db);
}

function lastLine(s: string): string {
  return s.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
}

const countSql = "SELECT (SELECT count(*) FROM pg_roles WHERE rolname = 'vowasia_migrator')::int + (SELECT count(*) FROM pg_namespace WHERE nspname = 'vowasia_ro')::int AS n";

async function expectPgError(code: string, fn: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.equal((e as { code?: string }).code, code, `${what}: expected SQLSTATE ${code}`);
    return;
  }
  assert.fail(`${what}: expected SQLSTATE ${code}, got success`);
}

function runDiscover(args: string[], env: Record<string, string>): { status: number; out: string; err: string } {
  const r = spawnSync("node", ["--import", "tsx", path.join(ROOT, "scripts/migrate/vowasia/discover-vowasia.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function main(): Promise<void> {
  // A + B: keyset on real PG.
  const u = await seed("probe_uuid", "uuid");
  await keysetCheck("probe_uuid", "uuid", u.siteV, u.expected);
  const b = await seed("probe_int", "bigint");
  await keysetCheck("probe_int", "integer", b.siteV, b.expected);

  // C0: 01 as a login role that can read but not write.
  await withClient("postgres", async (c) => {
    await c.query("CREATE ROLE probe_inspector LOGIN");
    await c.query("GRANT pg_read_all_data TO probe_inspector");
  });
  const inspect = psql("probe_uuid", path.join(SQL_DIR, "01-readonly-inspect.sql"), "probe_inspector");
  assert.equal(inspect.status, 0, `01 as a read-only role failed: ${inspect.err}`);
  assert.match(inspect.out, /vowasia/);
  log("C0 01: runs to the end as a login role without write rights");

  // C: owner SQL 02.
  const before = await baseState("probe_uuid");
  const tpl02 = readFileSync(path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"), "utf8");
  assert.ok(!/password\s+'/i.test(tpl02));
  const raw = psql("probe_uuid", path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"));
  assert.notEqual(raw.status, 0, "unfilled 02 must fail");
  assert.match(raw.err, /placeholder __VOWASIA_SITE_ID__ \/ __VOWASIA_SITE_SLUG__ not filled/);
  assert.equal(await withClient("postgres", async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].n), 0);
  for (const [site, slug, why] of [
    ["00000000-0000-0000-0000-0000000000ff", "vowasia", /SELF-CHECK STOP: view sites does not return exactly 1 row/],
    [u.siteO, "vowasia", /SELF-CHECK STOP: the site row slug is not the expected slug/],
  ] as const) {
    const bad = path.join(DIR, "02-bad.sql");
    writeFileSync(bad, fill(tpl02, site, "probe_uuid", slug), { mode: 0o600 });
    const r = psql("probe_uuid", bad);
    assert.notEqual(r.status, 0, "a failing self-check must stop psql");
    assert.match(r.err, why);
    assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0, "self-check STOP must roll back role and schema");
  }
  // m-E: database-name chốt in SQL (wrong name, and 'neondb' itself).
  const badDb = path.join(DIR, "02-baddb.sql");
  writeFileSync(badDb, fill(tpl02, u.siteV, "some_other_db"), { mode: 0o600 });
  const rDb = psql("probe_uuid", badDb);
  assert.notEqual(rDb.status, 0, "wrong legacy db name must stop");
  assert.match(rDb.err, /DB NAME STOP: connected database is not the filled old database name/);
  // MINOR-3: without ON_ERROR_STOP the status line still reports the failure honestly.
  const rDbNoStop = psql("probe_uuid", badDb, "postgres", [], false);
  assert.equal(lastLine(rDbNoStop.out), "SELF-CHECK FAILED: nothing created", "02 status line without ON_ERROR_STOP");
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0, "02 without ON_ERROR_STOP on a wrong db creates nothing");
  await withClient("postgres", (c) => c.query("CREATE DATABASE neondb TEMPLATE probe_uuid"));
  const neonFile = path.join(DIR, "02-neon.sql");
  writeFileSync(neonFile, fill(tpl02, u.siteV, "neondb"), { mode: 0o600 });
  const rNeon = psql("neondb", neonFile);
  assert.notEqual(rNeon.status, 0, "neondb must stop");
  assert.match(rNeon.err, /DB NAME STOP: connected to neondb \(Central\)/);
  const rNeon03 = drop03("neondb");
  assert.notEqual(rNeon03.status, 0, "03 on neondb must stop");
  assert.match(rNeon03.err, /DB NAME STOP: connected to neondb/);
  await withClient("postgres", (c) => c.query("DROP DATABASE neondb"));
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0, "DB NAME STOP creates nothing");
  // G9 #3: SECURITY DEFINER functions returning trigger / event_trigger (Supabase handle_new_user
  // style) cannot be called directly: they must NOT stop 02 (kept until the filled 02 below applies).
  await withClient("probe_uuid", async (c) => {
    await c.query("CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN NEW; END'");
    await c.query("CREATE SCHEMA probe_trg");
    await c.query("GRANT USAGE ON SCHEMA probe_trg TO PUBLIC");
    await c.query("CREATE FUNCTION probe_trg.on_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN END'");
  });
  // An ordinary SECURITY DEFINER function in public that PUBLIC can call -> STOP (always).
  await withClient("probe_uuid", (c) => c.query("CREATE FUNCTION public.leak_pub() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.articles'"));
  const defPub = path.join(DIR, "02-definer-public.sql");
  writeFileSync(defPub, fill(tpl02, u.siteV, "probe_uuid"), { mode: 0o600 });
  const rDefPub = psql("probe_uuid", defPub);
  assert.notEqual(rDefPub.status, 0, "PUBLIC-callable ordinary SECURITY DEFINER in public must stop");
  assert.match(rDefPub.err, /SELF-CHECK STOP: vowasia_migrator can EXECUTE a SECURITY DEFINER function in schema public/);
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0, "public definer STOP creates nothing");
  await withClient("probe_uuid", (c) => c.query("DROP FUNCTION public.leak_pub()"));
  // m-F: a SECURITY DEFINER function outside public that PUBLIC can call -> STOP by default.
  await withClient("probe_uuid", async (c) => {
    await c.query("CREATE SCHEMA probe_ext");
    await c.query("GRANT USAGE ON SCHEMA probe_ext TO PUBLIC");
    await c.query("CREATE FUNCTION probe_ext.leak() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.articles'");
  });
  const defFile = path.join(DIR, "02-definer.sql");
  writeFileSync(defFile, fill(tpl02, u.siteV, "probe_uuid"), { mode: 0o600 });
  const rDef = psql("probe_uuid", defFile);
  assert.notEqual(rDef.status, 0, "PUBLIC-callable SECURITY DEFINER outside public must stop");
  assert.match(rDef.err, /SELF-CHECK STOP: vowasia_migrator can EXECUTE 1 SECURITY DEFINER function\(s\) outside public/);
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0, "definer STOP creates nothing");
  await withClient("probe_uuid", (c) => c.query("DROP SCHEMA probe_ext CASCADE"));
  assert.equal(await baseState("probe_uuid"), before, "base tables unchanged by a rolled-back 02");
  log("C 02: wrong site id / wrong slug / wrong db name / neondb / PUBLIC SECURITY DEFINER in public and outside public -> STOP inside the transaction, nothing created");
  const filled = path.join(DIR, "02-filled.sql");
  writeFileSync(filled, fill(tpl02, u.siteV, "probe_uuid"), { mode: 0o600 });
  const applied = psql("probe_uuid", filled);
  assert.equal(applied.status, 0, `02 apply failed: ${applied.err}`);
  assert.equal(lastLine(applied.out), "SELF-CHECK OK", "02 self-check");
  assert.match(applied.out, /^probe_uuid\|postgres$/m, "02 prints database and user first");
  assert.equal(await withClient("postgres", async (c) => (await c.query("SELECT (rolvaliduntil > now() AND rolvaliduntil < now() + interval '15 days') AS ok FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].ok), true, "role has VALID UNTIL ~14 days");
  await withClient("postgres", (c) => c.query(`ALTER ROLE vowasia_migrator PASSWORD ${c.escapeLiteral(PASSWORD)}`));
  assert.equal(await baseState("probe_uuid"), before, "base tables RLS/policies/grants unchanged by 02");
  await withClient("probe_uuid", async (c) => {
    await c.query("DROP FUNCTION public.handle_new_user()");
    await c.query("DROP SCHEMA probe_trg CASCADE");
  });
  log("C 02: unfilled template refused; filled template applied (with trigger / event_trigger SECURITY DEFINER functions present: not counted); self-check OK; base tables unchanged");

  await withClient(
    "probe_uuid",
    async (c) => {
      const s = await c.query("SELECT slug FROM vowasia_ro.sites");
      assert.deepEqual(s.rows.map((r) => r.slug), ["vowasia"]);
      const a = await c.query("SELECT DISTINCT site_id::text AS s FROM vowasia_ro.articles");
      assert.deepEqual(a.rows.map((r) => r.s), [u.siteV]);
      await expectPgError("42703", () => c.query("SELECT author_email FROM vowasia_ro.articles"), "personal column not in view");
      for (const t of ["public.articles", "public.sites", "public.secret_table_a"]) await expectPgError("42501", () => c.query(`SELECT 1 FROM ${t} LIMIT 1`), `read ${t}`);
      assert.equal((await c.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on", "role default read-only");
      await expectPgError("42501", () => c.query("UPDATE vowasia_ro.articles SET title = 'x'"), "update in the default session");
      await c.query("BEGIN READ WRITE");
      await expectPgError("42501", () => c.query("INSERT INTO vowasia_ro.articles (id, site_id) VALUES (gen_random_uuid(), gen_random_uuid())"), "insert via view");
      await c.query("ROLLBACK");
      for (const stmt of [
        "UPDATE vowasia_ro.articles SET title = 'x'",
        "DELETE FROM vowasia_ro.articles",
        "UPDATE public.articles SET title = 'x'",
        "TRUNCATE public.articles",
        "CREATE TABLE vowasia_ro.x (i int)",
        "CREATE TABLE public.x (i int)",
        "DROP VIEW vowasia_ro.articles",
        "SET ROLE postgres",
      ]) {
        await c.query("BEGIN READ WRITE");
        await expectPgError("42501", () => c.query(stmt), stmt);
        await c.query("ROLLBACK");
      }
    },
    "vowasia_migrator",
    PASSWORD,
  );
  assert.equal(await baseState("probe_uuid"), before, "base tables unchanged after role checks");
  log("C role: reads only vowasia via views; base tables, decoys, writes, DDL and SET ROLE refused");

  // D: discover through the role (views), overlay fixture.
  const outDir = path.join(DIR, "out");
  const env = { LEGACY_VOWASIA_DB_URL: url("probe_uuid", "vowasia_migrator", PASSWORD), LEGACY_VOWASIA_DB_SSL: "disable" };
  const d = runDiscover(["--mapping-overlay", OVERLAY, "--out", outDir, "--sample", "50"], env);
  assert.equal(d.status, 0, `discover failed: ${d.err}`);
  const files = ["legacy-schema-report.md", "legacy-mapping.template.json", "query-log.json"];
  assert.deepEqual(readdirSync(outDir).sort(), [...files].sort());
  assert.equal(statSync(outDir).mode & 0o777, 0o700, "out dir mode 700");
  for (const f of files) assert.equal(statSync(path.join(outDir, f)).mode & 0o777, 0o600, `${f} mode 600`);
  const report = readFileSync(path.join(outDir, "legacy-schema-report.md"), "utf8");
  assert.match(report, /MISMATCH \(role skipped\): role section -> articles\.section not found/);
  assert.match(report, /Site: one row, slug vowasia \(verified\)/);
  assert.match(report, new RegExp(`- articles: ${u.expected.length}\\b`));
  assert.match(report, /img1\.example\.invalid: \d+/);
  const qlog = JSON.parse(readFileSync(path.join(outDir, "query-log.json"), "utf8")) as { id: string; text: string }[];
  assert.ok(qlog.length > 5);
  for (const e of qlog) {
    assert.deepEqual(Object.keys(e).sort(), ["id", "text"]);
    assert.ok(e.text.startsWith("SELECT "), e.text);
    assert.ok(!/\b(BEGIN|COMMIT|INSERT|UPDATE|DELETE|READ ONLY)\b/.test(e.text), e.text);
    if (e.id.startsWith("catalog")) assert.match(e.text, /table_name = ANY\(\$2::text\[\]\)/);
    else assert.match(e.text, / WHERE "(site_id|id)" = \$1\) AS t/);
    assert.ok(!e.text.includes("secret_table"));
  }
  const outputs = [d.out, d.err, ...files.map((f) => readFileSync(path.join(outDir, f), "utf8"))];
  for (const needle of [u.siteV, u.siteV.replace(/-/g, ""), PASSWORD, BODY_MARK, TITLE_MARK, "author1@example.invalid", "secret_table"]) {
    outputs.forEach((o, i) => assert.ok(!o.includes(needle), `output #${i} leaks a forbidden value`));
  }
  log(`D discover via role: exit 0, ${qlog.length} logged statements all site-scoped SELECT; outputs carry no site id, password, body or title; modes 700/600`);

  // D2: refusals (exit 2): the other site through the views is missing; a non-vowasia_migrator
  // credential, SSL inside the URL and the removed --site-id flag are refused; no site filter refused.
  const otherOverlay = path.join(DIR, "overlay-other.json");
  writeFileSync(otherOverlay, JSON.stringify(mergeOverlay(JSON.parse(readFileSync(OVERLAY, "utf8")), { source: { siteFilter: u.siteO } })), { mode: 0o600 });
  const other = runDiscover(["--mapping-overlay", otherOverlay, "--out", path.join(DIR, "out2")], env);
  assert.equal(other.status, 2, "other site through the views must be refused");
  assert.match(other.err, /site row for the site filter was not found/);
  const admin = runDiscover(["--mapping-overlay", OVERLAY, "--out", path.join(DIR, "out3"), "--schema", "public"], { LEGACY_VOWASIA_DB_URL: url("probe_uuid"), LEGACY_VOWASIA_DB_SSL: "disable" });
  assert.equal(admin.status, 2, "a credential other than vowasia_migrator must be refused");
  assert.match(admin.err, /must log in as vowasia_migrator/);
  const sslUrl = runDiscover(["--mapping-overlay", OVERLAY, "--out", path.join(DIR, "out5")], { LEGACY_VOWASIA_DB_URL: `${env.LEGACY_VOWASIA_DB_URL}?sslmode=disable` });
  assert.equal(sslUrl.status, 2);
  assert.match(sslUrl.err, /must not carry ssl settings/);
  assert.equal(runDiscover(["--mapping-overlay", OVERLAY, "--site-id", u.siteO], env).status, 2, "--site-id is not a flag");
  const noOverlay = runDiscover(["--out", path.join(DIR, "out4")], env);
  assert.equal(noOverlay.status, 2, "no site filter must be refused");
  for (const o of [other, admin, sslUrl, noOverlay]) assert.ok(!(o.out + o.err).includes(PASSWORD) && !(o.out + o.err).includes(u.siteO));
  log("D2 discover refuses the other site, a non-vowasia_migrator credential, ssl in the URL, --site-id and a missing site filter (exit 2)");

  // E: 03 removal (twice), then 02b syntax on a throwaway database.
  const noVar = drop03("probe_uuid", "postgres", null);
  assert.notEqual(noVar.status, 0, "03 without -v legacy_db must stop");
  const wrongVar = drop03("probe_uuid", "postgres", "some_other_db");
  assert.notEqual(wrongVar.status, 0, "03 with a wrong legacy_db must stop");
  assert.match(wrongVar.err, /DB NAME STOP: connected database is not the given legacy_db/);
  // MINOR-2: without ON_ERROR_STOP, the single transaction still drops nothing (wrong name, or no -v legacy_db).
  const sqlFile03 = path.join(SQL_DIR, "03-drop-role-and-views.sql");
  const noStopWrong = psql("probe_uuid", sqlFile03, "postgres", ["-v", "legacy_db=some_other_db"], false);
  assert.match(noStopWrong.err, /DB NAME STOP/);
  assert.match(lastLine(noStopWrong.out), /^CLEANUP STOP: role vowasia_migrator still exists$/, "03 without ON_ERROR_STOP on a wrong db: role kept");
  const noStopNoVar = psql("probe_uuid", sqlFile03, "postgres", [], false);
  assert.match(lastLine(noStopNoVar.out), /^CLEANUP STOP:/, "03 without ON_ERROR_STOP and without legacy_db: nothing dropped");
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 2, "03 refusals drop nothing");
  const drop = drop03("probe_uuid");
  assert.equal(drop.status, 0, `03 failed: ${drop.err}`);
  assert.equal(lastLine(drop.out), "CLEANUP OK");
  const again = drop03("probe_uuid");
  assert.equal(again.status, 0, "03 re-run");
  assert.equal(lastLine(again.out), "CLEANUP OK");
  await withClient("probe_uuid", async (c) => {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'vowasia_ro'")).rows[0].n, 0);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].n, 0);
  });
  assert.equal(await baseState("probe_uuid"), before, "base tables unchanged after 03");
  log("E 03: schema and role gone, CLEANUP OK, re-run is clean, base tables unchanged");

  // H (Amendment 1): Supabase SQL Editor variants 01e / 02p / 03e (no psql variables).
  // The Editor sends the whole text as ONE simple-query string and shows only the last
  // result; a node-pg multi-statement query is the closest local stand-in.
  const sql01e = readFileSync(path.join(SQL_DIR, "01e-inspect-single-result.sql"), "utf8");
  await withClient(
    "probe_uuid",
    async (c) => {
      await c.query("BEGIN READ ONLY");
      const r = await c.query(sql01e);
      await c.query("ROLLBACK");
      assert.ok(!Array.isArray(r), "01e must return exactly ONE result set");
      assert.deepEqual(r.fields.map((f) => f.name), ["section", "item", "detail"]);
      const rows = r.rows as { section: string; item: string; detail: string }[];
      assert.equal(rows[0]?.section, "6 vowasia site row", "first rows: the vowasia site row (section 6)");
      assert.ok(rows.some((x) => x.section === "1 connection" && x.item === "database | role" && x.detail === "probe_uuid | probe_inspector"), "database and role row");
      const sections = new Set(rows.map((x) => x.section.split(" ")[0]));
      for (const sec of ["1", "2", "4", "5", "5a", "5c", "5d", "5e", "5b", "5f", "5g", "6b", "6", "9"]) assert.ok(sections.has(sec), `01e section ${sec} present`);
      const last = rows[rows.length - 1];
      assert.deepEqual([last?.section, last?.detail], ["9 total rows", String(rows.length)], "last row: total rows");
      assert.ok(rows.some((x) => x.section === "5c public privileges" && x.item === "databases PUBLIC can CONNECT to" && x.detail.includes("probe_uuid")));
      assert.ok(rows.some((x) => x.section === "5c public privileges" && x.item === "password_encryption"));
      const b6 = rows.filter((x) => x.section === "6b columns").map((x) => x.item.split(".")[0]);
      assert.deepEqual(b6, [...b6].sort(), "6b ordered by table, then column position (not interleaved)");
      assert.ok(rows.some((x) => x.section === "6 vowasia site row" && x.item === "vowasia" && x.detail.includes(u.siteV)), "01e finds the vowasia site row");
      assert.ok(rows.some((x) => x.section === "6b columns" && x.item === "articles.site_id"), "01e lists article columns");
      assert.ok(rows.some((x) => x.section === "4 site_id column types" && x.item === "articles" && x.detail === "uuid"));
      const all = JSON.stringify(rows);
      for (const needle of [BODY_MARK, TITLE_MARK, "author1@example.invalid", "a@example.invalid"]) assert.ok(!all.includes(needle), "01e prints no article data / personal data");
      const ord = rows.map((x) => x.section);
      assert.equal(ord.indexOf("6 vowasia site row") < ord.indexOf("1 connection"), true, "stable section order: 6 first");
    },
    "probe_inspector",
  );
  await withClient("postgres", (c) => c.query("CREATE DATABASE probe_empty"));
  await withClient("probe_empty", async (c) => {
    await c.query("BEGIN READ ONLY");
    const r = await c.query(sql01e);
    await c.query("ROLLBACK");
    assert.ok(!Array.isArray(r));
    assert.ok(r.rows.some((x) => x.section === "6 vowasia site row" && x.item === "public.sites" && x.detail === "missing"), "01e does not fail when the tables are missing");
  }, "probe_inspector");
  await withClient("probe_empty", async (c) => {
    await c.query("CREATE TABLE public.sites (id int, title text)");
    await c.query("GRANT SELECT ON public.sites TO PUBLIC");
    await c.query("CREATE SCHEMA probe_open");
    await c.query("GRANT USAGE, CREATE ON SCHEMA probe_open TO PUBLIC");
    await c.query("CREATE FUNCTION public.leak_e() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
    await c.query("CREATE FUNCTION public.trg_e() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN NEW; END'");
  });
  await withClient("probe_empty", async (c) => {
    const r = await c.query(sql01e);
    assert.ok(r.rows.some((x) => x.section === "6 vowasia site row" && x.item === "public.sites" && /^columns missing/.test(x.detail)), "01e does not fail when public.sites lacks slug/name");
    assert.ok(r.rows.some((x) => x.section.startsWith("5f ") && x.item === "public.sites"), "01e 5f lists a PUBLIC-readable table (02 would stop)");
    assert.ok(r.rows.some((x) => x.section.startsWith("5g ") && x.item === "probe_open"), "01e 5g lists a schema where PUBLIC can add objects");
    assert.ok(r.rows.some((x) => x.section.startsWith("5d ") && x.item === "public.leak_e" && x.detail.startsWith("in_public=yes")), "01e 5d marks an ordinary definer in public");
    assert.ok(!r.rows.some((x) => x.item === "public.trg_e"), "01e 5d does not count trigger-returning functions (same as 02)");
  }, "probe_inspector");
  await withClient("postgres", (c) => c.query("DROP DATABASE probe_empty"));
  log("H 01e: one result set (section,item,detail), site row first, total rows last, all sections incl. 5f/5g/CONNECT list, read-only transaction as a non-superuser, no article data; tolerates missing tables and missing site columns");

  // 02p (G9 #1): no placeholder; the password is generated IN SQL and shown only in the
  // last result cell. STOP when the role / schema / 02 state is missing.
  const tpl02p = readFileSync(path.join(SQL_DIR, "02p-set-password.sql.template"), "utf8");
  assert.ok(!tpl02p.includes("__PASSWORD__"), "02p has no password placeholder");
  const pw02pLines = tpl02p.split("\n").filter((l) => !/^\s*--/.test(l) && /\bpassword\b/i.test(l));
  assert.deepEqual(pw02pLines, ["  EXECUTE format('ALTER ROLE vowasia_migrator PASSWORD %L', pw);"], "02p: the only PASSWORD line is the generated one");
  const stop02p = async (why: RegExp, what: string): Promise<void> => {
    try {
      await withClient("probe_uuid", (c) => c.query(tpl02p));
    } catch (e) {
      assert.equal((e as { code?: string }).code, "P0001", what);
      assert.match((e as Error).message, why, what);
      return;
    }
    assert.fail(`${what}: expected 02P STOP`);
  };
  await stop02p(/02P STOP: role vowasia_migrator does not exist/, "02p before 02 (no role)");
  await withClient("postgres", (c) => c.query("CREATE ROLE vowasia_migrator LOGIN"));
  await stop02p(/02P STOP: schema vowasia_ro does not exist/, "02p without schema");
  await withClient("probe_uuid", (c) => c.query("CREATE SCHEMA vowasia_ro"));
  await stop02p(/02P STOP: the views of 02 or their SELECT grant are missing/, "02p without the views of 02");
  const pwNone = await withClient("postgres", async (c) => (await c.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'vowasia_migrator'")).rows[0].rolpassword);
  assert.equal(pwNone, null, "02P STOP sets no password");
  await withClient("probe_uuid", (c) => c.query("DROP SCHEMA vowasia_ro"));
  await withClient("postgres", (c) => c.query("DROP ROLE vowasia_migrator"));
  log("H 02p: STOP (nothing changed) when the role, the schema, or the views/grants of 02 are missing");

  // 02 pasted Editor-style (one multi-statement string), then 02p, then a SCRAM login.
  const editorResults = (await withClient("probe_uuid", (c) => c.query(fill(tpl02, u.siteV, "probe_uuid")))) as unknown as pg.QueryResult[];
  assert.ok(Array.isArray(editorResults));
  assert.equal(editorResults[editorResults.length - 1]?.rows[0]?.vowasia_self_check, "SELF-CHECK OK", "02 Editor-style: last result is SELF-CHECK OK");
  const pwBefore = await withClient("postgres", async (c) => (await c.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'vowasia_migrator'")).rows[0].rolpassword);
  assert.equal(pwBefore, null, "role from 02 has no password yet");
  // psql -f (autocommit per statement): the value is not shown, the cell says so.
  const r02pPsql = psql("probe_uuid", path.join(SQL_DIR, "02p-set-password.sql.template"));
  assert.equal(r02pPsql.status, 0, "02p via psql -f runs");
  assert.match(lastLine(r02pPsql.out), /^NOT SHOWN: run the whole file as ONE query/, "02p outside one transaction shows no value");
  assert.ok(!/[0-9a-f]{64}/.test(r02pPsql.out + r02pPsql.err), "02p via psql -f prints no generated value");
  const run02p = async (): Promise<string> => {
    const res = (await withClient("probe_uuid", (c) => c.query(tpl02p))) as unknown as pg.QueryResult[];
    assert.ok(Array.isArray(res));
    const row = res[res.length - 1]?.rows[0] as { new_secret?: string; warning?: string } | undefined;
    assert.ok(row?.warning && /no screenshot/.test(row.warning), "02p warning column");
    const v = row?.new_secret ?? "";
    assert.match(v, /^[0-9a-f]{64}$/, "02p shows a 64-hex value in the last cell");
    SECRETS.push(v);
    return v;
  };
  const gen = await run02p();
  const pwAfter = await withClient("postgres", async (c) => (await c.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'vowasia_migrator'")).rows[0].rolpassword as string);
  assert.match(pwAfter, /^SCRAM-SHA-256\$/, "02p stored a SCRAM verifier");
  assert.ok(!pwAfter.includes(gen));
  // Real password check: SCRAM for vowasia_migrator on 127.0.0.1 (the rest stays trust), then restore.
  const hba = path.join(DIR, "pg", "pg_hba.conf");
  const hbaOrig = readFileSync(hba, "utf8");
  writeFileSync(hba, `host all vowasia_migrator 127.0.0.1/32 scram-sha-256\n${hbaOrig}`);
  await withClient("postgres", (c) => c.query("SELECT pg_reload_conf()"));
  await new Promise((r) => setTimeout(r, 300));
  try {
    await expectPgError("28P01", () => withClient("probe_uuid", (c) => c.query("SELECT 1"), "vowasia_migrator", "wrong-password-0000"), "SCRAM: a wrong password is refused");
    await withClient("probe_uuid", async (c) => {
      assert.deepEqual((await c.query("SELECT slug FROM vowasia_ro.sites")).rows.map((x) => x.slug), ["vowasia"]);
    }, "vowasia_migrator", gen);
    const gen2 = await run02p();
    assert.notEqual(gen2, gen, "each 02p run generates a new value");
    await expectPgError("28P01", () => withClient("probe_uuid", (c) => c.query("SELECT 1"), "vowasia_migrator", gen), "SCRAM: the old value no longer works after a re-run");
    await withClient("probe_uuid", (c) => c.query("SELECT 1"), "vowasia_migrator", gen2);
  } finally {
    writeFileSync(hba, hbaOrig);
    await withClient("postgres", (c) => c.query("SELECT pg_reload_conf()"));
  }
  const serverLog = readFileSync(path.join(DIR, "pg.log"), "utf8");
  for (const v of SECRETS.slice(1)) assert.ok(!serverLog.includes(v), "the generated value is not in the server log");
  log("H 02 Editor-style -> SELF-CHECK OK; 02p generates a 64-hex value in SQL, shows it only in the last cell (<redacted> here), stores SCRAM; SCRAM login works with it, a wrong / old value is refused; not in the server log; psql -f shows NOT SHOWN");

  // 03e: refusals drop nothing; the filled file cleans up.
  const tpl03e = readFileSync(path.join(SQL_DIR, "03e-drop-in-editor.sql.template"), "utf8");
  assert.ok(!/:'|^\s*\\/m.test(tpl03e.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")), "03e has no psql variables or meta-commands");
  const file03eRaw = path.join(SQL_DIR, "03e-drop-in-editor.sql.template");
  const e1 = psql("probe_uuid", file03eRaw);
  assert.notEqual(e1.status, 0, "unfilled 03e must stop");
  assert.match(e1.err, /DB NAME STOP: placeholder __LEGACY_DB_NAME__ not filled/);
  const e2 = psql("probe_uuid", file03eRaw, "postgres", [], false);
  assert.match(lastLine(e2.out).split("|")[0] ?? "", /^CLEANUP STOP: role vowasia_migrator still exists$/, "unfilled 03e without ON_ERROR_STOP drops nothing");
  const wrong03e = path.join(DIR, "03e-wrong.sql");
  writeFileSync(wrong03e, tpl03e.split("__LEGACY_DB_NAME__").join("some_other_db"), { mode: 0o600 });
  const e3 = psql("probe_uuid", wrong03e);
  assert.notEqual(e3.status, 0);
  assert.match(e3.err, /DB NAME STOP: connected database is not the given legacy_db/);
  const e4 = psql("probe_uuid", wrong03e, "postgres", [], false);
  assert.match(lastLine(e4.out).split("|")[0] ?? "", /^CLEANUP STOP: role vowasia_migrator still exists$/, "wrong-name 03e without ON_ERROR_STOP drops nothing");
  await expectPgError("P0001", () => withClient("probe_uuid", (c) => c.query(readFileSync(wrong03e, "utf8"))), "03e wrong name, Editor-style");
  await withClient("postgres", (c) => c.query("CREATE DATABASE neondb TEMPLATE probe_uuid"));
  const neon03e = path.join(DIR, "03e-neon.sql");
  writeFileSync(neon03e, tpl03e.split("__LEGACY_DB_NAME__").join("neondb"), { mode: 0o600 });
  const e5 = psql("neondb", neon03e);
  assert.notEqual(e5.status, 0);
  assert.match(e5.err, /DB NAME STOP: connected to neondb/);
  await withClient("postgres", (c) => c.query("DROP DATABASE neondb"));
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 2, "03e refusals drop nothing");
  const ok03e = path.join(DIR, "03e-ok.sql");
  writeFileSync(ok03e, tpl03e.split("__LEGACY_DB_NAME__").join("probe_uuid"), { mode: 0o600 });
  const editor03e = (await withClient("probe_uuid", (c) => c.query(readFileSync(ok03e, "utf8")))) as unknown as pg.QueryResult[];
  assert.equal(editor03e[editor03e.length - 1]?.rows[0]?.vowasia_cleanup_check, "CLEANUP OK", "03e Editor-style: last result is CLEANUP OK");
  assert.deepEqual(editor03e[editor03e.length - 1]?.rows[0], { vowasia_cleanup_check: "CLEANUP OK", articles_rls_enabled: "false", sites_rls_enabled: "false", vowasia_policies_left: "0" }, "03e Editor-style: AFTER state in the last cell");
  const e6 = psql("probe_uuid", ok03e);
  assert.equal(e6.status, 0, `03e re-run failed: ${e6.err}`);
  assert.equal(lastLine(e6.out), "CLEANUP OK|false|false|0", "03e: AFTER state in the result row (no NOTICE needed)");
  assert.equal(await withClient("probe_uuid", async (c) => (await c.query(countSql)).rows[0].n), 0);
  assert.equal(await baseState("probe_uuid"), before, "base tables unchanged after the Editor variants");
  log("H 03e: unfilled / wrong name / neondb stop (with and without ON_ERROR_STOP, and Editor-style) and drop nothing; filled -> CLEANUP OK (Editor-style and psql -f), re-runnable; base tables unchanged");

  // F: non-superuser owner with CREATEROLE (Supabase/Neon-style) runs 02 and 03.
  await withClient("postgres", async (c) => {
    await c.query("CREATE DATABASE probe_nsu TEMPLATE probe_uuid");
    await c.query("CREATE ROLE site_owner LOGIN NOSUPERUSER CREATEROLE");
    await c.query("GRANT CREATE ON DATABASE probe_nsu TO site_owner");
  });
  await withClient("probe_nsu", async (c) => {
    for (const t of ["articles", "sites"]) await c.query(`ALTER TABLE public.${t} OWNER TO site_owner`);
  });
  const filledN = path.join(DIR, "02-nsu.sql");
  writeFileSync(filledN, fill(tpl02, u.siteV, "probe_nsu"), { mode: 0o600 });
  const nsu = psql("probe_nsu", filledN, "site_owner");
  assert.equal(nsu.status, 0, `02 as non-superuser owner failed: ${nsu.err}`);
  assert.equal(lastLine(nsu.out), "SELF-CHECK OK");
  await withClient("postgres", (c) => c.query(`ALTER ROLE vowasia_migrator PASSWORD ${c.escapeLiteral(PASSWORD)}`));
  await withClient("probe_nsu", async (c) => {
    assert.deepEqual((await c.query("SELECT slug FROM vowasia_ro.sites")).rows.map((r) => r.slug), ["vowasia"]);
    await expectPgError("42501", () => c.query("SELECT 1 FROM public.articles LIMIT 1"), "nsu: read base table");
  }, "vowasia_migrator", PASSWORD);
  const nsuDrop = drop03("probe_nsu", "site_owner");
  assert.equal(nsuDrop.status, 0, `03 as non-superuser owner failed: ${nsuDrop.err}`);
  assert.equal(lastLine(nsuDrop.out), "CLEANUP OK");
  await withClient("postgres", async (c) => {
    await c.query("DROP DATABASE probe_nsu");
    await c.query("DROP ROLE site_owner");
  });
  log("F 02/03 by a non-superuser CREATEROLE owner: SELF-CHECK OK, role reads only the view, CLEANUP OK");

  const tpl02b = readFileSync(path.join(SQL_DIR, "02b-alternative-rls.sql.template"), "utf8");
  assert.notEqual(psql("probe_int", path.join(SQL_DIR, "02b-alternative-rls.sql.template")).status, 0, "unfilled 02b must fail");
  await withClient("postgres", (c) => c.query("CREATE DATABASE probe_rls TEMPLATE probe_int"));
  const filledB = path.join(DIR, "02b-filled.sql");
  writeFileSync(filledB, fill(tpl02b, b.siteV, "probe_rls"), { mode: 0o600 });
  const blocked = psql("probe_rls", filledB);
  assert.notEqual(blocked.status, 0, "02b must refuse while another login role can read the tables");
  assert.match(blocked.err, /RLS GUARD STOP: another role \(login or not.*probe_inspector/);
  assert.match(blocked.err, /BEFORE: public\.articles rls_enabled=f/);
  await withClient("probe_rls", async (c) => {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('articles', 'sites') AND relrowsecurity")).rows[0].n, 0, "guard: RLS untouched");
  });
  assert.equal(await withClient("postgres", async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].n), 0, "guard: no role");
  await withClient("postgres", (c) => c.query("DROP ROLE probe_inspector"));
  // m-C(a): a NOLOGIN role (anon/authenticated-style, used via SET ROLE) with SELECT also stops the guard.
  await withClient("postgres", (c) => c.query("CREATE ROLE probe_anon NOLOGIN"));
  await withClient("probe_rls", (c) => c.query("GRANT SELECT ON public.articles TO probe_anon"));
  const nologin = psql("probe_rls", filledB);
  assert.notEqual(nologin.status, 0, "02b must refuse while a NOLOGIN role can read the tables");
  assert.match(nologin.err, /RLS GUARD STOP: another role \(login or not.*probe_anon/);
  await withClient("probe_rls", (c) => c.query("REVOKE ALL ON public.articles FROM probe_anon"));
  await withClient("postgres", (c) => c.query("DROP ROLE probe_anon"));
  await withClient("postgres", (c) => c.query("CREATE DATABASE probe_rls2 TEMPLATE probe_rls"));
  const rb = psql("probe_rls", filledB);
  assert.equal(rb.status, 0, `02b apply failed: ${rb.err}`);
  assert.equal(lastLine(rb.out), "RLS SETUP OK", "02b final status line");
  await withClient("probe_rls", async (c) => {
    const r = await c.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('articles', 'sites') ORDER BY relname");
    assert.deepEqual(r.rows.map((x) => x.relrowsecurity), [true, true]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname LIKE 'vowasia_migrator_%'")).rows[0].n, 2);
  });
  assert.equal(await withClient("postgres", async (c) => (await c.query("SELECT (NOT rolinherit AND rolvaliduntil > now() AND rolvaliduntil < now() + interval '15 days') AS ok FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].ok), true, "02b role NOINHERIT + VALID UNTIL");
  // m-H documented order: manual removal (DROP POLICY + DISABLE RLS, since BEFORE was f) THEN 03.
  // Exactly the documented one-command manual removal (psql -c, one implicit transaction, lock_timeout first).
  const manual = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", "probe_rls", "-c", "SET lock_timeout = '3s'; DROP POLICY vowasia_migrator_articles ON public.articles; DROP POLICY vowasia_migrator_sites ON public.sites; ALTER TABLE public.articles DISABLE ROW LEVEL SECURITY; ALTER TABLE public.sites DISABLE ROW LEVEL SECURITY"], { encoding: "utf8" });
  assert.equal(manual.status, 0, `manual 02b removal failed: ${manual.stderr}`);
  const rbDrop = drop03("probe_rls");
  assert.equal(rbDrop.status, 0, `03 after manual 02b removal failed: ${rbDrop.err}`);
  assert.equal(lastLine(rbDrop.out), "CLEANUP OK");
  assert.match(rbDrop.err, /AFTER: public\.articles rls_enabled=f vowasia_policies_left=0/);
  // Undocumented order (03 directly after 02b): record what really happens.
  const filledB2 = path.join(DIR, "02b-rls2.sql");
  writeFileSync(filledB2, fill(tpl02b, b.siteV, "probe_rls2"), { mode: 0o600 });
  const rb2 = psql("probe_rls2", filledB2);
  assert.equal(rb2.status, 0, `02b (copy) apply failed: ${rb2.err}`);
  const direct = drop03("probe_rls2");
  assert.equal(direct.status, 0, `03 directly after 02b failed: ${direct.err}`);
  assert.equal(lastLine(direct.out), "CLEANUP OK");
  assert.match(direct.err, /AFTER: public\.articles rls_enabled=t vowasia_policies_left=0/, "03 directly: policies gone via DROP OWNED, RLS stays ON (manual step still needed)");
  await withClient("postgres", async (c) => {
    await c.query("DROP DATABASE probe_rls");
    await c.query("DROP DATABASE probe_rls2");
  });
  log("G 02b: refuses unfilled; guard stops for another login role AND a NOLOGIN role (nothing changed); applies with RLS SETUP OK, role NOINHERIT + VALID UNTIL; manual removal then 03 -> CLEANUP OK, RLS back off; 03 directly after 02b -> CLEANUP OK, policies dropped, RLS stays ON");
  log("ALL PROBE CHECKS PASSED");
}

main().catch((e: unknown) => {
  const msg = (e as Error)?.message ?? String(e);
  console.error(`[probe] FAILED: ${SECRETS.reduce((m, v) => m.split(v).join("<redacted>"), msg)}`);
  process.exit(1);
});
