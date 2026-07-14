/**
 * Read-only DB status probe. Points at ANY Postgres URL (a source site's DB, the
 * WTB production DB, or the central DB) and reports: the public table list, row
 * counts for the editorial tables that exist, and the applied Payload migrations.
 * SELECT / information_schema only — never writes.
 *
 *   STATUS_DB_URL='postgres://...' npm run db:status
 *   STATUS_DB_URL='postgres://...' STATUS_TENANT_SLUG=dtw npm run db:status
 *
 * Use it in the migration runbook to compare source-vs-central row counts per
 * tenant. Pass STATUS_TENANT_SLUG to scope central counts to one tenant.
 */
import "./lib/env";
import postgres from "postgres";

// Editorial tables of interest, with the naming variants across the three source
// schemas + central (Payload turns a `sub-sections` slug into a `sub_sections`
// table; central uses `subsections`).
const INTEREST = [
  "articles",
  "authors",
  "pillars",
  "subsections",
  "sub_sections",
  "cities",
  "sectors",
  "tags",
  "media",
  "newsletters",
  "newsletter_subscriptions",
  "subscribers",
  "podcasts",
  "corrections",
  "sponsor_slots",
  "sponsorslots",
  "wire_drops",
  "market_snapshots",
  "fx_rates",
  "users",
  "tenants",
];

async function main() {
  // STATUS_DB_URL points at any DB (a source site / WTB prod). Falls back to the
  // central DATABASE_URL (loaded from .env.local) so `npm run db:status` with no
  // args reports the central DB.
  const url = process.env.STATUS_DB_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set STATUS_DB_URL (or DATABASE_URL in .env.local).");
  const tenantSlug = process.env.STATUS_TENANT_SLUG?.trim();
  // Local docker Postgres speaks no TLS; Neon requires it. Strip sslmode/
  // channel_binding query params and set ssl explicitly (lenient verify — we only
  // read counts, and Neon's pooler + channel_binding trips strict verification).
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const clean = url.split("?")[0] ?? url;
  const sql = postgres(clean, {
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    idle_timeout: 5,
  });
  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    const names = tables.map((t) => t.table_name);
    const present = new Set(names);
    console.log(`\n=== DB STATUS (${new URL(url).host}) ===`);
    console.log(`public tables: ${names.length}`);

    // Resolve tenant id (central only) so per-tenant counts are possible.
    let tenantId: number | string | null = null;
    if (tenantSlug && present.has("tenants")) {
      const rows = await sql<{ id: number | string }[]>`
        SELECT id FROM tenants WHERE slug = ${tenantSlug} LIMIT 1`;
      tenantId = rows[0]?.id ?? null;
      console.log(`tenant "${tenantSlug}" → id ${tenantId ?? "NOT FOUND"}`);
    }

    console.log("\n-- editorial row counts --");
    for (const t of INTEREST) {
      if (!present.has(t)) continue;
      let hasTenantCol = false;
      if (tenantId != null) {
        const col = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema='public' AND table_name=${t} AND column_name='tenant_id'`;
        hasTenantCol = (col[0]?.n ?? 0) > 0;
      }
      const rows = hasTenantCol
        ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)} WHERE tenant_id = ${tenantId}`
        : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)}`;
      console.log(`  ${t.padEnd(26)} ${rows[0]?.n ?? 0}${hasTenantCol ? "  (tenant-scoped)" : ""}`);
    }

    if (present.has("payload_migrations")) {
      const migs = await sql<{ name: string; batch: number }[]>`
        SELECT name, batch FROM payload_migrations ORDER BY id`;
      console.log("\n-- payload_migrations --");
      for (const m of migs) console.log(`  batch ${m.batch}  ${m.name}`);
    }

    // Flag any GLOBAL unique index on articles.slug (a cross-tenant blocker).
    if (present.has("articles")) {
      const idx = await sql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='articles' AND indexdef ILIKE '%unique%'`;
      const globalSlugUnique = idx.filter(
        (i) => /\(slug\)/i.test(i.indexdef) && !/tenant/i.test(i.indexdef),
      );
      console.log(
        `\narticles global UNIQUE(slug) present: ${globalSlugUnique.length ? "YES ⚠ (blocker for a shared/2nd tenant)" : "no"}`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[db-status] failed", err);
  process.exit(1);
});
