/**
 * Scripted GTP migration rehearsal assertions (gtp-launch P4, A11-S12, A12,
 * A13; gate G40). LOCAL ONLY: both the Central DB and the legacy fixture DB
 * must pass assertLocalDb before anything runs. Driven by rehearse-gtp.sh,
 * which prepares the databases, the image server and (optionally) next dev.
 *
 * This file is the ONE place a driver executes `timestamps-fix.sql` (G54),
 * on the LOCAL Central only.
 *
 * Exits non-zero naming every failing assertion; writes rehearse-summary.json
 * (assertions, UNPROVEN list, measured facts) into the rehearsal out dir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { assertLocalDb } from "../../../lib/local-db-guard";
import { fetchImage } from "../../lib/media-fetch";
import { validateGtpWebRedirectFiles, type KnownRoutes } from "../../lib/gtp-redirect-contract";
import { stableFilename } from "../../lib/gtp-transform";
import { normaliseKey } from "../../lib/normalise-path";
import { readNdjson, type SlugMapEntry } from "../../lib/run-dir";
import { repoRoot, writeJsonSafe } from "../../lib/out-dir";

const ROOT = repoRoot();
const FIX = path.join(ROOT, "scripts/migrate/fixtures/gtp-legacy");
const OVERLAY = path.join(FIX, "overlay.fixture.json");
const KNOWN = path.join(FIX, "known-routes.json");
const OUT = process.env.REHEARSE_OUT ?? path.join(ROOT, "scripts/migrate/out/rehearse");
const CENTRAL = process.env.DATABASE_URL as string;
const LEGACY_ADMIN = process.env.LEGACY_FIXTURE_ADMIN_URL ?? "postgres://postgres:password@127.0.0.1:54327/gtp_legacy";
const SITE = "00000000-0000-0000-0000-00000000f001";
const PUBLIC_BASE = process.env.PUBLIC_BASE;
const ALLOW_SKIP_PUBLIC = process.env.ALLOW_SKIP_PUBLIC === "1";

assertLocalDb(CENTRAL);
assertLocalDb(LEGACY_ADMIN);
assertLocalDb(process.env.LEGACY_GTP_DB_URL);

type Doc = Record<string, unknown>;
interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}
const assertions: Assertion[] = [];
const unproven: string[] = [];
const facts: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail?: unknown): boolean {
  assertions.push({ name, ok, ...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail !== undefined ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return ok;
}

interface Run {
  code: number;
  out: string;
}
/** Run a tool with node --import tsx; retries the known load stall (exit 75). */
function tool(script: string, args: string[], env: Record<string, string> = {}): Run {
  for (let i = 0; i < 10; i++) {
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const code = r.status ?? (r.signal ? 128 : 1);
    if (code !== 75) return { code, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    console.log(`  (load stall in ${script}, retry ${i + 1})`);
  }
  return { code: 75, out: "load stall x10" };
}
const T = (n: string) => `scripts/migrate/${n}`;
const OV = ["--mapping-overlay", OVERLAY];
const RH = [...OV, "--rehearsal", "--out", OUT];
// The committed mapping is final; provisional-path checks run against a clone carrying one marker.
const PROV_MAPPING = path.join(OUT, "legacy-mapping.provisional.json");
function writeProvisionalMapping(): string {
  const raw = JSON.parse(readFileSync(path.join(ROOT, T("legacy-mapping.gtp-network.json")), "utf8")) as Record<string, unknown>;
  raw._provisional = ["urls.articlePathTemplate"];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PROV_MAPPING, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  return PROV_MAPPING;
}
const importArgs = (runId: string, extra: string[] = []) => [...RH, "--run-id", runId, ...extra];

function helper(action: string, args: Record<string, unknown> = {}): Doc {
  const r = tool(T("fixtures/gtp-legacy/rehearse-central-helper.ts"), [action, JSON.stringify(args)]);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (r.code !== 0 || !line) throw new Error(`helper ${action} failed (${r.code}): ${r.out.slice(-800)}`);
  return JSON.parse(line.slice(7)) as Doc;
}

const runDir = (id: string) => path.join(OUT, id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const report = (id: string) => JSON.parse(readFileSync(path.join(runDir(id), "import-report.json"), "utf8")) as any;
const slugMap = (id: string) => JSON.parse(readFileSync(path.join(runDir(id), "slug-map.json"), "utf8")) as SlugMapEntry[];

async function q<T = Doc>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const MARKER_SQL = "SELECT count(*)::int AS n FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'gtp' AND a.origin = 'import' AND a.engine_source_name = 'legacy:globaltravelpost'";
const markerCount = async () => Number((await q<{ n: number }>(CENTRAL, MARKER_SQL))[0]?.n);
const centralCounts = async () =>
  (await q<Doc>(CENTRAL, "SELECT (SELECT count(*) FROM articles)::int AS articles, (SELECT count(*) FROM media)::int AS media, (SELECT count(*) FROM tags)::int AS tags, (SELECT count(*) FROM activity_log)::int AS activity"))[0] as Doc;
const gtpMediaCount = async () => Number((await q<{ n: number }>(CENTRAL, "SELECT count(*)::int AS n FROM media m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = 'gtp'"))[0]?.n);

function rollback(id: string, extra: string[] = []): Run {
  return tool(T("rollback-gtp-import.ts"), ["--run-id", id, "--out", OUT, ...extra]);
}

async function main(): Promise<number> {
  const t0 = Date.now();
  rmSync(OUT, { recursive: true, force: true });
  const legacy = await q<Doc>(LEGACY_ADMIN, "SELECT id::text, slug, status, section, subsection, featured_image, source_url, title->>'en' AS title, site_id::text FROM articles ORDER BY created_at, id");
  const gtpRows = legacy.filter((r) => r.site_id === SITE);
  const expected = JSON.parse(readFileSync(path.join(ROOT, "scripts/migrate/out/fixture-expected.json"), "utf8")) as Doc & { byStatus: Record<string, number>; xssLegacyIds: string[]; internalLinkFrom: string; internalLinkTo: string; slugsShared: string[] };
  const importable = gtpRows.filter((r) => ["published", "archived", "draft"].includes(String(r.status))).length;
  const id = (i: number) => `aaaaaaaa-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
  const rowById = new Map(gtpRows.map((r) => [String(r.id), r]));

  console.log("\n== step 4: discovery (G6, G33c, G33b)");
  {
    const r = tool(T("discover-legacy-pg.ts"), ["--site-id", SITE, ...OV, "--out", path.join(OUT, "discover")]);
    check("discover exits 0", r.code === 0, r.out.slice(-400));
    const rep = readFileSync(path.join(OUT, "discover/legacy-schema-report.md"), "utf8");
    const inventory = rep.slice(rep.indexOf("## Inventory"), rep.indexOf("## Columns"));
    const tables = [...inventory.matchAll(/^\| ([a-z_]+) \| \d+ \|/gm)].map((m) => m[1]);
    const uniq = [...new Set(tables)];
    check("discovery report covers exactly the 9 allow-listed tables", uniq.length === 9 && !uniq.includes("article_review_queue"), uniq);
    check("discovery counts are site-filtered (articles 300 of 380)", /\| articles \| \d+ \| 300 \|/.test(rep) && legacy.length === 380, legacy.length);
    check("discovery names no decoy or non-allow-listed relation", !/secret_table|article_review_queue|CANARY/.test(rep));
    const tmpl = readFileSync(path.join(OUT, "discover/legacy-mapping.template.json"), "utf8");
    check("template carries TODO markers (validate fails until filled)", /TODO/.test(tmpl));
    const excerpt = rep.slice(rep.indexOf("## Inventory"), rep.indexOf("## Columns")).trim() + "\n";
    const expFile = path.join(FIX, "expected/legacy-schema-report.excerpt.md");
    check("G6 report excerpt equals the committed snapshot", existsSync(expFile) && readFileSync(expFile, "utf8") === excerpt, existsSync(expFile) ? "differs" : "missing");
  }

  console.log("\n== G5: the SELECT-only role cannot write or read decoys");
  {
    const c = new pg.Client({ connectionString: process.env.LEGACY_GTP_DB_URL });
    await c.connect();
    let insertRefused = false;
    let decoyRefused = false;
    let queueRefused = false;
    try {
      await c.query("INSERT INTO articles (id, site_id, title, status) VALUES (gen_random_uuid(), $1, '{}', 'draft')", [SITE]);
    } catch (e) {
      insertRefused = /permission denied|read-only/i.test(String((e as Error).message));
    }
    try {
      await c.query("SELECT * FROM secret_table_a");
    } catch (e) {
      decoyRefused = /permission denied/i.test(String((e as Error).message));
    }
    try {
      await c.query("SELECT * FROM article_review_queue");
    } catch (e) {
      queueRefused = /permission denied/i.test(String((e as Error).message));
    }
    await c.end();
    check("write attempt as gtp_migrator fails at the DB", insertRefused);
    check("decoy table unreadable as gtp_migrator", decoyRefused);
    check("article_review_queue unreadable as gtp_migrator", queueRefused);
  }

  console.log("\n== step 5: validate-mapping");
  {
    const prov = writeProvisionalMapping();
    const s = tool(T("validate-gtp-mapping.ts"), ["--structural-only", "--mapping", prov]);
    const m = tool(T("validate-gtp-mapping.ts"), ["--mapping", T("legacy-mapping.gtp-network.json"), ...OV]);
    const f = tool(T("validate-gtp-mapping.ts"), ["--mapping", prov, ...OV, "--require-final"]);
    const ff = tool(T("validate-gtp-mapping.ts"), ["--mapping", T("legacy-mapping.gtp-network.json"), ...OV, "--require-final"]);
    check("validate --structural-only exits 0 with PROVISIONAL list (provisional clone)", s.code === 0 && /PROVISIONAL/.test(s.out) && /urls\.articlePathTemplate/.test(s.out));
    check("validate merged fixture mapping exits 0", m.code === 0);
    check("validate --require-final exits 2 while markers remain (provisional clone)", f.code === 2);
    check("validate --require-final on the committed mapping exits 0 with an empty PROVISIONAL list", ff.code === 0 && /PROVISIONAL: none/.test(ff.out) && !/urls\.articlePathTemplate/.test(ff.out), ff.out.slice(-300));
  }

  console.log("\n== step 6 / G30 / G7: default dry run writes nothing");
  {
    const before = await centralCounts();
    const r = tool(T("import-gtp-legacy.ts"), importArgs("dry1"));
    const after = await centralCounts();
    check("import with no flag exits 0", r.code === 0, r.out.slice(-600));
    check("G30/G7 row counts of articles, media, tags, activity_log unchanged", JSON.stringify(before) === JSON.stringify(after), { before, after });
    const files = readdirSync(runDir("dry1")).sort();
    check("dry run writes only the report set", files.every((f) => ["import-report.json", "import-report.md", "rejects.ndjson", "query-log.json"].includes(f)), files);
    const dr = report("dry1") as Doc;
    check("dry run plans every importable row plus events", Number(dr.planned) === importable - 0 + 12, dr.planned);
    const both = tool(T("import-gtp-legacy.ts"), importArgs("dry2", ["--apply", "--dry-run"]));
    check("--apply with --dry-run exits 2", both.code === 2);
  }

  // Pre-existing media in the gtp tenant with the stable filename of row 45's hero -> must be ADOPTED, never deleted.
  const adoptedRow = rowById.get(id(45)) as Doc;
  const adoptedFilename = stableFilename(String(adoptedRow.featured_image));
  const adopted = helper("create-adopted-media", { filename: adoptedFilename });

  console.log("\n== step 7 / G8: staged apply, idempotent re-run, resume (events 6b)");
  let sliceA: Map<string, string>;
  {
    const r1 = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply", "--limit", "50"]));
    check("staged --apply --limit 50 exits 0", r1.code === 0, r1.out.slice(-800));
    check("staged run imported 50", Number(report("rehearsal").imported) === 50, report("rehearsal").imported);
    check("pre-existing media with the same stable filename was ADOPTED (not re-uploaded)", Number((report("rehearsal") as Doc).mediaAdopted) >= 1, (report("rehearsal") as Doc).mediaAdopted);
    const r2 = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply", "--limit", "50", "--resume"]));
    const rep2 = report("rehearsal") as Doc;
    check("idempotent re-run: imported 0, skippedExisting 50", r2.code === 0 && Number(rep2.imported) === 0 && Number(rep2.skippedExisting) === 50, { code: r2.code, imported: rep2.imported, skipped: rep2.skippedExisting });
    const r3 = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply"]));
    check("E16: existing run dir without --resume exits 2", r3.code === 2);
    const r4 = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply", "--resume"]));
    const rep4 = report("rehearsal") as Doc & { events: Doc };
    check("full --resume exits 0", r4.code === 0, r4.out.slice(-800));
    check("resume imported only the remaining rows (+12 events); skippedExisting 50", Number(rep4.imported) === importable - 50 + 12 && Number(rep4.skippedExisting) === 50, { imported: rep4.imported, skipped: rep4.skippedExisting });
    check("marker rows = importable articles + 12 events", (await markerCount()) === importable + 12, await markerCount());
    const ev = rep4.events as { imported: number; duplicatesSkipped: string[]; nearListed: unknown[]; archived: number };
    check("6b events: 2 duplicates skipped, 1 near listed, 1 inactive archived, 12 imported", ev.imported === 12 && ev.duplicatesSkipped.length === 2 && ev.nearListed.length === 1 && ev.archived === 1, ev);
    const evRows = await q<Doc>(CENTRAL, `SELECT a.id, l.slug, au.name AS author, (SELECT count(*) FROM articles_briefs b WHERE b._parent_id = a.id)::int AS briefs,
       (SELECT count(*) FROM articles_briefs b WHERE b._parent_id = a.id AND (coalesce(b.label,'') = '' OR coalesce(b.value,'') = '' OR coalesce(b.source,'') = ''))::int AS bad
       FROM articles a JOIN articles_locales l ON l._parent_id = a.id AND l._locale = 'en' JOIN tenants t ON t.id = a.tenant_id LEFT JOIN authors au ON au.id = a.author_id
       WHERE t.slug = 'gtp' AND a.id = ANY($1::int[])`, [slugMap("rehearsal").filter((e) => e.kind === "event").map((e) => Number(e.articleId))]).catch((e): Doc[] => [{ error: String((e as Error).message) }]);
    check("6b events: briefs 1..4 rows, non-empty label/value/source, author GTP Newsroom, unique slugs", evRows.length === 12 && evRows.every((r) => Number(r.briefs) >= 1 && Number(r.briefs) <= 4 && Number(r.bad) === 0 && r.author === "GTP Newsroom") && new Set(evRows.map((r) => r.slug)).size === 12, evRows.slice(0, 3));
    sliceA = new Map(slugMap("rehearsal").map((e) => [e.legacyId, e.slug]));
    // G13 / S-20: escaped text stays text.
    for (const xid of expected.xssLegacyIds) {
      const slug = sliceA.get(xid);
      const body = (await q<{ body: Doc }>(CENTRAL, "SELECT l.body FROM articles_locales l JOIN articles a ON a.id = l._parent_id JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'gtp' AND l.slug = $1", [slug]))[0]?.body;
      const types = new Set<string>();
      const texts: string[] = [];
      const walk = (n: Doc) => {
        if (typeof n.type === "string") types.add(n.type);
        for (const c of (n.children as Doc[]) ?? []) walk(c);
      };
      walk((body?.root ?? {}) as Doc);
      for (const b of ((body?.root as Doc)?.children as Doc[]) ?? []) texts.push((((b.children as Doc[]) ?? []).map((c) => String(c.text ?? "")).join("")));
      check("G13 stored Lexical holds only root/paragraph/heading/text nodes", [...types].every((t) => ["root", "paragraph", "heading", "text"].includes(t)), [...types]);
      check("G13 escaped paragraph text equals the source text", texts.includes("Tags <script>alert(1)</script> & an <img src=x onerror=alert(2)> stay text; 5 < 6 & 7 > 3."), texts);
    }
    const pred = helper("public-predicate");
    facts.F2b = pred;
    check("S-19/N-13 Local API public predicate: published visible, archived and draft not", Number(pred.visible) === Number(expected.byStatus.published) + 11 && Number(pred.archived) === Number(expected.byStatus.archived) + 1 && Number(pred.drafts) === Number(expected.byStatus.draft), pred);
    check("S-19 draft rows carry _status draft", pred.draftStatus === "draft", pred.draftStatus);
  }

  console.log("\n== first rollback to an empty tenant (G12 first half)");
  {
    const before = await centralCounts();
    const dry = rollback("rehearsal");
    check("G30 rollback with no flag writes nothing", dry.code === 0 && JSON.stringify(before) === JSON.stringify(await centralCounts()));
    const r = rollback("rehearsal", ["--apply"]);
    check("rollback rehearsal --apply exits 0", r.code === 0, r.out.slice(-500));
    check("marker rows 0 after rollback", (await markerCount()) === 0);
    check("adopted media survives rollback", Boolean(helper("media-exists", { id: adopted.id }).exists));
    check("media orphans 0 (only the adopted doc remains)", (await gtpMediaCount()) === 1, await gtpMediaCount());
  }

  console.log("\n== 7b / G49: tenant and marker scoping");
  {
    const foreignRow = rowById.get(id(60)) as Doc;
    const manualRow = rowById.get(id(61)) as Doc;
    const foreignSlug = sliceA.get(id(60)) as string;
    const manualSlug = sliceA.get(id(61)) as string;
    helper("setup-scope", { foreignSlug, manualSlug, mediaFilename: stableFilename(String(foreignRow.featured_image)) });
    const fbBefore = helper("fixture-b-counts");
    const manBefore = helper("manual-article", { slug: manualSlug });
    const r = tool(T("import-gtp-legacy.ts"), importArgs("scope", ["--apply", "--ids", `${String(foreignRow.id)},${String(manualRow.id)}`]));
    const rep = report("scope") as Doc & { slugConflictForeign: string[] };
    check("scope import exits 2 because of the foreign same-tenant slug", r.code === 2, r.code);
    check("exactly one slugConflictForeign", rep.slugConflictForeign.length === 1, rep.slugConflictForeign);
    const fbAfter = helper("fixture-b-counts");
    check("no cross-tenant adoption: fixture-b counts and row unchanged", JSON.stringify(fbBefore) === JSON.stringify(fbAfter), { fbBefore, fbAfter });
    const g = helper("gtp-article", { slug: foreignSlug });
    check("the legacy row was created in tenant gtp (not adopted from fixture-b)", g !== null && Number(rep.imported) === 1, g);
    const manAfter = helper("manual-article", { slug: manualSlug });
    check("the same-tenant manual article is untouched", JSON.stringify(manBefore) === JSON.stringify(manAfter) && manAfter.origin === "manual", { manBefore, manAfter });
    check("G34 --ids run gives the same slug as the full run", slugMap("scope").every((e) => sliceA.get(e.legacyId) === e.slug));
    helper("delete-manual", { slug: manualSlug });
    check("rollback scope exits 0", rollback("scope", ["--apply"]).code === 0);
    check("marker rows 0", (await markerCount()) === 0);
  }

  console.log("\n== 8a-8c / G9: interrupt and resume from an empty tenant");
  {
    const k = tool(T("import-gtp-legacy.ts"), importArgs("interrupt", ["--apply", "--batch", "25"]), { MIGRATE_TEST_KILL_AFTER: "37" });
    check("kill after 37 exits 137", k.code === 137, k.code);
    check("37 marker rows after the kill", (await markerCount()) === 37, await markerCount());
    const r = tool(T("import-gtp-legacy.ts"), importArgs("interrupt", ["--apply", "--resume", "--batch", "25"]));
    check("resume after the kill exits 0", r.code === 0, r.out.slice(-500));
    const lines = readNdjson<SlugMapEntry>(path.join(runDir("interrupt"), "slug-map.ndjson")).filter((e) => e.articleId !== undefined);
    const uniq = new Set(lines.map((e) => e.legacyId));
    check("journal lines == Central marker rows (no duplicates)", uniq.size === lines.length && uniq.size === (await markerCount()), { lines: lines.length, uniq: uniq.size, marker: await markerCount() });
    const dupSlugs = await q<Doc>(CENTRAL, "SELECT l.slug, count(*) FROM articles_locales l JOIN articles a ON a.id = l._parent_id JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'gtp' GROUP BY l.slug HAVING count(*) > 1");
    check("no duplicate slugs in the tenant", dupSlugs.length === 0, dupSlugs);
    check("G34 resumed run gives identical slugs per legacy id", slugMap("interrupt").every((e) => sliceA.get(e.legacyId) === e.slug));
    check("rollback interrupt", rollback("interrupt", ["--apply"]).code === 0 && (await markerCount()) === 0);

    // A row journaled by ANOTHER run must never be listed as an orphan (A13-R05).
    const other = tool(T("import-gtp-legacy.ts"), importArgs("other", ["--apply", "--ids", id(70)]));
    check("other run imports one row", other.code === 0 && (await markerCount()) === 1);
    const o = tool(T("import-gtp-legacy.ts"), importArgs("orphan", ["--apply"]), { MIGRATE_TEST_KILL_BEFORE_JOURNAL: "10" });
    check("kill before journal exits 137", o.code === 137, o.code);
    const lo = rollback("orphan", ["--list-orphans"]);
    const orphanLines = lo.out.split("\n").filter((l) => l.startsWith("[rollback] orphan:"));
    check("--list-orphans lists exactly 1 orphan (not the other run's journaled row)", orphanLines.length === 1, orphanLines);
    const res = tool(T("import-gtp-legacy.ts"), importArgs("orphan", ["--apply", "--resume"]));
    const ro = report("orphan") as Doc;
    check("resume records it with baselineReconstructed", res.code === 0 && Number(ro.baselineReconstructed) === 1, { code: res.code, b: ro.baselineReconstructed });
    check("rollback orphan + other", rollback("orphan", ["--apply"]).code === 0 && rollback("other", ["--apply"]).code === 0 && (await markerCount()) === 0, await markerCount());
    const o2 = tool(T("import-gtp-legacy.ts"), importArgs("orph2", ["--apply"]), { MIGRATE_TEST_KILL_BEFORE_JOURNAL: "3" });
    check("orph2 killed before journal", o2.code === 137);
    const io = rollback("orph2", ["--apply", "--include-orphans"]);
    check("--include-orphans deletes the run's orphan (marker rows 0)", io.code === 0 && (await markerCount()) === 0, await markerCount());
  }

  console.log("\n== N-12: crash between media upload and resolution");
  {
    const before = await gtpMediaCount();
    const k = tool(T("import-gtp-legacy.ts"), importArgs("pend", ["--apply"]), { MIGRATE_TEST_KILL_AFTER_MEDIA_UPLOAD: "1" });
    check("killed after the first media upload", k.code === 137);
    const pending = readNdjson<Doc>(path.join(runDir("pend"), "media-map.ndjson")).filter((l) => l.origin === "created-pending");
    check("one created-pending entry left", pending.length === 1, pending.length);
    check("the uploaded doc exists", (await gtpMediaCount()) === before + 1);
    const r = tool(T("import-gtp-legacy.ts"), importArgs("pend", ["--apply", "--resume"]));
    const mm = JSON.parse(readFileSync(path.join(runDir("pend"), "media-map.json"), "utf8")) as Doc[];
    check("resume resolves it as created", r.code === 0 && mm.some((x) => x.filename === pending[0]?.filename && x.origin === "created"));
    check("rollback deletes it (unreferenced after the rollback)", rollback("pend", ["--apply"]).code === 0 && (await gtpMediaCount()) === before && (await markerCount()) === 0, await gtpMediaCount());
  }

  console.log("\n== 9b / G50: snapshot round trip");
  {
    const snap = path.join(OUT, "snap-files");
    const d = tool(T("discover-legacy-pg.ts"), ["--site-id", SITE, ...OV, "--out", path.join(OUT, "discover2"), "--snapshot-dir", snap]);
    check("discover --snapshot-dir exits 0", d.code === 0, d.out.slice(-300));
    const files = readdirSync(snap).sort();
    check("snapshot holds only the 9 allow-listed tables + manifest", files.length === 10 && files.includes("manifest.json") && !files.some((f) => /secret|review_queue/.test(f)), files);
    const all = files.map((f) => readFileSync(path.join(snap, f), "utf8")).join("\n");
    check("snapshot has no WTB rows, no canary strings, redacted subscriber e-mails", !/WTB twin|wtb-only|CANARY|wtb-sub@/.test(all) && !/sub\d+@example\.invalid/.test(all));
    check("snapshot files mode 600", files.every((f) => (statSync(path.join(snap, f)).mode & 0o777) === 0o600));
    const r = tool(T("import-gtp-legacy.ts"), importArgs("snap", ["--apply", "--from-snapshot", snap]));
    check("import --from-snapshot exits 0", r.code === 0, r.out.slice(-500));
    check("snapshot import slug map equals the live import", slugMap("snap").every((e) => sliceA.get(e.legacyId) === e.slug) && slugMap("snap").length === sliceA.size, slugMap("snap").length);
    const p = tool(T("verify-gtp-parity.ts"), ["--run-id", "snap", ...RH, "--from-snapshot", snap]);
    check("parity on the snapshot import exits 0", p.code === 0, p.out.split("\n").filter((l) => l.includes("FAIL")).join(" | "));
    check("rollback snap", rollback("snap", ["--apply"]).code === 0 && (await markerCount()) === 0);
  }

  console.log("\n== step 9: fresh full import (staged then resumed), rewrite-links, redirects, exports");
  {
    rmSync(runDir("rehearsal"), { recursive: true, force: true }); // E16: reuse the id only after deleting the old run dir
    const a = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply", "--limit", "50"]));
    const b = tool(T("import-gtp-legacy.ts"), importArgs("rehearsal", ["--apply", "--resume"]));
    check("fresh staged + resumed import exits 0", a.code === 0 && b.code === 0, `${a.code}/${b.code} ${b.out.slice(-300)}`);
    check("G34 fresh import slugs equal the first full run", slugMap("rehearsal").every((e) => sliceA.get(e.legacyId) === e.slug));
    const flagged = slugMap("rehearsal").filter((e) => e.internalLinkRewritable);
    check("pass 1 flags exactly the fixture row with an internal link", flagged.length === 1 && flagged[0]?.legacyId === expected.internalLinkFrom, flagged.map((e) => e.legacyId));
    const snapRows = async () => q<Doc>(CENTRAL, "SELECT a.id, a.workflow_status, a._status, a.version, a.updated_at FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = 'gtp' ORDER BY a.id");
    const pre = await snapRows();
    const dry = tool(T("rewrite-links-gtp.ts"), ["--run-id", "rehearsal", "--rehearsal", "--out", OUT]);
    check("G30 rewrite-links with no flag writes nothing", dry.code === 0 && JSON.stringify(pre) === JSON.stringify(await snapRows()), dry.out.slice(-300));
    const ap = tool(T("rewrite-links-gtp.ts"), ["--run-id", "rehearsal", "--rehearsal", "--apply", "--out", OUT]);
    const post = await snapRows();
    const flaggedId = String(flagged[0]?.articleId);
    const changed = post.filter((r, i) => JSON.stringify(r) !== JSON.stringify(pre[i])).map((r) => String(r.id));
    check("G31 only the flagged row changed (status, _status, version, updatedAt of others identical)", ap.code === 0 && changed.length <= 1 && changed.every((x) => x === flaggedId), changed);
    const target = sliceA.get(expected.internalLinkTo);
    const body = JSON.stringify((await q<Doc>(CENTRAL, "SELECT l.body FROM articles_locales l WHERE l._parent_id = $1", [Number(flaggedId)]))[0]?.body ?? {});
    check("G31 the flagged row now carries the new URL", body.includes(`/article/${target}`), target);
    const fl = slugMap("rehearsal").find((e) => e.legacyId === expected.internalLinkFrom);
    const fr = post.find((r) => String(r.id) === flaggedId);
    check("G31 pass 2 re-recorded the rollback baseline", fl !== undefined && fr !== undefined && new Date(fl.baselineUpdatedAt).toISOString() === new Date(fr.updated_at as string | Date).toISOString() && Number(fl.baselineVersion) === Number(fr.version));

    const sitemap = path.join(OUT, "sitemap-urls.txt");
    const urls = slugMap("rehearsal").filter((e) => e.oldUrl && e.status === "published").map((e) => `https://globaltravelpost.com${e.oldUrl}`);
    urls.push("https://globaltravelpost.com/never-existed", "https://globaltravelpost.com/NEWS/");
    (await import("node:fs")).writeFileSync(sitemap, urls.join("\n") + "\n", { mode: 0o600 });
    const emit = path.join(OUT, "gtp-web");
    const rr = tool(T("build-gtp-redirects.ts"), ["--run-id", "rehearsal", ...RH, "--known-routes", KNOWN, "--emit-gtp-web", emit, "--sitemap-urls", sitemap]);
    check("redirects --rehearsal exits 0 (0 loops, 0 dangling)", rr.code === 0, rr.out.slice(-400));
    const map = JSON.parse(readFileSync(path.join(emit, "redirect-map.json"), "utf8")) as Record<string, unknown>;
    const rules = JSON.parse(readFileSync(path.join(emit, "redirect-rules.json"), "utf8")) as unknown[];
    const kr = JSON.parse(readFileSync(KNOWN, "utf8")) as KnownRoutes;
    check("G35 emitted files pass validateGtpWebRedirectFiles", validateGtpWebRedirectFiles(map, rules, kr).length === 0, validateGtpWebRedirectFiles(map, rules, kr).slice(0, 5));
    // With the /article/{slug} template a row whose old URL equals its new URL gets no (identity) redirect.
    const rehomedAll = slugMap("rehearsal").filter((e) => e.rehomed && e.status === "published");
    const rehomed = rehomedAll.find((e) => normaliseKey(e.oldUrl ?? "") !== `/article/${e.slug}`) ?? rehomedAll[0];
    const rhKey = rehomed ? normaliseKey(rehomed.oldUrl ?? "") ?? "" : "";
    const rhIdentity = rhKey === `/article/${rehomed?.slug}`;
    check("G35 re-homed published row: from = ORIGINAL old URL (identity redirect dropped)", !rehomed || (rhIdentity ? map[rhKey] === undefined || map[rhKey] === `/article/${rehomed.slug}` : map[rhKey] === `/article/${rehomed.slug}`), rehomed?.oldUrl);
    const arch = slugMap("rehearsal").find((e) => e.status === "archived" && e.oldUrl);
    check("G35 archived row -> section page of its NEW location", !arch || map[normaliseKey(arch.oldUrl ?? "") ?? ""] === (arch.subSection ? `/${arch.pillar}/${arch.subSection}` : `/${arch.pillar}`), arch);
    check("G35 redirects with no --rehearsal and provisional values exits 2", tool(T("build-gtp-redirects.ts"), ["--run-id", "rehearsal", "--mapping", writeProvisionalMapping(), ...OV, "--out", OUT, "--known-routes", KNOWN]).code === 2);
    const cov = readFileSync(path.join(runDir("rehearsal"), "redirect-coverage.md"), "utf8");
    check("coverage reported for the supplied URL list", /supplied URL list: \d+ URLs, matched \d+/.test(cov));
    facts.redirects = { mapEntries: Object.keys(map).length, patterns: rules.length, coverage: (/supplied URL list: .*$/m.exec(cov) ?? [""])[0] };

    const ex = tool(T("export-gtp-legacy.ts"), [...OV, "--out", path.join(OUT, "exports")]);
    const ex2 = tool(T("export-gtp-legacy.ts"), [...OV, "--out", path.join(OUT, "exports-contact"), "--include-contact"]);
    check("export exits 0 (both variants)", ex.code === 0 && ex2.code === 0, ex.out.slice(-300));
    const E = (f: string, d = "exports") => path.join(OUT, d, f);
    const uniqueUrls = new Set(gtpRows.map((r) => String(r.source_url ?? "")).filter(Boolean)).size;
    const nd = readFileSync(E("legacy-source-urls.ndjson"), "utf8").trim().split("\n");
    check("ndjson one line per unique source_url (all statuses)", nd.length === uniqueUrls, { nd: nd.length, uniqueUrls });
    check("source-urls.txt line count equal", readFileSync(E("source-urls.txt"), "utf8").trim().split("\n").length === uniqueUrls);
    check("export files mode 600", readdirSync(path.join(OUT, "exports")).every((f) => (statSync(E(f)).mode & 0o777) === 0o600));
    const csv = readFileSync(E("gtp-subscribers.export.csv"), "utf8").trim().split("\n");
    check("subscriber CSV has 16 GTP rows (WTB excluded)", csv.length === 17 && !csv.some((l) => l.includes("wtb-sub")), csv.length);
    const press = readFileSync(E("press-submissions.snapshot.json"), "utf8");
    const press2 = readFileSync(E("press-submissions.snapshot.json", "exports-contact"), "utf8");
    check("press submissions: contact redacted by default, present with --include-contact", /"contact_name": "<redacted>"/.test(press) && /Fixture Contact 0/.test(press2) && !/Fixture Contact 0/.test(press));
    check("visa rules snapshot has 30 rows", (JSON.parse(readFileSync(E("visa-rules.snapshot.json"), "utf8")) as unknown[]).length === 30);
    check("provenance.ndjson one line per imported article", readFileSync(path.join(runDir("rehearsal"), "provenance.ndjson"), "utf8").trim().split("\n").length === importable, importable);
  }

  console.log("\n== step 10 / G10: parity");
  {
    const args = ["--run-id", "rehearsal", ...RH];
    let publicChecked = false;
    if (PUBLIC_BASE) {
      const p = tool(T("verify-gtp-parity.ts"), [...args, "--public-base", PUBLIC_BASE]);
      publicChecked = true;
      check("parity with --public-base exits 0", p.code === 0, p.out.split("\n").filter((l) => /FAIL|error/i.test(l)).slice(0, 5).join(" | "));
    } else if (ALLOW_SKIP_PUBLIC) unproven.push("public API parity (verify --public-base) skipped by --allow-skip-public: C4/C7 public parts not proven");
    else check("public API server available (or --allow-skip-public)", false, "PUBLIC_BASE missing");
    const p = tool(T("verify-gtp-parity.ts"), args);
    check("parity (Local API) exits 0", p.code === 0, p.out.split("\n").filter((l) => /FAIL/.test(l)).slice(0, 5).join(" | "));
    facts.publicApiChecked = publicChecked;
  }

  console.log("\n== G54: timestamps-fix.sql executed on the LOCAL Central (after parity, before rollback)");
  const sm = slugMap("rehearsal");
  {
    const sqlFile = path.join(runDir("rehearsal"), "timestamps-fix.sql");
    const sql = readFileSync(sqlFile, "utf8");
    const baseline = JSON.parse(readFileSync(path.join(runDir("rehearsal"), "timestamps-baseline.json"), "utf8")) as Record<string, string>;
    const skipped = JSON.parse(readFileSync(path.join(runDir("rehearsal"), "timestamps-fix.skipped.json"), "utf8")) as { slug: string; reason: string }[];
    const blocks = (sql.match(/^DO \$\$/gm) ?? []).length;
    check("E13 accounting identity: blocks + skipped = slug-map entries (events included)", blocks + skipped.length === sm.length, { blocks, skipped: skipped.length, entries: sm.length });
    check("E13 staged rows are in the file (generated from the compacted slug map of all invocations)", sm.filter((e) => e.kind === "article").every((e) => sql.includes(`l.slug = '${e.slug}'`)));
    const snap = async () => ({
      a: await q<Doc>(CENTRAL, "SELECT * FROM articles ORDER BY id"),
      l: await q<Doc>(CENTRAL, "SELECT * FROM articles_locales ORDER BY id"),
      v: await q<Doc>(CENTRAL, "SELECT * FROM _articles_v ORDER BY id"),
    });
    const s0 = await snap();
    const latestPer = await q<Doc>(CENTRAL, "SELECT parent_id, count(*)::int AS n FROM _articles_v WHERE latest = true AND parent_id = ANY($1::int[]) GROUP BY parent_id", [sm.map((e) => Number(e.articleId))]);
    facts.latestVersionRowsPerArticle = [...new Set(latestPer.map((r) => r.n))];
    if (!check("exactly 1 latest _articles_v row per imported article (else E7 NEEDS_CONTEXT)", latestPer.length === sm.length && latestPer.every((r) => r.n === 1), { rows: latestPer.length, entries: sm.length })) {
      facts.E7 = "NEEDS_CONTEXT: latest-version count is not exactly 1 per article";
    }
    const c = new pg.Client({ connectionString: CENTRAL });
    await c.connect();
    let runErr = "";
    try {
      await c.query(sql); // the ONE permitted execution of the owner-run file: LOCAL Central only (assertLocalDb above)
    } catch (e) {
      runErr = String((e as Error).message);
    }
    await c.end();
    check("timestamps-fix.sql runs without error", runErr === "", runErr);
    const s1 = await snap();
    const diffRows = (x: Doc[], y: Doc[]) => {
      const before = new Map(x.map((r) => [String(r.id), JSON.stringify(r)]));
      return y.filter((r) => before.get(String(r.id)) !== JSON.stringify(r));
    };
    const changedA = diffRows(s0.a, s1.a);
    const expectedIds = new Set(sm.filter((e) => e.legacyCreatedAt || e.legacyUpdatedAt).filter((e) => /^[a-z0-9][a-z0-9-]*$/.test(e.slug)).map((e) => String(e.articleId)));
    check("changed articles rows == the expected gtp import rows", changedA.length === expectedIds.size && changedA.every((r) => expectedIds.has(String(r.id))), { changed: changedA.length, expected: expectedIds.size });
    const colsChanged = new Set<string>();
    for (const r of changedA) {
      const o = s0.a.find((x) => String(x.id) === String(r.id)) as Doc;
      for (const k of Object.keys(r)) if (JSON.stringify(r[k]) !== JSON.stringify(o[k])) colsChanged.add(k);
    }
    check("only created_at/updated_at changed on articles (version untouched)", [...colsChanged].every((k) => k === "created_at" || k === "updated_at"), [...colsChanged]);
    check("articles_locales untouched", diffRows(s0.l, s1.l).length === 0);
    const changedV = diffRows(s0.v, s1.v);
    check("changed _articles_v rows are exactly the latest rows of those articles", changedV.length === expectedIds.size && changedV.every((r) => r.latest === true && expectedIds.has(String(r.parent_id))), changedV.length);
    const fbIds = new Set((await q<Doc>(CENTRAL, "SELECT a.id FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug <> 'gtp'")).map((r) => String(r.id)));
    check("0 rows changed outside tenant gtp (fixture-b and others)", changedA.every((r) => !fbIds.has(String(r.id))));
    const evNoSource = sm.filter((e) => e.kind === "event").map((e) => String(e.articleId));
    check("events without source timestamps unchanged", changedA.every((r) => !evNoSource.includes(String(r.id))));
    const sample = sm.filter((e) => baseline[e.slug]).slice(0, 12).map((e) => e.slug);
    const drafts = sm.filter((e) => e.status === "draft" && baseline[e.slug]).slice(0, 4).map((e) => e.slug);
    const reads = helper("read-updated", { slugs: JSON.stringify([...sample, ...drafts]) }) as Record<string, { draftFalse: string | null; draftTrue: string | null }>;
    const mism = Object.entries(reads).filter(([s, r]) => r.draftTrue !== baseline[s] || (r.draftFalse !== null && r.draftFalse !== baseline[s]));
    check("updatedAt through draft:false AND draft:true equals timestamps-baseline.json", mism.length === 0 && Object.keys(reads).length === sample.length + drafts.length, mism.slice(0, 3));
    // negative case LAST: one expected article missing -> the whole file aborts, zero rows changed.
    const victim = sm.find((e) => e.kind === "article" && e.status === "published" && e.legacyId !== expected.internalLinkFrom && baseline[e.slug]) as SlugMapEntry;
    helper("delete-article", { slug: victim.slug });
    facts.g54DeletedSlug = victim.slug;
    const s2 = await snap();
    const c2 = new pg.Client({ connectionString: CENTRAL });
    await c2.connect();
    let negErr = "";
    try {
      await c2.query(sql);
    } catch (e) {
      negErr = String((e as Error).message);
      await c2.query("ROLLBACK").catch(() => {}); // E14: close the failed transaction before querying again
    }
    await c2.end();
    const s3 = await snap();
    check("negative: missing article aborts with the row-count guard", /expected 1 article row, got 0/.test(negErr), negErr.slice(0, 160));
    check("negative: ZERO rows changed anywhere", diffRows(s2.a, s3.a).length === 0 && diffRows(s2.v, s3.v).length === 0 && diffRows(s2.l, s3.l).length === 0);
  }

  console.log("\n== C7 mutation rehearsal (one deleted above, one body altered)");
  {
    const altered = sm.find((e) => e.kind === "article" && e.status === "published" && e.slug !== facts.g54DeletedSlug && e.legacyId !== expected.internalLinkFrom) as SlugMapEntry;
    helper("alter-body", { slug: altered.slug });
    const p = tool(T("verify-gtp-parity.ts"), ["--run-id", "rehearsal", ...RH]);
    check("parity FAILS after the mutation (exit 2)", p.code === 2, p.code);
    check("parity names the count/slug drift and the body drift", /\s1 FAIL|\s3 FAIL/.test(p.out) && /\s4 FAIL/.test(p.out), p.out.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
  }

  console.log("\n== step 11 / G12 / G43 / G52: rollback rules");
  {
    const edited = sm.find((e) => e.kind === "article" && e.status === "published" && e.slug !== facts.g54DeletedSlug && sm.filter((x) => x.legacyId !== e.legacyId).length > 0 && e.legacyId !== expected.internalLinkFrom && e.legacyId !== id(45)) as SlugMapEntry;
    const er = helper("edit-article", { slug: edited.slug });
    check("editor edit bumped the version", Number(er.version) === 2, er);
    const editedHero = helper("gtp-article", { slug: edited.slug }).heroImage as number | null;
    const r = rollback("rehearsal", ["--apply"]);
    const rep = JSON.parse(readFileSync(path.join(runDir("rehearsal"), "rollback-report.json"), "utf8")) as Doc & { keptEdited: string[]; alreadyGone: string[]; deleted: number; mediaKeptReferenced: number; mediaKeptAdopted: number };
    check("rollback without --include-edited exits 0", r.code === 0, r.out.slice(-400));
    check("G52/G43 the edited article is kept", rep.keptEdited.length === 1 && (await markerCount()) === 1, { kept: rep.keptEdited, marker: await markerCount() });
    check("E15 rollback tolerates the deleted (already gone) article", rep.alreadyGone.length === 1, rep.alreadyGone);
    check("G43/N-09 SQL-set updatedAt rows were deleted via timestamps-baseline.json", Number(rep.deleted) === sm.length - 2, { deleted: rep.deleted, entries: sm.length });
    check("G43 media referenced by the kept article is kept", editedHero !== null && editedHero !== undefined && Boolean(helper("media-exists", { id: editedHero }).exists), editedHero);
    check("G43 adopted media never deleted", Boolean(helper("media-exists", { id: adopted.id }).exists) && Number(rep.mediaKeptAdopted) >= 1, rep.mediaKeptAdopted);
    const r2 = rollback("rehearsal", ["--apply", "--include-edited"]);
    check("G52 --include-edited deletes the edited article", r2.code === 0 && (await markerCount()) === 0, await markerCount());
    check("G12 media orphans 0 (only the adopted doc remains)", (await gtpMediaCount()) === 1, await gtpMediaCount());
    const re = tool(T("import-gtp-legacy.ts"), importArgs("reimport", ["--apply"]));
    check("G12 re-import after rollback succeeds", re.code === 0 && (await markerCount()) === importable + 12, await markerCount());
    check("final rollback", rollback("reimport", ["--apply"]).code === 0 && (await markerCount()) === 0);
  }

  console.log("\n== F2 readbacks, G36 hybrid, G33b canary scan");
  {
    const f2 = helper("f2");
    facts.F2a = (f2 as Doc).f2a;
    facts.F2c = (f2 as Doc).f2c;
    const opts = { allow: ["images.fixture.invalid"], rewrite: { "images.fixture.invalid": "127.0.0.1:54328" }, maxBytes: 20_971_520, timeoutMs: 30_000 };
    const ev = await fetchImage("https://images.fixture.invalid/special/redirect-evil.jpg", opts);
    const big = await fetchImage("https://images.fixture.invalid/special/big.jpg", opts);
    const magic = await fetchImage("https://images.fixture.invalid/special/wrong-magic.jpg", opts);
    const lying = await fetchImage("https://images.fixture.invalid/special/lying.jpg", { ...opts, maxBytes: 1024 * 1024 });
    const signed = await fetchImage("https://images.fixture.invalid/storage/v1/object/sign/x.jpg?token=abc", opts);
    check("G36 302 to a disallowed host refused", !ev.ok && ev.reason === "mediaRedirectBlocked", ev);
    check("G36 25 MB file refused by the cap", !big.ok && big.reason === "tooLarge", big);
    check("G36 wrong magic bytes refused", !magic.ok && magic.reason === "badMagic", magic);
    const chunked = await fetchImage("https://images.fixture.invalid/special/chunked-big.jpg", { ...opts, maxBytes: 1024 * 1024 });
    check("G36 lying content-length refused (undici enforces the declared length, the truncated body fails the magic check)", !lying.ok && (lying.reason === "tooLarge" || lying.reason === "badMagic"), lying);
    check("G36 body without content-length stopped by the streamed cap", !chunked.ok && chunked.reason === "tooLarge", chunked);
    check("signed-URL look-alike answers 403", !signed.ok && signed.reason === "http 403", signed);
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/CANARY-SECRET|secret_table_|article_review_queue/.test(readFileSync(p, "utf8"))) hits.push(path.relative(OUT, p));
      }
    };
    walk(OUT);
    check("G33b no canary string or decoy relation name in any out file or query log", hits.length === 0, hits);
  }

  const failed = assertions.filter((x) => !x.ok);
  facts.durationSeconds = Math.round((Date.now() - t0) / 1000);
  writeJsonSafe(path.join(OUT, "rehearse-summary.json"), { ok: failed.length === 0, failed: failed.map((x) => x.name), unproven, assertions, facts });
  console.log(`\nrehearse-assert: ${assertions.length - failed.length}/${assertions.length} assertions ok; UNPROVEN: ${unproven.length ? unproven.join("; ") : "none"}`);
  if (failed.length) console.log(`FAILED: ${failed.map((x) => x.name).join(" | ")}`);
  return failed.length ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(`rehearse-assert aborted: ${(err as Error).message}`);
    process.exit(1);
  });
