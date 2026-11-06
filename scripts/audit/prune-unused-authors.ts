/**
 * Find (and, on approval, delete) `authors` rows no article uses, so the hub
 * composer's byline picker shows only real bylines. Keep rules and the reason
 * for each live in `scripts/lib/prune-authors.ts`.
 *
 * OWNER-RUN, two steps:
 *   1. DRY RUN (default, read-only): prints a per-tenant summary and writes to
 *      migration-data/ (gitignored):
 *        prune-authors.report-<stamp>.csv   every author: verdict, keep reasons,
 *                                           article counts by origin (engine /
 *                                           manual / import), drafts, history
 *        prune-authors.plan-<stamp>.json    the delete candidates (ids + names)
 *      Review the CSV / plan. Remove from the plan any id you want to keep.
 *   2. APPLY: `--apply --plan=<plan file>` deletes ONLY plan ids that are still
 *      candidates now (re-classified at apply time; anything else is skipped and
 *      printed). Before deleting it writes a full backup of those rows (authors +
 *      authors_locales) to migration-data/prune-authors.backup-<stamp>.json, and
 *      the DELETE itself re-checks "no live article, no draft, no rank, no user"
 *      in SQL, inside one transaction.
 *
 * Database safety (same guards as the scripts/audit/add-*-taxonomy owner scripts),
 * BEFORE the Payload config is imported:
 *   1. the database NAME is printed first;
 *   2. a NON-local host needs `--confirm-host=<exact DB hostname>`; `--apply`
 *      against a non-local host also needs an interactive terminal (TTY) and a
 *      typed confirmation of the number of rows;
 *   3. a NON-local database must be named exactly `/neondb` (Central CMS).
 *   The plan records the database it was made on; `--apply` refuses another one.
 * Print host and name by hand first:
 *   node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
 *
 *   npm run audit:prune-authors -- --confirm-host=<prod DB hostname>                     # dry run
 *   npm run audit:prune-authors -- --confirm-host=<host> --tenant=gcv,wad                 # dry run, some tenants
 *   npm run audit:prune-authors -- --confirm-host=<host> --apply --plan=migration-data/prune-authors.plan-<stamp>.json
 *
 * Options: `--keep-recent-days=<n>` (default 30) keeps authors created in the last n days.
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { assertLocalOrConfirmed, LocalDbGuardError } from "../lib/local-db-guard";
import { assertCentralDbName, CentralDbNameError, databaseNameBanner } from "../lib/central-db-name-guard";
import {
  DEFAULT_KEEP_RECENT_DAYS,
  PLAN_KIND,
  PLAN_VERSION,
  classifyAuthor,
  liveArticleCount,
  parsePlan,
  reconcilePlan,
  summarise,
  toCsv,
  type AuthorUsage,
  type Classification,
  type PruneAuthorsPlan,
} from "../lib/prune-authors";

const TAG = "[prune-authors]";

console.log(`${TAG} ${databaseNameBanner(process.env.DATABASE_URL)}`);

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const USAGE =
  "Usage:\n" +
  "  npm run audit:prune-authors [-- --confirm-host=<exact DB hostname>] [-- --tenant=<slug>[,<slug>...]]\n" +
  "                              [-- --keep-recent-days=<n>] [-- --apply --plan=<plan file>]\n" +
  "\n" +
  "  (no flags)              dry run: summary + CSV report + plan file in migration-data/\n" +
  "  --tenant=a,b            only these Central tenant slugs (e.g. gcv,wad,brief-asia,world-travel-brief)\n" +
  "  --keep-recent-days=<n>  keep authors created in the last n days (default 30)\n" +
  "  --apply --plan=<file>   delete the plan's ids that are still unused (backup written first)\n" +
  "  --confirm-host=<host>   required for a NON-local DATABASE_URL; must equal its HOSTNAME;\n" +
  "                          a non-local database must be named exactly /neondb; --apply also needs a TTY.\n";

function usage(message?: string): never {
  if (message) console.error(`\n${message}\n`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage();
const APPLY = argv.includes("--apply");
const one = (prefix: string): string | undefined => {
  const hits = argv.filter((a) => a.startsWith(prefix));
  if (hits.length > 1) usage(`Pass ${prefix.slice(0, -1)} at most once.`);
  return hits[0]?.slice(prefix.length);
};
const CONFIRM_HOST = one("--confirm-host=");
const TENANT_ARG = one("--tenant=");
const PLAN_ARG = one("--plan=");
const RECENT_ARG = one("--keep-recent-days=");
const KNOWN = ["--apply", "--confirm-host=", "--tenant=", "--plan=", "--keep-recent-days="];
const unknown = argv.filter((a) => !KNOWN.some((k) => (k.endsWith("=") ? a.startsWith(k) : a === k)));
if (unknown.length) usage(`Unknown argument(s): ${unknown.join(", ")}`);
if (APPLY && !PLAN_ARG) usage("--apply needs --plan=<plan file from a dry run>.");
if (!APPLY && PLAN_ARG) usage("--plan is only used with --apply.");
if (APPLY && (TENANT_ARG || RECENT_ARG)) usage("--apply takes its scope from the plan; drop --tenant / --keep-recent-days.");
const TENANTS = TENANT_ARG ? TENANT_ARG.split(",").map((s) => s.trim()).filter(Boolean) : null;
if (TENANTS && TENANTS.length === 0) usage("--tenant is empty.");
const KEEP_RECENT_DAYS = RECENT_ARG === undefined ? DEFAULT_KEEP_RECENT_DAYS : Number(RECENT_ARG);
if (!Number.isInteger(KEEP_RECENT_DAYS) || KEEP_RECENT_DAYS < 0) usage("--keep-recent-days must be a whole number >= 0.");

/* ── Database guards (before the Payload config is imported) ─────────────── */

