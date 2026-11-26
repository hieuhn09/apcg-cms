/**
 * GCV author clean-up, step 1 of 2: re-point every reference to a retired GCV
 * author so `audit:prune-authors --tenant=gcv --include-profiles` can then delete
 * those rows. Plan: `process/general-plans/active/gcv-author-reassign_PLAN_26-11-26.md`.
 * Sets, row changes and abort rules live in `scripts/lib/reassign-authors.ts`.
 * It never deletes a row and never touches `updated_at` / `version` / history.
 *
 * OWNER-RUN, two steps:
 *   1. DRY RUN (default, read-only): prints the sets (the full REMOVE list with
 *      counts), the row counts per operation and the pool before/after, then
 *      writes to migration-data/ (gitignored):
 *        reassign-authors.report-<stamp>.csv  one line per row change
 *                                             (article id, slug, title, old author,
 *                                             new author, operation, table, row id)
 *        reassign-authors.plan-<stamp>.json   the changes (only when nothing aborts)
 *   2. APPLY: `--apply --plan=<plan file>` re-reads the database, re-derives the
 *      plan and writes ONLY plan entries that still match (anything else is
 *      skipped and printed). Before writing it saves every row it will change
 *      (full rows) to migration-data/reassign-authors.backup-<stamp>.json. All
 *      UPDATEs run in ONE transaction and each re-checks the old value in SQL; if
 *      any row no longer matches, the whole transaction is rolled back.
 *
 * Database safety (same guards as `prune-unused-authors.ts`), BEFORE the Payload
 * config is imported:
 *   1. the database NAME is printed first;
 *   2. a NON-local host needs `--confirm-host=<exact DB hostname>`; `--apply`
 *      against a non-local host also needs an interactive terminal (TTY) and a
 *      typed confirmation of the number of rows;
 *   3. a NON-local database must be named exactly `/neondb` (Central CMS).
 *   The plan records the database it was made on; `--apply` refuses another one.
 * Print host and name by hand first:
 *   node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
 *
 *   npm run audit:reassign-authors -- --confirm-host=<prod DB hostname>                     # dry run
 *   npm run audit:reassign-authors -- --confirm-host=<host> --apply --plan=migration-data/reassign-authors.plan-<stamp>.json
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { assertLocalOrConfirmed, LocalDbGuardError } from "../lib/local-db-guard";
import { assertCentralDbName, CentralDbNameError, databaseNameBanner } from "../lib/central-db-name-guard";
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
  type Change,
  type ReassignAuthorsPlan,
  type ReassignInput,
  type ReassignResult,
  type RelRow,
  type Rename,
} from "../lib/reassign-authors";

const TAG = "[reassign-authors]";
const RULES = GCV_RULES;

console.log(`${TAG} ${databaseNameBanner(process.env.DATABASE_URL)}`);

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const USAGE =
  "Usage:\n" +
  "  npm run audit:reassign-authors [-- --confirm-host=<exact DB hostname>] [-- --apply --plan=<plan file>]\n" +
  "\n" +
  "  (no flags)              dry run, tenant gcv: sets, counts, CSV report + plan file in migration-data/\n" +
  "  --apply --plan=<file>   write the plan's changes that still match (backup written first, one transaction)\n" +
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
const PLAN_ARG = one("--plan=");
const KNOWN = ["--apply", "--confirm-host=", "--plan="];
const unknown = argv.filter((a) => !KNOWN.some((k) => (k.endsWith("=") ? a.startsWith(k) : a === k)));
if (unknown.length) usage(`Unknown argument(s): ${unknown.join(", ")}`);
if (APPLY && !PLAN_ARG) usage("--apply needs --plan=<plan file from a dry run>.");
if (!APPLY && PLAN_ARG) usage("--plan is only used with --apply.");

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
type Exec = { execute: (q: unknown) => Promise<{ rows?: Row[] }> };

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function migrationDataFile(name: string): string {
  const dir = path.resolve(process.cwd(), "migration-data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const plan: ReassignAuthorsPlan | null = PLAN_ARG ? readPlan(PLAN_ARG) : null;
  if (plan && plan.database !== target.banner) {
    console.error(`${TAG} plan was made on ${plan.database}, this run is ${target.banner}. Nothing done.`);
    process.exit(1);
  }
  if (plan && plan.tenant !== RULES.tenant) {
    console.error(`${TAG} plan is for tenant ${plan.tenant}, this script handles ${RULES.tenant}. Nothing done.`);
    process.exit(1);
  }
  console.log(`${TAG} database ${target.banner} (${target.local ? "local" : "NON-LOCAL, confirmed, name /neondb"}) - tenant ${RULES.tenant} - ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);

  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: payloadConfig });
  const db = (payload.db as unknown as { drizzle: Exec & { transaction: <T>(fn: (tx: Exec) => Promise<T>) => Promise<T> } }).drizzle;
  const rows = async (q: unknown): Promise<Row[]> => (await db.execute(q)).rows ?? [];

  /* ── Read ── */
  const tenants = await rows(sql`SELECT id FROM tenants WHERE slug = ${RULES.tenant}`);
  if (tenants.length !== 1) {
    console.error(`${TAG} tenant ${RULES.tenant} found ${tenants.length} time(s). Nothing done.`);
    process.exit(1);
  }
  const tenantId = num(tenants[0]?.id);
  const tenantAuthors = sql`SELECT id FROM authors WHERE tenant_id = ${tenantId}`;

  const input: ReassignInput = {
    authors: (await rows(sql`SELECT id, name, rank, user_id FROM authors WHERE tenant_id = ${tenantId} ORDER BY id`)).map((r) => ({
      id: num(r.id),
      name: String(r.name ?? ""),
      rank: numOrNull(r.rank),
      userId: numOrNull(r.user_id),
    })),
    articles: (
      await rows(sql`
        SELECT a.id, t.slug AS tenant, a.author_id, a.origin::text AS origin, loc.slug, loc.title
          FROM articles a
          LEFT JOIN tenants t ON t.id = a.tenant_id
          LEFT JOIN LATERAL (
            SELECT l.slug, l.title FROM articles_locales l
             WHERE l._parent_id = a.id
             ORDER BY (l._locale::text = 'en') DESC, l.id
             LIMIT 1
          ) loc ON true
         WHERE a.tenant_id = ${tenantId} OR a.author_id IN (${tenantAuthors})
         ORDER BY a.id`)
    ).map(
      (r): ArticleRow => ({
        id: num(r.id),
        tenant: strOrNull(r.tenant),
        authorId: numOrNull(r.author_id),
        origin: strOrNull(r.origin),
        slug: strOrNull(r.slug),
        title: strOrNull(r.title),
      }),
    ),
    versions: (
      await rows(sql`
        SELECT v.id, v.parent_id, v.version_author_id
          FROM _articles_v v
          LEFT JOIN articles a ON a.id = v.parent_id
         WHERE v.latest = true
           AND (a.tenant_id = ${tenantId} OR v.version_author_id IN (${tenantAuthors}))
         ORDER BY v.id`)
    ).map((r) => ({ id: num(r.id), articleId: numOrNull(r.parent_id), authorId: numOrNull(r.version_author_id) })),
    rels: [
      ...(await rows(sql`SELECT id, parent_id, authors_id FROM articles_rels WHERE authors_id IN (${tenantAuthors}) ORDER BY id`)).map(
        (r): RelRow => ({ table: "articles_rels", id: num(r.id), parentId: num(r.parent_id), articleId: num(r.parent_id), authorId: num(r.authors_id) }),
      ),
      ...(
        await rows(sql`
          SELECT r.id, r.parent_id, v.parent_id AS article_id, r.authors_id
            FROM _articles_v_rels r JOIN _articles_v v ON v.id = r.parent_id
           WHERE v.latest = true AND r.authors_id IN (${tenantAuthors})
           ORDER BY r.id`)
      ).map(
        (r): RelRow => ({ table: "_articles_v_rels", id: num(r.id), parentId: num(r.parent_id), articleId: numOrNull(r.article_id), authorId: num(r.authors_id) }),
      ),
    ],
  };

  const result = buildReassignPlan(input, RULES);
  printSummary(result, input.authors.length);

  if (!APPLY) {
    const s = stamp();
    const csvFile = migrationDataFile(`reassign-authors.report-${s}.csv`);
    fs.writeFileSync(csvFile, toCsv(result, input.articles));
    console.log(`\n${TAG} report: ${path.relative(process.cwd(), csvFile)}`);
    if (result.aborts.length) {
      printAborts(result.aborts);
      console.log(`${TAG} no plan file written. DRY RUN: nothing written to the database.`);
      process.exit(1);
    }
    const out: ReassignAuthorsPlan = {
      kind: PLAN_KIND,
      version: PLAN_VERSION,
      createdAt: new Date().toISOString(),
      database: target.banner,
      tenant: RULES.tenant,
      remove: result.remove.map(({ id, name }) => ({ id, name })),
      changes: result.changes,
      renames: result.renames,
    };
    const planFile = migrationDataFile(`reassign-authors.plan-${s}.json`);
    fs.writeFileSync(planFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${TAG} plan:   ${path.relative(process.cwd(), planFile)} (${out.changes.length + out.renames.length} row(s))`);
    console.log(`${TAG} DRY RUN: nothing written to the database.`);
    process.exit(0);
  }

  /* ── APPLY ── */
  if (result.aborts.length) {
    printAborts(result.aborts);
    console.log(`${TAG} Nothing done.`);
    process.exit(1);
  }
  const { changes, renames, skipped, newSinceDryRun } = reconcilePlan(plan as ReassignAuthorsPlan, result);
  for (const s of skipped) console.log(`  skip ${s.what}: ${s.why}`);
  if (newSinceDryRun) console.log(`${TAG} ${newSinceDryRun} change(s) needed now are not in the plan and will NOT be written; run a new dry run afterwards.`);
  const total = changes.length + renames.length;
  if (total === 0) {
    console.log(`${TAG} nothing to write.`);
    process.exit(0);
  }
  console.log(`${TAG} to write: ${fmtCounts(countByOp(changes))}${renames.length ? `, rename authors ${renames.length}` : ""}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`${TAG} update ${total} row(s) on ${target.banner}? Type ${total} to confirm: `)).trim();
  rl.close();
  if (typed !== String(total)) {
    console.log(`${TAG} not confirmed. Nothing done.`);
    process.exit(1);
  }

  const ids = (table: Change["table"]) => changes.filter((c) => c.table === table).map((c) => c.rowId);
  const idList = (list: number[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);
  const backupOf = async (table: string, list: number[]) => (list.length ? rows(sql`SELECT * FROM ${sql.raw(`"${table}"`)} WHERE id IN (${idList(list)}) ORDER BY id`) : []);
  const backup = {
    database: target.banner,
    takenAt: new Date().toISOString(),
    plan: PLAN_ARG,
    changes,
    renames,
    rows: {
      articles: await backupOf("articles", ids("articles")),
      _articles_v: await backupOf("_articles_v", ids("_articles_v")),
      articles_rels: await backupOf("articles_rels", ids("articles_rels")),
      _articles_v_rels: await backupOf("_articles_v_rels", ids("_articles_v_rels")),
      authors: await backupOf("authors", renames.map((r) => r.authorId)),
    },
  };
  const backupFile = migrationDataFile(`reassign-authors.backup-${stamp()}.json`);
  fs.writeFileSync(backupFile, `${JSON.stringify(backup, null, 2)}\n`);
  const backedUp = Object.values(backup.rows).reduce((n, list) => n + list.length, 0);
  console.log(`${TAG} backup: ${path.relative(process.cwd(), backupFile)} (${backedUp} row(s))`);
  if (backedUp !== total) {
    console.error(`${TAG} backup has ${backedUp} row(s), expected ${total}: rows changed since the check. Nothing done.`);
    process.exit(1);
  }

  let written: Record<string, number>;
  try {
    written = await db.transaction((tx) => writeAll(tx, sql, tenantId, changes, renames));
  } catch (err) {
    console.error(`${TAG} rolled back, nothing written: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const logFile = migrationDataFile(`reassign-authors.applied-${stamp()}.json`);
  fs.writeFileSync(logFile, `${JSON.stringify({ database: target.banner, plan: PLAN_ARG, written, skipped, newSinceDryRun }, null, 2)}\n`);
  console.log(`${TAG} written: ${fmtCounts(written)}. Log: ${path.relative(process.cwd(), logFile)}`);
  console.log(`${TAG} next: npm run audit:prune-authors -- --confirm-host=<host> --tenant=${RULES.tenant} --include-profiles`);
  process.exit(0);
}

type SqlTag = typeof import("@payloadcms/db-postgres").sql;

/**
 * Every UPDATE re-checks the old value (and tenant / latest) in SQL. A short
 * count means a row changed after the check: throw, so the transaction rolls back.
 */
async function writeAll(tx: Exec, sql: SqlTag, tenantId: number, changes: Change[], renames: Rename[]): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  const values = (list: Change[]) => sql.join(list.map((c) => sql`(${c.rowId}::int, ${c.from}::int, ${c.to}::int, ${c.articleId}::int, ${c.parentId}::int)`), sql`, `);
  const statements: [Change["table"], (list: Change[]) => unknown][] = [
    [
      "articles",
      (list) => sql`
        UPDATE articles x SET author_id = v.to_id
          FROM (VALUES ${values(list)}) AS v(id, from_id, to_id, article_id, parent_id)
         WHERE x.id = v.id AND x.author_id = v.from_id AND x.tenant_id = ${tenantId}
        RETURNING x.id`,
    ],
    [
      "_articles_v",
      (list) => sql`
        UPDATE _articles_v x SET version_author_id = v.to_id
          FROM (VALUES ${values(list)}) AS v(id, from_id, to_id, article_id, parent_id)
         WHERE x.id = v.id AND x.version_author_id = v.from_id AND x.latest = true AND x.parent_id = v.article_id
           AND EXISTS (SELECT 1 FROM articles a WHERE a.id = x.parent_id AND a.tenant_id = ${tenantId})
        RETURNING x.id`,
    ],
    [
      "articles_rels",
      (list) => sql`
        UPDATE articles_rels x SET authors_id = v.to_id
          FROM (VALUES ${values(list)}) AS v(id, from_id, to_id, article_id, parent_id)
         WHERE x.id = v.id AND x.authors_id = v.from_id AND x.parent_id = v.article_id
           AND EXISTS (SELECT 1 FROM articles a WHERE a.id = x.parent_id AND a.tenant_id = ${tenantId})
        RETURNING x.id`,
    ],
    [
      "_articles_v_rels",
      (list) => sql`
        UPDATE _articles_v_rels x SET authors_id = v.to_id
          FROM (VALUES ${values(list)}) AS v(id, from_id, to_id, article_id, parent_id)
         WHERE x.id = v.id AND x.authors_id = v.from_id AND x.parent_id = v.parent_id
           AND EXISTS (SELECT 1 FROM _articles_v pv JOIN articles a ON a.id = pv.parent_id
                        WHERE pv.id = x.parent_id AND pv.latest = true AND a.tenant_id = ${tenantId})
        RETURNING x.id`,
    ],
  ];
  for (const [table, statement] of statements) {
    const list = changes.filter((c) => c.table === table);
    if (!list.length) continue;
    const n = ((await tx.execute(statement(list))).rows ?? []).length;
    if (n !== list.length) throw new Error(`${table}: ${n} of ${list.length} row(s) still matched`);
    written[table] = n;
  }
  for (const r of renames) {
    const n = (
      (
        await tx.execute(sql`
          UPDATE authors a SET name = ${r.to}
           WHERE a.id = ${r.authorId} AND a.name = ${r.from} AND a.tenant_id = ${tenantId}
             AND NOT EXISTS (SELECT 1 FROM authors b WHERE b.tenant_id = ${tenantId} AND b.name = ${r.to})
          RETURNING a.id`)
      ).rows ?? []
    ).length;
    if (n !== 1) throw new Error(`rename of author #${r.authorId} no longer matched`);
    written.authors = (written.authors ?? 0) + 1;
  }
  return written;
}

function readPlan(file: string): ReassignAuthorsPlan {
  try {
    return parsePlan(fs.readFileSync(file, "utf8"));
  } catch (err) {
    usage(`--plan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const fmtCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";

function printSummary(r: ReassignResult, totalAuthors: number): void {
  const names = (list: { id: number; name: string }[]) => list.map((a) => `${JSON.stringify(a.name)} #${a.id}`).join(", ") || "(none)";
  console.log(`\n${TAG} tenant ${r.tenant}: ${totalAuthors} author(s)`);
  console.log(`  POOL (${r.pool.length}): ${names(r.pool)}`);
  console.log(`  KEEP (${r.keep.length}): ${names(r.keep)}`);
  console.log(`  MERGE: ${r.mergeFrom ? `${names([r.mergeFrom])} -> ${r.mergeTo ? names([r.mergeTo]) : "(missing)"}` : "(source not found, nothing to merge)"}`);
  console.log(`  RENAME: ${r.renames.map((x) => `#${x.authorId} ${JSON.stringify(x.from)} -> ${JSON.stringify(x.to)}`).join(", ") || "(none)"}`);
  const expected = RULES.expectedRemove;
  const note = expected === null || expected === r.remove.length ? "" : `  <- expected ${expected}, CHECK THE LIST`;
  console.log(`\n${TAG} REMOVE (${r.remove.length})${note}: import articles / other articles / co-author rels / latest-version refs`);
  for (const x of r.remove) {
    console.log(`  #${String(x.id).padEnd(6)} ${JSON.stringify(x.name).padEnd(34)} ${x.importArticles} / ${x.otherArticles} / ${x.coAuthorRels} / ${x.latestVersionRefs}`);
  }
  const c = countByOp(r.changes);
  console.log(`\n${TAG} row changes:`);
  console.log(`  a. sync      latest versions -> article's author  ${c["sync _articles_v"] ?? 0}`);
  console.log(`  b. reassign  articles -> pool                     ${c["reassign articles"] ?? 0}`);
  console.log(`     reassign  their latest versions                ${c["reassign _articles_v"] ?? 0}`);
  console.log(`  c. merge     articles / latest versions           ${c["merge articles"] ?? 0} / ${c["merge _articles_v"] ?? 0}`);
  console.log(`     merge     co-author rels (live / latest)       ${c["merge articles_rels"] ?? 0} / ${c["merge _articles_v_rels"] ?? 0}`);
  console.log(`     rename    authors                              ${r.renames.length}`);
  console.log(`  total ${r.changes.length + r.renames.length}`);
  console.log(`\n${TAG} pool articles (live author_id), before -> after:`);
  for (const p of r.poolCounts) console.log(`  ${JSON.stringify(p.name).padEnd(20)} ${String(p.before).padStart(5)} -> ${String(p.after).padStart(5)}`);
  if (r.warnings.length) {
    console.log(`\n${TAG} warnings:`);
    for (const w of r.warnings) console.log(`  ${w}`);
  }
}

function printAborts(aborts: string[]): void {
  console.log(`\n${TAG} REFUSING (${aborts.length} reason(s)):`);
  for (const a of aborts.slice(0, 100)) console.log(`  ${a}`);
  if (aborts.length > 100) console.log(`  ... and ${aborts.length - 100} more`);
}

main().catch((err) => {
  console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
