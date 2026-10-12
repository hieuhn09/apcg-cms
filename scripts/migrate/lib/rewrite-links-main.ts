/**
 * Implementation of `scripts/migrate/rewrite-links-gtp.ts`: the gated second
 * pass (gtp-launch P4, A11-S03, A12-N11, E17). Touches ONLY slug-map entries
 * flagged `internalLinkRewritable` by pass 1 whose article is still untouched,
 * replacing old-site URLs in the body text with `/article/<slug>` of the
 * migrated target. Writes with `systemWrite` (no version bump), per-status
 * `draft`, revalidate and translation enqueue disabled, then records the new
 * `version`/`updatedAt` as the rollback baseline. Real GTP bodies are plain
 * text, so the expected result in production is "0 rewritable, nothing written".
 *
 *   npm run migrate:gtp:rewrite-links -- --run-id <id> [--apply] [--confirm-host=<host>] [--require-final] [--rehearsal]
 */
import "../../lib/env";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../../payload.config";
import { pFind, pUpdate } from "../../lib/payload-loose";
import { CliError } from "./args";
import { parseCommand, resolveRequireFinal } from "./cli-spec";
import { assertImportTenant, centralTarget, outDir, runMain } from "./cli-common";
import { replaceInText, type LexicalState } from "./lexical-body";
import { normaliseKey } from "./normalise-path";
import { untouched } from "./rollback-rules";
import { RunDir, RunDirError, RUN_MESSAGES, checkRunId } from "./run-dir";

type Doc = Record<string, unknown>;

async function main(): Promise<number> {
  const a = parseCommand("rewrite-links", process.argv.slice(2));
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError("rewrite-links: --run-id is required.");
  const runId = checkRunId(runIdRaw);
  const central = centralTarget(a, a.apply);
  assertImportTenant();
  const run = new RunDir(path.join(outDir(a), runId));
  if (!run.exists()) throw new RunDirError(RUN_MESSAGES.missing);
  const state = run.state();
  const rf = resolveRequireFinal("rewrite-links", a, { centralLocal: central.local });
  if (rf.requireFinal) {
    if (!state) throw new CliError("rewrite-links: no recorded provisional list in state.json for a non-local or --require-final run; refusing.");
    if (state.provisional.length) throw new CliError(`rewrite-links: provisional owner-decision values were recorded by the import (${state.provisional.join(", ")}); refusing.`);
  }
  const entries = run.slugMap();
  const flagged = entries.filter((e) => e.internalLinkRewritable === true);
  if (!flagged.length) {
    console.log("[rewrite-links] 0 rewritable, nothing written");
    return 0;
  }
  const byOld = new Map<string, string>();
  for (const e of entries) if (e.oldUrl && e.status === "published") byOld.set(normaliseKey(e.oldUrl) ?? e.oldUrl, `/article/${e.slug}`);
  const tsBaseline = run.readJson<Record<string, string>>("timestamps-baseline.json", {});
  const payload = await getPayload({ config });
  const journal = a.apply ? run.slugJournal() : undefined;
  const rep = { flagged: flagged.length, rewritten: [] as string[], skippedEdited: [] as string[], skippedNoChange: [] as string[] };
  for (const e of flagged) {
    const doc = ((await pFind(payload, "articles", { where: { id: { equals: e.articleId } }, limit: 1, draft: true })) as unknown as { docs: Doc[] }).docs[0];
    if (!doc || !untouched(doc, e, tsBaseline)) {
      rep.skippedEdited.push(e.legacyId);
      continue;
    }
    const repl = new Map<string, string>();
    for (const u of e.textLinks ?? []) {
      try {
        const to = byOld.get(normaliseKey(new URL(u).pathname) ?? "");
        if (to) repl.set(u, to);
      } catch {
        /* skip */
      }
    }
    const body = JSON.parse(JSON.stringify(doc.body ?? null)) as LexicalState | null;
    if (!body || !repl.size || replaceInText(body, repl) === 0) {
      rep.skippedNoChange.push(e.legacyId);
      continue;
    }
    if (!a.apply) {
      rep.rewritten.push(e.legacyId);
      continue;
    }
    await pUpdate(payload, "articles", e.articleId, { body }, { context: { systemWrite: true, skipTranslationEnqueue: true, disableRevalidate: true }, draft: e.status === "draft", locale: "en" });
    const rb = ((await pFind(payload, "articles", { where: { id: { equals: e.articleId } }, limit: 1, draft: true })) as unknown as { docs: Doc[] }).docs[0];
    journal?.append({ legacyId: e.legacyId, baselineVersion: Number(rb?.version), baselineUpdatedAt: String(rb?.updatedAt), rewrittenAtRun: runId });
    rep.rewritten.push(e.legacyId);
  }
  journal?.close();
  if (a.apply) run.compactSlugMap();
  run.writeJson(`rewrite-links-report${a.apply ? "" : "-dry"}.json`, { ...rep, rewrittenIds: rep.rewritten });
  console.log(`[rewrite-links] ${a.apply ? "APPLY" : "DRY RUN"}: flagged ${rep.flagged}; ${a.apply ? "rewritten" : "would rewrite"} ${rep.rewritten.length}; skipped edited ${rep.skippedEdited.length}; no change ${rep.skippedNoChange.length}`);
  return 0;
}

runMain("rewrite-links", main);