let target: ReturnType<typeof assertLocalOrConfirmed>;
try {
  target = assertLocalOrConfirmed(process.env.DATABASE_URL, CONFIRM_HOST, process.stdin.isTTY === true, APPLY);
  assertCentralDbName(process.env.DATABASE_URL, target);
} catch (err) {
  console.error(err instanceof LocalDbGuardError || err instanceof CentralDbNameError ? err.message : "database guard: refusing.");
  usage("Refusing to run.");
}
if (!target.local) process.env.PAYLOAD_DB_PUSH = "false";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
type Classified = { usage: AuthorUsage; c: Classification };

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function toUsage(r: Row): AuthorUsage {
  return {
    id: num(r.id),
    tenant: strOrNull(r.tenant),
    name: String(r.name ?? ""),
    role: strOrNull(r.role),
    rank: numOrNull(r.rank),
    slug: strOrNull(r.slug),
    userId: numOrNull(r.user_id),
    avatarId: numOrNull(r.avatar_id),
    hasBio: r.has_bio === true,
    createdAt: iso(r.created_at) ?? "",
    engineArticles: num(r.engine_n),
    manualArticles: num(r.manual_n),
    importArticles: num(r.import_n),
    coAuthorArticles: num(r.co_n),
    draftRefs: num(r.draft_n),
    historyRefs: num(r.hist_n),
    lastPublishedAt: iso(r.last_pub),
  };
}

