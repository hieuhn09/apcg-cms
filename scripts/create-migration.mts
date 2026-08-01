/**
 * Generate a Payload migration (SQL + drizzle snapshot + index entry).
 *
 * Called by scripts/migrate-create.mjs, which loads env first. Run that, not this.
 *
 * Why this bypasses `payload migrate:create`: the CLI resolves the migration NAME
 * through its predefined-migration importer, and under tsx on Node 26 that path
 * dies with `ENOENT … node:crypto?tsx-namespace=…` before any SQL is generated.
 * The programmatic adapter call skips that importer entirely and produces exactly
 * the same three artifacts.
 */
import { getPayload } from "payload";
import config from "../payload.config";

const migrationName = process.argv[2];
if (!migrationName) {
  console.error("[migrate:create] usage: node scripts/migrate-create.mjs <migration_name>");
  process.exit(1);
}

const payload = await getPayload({ config });
await payload.db.createMigration({ migrationName, payload, forceAcceptWarning: true } as never);
process.exit(0);
