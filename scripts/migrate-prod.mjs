// Run pending Payload migrations before a production build (Vercel build hook).
// Mirrors the site repos' migrate-prod. Uses the direct (non-pooled) DB URL for DDL.
//
// GUARDED TO VERCEL_ENV=production. That guard was MISSING until 04-09-2026, and
// the omission was not theoretical: DATABASE_URL and DATABASE_DIRECT_URL are set
// for BOTH Production and Preview as ONE shared value, so every preview build —
// that is, every push of any branch — ran `payload migrate` against the LIVE
// database before anyone had reviewed the branch.
//
// The 04-09 dtw-dashboards migration was applied exactly that way: it ran in the
// preview build of its own branch at 11:09:52, and the production build nine
// minutes later was a silent no-op because the work was already done. It worked,
// but only by luck — a bad migration would have hit production the moment the
// branch was pushed, with no review and no deploy to roll back.
//
// Vercel's deployment protection does NOT cover this. SSO gates HTTP access to a
// preview URL; the build runs before any of that, with the preview env vars, and
// can issue whatever DDL it likes.
//
// Every sibling site repo (brief-asia, dtw-web, wtb-web, gcv-web, wad-web) has
// carried this guard since 2026-05-29. Central was the outlier, and it is the one
// repo where a bad migration takes down every publication at once.
//
// To apply a migration deliberately (outside a production deploy), run
// `npm run payload:migrate` — that path is unchanged and still available.
import { execSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV ?? "local";

if (vercelEnv !== "production") {
  console.log(`[migrate-prod] VERCEL_ENV=${vercelEnv} — skipping migrations (production only).`);
  console.log(
    "[migrate-prod] Preview and Production share one database, so running migrations " +
      "here would mutate the live schema from an unreviewed branch. Use " +
      "`npm run payload:migrate` to apply one on purpose.",
  );
  process.exit(0);
}

// DDL must go over the DIRECT (non-pooled) endpoint — pgbouncer transaction
// pooling breaks some DDL/session features.
const directUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!directUrl) {
  console.error("[migrate-prod] DATABASE_URL / DATABASE_DIRECT_URL not set");
  process.exit(1);
}
if (!process.env.DATABASE_DIRECT_URL) {
  console.warn(
    "[migrate-prod] DATABASE_DIRECT_URL not set — falling back to DATABASE_URL (pooled). " +
      "DDL over pgbouncer can fail; set DATABASE_DIRECT_URL in the Vercel dashboard.",
  );
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