function migrationDataFile(name: string): string {
  const dir = path.resolve(process.cwd(), "migration-data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const plan: PruneAuthorsPlan | null = PLAN_ARG ? readPlan(PLAN_ARG) : null;
  if (plan && plan.database !== target.banner) {
    console.error(`${TAG} plan was made on ${plan.database}, this run is ${target.banner}. Nothing done.`);
    process.exit(1);
  }
  console.log(`${TAG} database ${target.banner} (${target.local ? "local" : "NON-LOCAL, confirmed, name /neondb"}) - ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);

  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: payloadConfig });
  const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows?: Row[] }>; transaction: <T>(fn: (tx: { execute: (q: unknown) => Promise<{ rows?: Row[] }> }) => Promise<T>) => Promise<T> } }).drizzle;

  const usageQuery = sql`
    WITH live AS (
      SELECT author_id AS aid,
             count(*) FILTER (WHERE origin = 'engine') AS engine_n,
             count(*) FILTER (WHERE origin = 'manual') AS manual_n,
             count(*) FILTER (WHERE origin = 'import') AS import_n,
             max(published_at) AS last_pub
        FROM articles WHERE author_id IS NOT NULL GROUP BY author_id
    ), co AS (
      SELECT authors_id AS aid, count(DISTINCT parent_id) AS co_n
        FROM articles_rels WHERE authors_id IS NOT NULL GROUP BY authors_id
    ), ver AS (
      SELECT aid,
             count(*) FILTER (WHERE is_draft) AS draft_n,
             count(*) FILTER (WHERE NOT is_draft) AS hist_n
        FROM (
          SELECT v.version_author_id AS aid,
                 (coalesce(v.latest, false) AND v.version__status = 'draft') AS is_draft
            FROM _articles_v v WHERE v.version_author_id IS NOT NULL
          UNION ALL
          SELECT r.authors_id,
                 (coalesce(v.latest, false) AND v.version__status = 'draft')
            FROM _articles_v_rels r JOIN _articles_v v ON v.id = r.parent_id
           WHERE r.authors_id IS NOT NULL
        ) u
       GROUP BY aid
    )
    SELECT a.id, t.slug AS tenant, a.name, a.role, a.rank, a.slug, a.user_id, a.avatar_id, a.created_at,
           EXISTS (SELECT 1 FROM authors_locales l WHERE l._parent_id = a.id AND coalesce(btrim(l.bio), '') <> '') AS has_bio,
           live.engine_n, live.manual_n, live.import_n, live.last_pub, co.co_n, ver.draft_n, ver.hist_n
      FROM authors a
      LEFT JOIN tenants t ON t.id = a.tenant_id
      LEFT JOIN live ON live.aid = a.id
      LEFT JOIN co ON co.aid = a.id
      LEFT JOIN ver ON ver.aid = a.id
     ORDER BY t.slug NULLS FIRST, a.name, a.id`;

  const scope = plan ? plan.tenants : TENANTS;
  const keepRecentDays = plan ? plan.keepRecentDays : KEEP_RECENT_DAYS;
  const now = new Date();
  const all = ((await db.execute(usageQuery)).rows ?? []).map(toUsage);
  if (scope) {
    const known = new Set(all.map((a) => a.tenant));
    const missing = scope.filter((s) => !known.has(s));
    if (missing.length) console.log(`${TAG} WARN: no authors for tenant(s): ${missing.join(", ")}`);
  }
  const rows: Classified[] = all
    .filter((a) => !scope || (a.tenant !== null && scope.includes(a.tenant)))
    .map((usage) => ({ usage, c: classifyAuthor(usage, { now, keepRecentDays }) }));

  printSummary(rows);

  if (!APPLY) {
    const s = stamp();
    const csvFile = migrationDataFile(`prune-authors.report-${s}.csv`);
    fs.writeFileSync(csvFile, toCsv(rows));
    const candidates = rows.filter((r) => r.c.verdict === "delete").map((r) => ({ id: r.usage.id, tenant: r.usage.tenant, name: r.usage.name }));
    const out: PruneAuthorsPlan = {
      kind: PLAN_KIND,
      version: PLAN_VERSION,
      createdAt: now.toISOString(),
      database: target.banner,
      keepRecentDays,
      tenants: scope,
      candidates,
    };
    const planFile = migrationDataFile(`prune-authors.plan-${s}.json`);
    fs.writeFileSync(planFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n${TAG} report: ${path.relative(process.cwd(), csvFile)}`);
    console.log(`${TAG} plan:   ${path.relative(process.cwd(), planFile)} (${candidates.length} candidate(s))`);
    console.log(`${TAG} DRY RUN: nothing written to the database.`);
    process.exit(0);
  }

  /* ── APPLY ── */
  const byId = new Map(rows.map((r) => [r.usage.id, r]));
  const { ids, skipped } = reconcilePlan(plan as PruneAuthorsPlan, byId);
  for (const s of skipped) console.log(`  skip #${s.id} ${s.name}: ${s.why}`);
  if (ids.length === 0) {
    console.log(`${TAG} nothing to delete.`);
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`${TAG} delete ${ids.length} author row(s) on ${target.banner}? Type ${ids.length} to confirm: `)).trim();
  rl.close();
  if (typed !== String(ids.length)) {
    console.log(`${TAG} not confirmed. Nothing done.`);
    process.exit(1);
  }

  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const backupFile = migrationDataFile(`prune-authors.backup-${stamp()}.json`);
  const authorsBackup = (await db.execute(sql`SELECT * FROM authors WHERE id IN (${idList}) ORDER BY id`)).rows ?? [];
  const localesBackup = (await db.execute(sql`SELECT * FROM authors_locales WHERE _parent_id IN (${idList}) ORDER BY id`)).rows ?? [];
  fs.writeFileSync(backupFile, `${JSON.stringify({ database: target.banner, takenAt: new Date().toISOString(), authors: authorsBackup, authors_locales: localesBackup }, null, 2)}\n`);
  console.log(`${TAG} backup: ${path.relative(process.cwd(), backupFile)} (${authorsBackup.length} row(s))`);

  // The SQL re-checks the hard rules, so a row that gained an article between
  // the read above and this statement is left alone.
  const deleted = await db.transaction(async (tx) =>
    (
      await tx.execute(sql`
        DELETE FROM authors a
         WHERE a.id IN (${idList})
           AND a.rank IS NULL AND a.user_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM articles x WHERE x.author_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM articles_rels r WHERE r.authors_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM _articles_v v WHERE v.version_author_id = a.id AND v.latest AND v.version__status = 'draft')
           AND NOT EXISTS (SELECT 1 FROM _articles_v_rels vr JOIN _articles_v v ON v.id = vr.parent_id
                            WHERE vr.authors_id = a.id AND v.latest AND v.version__status = 'draft')
        RETURNING a.id, a.name`)
    ).rows ?? [],
  );
  const deletedIds = new Set(deleted.map((r) => num(r.id)));
  for (const id of ids) if (!deletedIds.has(id)) console.log(`  kept #${id} ${byId.get(id)?.usage.name ?? ""}: re-check in SQL found a reference`);

  const logFile = migrationDataFile(`prune-authors.applied-${stamp()}.json`);
  fs.writeFileSync(logFile, `${JSON.stringify({ database: target.banner, plan: PLAN_ARG, deleted, skipped }, null, 2)}\n`);
  console.log(`${TAG} deleted ${deleted.length} of ${ids.length}. Log: ${path.relative(process.cwd(), logFile)}`);
  process.exit(0);
}

