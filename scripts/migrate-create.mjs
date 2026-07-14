/**
 * Generate a Payload migration locally. Loads .env.local + .env (so DATABASE_URL /
 * PAYLOAD_SECRET are available without exporting secrets on the command line), then
 * runs `payload migrate:create <name>` with DATABASE_URL pinned to the DIRECT
 * (non-pooled) URL for schema introspection. Read-only against the DB — it only
 * diffs the live schema against the Payload config and writes the migration files.
 *
 *   node scripts/migrate-create.mjs add_wtb_schema
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

execSync(`npx payload migrate:create ${name}`, {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: direct, PAYLOAD_DB_PUSH: "false" },
});
