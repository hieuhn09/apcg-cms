/**
 * Backfill a frontend's reader-side tables that reference articles by NUMERIC id
 * after migration (Central assigns new ids). Slug-keyed references need no change
 * (slugs are preserved). Uses the article-id-map.json produced by import-central.
 *
 *   READER_DATABASE_URL=postgres://...           (the frontend's own DB)
 *   READER_ID_MAP=migration-data/brief-asia/article-id-map.json
 *   READER_TABLES=bookmarks:article_id,reading_queue:article_id,reading_history:article_id,follows:article_id,article_views:article_id
 *   npm run migrate:reader-backfill -- [--dry-run]
 *
 * Optional:
 *   READER_SNAPSHOT=0   skip the pre-image backup tables (NOT recommended)
 *
 * Safety model — why this is a set-based join and not a per-id loop:
 *   The source id space and the central id space OVERLAP (both are dense serial
 *   integers). A naive `for (src, dst) UPDATE t SET col = dst WHERE col = src`
 *   loop re-visits rows it already rewrote as soon as some `dst` equals a later
 *   `src`, silently double-remapping them. This script instead loads the map into
 *   a temp table and runs ONE `UPDATE ... FROM map` per table, so every row is
 *   matched against its ORIGINAL value exactly once.
 *
 * Before rewriting anything it copies each table to `<table>_pre_central` (once).
 * That snapshot is the rollback path — the remap is otherwise irreversible when
 * the two id spaces overlap. Drop the snapshots by hand after the release is
 * stable; they are deliberately not managed by Drizzle.
 *
 * Re-running is safe: rows already carrying a central id no longer match any
 * `src`, so a second pass reports 0 updates rather than shifting them again.
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const SNAPSHOT = process.env.READER_SNAPSHOT !== "0";

const rawMap = JSON.parse(readFileSync(requireEnv("READER_ID_MAP"), "utf8")) as Record<string, number | string>;
const pairs = Object.entries(rawMap).map(([src, dst]) => ({ src: String(src), dst: String(dst) }));

const tables = requireEnv("READER_TABLES")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [table, column] = entry.split(":");
    if (!table || !column) throw new Error(`Bad READER_TABLES entry: ${entry}`);
    return { table, column };
  });

/** Fail fast on a map that cannot be applied unambiguously (two sources → one target). */
function assertInjective(): void {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const { src, dst } of pairs) {
    const prev = seen.get(dst);
    if (prev != null) collisions.push(`${prev} and ${src} both map to ${dst}`);
    else seen.set(dst, src);
  }
  if (collisions.length) {
    throw new Error(
      `article-id-map is not injective — refusing to run:\n  ${collisions.slice(0, 10).join("\n  ")}` +
        (collisions.length > 10 ? `\n  …and ${collisions.length - 10} more` : ""),
    );
  }
}

async function main() {
  if (!pairs.length) throw new Error("article-id-map is empty — nothing to backfill");
  assertInjective();

  // Diagnostic: how much the two id spaces overlap. Any non-zero value here is
  // what would have corrupted a per-id update loop.
  const srcSet = new Set(pairs.map((p) => p.src));
  const overlap = pairs.filter((p) => srcSet.has(p.dst)).length;
  console.log(`[reader-backfill] ${pairs.length} id pairs; ${overlap} target id(s) collide with the source id space`);

  const sql = postgres(requireEnv("READER_DATABASE_URL"), { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE _reader_id_map (src text PRIMARY KEY, dst text NOT NULL) ON COMMIT DROP`;
      await tx`INSERT INTO _reader_id_map ${tx(pairs, "src", "dst")}`;

      for (const { table, column } of tables) {
        const tableExists = await tx<{ exists: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS exists`;
        if (!tableExists[0]?.exists) {
          console.warn(`[reader-backfill] ${table}: table not found — SKIPPED`);
          continue;
        }

        const matchedRows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ${tx(table)} t
          JOIN _reader_id_map m ON t.${tx(column)} = m.src`;
        const unmappedRows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ${tx(table)} t
          WHERE t.${tx(column)} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM _reader_id_map m WHERE m.src = t.${tx(column)})`;
        const matched = matchedRows[0]?.n ?? 0;
        const unmapped = unmappedRows[0]?.n ?? 0;

        if (DRY_RUN) {
          console.log(`[reader-backfill] ${table}.${column}: ${matched} rows would update, ${unmapped} row(s) match no source id`);
          continue;
        }

        if (SNAPSHOT) {
          const snapshotName = `${table}_pre_central`;
          const snapshotRows = await tx<{ exists: boolean }[]>`SELECT to_regclass(${snapshotName}) IS NOT NULL AS exists`;
          if (snapshotRows[0]?.exists) {
            console.log(`[reader-backfill] ${snapshotName} already exists — keeping the original pre-image`);
          } else {
            await tx`CREATE TABLE ${tx(snapshotName)} AS SELECT * FROM ${tx(table)}`;
            console.log(`[reader-backfill] snapshot → ${snapshotName}`);
          }
        }

        const res = await tx`
          UPDATE ${tx(table)} t SET ${tx(column)} = m.dst
          FROM _reader_id_map m WHERE t.${tx(column)} = m.src`;
        console.log(`[reader-backfill] ${table}.${column}: ${res.count} rows updated, ${unmapped} row(s) matched no source id`);
      }
    });
  } finally {
    await sql.end();
  }
  console.log(`[reader-backfill] done${DRY_RUN ? " (dry-run — nothing written)" : ""}`);
}

main().catch((err) => {
  console.error("[reader-backfill] failed", err);
  process.exit(1);
});
