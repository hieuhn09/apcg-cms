/**
 * VowAsia `rewrite-links` (Amendment 4 §4.2.3, §4.4 item 9, B-9b; Q11, O-B5). Owner-run, per run.
 *
 *   npm run migrate:vowasia:rewrite-links -- --run-id <id> --runs-dir <dir> --snapshot <dir>
 *       --old-site-links-file <answer file outside the repo> [--expect-sha256 <digest>]
 *       [--confirm-host=<host>] [--apply]
 *
 * Acts ONLY on `old-site-article` links (host vowasia.com / www.vowasia.com, path
 * /article/<slug>) in articles created by THIS run, exactly as the owner answered
 * in the per-link answer file (no default, E21). `external` links are never touched.
 *
 * Answer file: one line per link, `<article slug> <URL> rewrite|keep`; blank lines
 * are ignored. Refused (nothing written) when: a line is malformed or has another
 * value; the same (slug, URL) appears twice; an entry is not among the
 * `old-site-article` links of the WHOLE verified snapshot (extra; an entry for
 * another run's article is NOT extra: accepted and ignored, V-W3); an
 * `old-site-article` link of THIS run's articles has no line (missing); the file
 * is empty while the snapshot has such links. The file must be an existing regular
 * file whose directory is outside every git working tree (E17).
 *
 * `rewrite` -> the relative path `/<pillar>/<slug>` ONLY when the linked article
 * was created by THIS run (its slug map) AND its live Central `workflowStatus` is
 * `published` now; otherwise unchanged + one report line. Links are matched with
 * the SAME extractor the import dry-run printed (E16), so the URL string the owner
 * copied is byte-identical to what is replaced.
 *
 * Dry run (default): prints per link the article slug, the URL, the decision and
 * the exact replacement text; writes nothing. `--apply` takes the lock, writes with
 * `systemWrite` (no version bump), re-baselines each rewritten row in the run's slug
 * map (rollback of the run still deletes it, Q11) and writes the report into the run dir.
 */
import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { untouched } from "../../lib/rollback-rules";
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { URL_IN_TEXT } from "./image-refs";
import { writeJsonSafe } from "./out-dir";
import { verifySnapshotInput } from "./snapshot-vowasia-main";
import { resolvePath } from "./vowasia-cli";
import { planBody, textNodes, type LexicalState } from "./vowasia-body";
import { centralTarget } from "./vowasia-central";
import { isMarker, loadTenantId } from "./vowasia-central-state";
import { MediaStore } from "./vowasia-media";
import { snapshotArticles } from "./vowasia-plan";
import { SYSTEM_WRITE_CTX, findOne, type CentralPort } from "./vowasia-port";
import { Journals, RunDir, RunError, RUN_MESSAGES, acquireLock, checkRunId, type SlugMapLine } from "./vowasia-run";
import { readEn } from "./vowasia-transform";
import type { ImportDeps } from "./import-vowasia-main";

export const REWRITE_FLAGS: FlagSpec = {
  "run-id": "value", "runs-dir": "value", snapshot: "value", "expect-sha256": "value", "old-site-links-file": "value", "confirm-host": "value", apply: "bool", "dry-run": "bool",
};
const TOOL = "rewrite-links";

export class AnswerFileError extends Error {
  override name = "AnswerFileError";
}

export type Answer = "rewrite" | "keep";

/** Parse the per-link answer file (pure). Key: `<slug> <URL>`. */
export function parseAnswerFile(text: string): Map<string, Answer> {
  const out = new Map<string, Answer>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || (parts[2] !== "rewrite" && parts[2] !== "keep") || !/^https?:\/\//i.test(parts[1] as string)) {
      throw new AnswerFileError(`${TOOL}: answer file line ${i + 1} is malformed (expected "<article slug> <URL> rewrite|keep"); refusing.`);
    }
    const key = `${parts[0]} ${parts[1]}`;
    if (out.has(key)) throw new AnswerFileError(`${TOOL}: answer file lists the same link twice (line ${i + 1}: ${key}); refusing.`);
    out.set(key, parts[2] as Answer);
  });
  return out;
}

