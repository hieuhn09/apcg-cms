/**
 * VowAsia legacy IMPORT (Amendment 4 §4.3/§4.4 item 6, B-7). Owner-run on the Mac.
 *
 *   npm run migrate:vowasia:import -- --snapshot <dir> --runs-dir <dir outside the repo>
 *       [--expect-sha256 <manifest digest>] [--confirm-host=<host>] [--limit N]
 *       [--apply --run-id <NEW id>]
 *
 * Source: ONLY the verified snapshot + its local image store (no old-DB path).
 * Target: Central tenant `vowasia` through the Payload Local API (a CentralPort).
 *
 * Gates (all enforced here, in this order):
 *   flags: `--runs-dir` always; `--apply` needs a NEW `--run-id` and `--expect-sha256`;
 *          a dry run never takes `--run-id`; `--resume` does not exist;
 *   Central: DB name printed first; host guard (non-local: `--confirm-host`, `--apply`
 *          also a TTY); name guard `/neondb` (dry-run too); R2 preflight (apply, non-local);
 *   paths: `--runs-dir` and `--snapshot` outside every git working tree (`assertOutsideRepo`);
 *   snapshot: sha256 chain snapshot -> manifest -> `--expect-sha256`, every image re-hashed;
 *   lock (apply only): `<runs-dir>/.import.lock`, O_EXCL; no dangling intent in any run;
 *          no marker article missing from every journal;
 *   taxonomy presence: STOP with the full list (dry-run too); never creates taxonomy;
 *   store-level image failures over 2% of the referenced images: STOP before any write.
 *
 * Writes: create-only. Per article: intent line (fsync) -> Media (cover, body; reuse by
 * stable filename) -> create article -> outcome line (fsync) -> slug-map line. An upload
 * error (Q12) stops the run BEFORE that article is created (outcome failed/uploadError).
 * After the run: timestamps-fix.sql + timestamps-baseline.json (owner-run), report.
 * A dry run writes only `<runs-dir>/dry-<timestamp>/` (never a named run dir, never the repo).
 */
import path from "node:path";
import { statusWrite } from "../../lib/gtp-transform";
import { CliError, intFlag, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { writeFileSafe, writeJsonSafe } from "./out-dir";
import { verifySnapshotInput } from "./snapshot-vowasia-main";
import { resolvePath } from "./vowasia-cli";
import { buildLexical, oldHostsLeft, pendingUploadCount } from "./vowasia-body";
import { centralTarget, r2Preflight } from "./vowasia-central";
import { checkTaxonomy, isMarker, loadTenantId, markerArticles, tenantArticles } from "./vowasia-central-state";
import { MARKER_ORIGIN, MARKER_SOURCE_NAME, TENANT_SLUG } from "./vowasia-constants";
import { MediaStore, UploadError, ensureMedia } from "./vowasia-media";
import { STORE_FAILURE_LIMIT, buildPlan, countBlock, storeFailureRatio, type PlannedArticle } from "./vowasia-plan";
import { WRITE_CTX, findOne, type CentralPort, type Doc, type Id } from "./vowasia-port";
import { Journals, RunError, acquireLock, allRuns, checkRunId, createRunDir, writeState, type RunDir } from "./vowasia-run";
import { limitPlan } from "./vowasia-slug-plan";
import { generateVowasiaTimestampsFix } from "./vowasia-timestamps";

export const IMPORT_FLAGS: FlagSpec = {
  snapshot: "value",
  "expect-sha256": "value",
  "runs-dir": "value",
  "run-id": "value",
  limit: "value",
  "confirm-host": "value",
  apply: "bool",
  "dry-run": "bool",
  resume: "bool",
};

const TOOL = "import";
const CONSECUTIVE_FAILURE_STOP = 5;

export interface ImportHooks {
  /** LOCAL rehearsal only: exit (137) after the N-th article create, before its outcome line. */
  killBeforeJournal?: number;
  /** LOCAL rehearsal only: the N-th Media create of the run throws (forced upload error, Q12). */
  failUploadAt?: number;
}

export interface ImportDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  isTty: boolean;
  openPort: () => Promise<CentralPort>;
  /** Repo root for the outside-repo guard (default: this repo). */
  root?: string;
  now?: () => Date;
  pid?: number;
  /** Called by the kill hook (default process.exit). */
  exit?: (code: number) => never;
}

