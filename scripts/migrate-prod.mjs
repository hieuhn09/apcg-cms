// Run pending Payload migrations before a production build (Vercel build hook).
// Mirrors brief-asia's migrate-prod. Uses the direct (non-pooled) DB URL for DDL.
import { execSync } from "node:child_process";

const directUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!directUrl) {
  console.error("[migrate-prod] DATABASE_URL / DATABASE_DIRECT_URL not set");
  process.exit(1);
}

try {
  execSync("payload migrate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: directUrl },
  });
} catch (err) {
  console.error("[migrate-prod] migration failed", err);
  process.exit(1);
}
