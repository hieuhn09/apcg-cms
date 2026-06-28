/**
 * Backfill a frontend's reader-side tables that reference articles by NUMERIC id
 * after migration (Central assigns new ids). Slug-keyed references need no change
 * (slugs are preserved). Uses the article-id-map.json produced by import-central.
 *
 *   READER_DATABASE_URL=postgres://...           (the frontend's own DB)
 *   READER_ID_MAP=migration-data/brief-asia/article-id-map.json
 *   READER_TABLES=bookmarks:article_id,reading_queue:article_id,reading_history:article_id,follows:article_id
 *   npm run migrate:reader-backfill -- [--dry-run]
 *
 * Each READER_TABLES entry is `table:column`. For each row whose column matches a
 * source id in the map, it is updated to the new central id. Safe + idempotent
 * (only rewrites values still equal to a known source id).
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const idMap = JSON.parse(readFileSync(requireEnv("READER_ID_MAP"), "utf8")) as Record<string, number | string>;
const tables = requireEnv("READER_TABLES")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [table, column] = entry.split(":");
    if (!table || !column) throw new Error(`Bad READER_TABLES entry: ${entry}`);
    return { table, column };
  });

async function main() {
  const sql = postgres(requireEnv("READER_DATABASE_URL"), { max: 4 });
  try {
    for (const { table, column } of tables) {
      let updated = 0;
      for (const [sourceId, newId] of Object.entries(idMap)) {
        if (DRY_RUN) {
          const rows = await sql`SELECT count(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} = ${sourceId}`;
          updated += rows[0]?.n ?? 0;
          continue;
        }
        const res = await sql`UPDATE ${sql(table)} SET ${sql(column)} = ${String(newId)} WHERE ${sql(column)} = ${sourceId}`;
        updated += res.count;
      }
      console.log(`[reader-backfill] ${table}.${column}: ${updated} rows ${DRY_RUN ? "would update" : "updated"}`);
    }
  } finally {
    await sql.end();
  }
  console.log("[reader-backfill] done");
}

main().catch((err) => {
  console.error("[reader-backfill] failed", err);
  process.exit(1);
});
