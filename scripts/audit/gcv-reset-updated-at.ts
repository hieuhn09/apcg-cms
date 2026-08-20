/**
 * GCV audit item 5 — every article shows "UPDATED 17 AUG 2026" because bulk
 * jobs (import delta / backfills) touched updatedAt without any real edit.
 * Reset updated_at := published_at for gcv articles never edited by a human
 * (edited_by_human = false/null), directly in SQL — the Payload API would
 * bump updated_at again on the very write that resets it.
 *
 * DRY-RUN by default (prints the row count). --apply to execute.
 * Run AFTER gcv-fix-hero-credits.ts --apply (that script bumps updatedAt).
 *
 *   npx tsx scripts/audit/gcv-reset-updated-at.ts [--apply]
 */
import "../lib/env";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const tenant = await client.query(`select id from tenants where slug = 'gcv' limit 1`);
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error("tenant gcv not found");

  const where = `tenant_id = $1
      and published_at is not null
      and coalesce(edited_by_human, false) = false
      and updated_at > published_at`;

  const count = await client.query(`select count(*)::int as n from articles where ${where}`, [tenantId]);
  console.log(`${count.rows[0].n} gcv articles have a bulk-touched updated_at (no human edit).`);

  if (APPLY) {
    const res = await client.query(
      `update articles set updated_at = published_at where ${where}`,
      [tenantId]
    );
    console.log(`APPLIED: reset updated_at on ${res.rowCount} articles.`);
  } else {
    console.log("DRY-RUN — re-run with --apply to reset them.");
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
