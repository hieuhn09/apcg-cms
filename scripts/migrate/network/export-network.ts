/**
 * READ-ONLY export for a network title (network-legacy `export`). Writes, into
 * the git-ignored out dir (mode 600): `legacy-source-urls.ndjson` and
 * `source-urls.txt` (the engine's seed-dedup input: one line per unique source
 * URL, every status) and `source-url-collisions.json`. Nothing is imported.
 * The GTP-only side datasets (subscribers, visa rules, press submissions) do
 * not exist for other titles and are not read.
 */
import path from "node:path";
import { parseCommand, resolveMappingPath, resolveSiteFilter } from "../lib/cli-spec";
import { loadEffectiveMapping, openLegacy, outDir, runMain } from "../lib/cli-common";
import { legacySourceUrls } from "../lib/gtp-exports";
import { writeFileSafe, writeJsonSafe } from "../lib/out-dir";

async function main(): Promise<number> {
  const a = parseCommand("export", process.argv.slice(2));
  const v = loadEffectiveMapping(a, resolveMappingPath("export", a));
  const siteId = resolveSiteFilter(a, v.mapping.source.siteFilter);
  const out = outDir(a);
  const reader = await openLegacy(a, v, siteId);
  const rows: Record<string, unknown>[] = [];
  for await (const p of reader.pages("articles", ["id", "created_at", "source_url", "title", "published_at"], 500)) rows.push(...p);
  const { lines, collisions } = legacySourceUrls(rows);
  writeFileSafe(path.join(out, "legacy-source-urls.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  writeFileSafe(path.join(out, "source-urls.txt"), lines.map((l) => l.source_url).join("\n") + (lines.length ? "\n" : ""));
  writeJsonSafe(path.join(out, "source-url-collisions.json"), collisions);
  writeJsonSafe(path.join(out, "export-query-log.json"), reader.queryLog());
  await reader.close();
  console.log(`[export] articles read ${rows.length}; unique source urls ${lines.length} (collisions ${collisions.length}); written to ${out}`);
  return 0;
}

runMain("export", main);
