/**
 * Apply committed Payload migrations to the DB in DATABASE_URL. Loads .env.local
 * for PAYLOAD_SECRET etc. WITHOUT overriding an inline DATABASE_URL, so you can
 * target a specific DB:
 *
 *   DATABASE_URL='<prod>' node scripts/migrate-apply.mjs
 *
 * Read-through of unapplied migrations only; never pushes. Use the DIRECT
 * (non-pooled) URL when possible for DDL.
 */
import { config as dotenv } from "dotenv";
import { execSync } from "node:child_process";
import path from "node:path";

dotenv({ path: path.resolve(process.cwd(), ".env.local") });
dotenv({ path: path.resolve(process.cwd(), ".env") });

if (!process.env.DATABASE_URL) {
  console.error("[migrate] DATABASE_URL required (inline).");
  process.exit(1);
}
console.log("[migrate] applying migrations to", new URL(process.env.DATABASE_URL).host);
execSync("npx payload migrate", {
  stdio: "inherit",
  env: { ...process.env, PAYLOAD_DB_PUSH: "false" },
});
