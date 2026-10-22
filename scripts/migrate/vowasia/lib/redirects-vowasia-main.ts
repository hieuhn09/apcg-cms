/**
 * VowAsia redirect map builder CLI body (Amendment 4 §4.4 item 8, B-9a). READ-ONLY on Central.
 *
 *   npm run migrate:vowasia:redirects -- --snapshot <dir> --out <dir outside the repo>
 *       [--expect-sha256 <digest>] [--confirm-host=<host>] [--min-coverage <percent>]
 *
 * Input: the verified snapshot (old status, plan reasons such as no cover) and the
 * LIVE Central state (workflowStatus of the tenant-vowasia marker article per slug).
 * Rules: `buildVowasiaRedirects` (owner rules C3, Q1, Q9). Output, only when no
 * O-B12 row and no hard error: `<out>/redirect-map.json` (the object for
 * `vowasia-web` `src/redirects/redirect-map.json`) and `<out>/redirects-report.json`.
 * Exit 3 = O-B12 rows or hard errors (nothing written); exit 2 = coverage below
 * `--min-coverage` (CF1: published source rows with an entry / published rows).
 */
import path from "node:path";
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { writeJsonSafe } from "./out-dir";
import { verifySnapshotInput } from "./snapshot-vowasia-main";
import { resolvePath } from "./vowasia-cli";
import { centralTarget } from "./vowasia-central";
import { isMarker, loadTenantId, tenantArticles } from "./vowasia-central-state";
import { MediaStore } from "./vowasia-media";
import { buildPlan, redirectSources } from "./vowasia-plan";
import type { Id } from "./vowasia-port";
import { buildVowasiaRedirects } from "./vowasia-redirects";
import type { ImportDeps } from "./import-vowasia-main";

export const REDIRECTS_FLAGS: FlagSpec = { snapshot: "value", "expect-sha256": "value", out: "value", "confirm-host": "value", "min-coverage": "value" };
const TOOL = "redirects";

export async function runRedirects(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const a = parseArgs(argv, REDIRECTS_FLAGS);
  const log = deps.log;
  const snapArg = a.get("snapshot");
  const outArg = a.get("out");
  if (!snapArg || !outArg) throw new CliError(`${TOOL}: --snapshot and --out <directory outside the repo> are required; refusing.`);
  const min = a.get("min-coverage");
  if (min !== undefined && !/^\d+(\.\d+)?$/.test(min)) throw new CliError(`${TOOL}: --min-coverage must be a number (percent); refusing.`);
  centralTarget(deps.env, { confirmHost: a.get("confirm-host"), apply: false, isTty: deps.isTty, log, tool: TOOL });
  const snapDir = assertOutsideRepo(resolvePath(snapArg), deps.root, { create: false });
  const outDir = assertOutsideRepo(resolvePath(outArg), deps.root, { create: false });
  const expect = a.get("expect-sha256");
  const input = verifySnapshotInput(snapDir, { requireManifest: true, ...(expect ? { expectManifestSha256: expect } : {}) });
  const port = await deps.openPort();
  let docs;
  try {
    const tenantId = await loadTenantId(port);
    docs = await tenantArticles(port, tenantId);
  } finally {
    await port.close?.();
  }
  const markers = docs.filter(isMarker);
  const plan = buildPlan(input, new MediaStore(snapDir, input.manifest!), docs.filter((d) => !isMarker(d)).map((d) => ({ id: d.id as Id, slug: String(d.slug), marker: false })));
  const b = buildVowasiaRedirects(redirectSources(plan), new Map(markers.map((d) => [String(d.slug), String(d.workflowStatus)])));
  const pct = Math.round(b.coverage.ratio * 10000) / 100;
  log(`[${TOOL}] entries ${b.counts.total} = ${b.counts.gone410} x 410 + ${b.counts.total - b.counts.gone410} x 308 (published -> article ${b.counts.publishedToArticle}, archived -> pillar ${b.counts.archivedToPillar}, no-cover -> pillar ${b.counts.noCoverToPillar}); no entry ${b.noEntry.length}; O-B12 rows ${b.stops.length}; errors ${b.errors.length}`);
  log(`[${TOOL}] coverage (CF1): ${b.coverage.publishedWithEntry} of ${b.coverage.published} published source rows have an entry; published with an entry / published = ${b.coverage.ratio.toFixed(4)} (${pct}%)`);
  for (const x of b.noEntry) log(`[${TOOL}] no entry: slug=${x.slug} reason=${x.reason}`);
  if (b.stops.length || b.errors.length) {
    for (const s of b.stops) log(`[${TOOL}] STOP O-B12 (open owner item, no default): slug=${s.slug} was published on the old site and is a draft because a stored image failed`);
    for (const e of b.errors) log(`[${TOOL}] ERROR ${e}`);
    log(`[${TOOL}] nothing written.`);
    return 3;
  }
  const dir = assertOutsideRepo(outDir, deps.root);
  writeJsonSafe(path.join(dir, "redirect-map.json"), b.map);
  writeJsonSafe(path.join(dir, "redirects-report.json"), { counts: b.counts, coverage: b.coverage, noEntry: b.noEntry, snapshotSha256: input.snapshotSha256 });
  log(`[${TOOL}] wrote redirect-map.json (${b.counts.total} entries) and redirects-report.json to --out`);
  if (min !== undefined && pct < Number(min)) {
    log(`[${TOOL}] coverage ${pct}% is below --min-coverage ${min}%`);
    return 2;
  }
  return 0;
}
