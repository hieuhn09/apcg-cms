/** Load .env.local then .env for tsx scripts (Payload config reads process.env). */
import { config as dotenv } from "dotenv";
import path from "node:path";

dotenv({ path: path.resolve(process.cwd(), ".env.local") });
dotenv({ path: path.resolve(process.cwd(), ".env") });

/**
 * Refuse Payload's dev schema-push against a remote database.
 *
 * `PAYLOAD_DB_PUSH=true` is meant for local dev against the docker Postgres, where
 * there are no committed migrations yet (see README). But `.env.local` is also the
 * file that carries the PRODUCTION connection string during a migration run, and
 * every script here loads it. Left on, `migrate:import` boots Payload with
 * `push: true` (payload.config.ts) and syncs the schema straight into production —
 * altering columns to match the config and writing a `dev` row into
 * `payload_migrations`.
 *
 * That `dev` row is the expensive part. Once present, `payload migrate` prompts
 * "data loss will occur"; on CI there is no TTY, so it takes the default No, skips
 * the migration and STILL EXITS 0 — a green deploy with no schema change, which is
 * exactly the class of silent failure this migration keeps hitting.
 *
 * `migrate-apply.mjs` and `migrate-create.mjs` already hard-code the flag off for
 * this reason; this closes the same hole for every other script. Forced off with a
 * warning rather than thrown, so a legitimate local run is never blocked.
 */
const dbUrl = process.env.DATABASE_URL ?? "";
const isLocalDb = /(?:localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)/i.test(dbUrl);
if (process.env.PAYLOAD_DB_PUSH === "true" && dbUrl && !isLocalDb) {
  console.warn(
    "[env] PAYLOAD_DB_PUSH=true with a REMOTE DATABASE_URL — forcing it off.\n" +
      "      Dev-push would rewrite the deployed schema and add a `dev` row to payload_migrations,\n" +
      "      after which `payload migrate` silently skips on CI. Use `npm run migrate:prod` instead.",
  );
  process.env.PAYLOAD_DB_PUSH = "false";
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const DRY_RUN = process.argv.includes("--dry-run");
