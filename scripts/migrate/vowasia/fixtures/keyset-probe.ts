/**
 * VowAsia phase A probe body (Hybrid gate G6), started ONLY by keyset-probe.sh
 * against the throwaway PostgreSQL 16 it created (127.0.0.1, port 54331-54339).
 *
 *   A. keyset reads on real PG, uuid site ids: same millisecond / different
 *      microseconds at page boundaries, identical created-at with different ids,
 *      NULL created-at, 1970; page sizes 1/2/3; another site interleaved.
 *   B. the same with integer (bigint) site ids.
 *   C. owner SQL: 02 refuses when not filled; 02 filled applies, self-check OK;
 *      the role reads only the vowasia rows through the views, cannot read the
 *      base tables, cannot write or create anything; RLS/policies/grants of the
 *      base tables unchanged.
 *   D. discover through the role (overlay fixture): exit 0, report written,
 *      query-log only site-scoped SELECTs, no site id / password / body / title
 *      in stdout, stderr or any output file, out dir 700, files 600; discover
 *      on the other site is refused (exit 2).
 *   E. 03 removes schema + role and is re-runnable; 02b fill + apply on a
 *      throwaway database (syntax only), then removed.
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

function psql(db: string, file: string): { status: number; out: string; err: string } {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-f", file], { encoding: "utf8" });
  return { status: r.status ?? -1, out: r.stdout.trim(), err: r.stderr.trim() };
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

function fill(template: string, site: string): string {
  return template.split("__VOWASIA_SITE_ID__").join(site).split("__ARTICLE_COLUMNS__").join(ARTICLE_COLUMNS);
}

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

  // C: owner SQL 02.
  const before = await baseState("probe_uuid");
  const tpl02 = readFileSync(path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"), "utf8");
  assert.ok(!/password\s+'/i.test(tpl02));
  const raw = psql("probe_uuid", path.join(SQL_DIR, "02-create-readonly-role-views.sql.template"));
  assert.notEqual(raw.status, 0, "unfilled 02 must fail");
  assert.match(raw.err, /placeholder __VOWASIA_SITE_ID__ not filled/);
  assert.equal(await withClient("postgres", async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].n), 0);
  const filled = path.join(DIR, "02-filled.sql");
  writeFileSync(filled, fill(tpl02, u.siteV), { mode: 0o600 });
  const applied = psql("probe_uuid", filled);
  assert.equal(applied.status, 0, `02 apply failed: ${applied.err}`);
  assert.equal(applied.out, "SELF-CHECK OK", "02 self-check");
  await withClient("postgres", (c) => c.query(`ALTER ROLE vowasia_migrator PASSWORD ${c.escapeLiteral(PASSWORD)}`));
  assert.equal(await baseState("probe_uuid"), before, "base tables RLS/policies/grants unchanged by 02");
  log("C 02: unfilled template refused; filled template applied; self-check OK; base tables unchanged");

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

  // D2: discover on the other site is refused (exit 2): through the views it is missing, on the base tables its slug is not vowasia.
  const other = runDiscover(["--mapping-overlay", OVERLAY, "--out", path.join(DIR, "out2"), "--site-id", u.siteO], env);
  assert.equal(other.status, 2, "other site through the views must be refused");
  assert.match(other.err, /site row for the site filter was not found/);
  const admin = runDiscover(["--mapping-overlay", OVERLAY, "--out", path.join(DIR, "out3"), "--schema", "public", "--site-id", u.siteO], { LEGACY_VOWASIA_DB_URL: url("probe_uuid"), LEGACY_VOWASIA_DB_SSL: "disable" });
  assert.equal(admin.status, 2, "a non-vowasia site must be refused");
  assert.match(admin.err, /expected vowasia slug/);
  const noOverlay = runDiscover(["--out", path.join(DIR, "out4")], env);
  assert.equal(noOverlay.status, 2, "no site filter must be refused");
  log("D2 discover refuses the other site (views: missing; base tables: wrong slug) and a missing site filter (exit 2)");

  // E: 03 removal (twice), then 02b syntax on a throwaway database.
  const drop = psql("probe_uuid", path.join(SQL_DIR, "03-drop-role-and-views.sql"));
  assert.equal(drop.status, 0, `03 failed: ${drop.err}`);
  assert.equal(psql("probe_uuid", path.join(SQL_DIR, "03-drop-role-and-views.sql")).status, 0, "03 re-run");
  await withClient("probe_uuid", async (c) => {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'vowasia_ro'")).rows[0].n, 0);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'vowasia_migrator'")).rows[0].n, 0);
  });
  assert.equal(await baseState("probe_uuid"), before, "base tables unchanged after 03");
  log("E 03: schema and role gone, re-run is clean, base tables unchanged");

  const tpl02b = readFileSync(path.join(SQL_DIR, "02b-alternative-rls.sql.template"), "utf8");
  assert.notEqual(psql("probe_int", path.join(SQL_DIR, "02b-alternative-rls.sql.template")).status, 0, "unfilled 02b must fail");
  await withClient("postgres", (c) => c.query("CREATE DATABASE probe_rls TEMPLATE probe_int"));
  const filledB = path.join(DIR, "02b-filled.sql");
  writeFileSync(filledB, fill(tpl02b, b.siteV), { mode: 0o600 });
  const rb = psql("probe_rls", filledB);
  assert.equal(rb.status, 0, `02b apply failed: ${rb.err}`);
  await withClient("probe_rls", async (c) => {
    const r = await c.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('articles', 'sites') ORDER BY relname");
    assert.deepEqual(r.rows.map((x) => x.relrowsecurity), [true, true]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname LIKE 'vowasia_migrator_%'")).rows[0].n, 2);
  });
  await withClient("postgres", async (c) => {
    await c.query("DROP DATABASE probe_rls");
    await c.query("DROP ROLE vowasia_migrator");
  });
  log("E 02b: refuses unfilled; filled version applies on a throwaway database (syntax only), then removed");
  log("ALL PROBE CHECKS PASSED");
}

main().catch((e: unknown) => {
  const msg = (e as Error)?.message ?? String(e);
  console.error(`[probe] FAILED: ${msg.split(PASSWORD).join("<redacted>")}`);
  process.exit(1);
});