/** LOCAL-only test hooks from the environment (refused against a non-local Central). */
export function importHooks(env: Record<string, string | undefined>, local: boolean): ImportHooks {
  const k = env.VOWASIA_TEST_KILL_BEFORE_JOURNAL;
  const f = env.VOWASIA_TEST_FAIL_UPLOAD_AT;
  if (!k && !f) return {};
  if (!local) throw new CliError(`${TOOL}: VOWASIA_TEST_* hooks are for a LOCAL rehearsal Central only; refusing.`);
  const num = (v: string, name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new CliError(`${TOOL}: ${name} must be a positive integer.`);
    return n;
  };
  return { ...(k ? { killBeforeJournal: num(k, "VOWASIA_TEST_KILL_BEFORE_JOURNAL") } : {}), ...(f ? { failUploadAt: num(f, "VOWASIA_TEST_FAIL_UPLOAD_AT") } : {}) };
}

/** Wrap a port so the N-th Media create throws (local rehearsal of the Q12 stop). */
function withForcedUploadError(port: CentralPort, n: number): CentralPort {
  let seen = 0;
  return {
    ...port,
    find: port.find.bind(port),
    update: port.update.bind(port),
    delete: port.delete.bind(port),
    create: async (c, d, o) => {
      if (c === "media" && ++seen === n) throw new Error("VOWASIA_TEST_FAIL_UPLOAD_AT: forced upload error (local rehearsal hook)");
      return port.create(c, d, o);
    },
  };
}

function wordCount(p: PlannedArticle): number {
  const t = p.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs]).join(" ").trim();
  return t ? t.split(/\s+/).length : 0;
}

export async function runImport(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const a = parseArgs(argv, IMPORT_FLAGS);
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  if (a.has("resume")) throw new CliError(`${TOOL}: there is no --resume; a new --apply always uses a NEW --run-id (rows of earlier runs are skipped); refusing.`);
  const runsArg = a.get("runs-dir");
  if (!runsArg) throw new CliError(`${TOOL}: --runs-dir <directory outside the repo> is required (dry-run reports go there too); refusing.`);
  const snapArg = a.get("snapshot");
  if (!snapArg) throw new CliError(`${TOOL}: --snapshot <directory written by migrate:vowasia:snapshot> is required; refusing.`);
  const runIdArg = a.get("run-id");
  if (a.apply && !runIdArg) throw new CliError(`${TOOL}: --apply needs a NEW --run-id; refusing.`);
  if (!a.apply && runIdArg) throw new CliError(`${TOOL}: a dry run never takes --run-id (it writes only <runs-dir>/dry-<timestamp>); refusing.`);
  const runId = runIdArg ? checkRunId(runIdArg) : undefined;
  const expect = a.get("expect-sha256");
  if (a.apply && !expect) throw new CliError(`${TOOL}: --apply needs --expect-sha256 <manifest digest recorded at the snapshot sitting>; refusing.`);
  const limit = intFlag(a, "limit");

  const target = centralTarget(deps.env, { confirmHost: a.get("confirm-host"), apply: a.apply, isTty: deps.isTty, log, tool: TOOL });
  const hooks = importHooks(deps.env, target.local);
  const runsDir = assertOutsideRepo(resolvePath(runsArg), deps.root);
  const snapDir = assertOutsideRepo(resolvePath(snapArg), deps.root, { create: false });
  const input = verifySnapshotInput(snapDir, { requireManifest: true, checkImages: true, ...(expect ? { expectManifestSha256: expect } : {}) });
  log(`[${TOOL}] snapshot OK: ${input.articles.length} articles, snapshot sha256 ${input.snapshotSha256}, manifest sha256 ${input.manifestSha256}`);
  r2Preflight(deps.env, target, a.apply, log, TOOL);

  let release: (() => void) | undefined;
  if (a.apply) {
    if (allRuns(runsDir).some((r) => r.id === runId)) throw new RunError(`run: this run directory already exists; every --apply needs a NEW --run-id (there is no --resume); refusing.`);
    release = acquireLock(runsDir, { pid: deps.pid ?? process.pid, runId: runId as string, mode: "import", startedAt: now().toISOString() });
  }
  try {
    if (a.apply) {
      const dangling = allRuns(runsDir).flatMap((r) => r.dangling().map((i) => `${r.id}: ${i.slug}`));
      if (dangling.length) throw new RunError(`${TOOL}: dangling intent(s) without an outcome line (a crashed run): ${dangling.join(", ")}; run migrate:vowasia:rollback -- --run-id <that run> first (dry run, then --apply); refusing.`);
    }
    const opened = await deps.openPort();
    const port = hooks.failUploadAt !== undefined ? withForcedUploadError(opened, hooks.failUploadAt) : opened;
    try {
      return await importBody(a.apply, runId, limit, runsDir, snapDir, input, port, target.local, hooks, deps, now);
    } finally {
      await port.close?.();
    }
  } finally {
    release?.();
  }
}

