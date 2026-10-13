/**
 * READ-ONLY export of the GTP side datasets (gtp-launch P4, A3, H7, A13-R07).
 * Nothing here is imported into Central.
 *
 *   LEGACY_GTP_DB_URL=... npm run migrate:gtp:export -- (--site-id <uuid> | --mapping-overlay <path>) [--out dir] [--include-contact]
 *
 * Writes (mode 600, git-ignored out dir; reports show counts only):
 *   legacy-source-urls.ndjson  one {source_url,title,published_at} per unique source_url (all statuses)
 *   source-urls.txt            URLs only (P2 gtp:seed-dedup input, for humans)
 *   source-url-collisions.json canonical-URL collisions with legacy ids
 *   gtp-subscribers.export.csv email,newsletter,source,created_at (owner decision OD-9; NOT imported)
 *   visa-rules.snapshot.json   (option A; later CMS collection = option C)
 *   press-submissions.snapshot.json contact columns redacted unless --include-contact
 */
import path from "node:path";
import { parseCommand, resolveMappingPath, resolveSiteFilter } from "./lib/cli-spec";
import { loadEffectiveMapping, openLegacy, outDir, runMain } from "./lib/cli-common";
import { legacySourceUrls, redactRow, subscribersCsv } from "./lib/gtp-exports";
import { ALLOWED_TABLES, type AllowedTable } from "./lib/legacy-sql";
import type { LegacyReader } from "./lib/legacy-reader";
import { writeFileSafe, writeJsonSafe } from "./lib/out-dir";

type Row = Record<string, unknown>;

async function all(reader: LegacyReader, t: AllowedTable, cols: string[] | "all"): Promise<Row[]> {
  const out: Row[] = [];
  for await (const p of reader.pages(t, cols, 500)) out.push(...p);
  return out;
}

async function main(): Promise<number> {
  const a = parseCommand("export", process.argv.slice(2));
  const v = loadEffectiveMapping(a, resolveMappingPath("export", a));
  const siteId = resolveSiteFilter(a, v.mapping.source.siteFilter);
  const out = outDir(a);
  const reader = await openLegacy(a, v, siteId);
  const includeContact = a.has("include-contact");

  const articles = await all(reader, "articles", ["id", "created_at", "source_url", "title", "published_at"]);
  const { lines, collisions } = legacySourceUrls(articles);
  writeFileSafe(path.join(out, "legacy-source-urls.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  writeFileSafe(path.join(out, "source-urls.txt"), lines.map((l) => l.source_url).join("\n") + (lines.length ? "\n" : ""));
  writeJsonSafe(path.join(out, "source-url-collisions.json"), collisions);

  const subs = await all(reader, "gtp_subscribers", ["email", "newsletter", "source", "created_at"]);
  writeFileSafe(path.join(out, "gtp-subscribers.export.csv"), subscribersCsv(subs));

  const omitSite = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "site_id"));
  const visa = (await all(reader, "visa_rules", "all")).map(omitSite);
  writeJsonSafe(path.join(out, "visa-rules.snapshot.json"), visa);

  const press = (await all(reader, "press_submissions", "all")).map((r) =>
    redactRow(omitSite(r), v.mapping.redact, { personalColumns: ALLOWED_TABLES.press_submissions.personalColumns, includeContact }),
  );
  writeJsonSafe(path.join(out, "press-submissions.snapshot.json"), press);
  writeJsonSafe(path.join(out, "export-query-log.json"), reader.queryLog());
  await reader.close();
  console.log(
    `[export] source urls ${lines.length} (collisions ${collisions.length}); subscribers ${subs.length} (NOT imported); visa rules ${visa.length}; press submissions ${press.length}${includeContact ? " (contact INCLUDED)" : " (contact redacted)"}`,
  );
  return 0;
}

runMain("export", main);
