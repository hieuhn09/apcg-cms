/**
 * VowAsia legacy ROLLBACK of ONE run (Amendment 4 §4.4 item 7, B-8). Owner-run.
 *
 *   npm run migrate:vowasia:rollback -- --run-id <id> --runs-dir <dir outside the repo>
 *       [--confirm-host=<host>] [--include-edited] [--apply]
 *
 * Dry run by default: prints the plan to stdout and writes NOTHING (not even into
 * the run directory, CF2). `--apply` takes the `.import.lock` (CF4), deletes, then
 * writes `rollback-report.json` and one `resolved` outcome line per dangling intent.
 *
 * Articles deleted: ONLY rows of THIS run's journal that still carry the marker
 * (`origin=import`, `engineSourceName=legacy:vowasia`) in tenant vowasia AND are
 * untouched since the import (`version` and `updatedAt` equal the baseline, or the
 * `timestamps-baseline.json` value after OB9; `--include-edited` overrides).
 *
 * A dangling intent (an intent line with no outcome: a crash between the intent
 * and the outcome) is resolved to a Central article ONLY when ALL five hold
 * (Amendment 3 §3.4 step 6, copied verbatim):
 *   (a) no outcome `failed` for that intent;
 *   (b) the article matches (tenant vowasia, slug) + marker `legacy:vowasia`;
 *   (c) its id is NOT in `slug-map.ndjson` or `outcome.ndjson` of ANY other run in --runs-dir;
 *   (d) `version === 1` (unless `--include-edited`);
 *   (e) `createdAt >= startedAt` of this run.
 * Any condition missing -> not deleted, printed for the owner. Intents with an
 * outcome `failed` are skipped.
 *
 * Media: a Media row created by this run (journal `created`, or a `pending` line
 * whose stable filename resolves to a tenant Media created after the run start)
 * is deleted only if NO surviving tenant-vowasia article references it, as
 * `heroImage` OR as an `upload` node anywhere in its body (full scan of every
 * tenant article, draft versions included). Reused Media is never deleted.
 *
 * A delete error is reported (run id, slug, id, error) and the run goes on; there
 * is NO archive fallback (that would be an update).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { untouched } from "../../lib/rollback-rules";
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { writeJsonSafe } from "./out-dir";
import { resolvePath } from "./vowasia-cli";
import { uploadIds } from "./vowasia-body";
import { centralTarget } from "./vowasia-central";
import { isMarker, loadTenantId, tenantArticles } from "./vowasia-central-state";
import { findMediaByStable } from "./vowasia-media";
import { WRITE_CTX, findOne, relId, type CentralPort, type Id } from "./vowasia-port";
import { Journals, RunDir, RunError, RUN_MESSAGES, acquireLock, allRuns, checkRunId } from "./vowasia-run";
import type { ImportDeps } from "./import-vowasia-main";

export const ROLLBACK_FLAGS: FlagSpec = { "run-id": "value", "runs-dir": "value", "confirm-host": "value", "include-edited": "bool", apply: "bool", "dry-run": "bool" };
const TOOL = "rollback";

export async function runRollback(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const a = parseArgs(argv, ROLLBACK_FLAGS);
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError(`${TOOL}: --run-id is required; refusing.`);
  const runId = checkRunId(runIdRaw);
  const runsArg = a.get("runs-dir");
  if (!runsArg) throw new CliError(`${TOOL}: --runs-dir <directory outside the repo> is required; refusing.`);
  const runsDir = assertOutsideRepo(resolvePath(runsArg), deps.root, { create: false });
  centralTarget(deps.env, { confirmHost: a.get("confirm-host"), apply: a.apply, isTty: deps.isTty, log, tool: TOOL });
  const run = new RunDir(path.join(runsDir, runId));
  if (!run.exists()) throw new RunError(RUN_MESSAGES.missing);
  const release = a.apply ? acquireLock(runsDir, { pid: deps.pid ?? process.pid, runId, mode: "rollback", startedAt: now().toISOString() }) : undefined;
  try {
    const port = await deps.openPort();
    try {
      return await body(a.apply, a.has("include-edited"), run, runsDir, port, deps, now);
    } finally {
      await port.close?.();
    }
  } finally {
    release?.();
  }
}

async function body(apply: boolean, includeEdited: boolean, run: RunDir, runsDir: string, port: CentralPort, deps: ImportDeps, now: () => Date): Promise<number> {
  const log = deps.log;
  const runId = run.id;
  const tenantId = await loadTenantId(port);
  const state = run.state();
  const tsFile = run.p("timestamps-baseline.json");
  const tsBaseline = existsSync(tsFile) ? (JSON.parse(readFileSync(tsFile, "utf8")) as Record<string, string>) : {};
  const rep = {
    mode: apply ? "apply" : "dry-run",
    runId,
    entries: 0,
    toDelete: [] as string[],
    keptEdited: [] as string[],
    keptNotMarker: [] as string[],
    alreadyGone: [] as string[],
    dangling: [] as { slug: string; decision: string }[],
    deleted: 0,
    mediaToDelete: [] as string[],
    mediaDeleted: 0,
    mediaKeptReferenced: 0,
    errors: [] as string[],
  };
  const entries = run.slugMap();
  rep.entries = entries.length;
  const del: { id: Id; slug: string }[] = [];
  for (const e of entries) {
    const doc = await findOne(port, "articles", { id: { equals: e.articleId } }, true);
    if (!doc) {
      rep.alreadyGone.push(e.slug);
      continue;
    }
    if (!isMarker(doc) || relId(doc.tenant) !== String(tenantId)) {
      rep.keptNotMarker.push(e.slug);
      continue;
    }
    if (!includeEdited && !untouched(doc, e, tsBaseline)) {
      rep.keptEdited.push(e.slug);
      continue;
    }
    rep.toDelete.push(e.slug);
    del.push({ id: doc.id as Id, slug: e.slug });
  }

  // dangling intents: the five conditions
  const otherIds = new Set<string>();
  for (const r of allRuns(runsDir)) if (r.id !== runId) for (const id of r.articleIds()) otherIds.add(id);
  const failed = new Set(run.outcomes().filter((o) => o.result === "failed").map((o) => `${o.legacyId}\u0000${o.slug}`));
  const resolved: { legacyId: string; slug: string; deleted: boolean; id?: Id }[] = [];
  for (const i of run.dangling()) {
    const why: string[] = [];
    if (failed.has(`${i.legacyId}\u0000${i.slug}`)) why.push("(a) has a failed outcome");
    const doc = await findOne(port, "articles", { and: [{ tenant: { equals: tenantId } }, { slug: { equals: i.slug } }] }, true);
    if (!doc) why.push("(b) no article with this slug");
    else {
      if (!isMarker(doc)) why.push("(b) not a marker article");
      if (otherIds.has(String(doc.id))) why.push("(c) id is journaled by another run");
      if (!includeEdited && Number(doc.version) !== 1) why.push("(d) version is not 1");
      if (!state || String(doc.createdAt) < state.startedAt) why.push("(e) created before this run started");
    }
    if (doc && why.length === 0 && !del.some((d) => String(d.id) === String(doc.id))) {
      del.push({ id: doc.id as Id, slug: i.slug });
      rep.toDelete.push(i.slug);
      resolved.push({ legacyId: i.legacyId, slug: i.slug, deleted: true, id: doc.id as Id });
      rep.dangling.push({ slug: i.slug, decision: "delete (all five conditions hold)" });
    } else {
      resolved.push({ legacyId: i.legacyId, slug: i.slug, deleted: false, ...(doc ? { id: doc.id as Id } : {}) });
      rep.dangling.push({ slug: i.slug, decision: `keep: ${why.join("; ") || "already selected"}` });
    }
  }

  // media created by this run that no surviving article references (hero OR body upload node)
  const deleting = new Set(del.map((d) => String(d.id)));
  const candidates = new Map<string, string>();
  const startedAt = state?.startedAt ?? "";
  for (const m of run.media()) {
    if (m.origin === "created" && m.mediaId !== undefined) candidates.set(String(m.mediaId), m.filename);
  }
  for (const m of run.media().filter((x) => x.origin === "pending")) {
    if (run.media().some((x) => x.origin !== "pending" && x.filename === m.filename)) continue;
    const doc = await findMediaByStable(port, tenantId, m.filename);
    if (doc && String(doc.createdAt) >= startedAt) candidates.set(String(doc.id), m.filename);
  }
  const referenced = new Set<string>();
  for (const d of await tenantArticles(port, tenantId)) {
    if (deleting.has(String(d.id))) continue;
    const hero = relId(d.heroImage);
    if (hero) referenced.add(hero);
    for (const id of uploadIds(d.body)) referenced.add(id);
  }
  const mediaDel: { id: string; filename: string }[] = [];
  for (const [id, filename] of candidates) {
    if (referenced.has(id)) {
      rep.mediaKeptReferenced++;
      continue;
    }
    const exists = await findOne(port, "media", { and: [{ tenant: { equals: tenantId } }, { id: { equals: id } }] });
    if (!exists) continue;
    mediaDel.push({ id, filename });
    rep.mediaToDelete.push(filename);
  }

  if (apply) {
    for (const d of del) {
      try {
        await port.delete("articles", d.id, { context: { ...WRITE_CTX } });
        rep.deleted++;
      } catch (err) {
        rep.errors.push(`run ${runId}, slug ${d.slug}, id ${String(d.id)}: ${String((err as Error).message).slice(0, 200)}`);
      }
    }
    const stillThere = new Set<string>();
    if (rep.errors.length) for (const d of del) if (await findOne(port, "articles", { id: { equals: d.id } }, true)) stillThere.add(String(d.id));
    for (const m of mediaDel) {
      // an article whose delete failed still references its media: keep it
      if (stillThere.size && (await tenantArticles(port, tenantId)).some((d) => stillThere.has(String(d.id)) && (relId(d.heroImage) === m.id || uploadIds(d.body).includes(m.id)))) continue;
      try {
        await port.delete("media", m.id, { context: { ...WRITE_CTX } });
        rep.mediaDeleted++;
      } catch (err) {
        rep.errors.push(`run ${runId}, media ${m.filename}, id ${m.id}: ${String((err as Error).message).slice(0, 200)}`);
      }
    }
    if (resolved.length) {
      const j = new Journals(run);
      for (const r of resolved) j.outcome({ legacyId: r.legacyId, slug: r.slug, result: "resolved", deleted: r.deleted && !stillThere.has(String(r.id)), ...(r.id !== undefined ? { id: r.id } : {}), at: now().toISOString() });
      j.close();
    }
    writeJsonSafe(run.p("rollback-report.json"), rep);
  }
  log(
    `[${TOOL}] ${apply ? "APPLY" : "DRY RUN"} run ${runId}: entries ${rep.entries}; ${apply ? `deleted ${rep.deleted}` : `would delete ${rep.toDelete.length}`}; kept edited ${rep.keptEdited.length}; kept not-marker ${rep.keptNotMarker.length}; already gone ${rep.alreadyGone.length}; dangling intents ${rep.dangling.length}; media ${apply ? `deleted ${rep.mediaDeleted}` : `would delete ${rep.mediaToDelete.length}`}, kept referenced ${rep.mediaKeptReferenced}; errors ${rep.errors.length}`,
  );
  for (const d of rep.dangling) log(`[${TOOL}] dangling intent ${d.slug}: ${d.decision}`);
  for (const s of rep.keptEdited) log(`[${TOOL}] kept (edited since import): ${s}`);
  for (const e of rep.errors) log(`[${TOOL}] ERROR ${e}`);
  if (!apply) log(`[${TOOL}] DRY RUN: nothing deleted, nothing written.`);
  return rep.errors.length ? 2 : 0;
}