async function importBody(
  apply: boolean,
  runId: string | undefined,
  limit: number | undefined,
  runsDir: string,
  snapDir: string,
  input: ReturnType<typeof verifySnapshotInput>,
  port: CentralPort,
  local: boolean,
  hooks: ImportHooks,
  deps: ImportDeps,
  now: () => Date,
): Promise<number> {
  const log = deps.log;
  const tenantId = await loadTenantId(port);
  const tax = await checkTaxonomy(port, tenantId);
  log(`[${TOOL}] taxonomy OK: tenant ${TENANT_SLUG}, 5 pillars, 17 sub-sections, 4 tags, 6 authors present`);
  const all = await tenantArticles(port, tenantId);
  if (apply) {
    const journaled = new Set<string>();
    for (const r of allRuns(runsDir)) for (const id of r.articleIds()) journaled.add(id);
    const orphans = (await markerArticles(port, tenantId)).filter((d) => !journaled.has(String(d.id)));
    if (orphans.length) throw new RunError(`${TOOL}: ${orphans.length} marker article(s) in tenant ${TENANT_SLUG} are not in any run journal of --runs-dir (${orphans.slice(0, 20).map((d) => `${String(d.id)} ${String(d.slug)}`).join(", ")}); use the rollback of their run or remove them by hand; refusing.`);
  }
  if (!input.manifest) throw new CliError(`${TOOL}: manifest.json is missing in --snapshot; refusing.`);
  const store = new MediaStore(snapDir, input.manifest);
  const plan = buildPlan(input, store, all.map((d) => ({ id: d.id as Id, slug: String(d.slug), marker: isMarker(d) })));
  const block = countBlock(plan);
  for (const l of block) log(`[${TOOL}] ${l}`);
  const sf = storeFailureRatio(plan);
  if (sf.ratio > STORE_FAILURE_LIMIT) throw new RunError(`${TOOL}: store-level image failures ${sf.failed}/${sf.total} exceed 2% (C6); STOP before any write.`);
  const todo = limitPlan(plan.toCreate, limit);
  const started = now().toISOString();
  const report = {
    mode: apply ? "apply" : "dry-run",
    runId: runId ?? null,
    startedAt: started,
    planned: plan.toCreate.length,
    thisRun: todo.length,
    created: 0,
    createdByStatus: {} as Record<string, number>,
    skippedExisting: plan.existing.length,
    rejects: plan.rejects.map((r) => ({ slug: r.slug, reason: r.reason })),
    failed: [] as { slug: string; reason: string }[],
    mediaCreated: 0,
    mediaReused: 0,
    stop: null as string | null,
    countBlock: block,
  };
  if (!apply) {
    const dir = path.join(runsDir, `dry-${started.replace(/[:.]/g, "-")}`);
    assertOutsideRepo(dir, deps.root);
    writeJsonSafe(path.join(dir, "dry-run-report.json"), report);
    writeFileSafe(path.join(dir, "dry-run-report.md"), renderReport(report));
    log(`[${TOOL}] DRY RUN: nothing written to Central; would create ${todo.length} article(s) (report: <runs-dir>/${path.basename(dir)})`);
    return 0;
  }

  const run = createRunDir(runsDir, runId as string);
  writeState(run, { runId: runId as string, startedAt: started, tenant: TENANT_SLUG, snapshotSha256: input.snapshotSha256, manifestSha256: input.manifestSha256 as string, limit: limit ?? null });
  const j = new Journals(run);
  let consecutive = 0;
  let creates = 0;
  let code = 0;
  try {
    for (const p of todo) {
      const at = () => now().toISOString();
      j.intent({ legacyId: p.legacyId, slug: p.slug, runId: runId as string, at: at() });
      // re-check the slug right before the create (create-only; never adopt)
      const clash = await findOne(port, "articles", { and: [{ tenant: { equals: tenantId } }, { slug: { equals: p.slug } }] }, true);
      if (clash) {
        j.outcome({ legacyId: p.legacyId, slug: p.slug, result: "failed", reason: isMarker(clash) ? "existsNow" : "slugClashNow", at: at() });
        report.failed.push({ slug: p.slug, reason: "slug taken since the plan" });
        continue;
      }
      let heroId: Id | undefined;
      const mediaIdByUrl = new Map<string, Id>();
      try {
        const media = async (url: string, role: "cover" | "body", alt: string, credit: string): Promise<Id> => {
          const chk = store.check(url);
          if (!chk.ok) throw new Error("internal: store failure reached the upload step");
          const r = await ensureMedia(port, tenantId, chk, { alt, credit }, () => j.media({ legacyId: p.legacyId, role, filename: chk.filename, origin: "pending", at: at() }));
          j.media({ legacyId: p.legacyId, role, filename: r.filename, origin: r.origin, mediaId: r.id, at: at() });
          if (r.origin === "created") report.mediaCreated++;
          else report.mediaReused++;
          return r.id;
        };
        if (p.coverUrl && p.coverOk) heroId = await media(p.coverUrl, "cover", p.title, p.coverCredit);
        for (const s of p.sections) if (s.image && !p.failedBodyUrls.includes(s.image.url) && !mediaIdByUrl.has(s.image.url)) mediaIdByUrl.set(s.image.url, await media(s.image.url, "body", s.image.alt, s.image.credit));
      } catch (err) {
        if (err instanceof UploadError) {
          j.outcome({ legacyId: p.legacyId, slug: p.slug, result: "failed", reason: "uploadError", at: at() });
          report.failed.push({ slug: p.slug, reason: "uploadError" });
          report.stop = `Q12: Media upload failed for ${p.slug}; the run stopped BEFORE creating that article. Fix the cause (R2 credentials / network) and run again with a NEW --run-id. (${err.message})`;
          code = 1;
          break;
        }
        throw err;
      }
      const body = buildLexical(p.sections, { mediaIdByUrl, failedUrls: new Set(p.failedBodyUrls), nodeSeed: p.legacyId });
      if (pendingUploadCount(body.state) !== 0 || oldHostsLeft(body.state, plan.imageHosts).length) {
        j.outcome({ legacyId: p.legacyId, slug: p.slug, result: "failed", reason: "bodyPostCheck", at: at() });
        report.failed.push({ slug: p.slug, reason: "bodyPostCheck" });
        continue;
      }
      const sw = statusWrite(p.finalStatus);
      const data: Doc = {
        tenant: tenantId,
        title: p.title,
        slug: p.slug,
        ...(p.excerpt ? { dek: p.excerpt } : {}),
        ...(body.state ? { body: body.state } : {}),
        workflowStatus: sw.workflowStatus,
        ...(sw._status ? { _status: sw._status } : {}),
        publishedAt: p.publishedAt ?? started,
        pillar: tax.pillarId.get(p.pillar),
        ...(p.subSection ? { subSection: tax.subId.get(`${p.pillar}/${p.subSection}`) } : {}),
        author: tax.authorId.get(p.author),
        ...(p.tag ? { tags: [tax.tagId.get(p.tag)] } : {}),
        ...(heroId !== undefined ? { heroImage: heroId } : {}),
        readMin: Math.max(1, Math.ceil(wordCount(p) / 230)),
        pinnedToLatest: false,
        origin: MARKER_ORIGIN,
        editedByHuman: true,
        engineSourceName: MARKER_SOURCE_NAME,
      };
      let created: Doc;
      try {
        created = await port.create("articles", data, { draft: sw.draft, context: { ...WRITE_CTX } });
      } catch (err) {
        j.outcome({ legacyId: p.legacyId, slug: p.slug, result: "failed", reason: "createError", at: at() });
        report.failed.push({ slug: p.slug, reason: `createError: ${String((err as Error).message).slice(0, 160)}` });
        if (++consecutive >= CONSECUTIVE_FAILURE_STOP) {
          report.stop = `${CONSECUTIVE_FAILURE_STOP} consecutive create failures; stopping.`;
          code = 2;
          break;
        }
        continue;
      }
      consecutive = 0;
      creates++;
      if (hooks.killBeforeJournal !== undefined && creates >= hooks.killBeforeJournal) {
        log(`[${TOOL}] VOWASIA_TEST_KILL_BEFORE_JOURNAL=${hooks.killBeforeJournal}: exiting between create and journal (local rehearsal hook)`);
        (deps.exit ?? ((c: number) => process.exit(c)))(137);
      }
      const rb = (await findOne(port, "articles", { id: { equals: created.id } }, true)) ?? created;
      j.outcome({ legacyId: p.legacyId, slug: p.slug, result: "created", id: created.id as Id, at: at() });
      j.slug({
        legacyId: p.legacyId, slug: p.slug, articleId: created.id as Id, status: p.finalStatus, oldStatus: p.oldStatus, pillar: p.pillar, subSection: p.subSection,
        draftReasons: p.finalDraftReasons, legacyCreatedAt: p.createdAt, legacyUpdatedAt: p.updatedAt,
        baselineVersion: Number(rb.version ?? 1), baselineUpdatedAt: String(rb.updatedAt), createdAtRun: runId as string,
      });
      report.created++;
      report.createdByStatus[p.finalStatus] = (report.createdByStatus[p.finalStatus] ?? 0) + 1;
    }
  } finally {
    j.close();
    finishRun(run, runId as string, report, log);
  }
  log(`[${TOOL}] APPLY run ${runId as string}: created ${report.created}; media created ${report.mediaCreated}, reused ${report.mediaReused}; failed ${report.failed.length}${report.stop ? `; STOP: ${report.stop}` : ""}`);
  if (report.stop) log(`[${TOOL}] ${report.stop}`);
  if (code === 0 && report.failed.length) code = 2;
  if (!local) log(`[${TOOL}] next: check the rows in /admin, then the next run with a NEW --run-id; timestamps-fix.sql is in the run directory (owner-run, OB9).`);
  return code;
}

