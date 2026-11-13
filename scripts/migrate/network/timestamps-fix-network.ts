/**
 * network-legacy `timestamps-fix`: prints where the run's OWNER-RUN
 * `timestamps-fix.sql` is and what it does (blocks, skipped). It never executes
 * SQL: the owner runs the file with psql on the DIRECT Central URL (no pooler).
 *
 *   npm run migrate:network -- timestamps-fix --tenant <slug> --run-id <id> [--out dir]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliError, parseArgs } from "../lib/args";
import { outDir, runMain } from "../lib/cli-common";
import { profile } from "../lib/network-profile";
import { checkRunId } from "../lib/run-dir";

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2), { "run-id": "value", out: "value" });
  const id = a.get("run-id");
  if (!id) throw new CliError("timestamps-fix: --run-id is required.");
  const dir = path.join(outDir(a), checkRunId(id));
  const file = path.join(dir, "timestamps-fix.sql");
  if (!existsSync(file)) throw new CliError("timestamps-fix: this run has no timestamps-fix.sql (it is written by import --apply).");
  const sql = readFileSync(file, "utf8");
  const blocks = (sql.match(/^DO \$\$/gm) ?? []).length;
  const marker = sql.includes(`'${profile().markerSourceName}'`);
  const tenant = sql.includes(`slug = '${profile().tenant}'`);
  console.log(`[timestamps-fix] ${file}\n[timestamps-fix] ${blocks} blocks; marker ${profile().markerSourceName} ${marker ? "OK" : "MISSING"}; tenant ${profile().tenant} ${tenant || blocks === 0 ? "OK" : "MISSING"}`);
  if (blocks && (!marker || !tenant)) throw new CliError("timestamps-fix: the file was not generated for this tenant; refusing.");
  return 0;
}

runMain("timestamps-fix", main);