/** E17: an existing regular file whose real directory is outside every git working tree. */
export function checkAnswerFile(file: string, root?: string): string {
  const abs = resolvePath(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new AnswerFileError(`${TOOL}: --old-site-links-file must be an existing regular file; refusing.`);
  const real = realpathSync.native(abs);
  assertOutsideRepo(path.dirname(real), root, { create: false });
  return real;
}

/** Replace whole extracted URLs (same extractor as the import dry-run) in one text. */
export function replaceLinks(text: string, repl: ReadonlyMap<string, string>): { text: string; n: number } {
  let n = 0;
  const out = text.replace(URL_IN_TEXT, (m) => {
    const stripped = m.replace(/[.,;:!?]+$/, "");
    const to = repl.get(stripped);
    if (to === undefined) return m;
    n++;
    return to + m.slice(stripped.length);
  });
  return { text: out, n };
}

export async function runRewriteLinks(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const a = parseArgs(argv, REWRITE_FLAGS);
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  const fileArg = a.get("old-site-links-file");
  if (!fileArg) throw new CliError(`${TOOL}: --old-site-links-file <answer file written by the owner after OB5> is required (no default); refusing.`);
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError(`${TOOL}: --run-id is required; refusing.`);
  const runId = checkRunId(runIdRaw);
  const runsArg = a.get("runs-dir");
  const snapArg = a.get("snapshot");
  if (!runsArg || !snapArg) throw new CliError(`${TOOL}: --runs-dir and --snapshot are required; refusing.`);
  const expect = a.get("expect-sha256");
  if (a.apply && !expect) throw new CliError(`${TOOL}: --apply needs --expect-sha256; refusing.`);
  centralTarget(deps.env, { confirmHost: a.get("confirm-host"), apply: a.apply, isTty: deps.isTty, log, tool: TOOL });
  const runsDir = assertOutsideRepo(resolvePath(runsArg), deps.root, { create: false });
  const run = new RunDir(path.join(runsDir, runId));
  if (!run.exists()) throw new RunError(RUN_MESSAGES.missing);
  const answerFile = checkAnswerFile(fileArg, deps.root);
  const snapDir = assertOutsideRepo(resolvePath(snapArg), deps.root, { create: false });
  const input = verifySnapshotInput(snapDir, { requireManifest: true, ...(expect ? { expectManifestSha256: expect } : {}) });
  const hosts = new MediaStore(snapDir, input.manifest!).hosts();
  const answers = parseAnswerFile(readFileSync(answerFile, "utf8"));

  // snapshot-wide old-site-article links, and the links of each article by legacy id
  const snapshotLinks = new Set<string>();
  const linksOf = new Map<string, { slug: string; urls: { url: string; legacySlug: string }[] }>();
  for (const r of snapshotArticles(input)) {
    const t = readEn(r.title);
    const b = planBody(r.body, t.ok ? t.text : "", hosts);
    if (!b.ok) continue;
    const slug = typeof r.slug === "string" ? r.slug.trim() : "";
    const urls = b.links.filter((l) => l.cls === "old-site-article").map((l) => ({ url: l.url, legacySlug: l.legacySlug as string }));
    for (const u of urls) snapshotLinks.add(`${slug} ${u.url}`);
    linksOf.set(r.legacyId, { slug, urls });
  }
  for (const k of answers.keys()) if (!snapshotLinks.has(k)) throw new AnswerFileError(`${TOOL}: answer file entry "${k}" is not an old-site-article link of the snapshot (extra or unknown); refusing.`);
  if (answers.size === 0 && snapshotLinks.size > 0) throw new AnswerFileError(`${TOOL}: the answer file is empty but the snapshot has ${snapshotLinks.size} old-site-article link(s): every link is missing; refusing.`);
  const entries = run.slugMap();
  const missing: string[] = [];
  for (const e of entries) for (const u of linksOf.get(e.legacyId)?.urls ?? []) if (!answers.has(`${e.slug} ${u.url}`)) missing.push(`${e.slug} ${u.url}`);
  if (missing.length) throw new AnswerFileError(`${TOOL}: ${missing.length} old-site-article link(s) of run ${runId} are missing from the answer file: ${missing.join(", ")}; refusing.`);

  const release = a.apply ? acquireLock(runsDir, { pid: deps.pid ?? process.pid, runId, mode: "rewrite-links", startedAt: now().toISOString() }) : undefined;
  try {
    const port = await deps.openPort();
    try {
      return await body(a.apply, run, entries, linksOf, answers, port, deps, now);
    } finally {
      await port.close?.();
    }
  } finally {
    release?.();
  }
}

async function body(
  apply: boolean,
  run: RunDir,
  entries: SlugMapLine[],
  linksOf: Map<string, { slug: string; urls: { url: string; legacySlug: string }[] }>,
  answers: Map<string, Answer>,
  port: CentralPort,
  deps: ImportDeps,
  now: () => Date,
): Promise<number> {
  const log = deps.log;
  const runId = run.id;
  const tenantId = await loadTenantId(port);
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const tsFile = run.p("timestamps-baseline.json");
  const tsBaseline = existsSync(tsFile) ? (JSON.parse(readFileSync(tsFile, "utf8")) as Record<string, string>) : {};
  const rep = { mode: apply ? "apply" : "dry-run", runId, links: [] as { slug: string; url: string; decision: string; replacement: string | null }[], rewrittenArticles: [] as string[], skippedEdited: [] as string[] };
  const j = apply ? new Journals(run) : undefined;
  try {
    for (const e of entries) {
      const links = linksOf.get(e.legacyId)?.urls ?? [];
      if (!links.length) continue;
      const repl = new Map<string, string>();
      for (const l of links) {
        const ans = answers.get(`${e.slug} ${l.url}`) as Answer;
        let decision: string;
        let replacement: string | null = null;
        if (ans === "keep") decision = "unchanged (keep)";
        else {
          const target = bySlug.get(l.legacySlug);
          if (!target) decision = "unchanged (rewrite asked; target not created by this run)";
          else {
            const live = await findOne(port, "articles", { id: { equals: target.articleId } }, true);
            if (!live || !isMarker(live) || String(live.workflowStatus) !== "published") decision = `unchanged (rewrite asked; target is ${live ? String(live.workflowStatus) : "gone"} in Central)`;
            else {
              replacement = `/${target.pillar}/${target.slug}`;
              decision = `rewrite -> "${replacement}"`;
              repl.set(l.url, replacement);
            }
          }
        }
        rep.links.push({ slug: e.slug, url: l.url, decision, replacement });
        log(`[${TOOL}] slug=${e.slug} url=${l.url} decision=${decision}`);
      }
      if (!repl.size) continue;
      const doc = await findOne(port, "articles", { and: [{ tenant: { equals: tenantId } }, { id: { equals: e.articleId } }] }, true);
      if (!doc || !isMarker(doc) || !untouched(doc, e, tsBaseline)) {
        rep.skippedEdited.push(e.slug);
        log(`[${TOOL}] slug=${e.slug}: article edited or gone since the import; not rewritten`);
        continue;
      }
      const state = JSON.parse(JSON.stringify(doc.body ?? null)) as LexicalState | null;
      let n = 0;
      for (const t of textNodes(state)) {
        const r = replaceLinks(String(t.text), repl);
        t.text = r.text;
        n += r.n;
      }
      if (!n) continue;
      rep.rewrittenArticles.push(e.slug);
      if (!apply) continue;
      await port.update("articles", doc.id as string | number, { body: state }, { draft: e.status === "draft", context: { ...SYSTEM_WRITE_CTX } });
      const rb = await findOne(port, "articles", { id: { equals: doc.id } }, true);
      j?.slug({ legacyId: e.legacyId, baselineVersion: Number(rb?.version), baselineUpdatedAt: String(rb?.updatedAt), rewrittenAtRun: runId });
    }
  } finally {
    j?.close();
  }
  if (apply) writeJsonSafe(run.p("rewrite-links-report.json"), { ...rep, at: now().toISOString() });
  log(`[${TOOL}] ${apply ? "APPLY" : "DRY RUN"} run ${runId}: links ${rep.links.length}; articles ${apply ? "rewritten" : "to rewrite"} ${rep.rewrittenArticles.length}; skipped edited ${rep.skippedEdited.length}${apply ? "" : "; nothing written"}`);
  return 0;
}