function finishRun(run: RunDir, runId: string, report: Record<string, unknown>, log: (l: string) => void): void {
  const ts = generateVowasiaTimestampsFix(
    run.slugMap().map((e) => ({ slug: e.slug, articleId: e.articleId, legacyCreatedAt: e.legacyCreatedAt, legacyUpdatedAt: e.legacyUpdatedAt })),
    { runId },
  );
  writeFileSafe(run.p("timestamps-fix.sql"), ts.sql);
  writeJsonSafe(run.p("timestamps-baseline.json"), ts.baseline);
  writeJsonSafe(run.p("import-report.json"), report);
  writeFileSafe(run.p("import-report.md"), renderReport(report as Parameters<typeof renderReport>[0]));
  log(`[${TOOL}] timestamps-fix.sql: ${ts.counts.blocks} block(s) for ${ts.counts.entries} article(s) of this run`);
}

function renderReport(r: { mode: string; runId: string | null; planned: number; thisRun: number; created: number; createdByStatus: Record<string, number>; skippedExisting: number; rejects: { slug: string; reason: string }[]; failed: { slug: string; reason: string }[]; mediaCreated: number; mediaReused: number; stop: string | null; countBlock: string[] }): string {
  const byReason: Record<string, number> = {};
  for (const x of r.rejects) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
  return [
    `# VowAsia import report (${r.mode === "apply" ? "APPLY" : "DRY RUN: nothing written"})`,
    "",
    `- run id: ${r.runId ?? "(dry run)"}`,
    `- planned new articles: ${r.planned}; in this run: ${r.thisRun}; created: ${r.created}; already in Central (skipped): ${r.skippedExisting}`,
    `- created by status: ${Object.entries(r.createdByStatus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `- media created ${r.mediaCreated}, reused ${r.mediaReused}`,
    "- rejects by reason:",
    ...(Object.entries(byReason).map(([k, v]) => `  - ${k}: ${v}`).length ? Object.entries(byReason).map(([k, v]) => `  - ${k}: ${v}`) : ["  - (none)"]),
    `- failed: ${r.failed.length}`,
    ...r.failed.map((f) => `  - ${f.slug}: ${f.reason}`),
    `- stop: ${r.stop ?? "none"}`,
    "",
    "## Expected-count block",
    ...r.countBlock.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