function readPlan(file: string): PruneAuthorsPlan {
  try {
    return parsePlan(fs.readFileSync(file, "utf8"));
  } catch (err) {
    usage(`--plan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function printSummary(rows: Classified[]): void {
  console.log(`\n${TAG} per tenant (keep reasons can overlap):`);
  for (const s of summarise(rows)) {
    const reasons = Object.entries(s.byReason).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`  ${s.tenant.padEnd(20)} total ${String(s.total).padStart(5)}  keep ${String(s.keep).padStart(5)}  delete ${String(s.delete).padStart(5)}   [${reasons}]`);
  }
  const cands = rows.filter((r) => r.c.verdict === "delete");
  if (cands.length) {
    console.log(`\n${TAG} delete candidates (no live article, no draft, not masthead / user / engine pool / recent / profile):`);
    for (const r of cands.slice(0, 200)) {
      const hist = r.usage.historyRefs ? `  (in ${r.usage.historyRefs} old revision(s))` : "";
      console.log(`  ${String(r.usage.tenant).padEnd(20)} #${String(r.usage.id).padEnd(6)} ${r.usage.name}${r.usage.role ? ` (${r.usage.role})` : ""}${hist}`);
    }
    if (cands.length > 200) console.log(`  ... and ${cands.length - 200} more (see the CSV)`);
  }
  const kept = rows.filter((r) => r.c.verdict === "keep" && !r.c.reasons.includes("engine") && !r.c.reasons.includes("masthead") && liveArticleCount(r.usage) > 0);
  if (kept.length) {
    console.log(`\n${TAG} kept only because they have articles (not engine pool, not masthead): ${kept.length} - see the CSV for counts by origin.`);
  }
}

main().catch((err) => {
  console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
