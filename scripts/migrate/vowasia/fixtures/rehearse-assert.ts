/**
 * VowAsia phase-B rehearsal assertions (Amendment 4 §4.4 item 13; Hybrid gate G19).
 * LOCAL ONLY: started by rehearse-vowasia.sh after it bootstrapped the local
 * Central (seed.ts + tenant + 49 taxonomy rows), the fake legacy DB and the fake
 * image host. Every database URL comes from the environment of that script and is
 * re-checked with `assertLocalDb` before anything runs.
 *
 * Flow: snapshot (read + images) -> measure -> import dry-run -> run A --apply
 * --limit 50 -> run B (rest) -> run C (0 new) -> Media prefix -> verify ->
 * redirects -> rewrite-links (per-link answer file) -> timestamps-fix.sql (the ONE
 * place a driver executes it, on the LOCAL Central) -> verify -> mutants (allow-list
 * off and wrong digest before the import; marker changed after it) -> rollback B, rollback A ->
 * crash between create and journal + stale lock recovery -> forced upload error
 * (Q12) -> final: 0 marker rows, other tenants untouched.
 * Exits non-zero naming every failing assertion; prints the UNPROVEN list.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { assertLocalDb } from "../../../lib/local-db-guard";
import { FIX_SITE_ID, fixtureRows } from "./vowasia-legacy/fixture-rows";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..");
const WORK = process.env.REHEARSE_WORK ?? "";
if (!WORK.startsWith("/tmp/vowasia-rehearse-")) {
  console.error("[rehearse-assert] must be started by rehearse-vowasia.sh (REHEARSE_WORK); refusing.");
  process.exit(2);
}
const CENTRAL = process.env.DATABASE_URL as string;
const LEGACY_ADMIN = process.env.LEGACY_FIXTURE_ADMIN_URL as string;
assertLocalDb(CENTRAL);
assertLocalDb(LEGACY_ADMIN);
assertLocalDb(process.env.LEGACY_VOWASIA_DB_URL);
// F-2: the four R2 names must be set to "" by rehearse-vowasia.sh (dotenv cannot override them).
const R2_NAMES = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
const r2Bad = R2_NAMES.filter((k) => process.env[k] === undefined || process.env[k] !== "");
if (r2Bad.length) {
  console.error(`[rehearse-assert] ${r2Bad.join(", ")} must be exported as empty strings by rehearse-vowasia.sh (a host .env.local could reach real R2); refusing.`);
  process.exit(2);
}

const SNAP = path.join(WORK, "snapshot");
const RUNS = path.join(WORK, "runs");
const OVERLAY = path.join(WORK, "overlay.json");
const BULK = Number(process.env.REHEARSE_BULK ?? "120");

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}
const assertions: Assertion[] = [];
const unproven = [
  "real R2 upload and R2 credential errors (the local Central stores media on local disk)",
  "TTY prompt and --confirm-host on macOS, and the /neondb banner on the real host (a local DB is exempt by guard design)",
  "the real 370-row snapshot and its counts (owner dry-run OB5)",
  "the public read API of vowasia-web (no Central dev server started on 3518)",
];
function check(name: string, ok: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, ...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail !== undefined ? ` :: ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)}` : ""}`);
  return ok;
}

interface Run {
  code: number;
  out: string;
}
function tool(script: string, args: string[], env: Record<string, string> = {}): Run {
  for (let i = 0; i < 10; i++) {
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts/migrate/vowasia", script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const code = r.status ?? (r.signal === "SIGKILL" ? 137 : 1);
    if (code !== 75) return { code, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    console.log(`  (load stall in ${script}, retry ${i + 1})`);
  }
  return { code: 75, out: "load stall x10" };
}
const imp = (args: string[], env: Record<string, string> = {}) => tool("import-vowasia.ts", ["--snapshot", SNAP, "--runs-dir", RUNS, ...args], env);
const rollback = (id: string, extra: string[] = []) => tool("rollback-vowasia.ts", ["--run-id", id, "--runs-dir", RUNS, ...extra]);
const verify = (digest: string) => tool("verify-vowasia.ts", ["--snapshot", SNAP, "--runs-dir", RUNS, "--expect-sha256", digest]);

async function q<T = Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const MARKER = "SELECT count(*)::int AS n FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'vowasia' AND a.origin = 'import' AND a.engine_source_name = 'legacy:vowasia'";
const markerCount = async () => Number((await q<{ n: number }>(CENTRAL, MARKER))[0]?.n);
const vowasiaMedia = async () => q<{ id: number; prefix: string | null }>(CENTRAL, "SELECT m.id, m.prefix FROM media m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = 'vowasia'");
const otherTenants = async () => (await q<{ n: number }>(CENTRAL, "SELECT count(*)::int AS n FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug <> 'vowasia'"))[0]?.n;
const lockPath = path.join(RUNS, ".import.lock");
const slugMapLen = (id: string) => (existsSync(path.join(RUNS, id, "slug-map.ndjson")) ? readFileSync(path.join(RUNS, id, "slug-map.ndjson"), "utf8").split("\n").filter(Boolean).length : 0);

/** Where Payload keeps the localized body/slug (articles_locales) for this config. */
async function bodyText(slug: string): Promise<string> {
  const loc = await q<{ table_name: string }>(CENTRAL, "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'body' AND table_name IN ('articles', 'articles_locales')");
  const inLocales = loc.some((x) => x.table_name === "articles_locales");
  const sql = inLocales
    ? "SELECT l.body::text AS b FROM articles_locales l JOIN articles a ON a.id = l._parent_id JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'vowasia' AND l.slug = $1"
    : "SELECT a.body::text AS b FROM articles a JOIN articles_locales l ON l._parent_id = a.id JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'vowasia' AND l.slug = $1";
  return (await q<{ b: string }>(CENTRAL, sql, [slug]))[0]?.b ?? "";
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const rows = fixtureRows({ bulk: BULK });
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const importable = rows.length - rejected;
  const publishedOrArchived = rows.filter((r) => r.status === "published" || r.status === "archived").length;
  const othersBefore = await otherTenants();

  console.log("\n== bootstrap (OB1 rehearsed)");
  {
    const c = (await q<Record<string, number>>(CENTRAL, "SELECT (SELECT count(*) FROM pillars p JOIN tenants t ON t.id = p.tenant_id WHERE t.slug = 'vowasia')::int AS pillars, (SELECT count(*) FROM subsections s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = 'vowasia')::int AS subs, (SELECT count(*) FROM tags g JOIN tenants t ON t.id = g.tenant_id WHERE t.slug = 'vowasia')::int AS tags, (SELECT count(*) FROM authors a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'vowasia')::int AS authors"))[0] as Record<string, number>;
    check("tenant vowasia holds 8 pillars, 27 sub-sections, 6 tags, 6 authors", c.pillars === 8 && c.subs === 27 && c.tags === 6 && c.authors === 6, c);
    const tl = existsSync(path.join(WORK, "taxonomy.log")) ? readFileSync(path.join(WORK, "taxonomy.log"), "utf8") : "";
    check("taxonomy --apply created 49 rows", /created 49 row\(s\)/.test(tl), tl.slice(-300));
    const legacy = await q<{ n: number }>(LEGACY_ADMIN, "SELECT count(*)::int AS n FROM public.articles WHERE site_id = $1", [FIX_SITE_ID]);
    check("fake legacy DB holds the fixture rows", legacy[0]?.n === rows.length, legacy);
  }

  console.log("\n== snapshot -> measure");
  let digest = "";
  {
    const r = tool("snapshot-vowasia.ts", ["--mapping-overlay", OVERLAY, "--out", SNAP]);
    check("snapshot read exits 0", r.code === 0, r.out.slice(-600));
    const d = tool("snapshot-vowasia.ts", ["--download-images", "--snapshot", SNAP, "--mapping-overlay", OVERLAY, "--rehearsal"]);
    check("image download exits 0", d.code === 0, d.out.slice(-600));
    digest = /manifest\.json sha256[^:]*: ([0-9a-f]{64})/.exec(d.out)?.[1] ?? "";
    check("manifest digest printed", digest.length === 64, d.out.slice(-300));
    check("0 image failures", /failed=0 /.test(d.out), d.out.slice(-300));
    const noAllow = path.join(WORK, "overlay-no-allowlist.json");
    const ov = JSON.parse(readFileSync(OVERLAY, "utf8"));
    delete ov.media.hostAllowlist;
    writeFileSync(noAllow, JSON.stringify(ov));
    const m1 = tool("snapshot-vowasia.ts", ["--download-images", "--snapshot", SNAP, "--mapping-overlay", noAllow, "--rehearsal"]);
    check("mutant: allow-list off -> download refused (exit 2)", m1.code === 2 && /hostAllowlist is empty/.test(m1.out), m1.out.slice(-300));
    const ms = tool("measure-vowasia.ts", ["--snapshot", SNAP, "--out", path.join(WORK, "measure")]);
    check("measure exits 0", ms.code === 0, ms.out.slice(-400));
  }

  console.log("\n== import dry-run, run A (--limit 50), run B, run C");
  {
    const wrong = imp(["--expect-sha256", "0".repeat(64)]);
    check("mutant: wrong --expect-sha256 -> refused (exit 2)", wrong.code === 2, wrong.out.slice(-300));
    const dry = imp(["--expect-sha256", digest]);
    check("dry-run exits 0", dry.code === 0, dry.out.slice(-800));
    check("dry-run prints the database name first", /database name \(new URL\(DATABASE_URL\)\.pathname\): "\/vowasia_rehearsal"/.test(dry.out.split("\n").find((l) => l.includes("[import]")) ?? ""), dry.out.slice(0, 300));
    check(`dry-run: to import ${importable}, dropped ${rejected}, 0 C8 rejects`, dry.out.includes(`to import: ${importable} `) && dry.out.includes(`dropped (rejected, C2): ${rejected};`) && dry.out.includes("C8 rejects: 0"), dry.out.slice(-1500));
    check("dry-run: 4 old-site-article links listed with slug and URL", (dry.out.match(/link: old-site-article slug=links-post url=https:\/\/(www\.)?vowasia\.com\/article\//g) ?? []).length === 4);
    check(`dry-run: expected redirect map ${rejected + publishedOrArchived} entries`, dry.out.includes(`expected redirect map: ${rejected + publishedOrArchived} entries = ${rejected} x 410`), /expected redirect map[^\n]*/.exec(dry.out)?.[0]);
    check("dry-run wrote nothing to Central", (await markerCount()) === 0);
    const a = imp(["--expect-sha256", digest, "--apply", "--run-id", "A", "--limit", "50"]);
    check("run A --apply --limit 50 exits 0", a.code === 0, a.out.slice(-800));
    check("run A created 50 marker rows", (await markerCount()) === 50, await markerCount());
    const b = imp(["--expect-sha256", digest, "--apply", "--run-id", "B"]);
    check("run B (new run id) exits 0", b.code === 0, b.out.slice(-800));
    check(`after run B: ${importable} marker rows (no duplicates)`, (await markerCount()) === importable, await markerCount());
    const c = imp(["--expect-sha256", digest, "--apply", "--run-id", "C"]);
    check("run C exits 0 and creates 0 new rows", c.code === 0 && (await markerCount()) === importable && slugMapLen("C") === 0, c.out.slice(-400));
    const media = await vowasiaMedia();
    check("every tenant-vowasia Media has prefix === 'vowasia'", media.length > 0 && media.every((m) => m.prefix === "vowasia"), media.slice(0, 5));
    check("lock released after the runs", !existsSync(lockPath));
  }

  console.log("\n== verify, redirects");
  {
    const v = verify(digest);
    check("verify exits 0 (VERIFY OK)", v.code === 0 && /VERIFY OK/.test(v.out), v.out.slice(-1200));
    const r = tool("build-vowasia-redirects.ts", ["--snapshot", SNAP, "--expect-sha256", digest, "--out", path.join(WORK, "redirects"), "--min-coverage", "100"]);
    check("redirects exits 0 with coverage 100%", r.code === 0, r.out.slice(-800));
    const map = existsSync(path.join(WORK, "redirects", "redirect-map.json")) ? (JSON.parse(readFileSync(path.join(WORK, "redirects", "redirect-map.json"), "utf8")) as Record<string, unknown>) : {};
    check(`redirect map has ${rejected + publishedOrArchived} entries (${rejected} x 410)`, Object.keys(map).length === rejected + publishedOrArchived && Object.values(map).filter((x) => typeof x === "object").length === rejected, Object.keys(map).length);
    check("redirect rules: published -> /pillar/slug, archived -> /pillar, no-cover -> /pillar, old draft none", map["/article/body-images-post"] === "/venues/body-images-post" && map["/article/archived-target"] === "/style" && map["/article/no-cover-published"] === "/style" && map["/article/old-draft"] === undefined);
  }

  console.log("\n== rewrite-links (per-link answer file), timestamps-fix.sql");
  {
    const ans = path.join(WORK, "old-site-links.txt");
    writeFileSync(ans, ["https://vowasia.com/article/body-images-post", "https://www.vowasia.com/article/archived-target", "https://vowasia.com/article/no-cover-published", "https://vowasia.com/article/rejected-one"].map((u) => `links-post ${u} rewrite`).join("\n") + "\n");
    const base = ["--runs-dir", RUNS, "--snapshot", SNAP, "--expect-sha256", digest, "--old-site-links-file", ans];
    const dry = tool("rewrite-links-vowasia.ts", ["--run-id", "A", ...base]);
    check("rewrite-links dry-run exits 0 and prints the replacement", dry.code === 0 && /decision=rewrite -> "\/venues\/body-images-post"/.test(dry.out), dry.out.slice(-800));
    check("rewrite-links dry-run changed nothing", (await bodyText("links-post")).includes("https://vowasia.com/article/body-images-post"));
    const ap = tool("rewrite-links-vowasia.ts", ["--run-id", "A", ...base, "--apply"]);
    check("rewrite-links --apply exits 0", ap.code === 0, ap.out.slice(-600));
    const body = await bodyText("links-post");
    check("links-post now points at /venues/body-images-post; other links unchanged; external kept", body.includes("/venues/body-images-post for the venue") && body.includes("https://www.vowasia.com/article/archived-target") && body.includes("https://partner.example.invalid/report?id=7"), body.slice(0, 600));
    const bRun = tool("rewrite-links-vowasia.ts", ["--run-id", "B", ...base, "--apply"]);
    check("rewrite-links for run B (other-run entries accepted, ignored) exits 0", bRun.code === 0, bRun.out.slice(-400));
    const sql = path.join(RUNS, "A", "timestamps-fix.sql");
    const p = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", "54347", "-U", "postgres", "-d", "vowasia_rehearsal", "-f", sql], { encoding: "utf8", env: { ...process.env, PGPASSWORD: "password" } });
    check("timestamps-fix.sql of run A runs with ON_ERROR_STOP (exit 0)", p.status === 0, `${p.stdout}${p.stderr}`.slice(-600));
    const ca = await q<{ c: string }>(CENTRAL, "SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS c FROM articles a JOIN articles_locales l ON l._parent_id = a.id WHERE l.slug = 'body-images-post'");
    check("legacy created_at restored on body-images-post", ca[0]?.c === "2025-01-02T10:00:00", ca);
    const v = verify(digest);
    check("verify still OK after rewrite-links and timestamps-fix", v.code === 0, v.out.slice(-800));
  }

  console.log("\n== mutants (must make verify RED)");
  {
    const setMarker = async (v: string) => {
      const id = (await q<{ id: number }>(CENTRAL, "SELECT a.id FROM articles a JOIN articles_locales l ON l._parent_id = a.id WHERE l.slug = 'ring-post'"))[0]?.id;
      await q(CENTRAL, "UPDATE articles SET engine_source_name = $1 WHERE id = $2", [v, id]);
      // draft reads come from the versions table: change the copy there too
      const vcols = await q<{ column_name: string }>(CENTRAL, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '_articles_v' AND column_name LIKE '%engine_source_name'");
      for (const c of vcols) await q(CENTRAL, `UPDATE _articles_v SET "${c.column_name.replace(/[^a-z_]/g, "")}" = $1 WHERE parent_id = $2`, [v, id]);
    };
    await setMarker("legacy:mutant");
    const v1 = verify(digest);
    check("mutant: marker changed on one row -> verify exit 3", v1.code === 3, v1.out.slice(-400));
    await setMarker("legacy:vowasia");
    check("mutant restored -> verify exit 0", verify(digest).code === 0);
  }

  console.log("\n== rollback B, rollback A");
  {
    const dryB = rollback("B");
    check("rollback B dry-run exits 0 and deletes nothing", dryB.code === 0 && (await markerCount()) === importable, dryB.out.slice(-400));
    const rb = rollback("B", ["--apply"]);
    check("rollback B --apply exits 0", rb.code === 0, rb.out.slice(-600));
    check(`after rollback B: 50 marker rows (run A untouched)`, (await markerCount()) === 50, await markerCount());
    const ra = rollback("A", ["--apply"]);
    check("rollback A --apply exits 0 (rewritten + timestamp-fixed rows included)", ra.code === 0, ra.out.slice(-600));
    check("after rollback A: 0 marker rows", (await markerCount()) === 0, await markerCount());
    check("no tenant-vowasia Media left", (await vowasiaMedia()).length === 0, (await vowasiaMedia()).length);
  }

  console.log("\n== crash between create and journal; stale lock recovery");
  {
    const d = imp(["--expect-sha256", digest, "--apply", "--run-id", "D", "--limit", "10"], { VOWASIA_TEST_KILL_BEFORE_JOURNAL: "3" });
    check("run D killed after the 3rd create (exit 137)", d.code === 137, d.out.slice(-400));
    check(".import.lock is still there after the kill", existsSync(lockPath));
    const refused = rollback("D", ["--apply"]);
    check("rollback D --apply refuses while the stale lock exists", refused.code === 2 && /held by pid \d+, run D, import/.test(refused.out), refused.out.slice(-300));
    const ps = spawnSync("sh", ["-c", "ps aux | grep -E 'import-vowasia|rollback-vowasia|rewrite-links-vowasia' | grep -v grep || true"], { encoding: "utf8" });
    check("runbook step 1: no import/rollback/rewrite-links process running", ps.stdout.trim() === "", ps.stdout);
    rmSync(lockPath, { force: true });
    check("rollback D dry-run exits 0", rollback("D").code === 0);
    const ok = rollback("D", ["--apply"]);
    check("rollback D --apply exits 0 and removes the 3 rows (incl. the unjournaled one)", ok.code === 0 && (await markerCount()) === 0, ok.out.slice(-600));
  }

  console.log("\n== forced upload error (Q12)");
  {
    const e = imp(["--expect-sha256", digest, "--apply", "--run-id", "E", "--limit", "10"], { VOWASIA_TEST_FAIL_UPLOAD_AT: "4" });
    check("run E stops with a non-zero exit", e.code === 1, e.out.slice(-400));
    const outcomes = readFileSync(path.join(RUNS, "E", "outcome.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { result: string; reason?: string; slug: string });
    const failed = outcomes.filter((o) => o.result === "failed");
    check("exactly one outcome failed/uploadError", failed.length === 1 && failed[0]?.reason === "uploadError", failed);
    check("no article for the failed upload; created rows = journaled rows", (await markerCount()) === slugMapLen("E") && !(await bodyText(failed[0]?.slug ?? "x")), { marker: await markerCount(), journaled: slugMapLen("E") });
    check("lock released after the upload stop", !existsSync(lockPath));
    check("rollback E --apply exits 0", rollback("E", ["--apply"]).code === 0 && (await markerCount()) === 0);
  }

  console.log("\n== final");
  check("other tenants' articles untouched", (await otherTenants()) === othersBefore, { before: othersBefore, after: await otherTenants() });
  check("0 marker rows at the end", (await markerCount()) === 0);
  const failed = assertions.filter((x) => !x.ok);
  console.log(`\nrehearse-assert: ${assertions.length - failed.length}/${assertions.length} assertions ok in ${Math.round((Date.now() - t0) / 1000)} s; UNPROVEN: ${unproven.join("; ")}`);
  if (failed.length) console.log(`FAILED: ${failed.map((x) => x.name).join(" | ")}`);
  return failed.length ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(`rehearse-assert aborted: ${(err as Error).message}`);
    process.exit(1);
  });
