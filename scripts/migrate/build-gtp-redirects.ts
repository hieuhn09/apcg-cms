/**
 * Redirect map builder for gtp-web (gtp-launch P4, 7.8 as superseded by
 * A11-S14, A12-N04, A13-R02). Reads a run's slug map; writes `redirects.json`
 * and `redirect-coverage.md` into the run directory, and with --emit-gtp-web
 * the Phase 3 shaped `redirect-map.json` + `redirect-rules.json`.
 * `--require-final` is IMPLIED unless --rehearsal (a provisional
 * urls.articlePathTemplate or archivedAs can never drive a production map).
 *
 *   npm run migrate:gtp:redirects -- --run-id <id> --known-routes <known-routes.json> [--mapping-overlay <overlay>]
 *     [--emit-gtp-web <dir>] [--sitemap-urls <file>] [--min-coverage <pct>] [--rehearsal] [--require-final] [--mapping path] [--out dir]
 *
 * Exit 3 = hard check failed (chains, loops, dangling targets, uncovered published rows,
 * hand-off contract); exit 2 = refusal (provisional values, coverage below --min-coverage).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./lib/args";
import { parseCommand, resolveMappingPath, resolveRequireFinal } from "./lib/cli-spec";
import { loadEffectiveMapping, outDir, resolvePath, runMain } from "./lib/cli-common";
import { buildRedirects, coverage, gtpWebFiles } from "./lib/gtp-redirects";
import { validateGtpWebRedirectFiles, type KnownRoutes } from "./lib/gtp-redirect-contract";
import { assertOutDirSafe, writeFileSafe, writeJsonSafe } from "./lib/out-dir";
import { RunDir, RunDirError, RUN_MESSAGES, checkRunId } from "./lib/run-dir";

async function main(): Promise<number> {
  const a = parseCommand("redirects", process.argv.slice(2));
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError("redirects: --run-id is required.");
  const kr = a.get("known-routes");
  if (!kr) throw new CliError("redirects: --known-routes <file> is required (Phase 3 npm run export:known-routes).");
  const v0 = loadEffectiveMapping(a, resolveMappingPath("redirects", a));
  const rf = resolveRequireFinal("redirects", a, { siteFilter: v0.mapping.source.siteFilter });
  const v = rf.requireFinal ? loadEffectiveMapping(a, resolveMappingPath("redirects", a), { requireFinal: true }) : v0;
  if (a.has("rehearsal")) console.log("[redirects] REHEARSAL: provisional urls.* prove the mechanism only, not the real old URL pattern.");
  const run = new RunDir(path.join(outDir(a), checkRunId(runIdRaw)));
  if (!run.exists()) throw new RunDirError(RUN_MESSAGES.missing);
  const knownRoutes = JSON.parse(readFileSync(resolvePath(kr), "utf8")) as KnownRoutes;
  const entries = run.slugMap();
  const b = buildRedirects(entries, v.mapping, knownRoutes);
  const files = gtpWebFiles(b);
  const contract = validateGtpWebRedirectFiles(files.map, files.rules, knownRoutes);
  const urls = a.get("sitemap-urls") ? readFileSync(resolvePath(a.get("sitemap-urls") as string), "utf8").split("\n") : [];
  const cov = coverage(urls, b);
  writeJsonSafe(run.p("redirects.json"), { version: 1, generatedAt: new Date().toISOString(), rules: b.rules, counts: b.counts, collisions: b.collisions, unconverged: b.unconverged });
  const md = [
    "# Redirect coverage",
    "",
    `- rules: ${b.rules.length}; counts: ${JSON.stringify(b.counts)}`,
    `- old-URL collisions (first by plan order kept): ${b.collisions.length}`,
    `- hard errors: ${b.errors.length}; hand-off contract errors: ${contract.length}`,
    `- supplied URL list: ${cov.total} URLs, matched ${cov.matched} (${cov.pct}%)`,
    "- unmatched (top 50; default decision: 404 page, never a blanket 301 to home):",
    ...cov.unmatched.map((u) => `  - ${u}`),
    ...b.errors.map((e) => `- ERROR ${e}`),
    ...contract.map((e) => `- CONTRACT ${e}`),
  ].join("\n");
  writeFileSafe(run.p("redirect-coverage.md"), md + "\n");
  const emit = a.get("emit-gtp-web");
  if (emit && !b.errors.length && !contract.length) {
    const dir = assertOutDirSafe(resolvePath(emit));
    writeJsonSafe(path.join(dir, "redirect-map.json"), files.map);
    writeJsonSafe(path.join(dir, "redirect-rules.json"), files.rules);
  }
  console.log(`[redirects] rules ${b.rules.length} (map ${Object.keys(files.map).length}, patterns ${files.rules.length}); identityDropped ${b.counts.identityDropped}; collisions ${b.collisions.length}; errors ${b.errors.length}; contract errors ${contract.length}; coverage ${cov.matched}/${cov.total} (${cov.pct}%)`);
  for (const e of [...b.errors, ...contract].slice(0, 20)) console.error(`[redirects] ${e}`);
  if (b.errors.length || contract.length) return 3;
  const min = a.get("min-coverage");
  if (min !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(min)) throw new CliError("redirects: --min-coverage must be a number (percent).");
    if (cov.pct < Number(min)) {
      console.error(`[redirects] coverage ${cov.pct}% is below --min-coverage ${min}%`);
      return 2;
    }
  } else if (cov.total && cov.pct < 100) console.warn(`[redirects] WARNING coverage ${cov.pct}% (no --min-coverage set)`);
  return 0;
}

runMain("redirects", main);
