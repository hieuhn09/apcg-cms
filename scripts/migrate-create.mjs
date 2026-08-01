/**
 * Generate a Payload migration locally. Loads .env.local + .env (so DATABASE_URL /
 * PAYLOAD_SECRET are available without exporting secrets on the command line), then
 * generates the migration with DATABASE_URL pinned to the DIRECT (non-pooled) URL
 * for schema introspection. Read-only against the DB — it only diffs the live
 * schema against the Payload config and writes the migration files.
 *
 *   node scripts/migrate-create.mjs add_wtb_schema
 *
 * This drives scripts/create-migration.mts (the adapter's programmatic
 * createMigration) rather than `payload migrate:create`. The CLI feeds the
 * migration NAME through its predefined-migration importer, which on Windows +
 * Node 26 under tsx dies with `ENOENT … node:crypto?tsx-namespace=…` before
 * generating anything. Same output, minus the trap.
 */
import { config as dotenv } from "dotenv";
import { execSync } from "node:child_process";
import path from "node:path";

dotenv({ path: path.resolve(process.cwd(), ".env.local") });
dotenv({ path: path.resolve(process.cwd(), ".env") });

const name = process.argv[2] || "migration";
const direct = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!direct) {
  console.error("[migrate:create] DATABASE_URL / DATABASE_DIRECT_URL missing (.env.local).");
  process.exit(1);
}

execSync(`npx tsx scripts/create-migration.mts ${name}`, {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: direct, PAYLOAD_DB_PUSH: "false" },
});
