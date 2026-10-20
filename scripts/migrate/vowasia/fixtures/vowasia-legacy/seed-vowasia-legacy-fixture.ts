/**
 * Seeds the FAKE legacy VowAsia database of the rehearsal (Amendment 4 B-11,
 * E12) so the EXISTING snapshot CLI can read it like the real old site:
 * `public.sites` + `public.articles` (the 15 snapshot columns + one personal
 * column that must never be read), two sites (vowasia + another site), the
 * fixture rows, a `vowasia_ro` schema with two site-filtered views (the shape
 * of the owner SQL 02) and the login role `vowasia_migrator` with SELECT on them only. Writes the rehearsal overlay (site filter, allow-listed fake image
 * host, local host rewrite to the image server on 3519) to `--overlay <file>`.
 *
 * LOCAL ONLY: the admin URL is a literal 127.0.0.1 URL (G10c-local), checked
 * again with `assertLocalDb`. Synthetic data only (fake hosts, no real rows).
 *
 *   npm run migrate:vowasia:fixture -- --overlay <file outside the repo> [--bulk 120]
 */
import { writeFileSync } from "node:fs";
import pg from "pg";
import { assertLocalDb } from "../../../../lib/local-db-guard";
import { FIX_COLUMNS, FIX_IMAGE_HOST, FIX_OTHER_SITE_ID, FIX_SITE_ID, fixtureRows, otherSiteRows } from "./fixture-rows";

const ADMIN_URL = "postgres://postgres:password@127.0.0.1:54346/vowasia_legacy";
const ROLE_PASSWORD = "password";
const JSON_COLS = new Set(["title", "excerpt", "body_sections", "tags"]);
const TS_COLS = new Set(["created_at", "published_at", "updated_at"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  assertLocalDb(ADMIN_URL);
  const overlay = arg("overlay");
  if (!overlay) throw new Error("fixture: --overlay <file> is required");
  const bulk = Number(arg("bulk") ?? "120");
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    const cols = FIX_COLUMNS.map((x) => `"${x}" ${x === "id" || x === "site_id" ? "uuid" : JSON_COLS.has(x) ? "jsonb" : TS_COLS.has(x) ? "timestamptz" : "text"}`).join(", ");
    await c.query("DROP TABLE IF EXISTS public.articles; DROP TABLE IF EXISTS public.sites");
    await c.query("CREATE TABLE public.sites (id uuid PRIMARY KEY, slug text NOT NULL, name text, contact_email text)");
    await c.query(`CREATE TABLE public.articles (${cols}, author_email text, PRIMARY KEY (id))`);
    await c.query("INSERT INTO public.sites VALUES ($1, 'gtp', 'Other site', 'a@example.invalid'), ($2, 'vowasia', 'VowAsia', 'b@example.invalid')", [FIX_OTHER_SITE_ID, FIX_SITE_ID]);
    const rows = [...fixtureRows({ bulk }), ...otherSiteRows()];
    for (const r of rows) {
      const values = FIX_COLUMNS.map((x) => (JSON_COLS.has(x) && r[x] !== null && r[x] !== undefined ? JSON.stringify(r[x]) : r[x] === "" && TS_COLS.has(x) ? null : r[x] ?? null));
      await c.query(`INSERT INTO public.articles (${FIX_COLUMNS.map((x) => `"${x}"`).join(", ")}, author_email) VALUES (${FIX_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}, $${FIX_COLUMNS.length + 1})`, [...values, "author@example.invalid"]);
    }
    await c.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vowasia_migrator') THEN CREATE ROLE vowasia_migrator LOGIN; END IF; END $$");
    await c.query(`ALTER ROLE vowasia_migrator WITH LOGIN PASSWORD '${ROLE_PASSWORD}'`);
    // the same shape as the owner SQL 02: a read-only schema with two site-filtered views
    await c.query("DROP SCHEMA IF EXISTS vowasia_ro CASCADE");
    await c.query("CREATE SCHEMA vowasia_ro");
    await c.query(`CREATE VIEW vowasia_ro.articles AS SELECT ${FIX_COLUMNS.map((x) => `"${x}"`).join(", ")} FROM public.articles WHERE site_id = '${FIX_SITE_ID}'`);
    await c.query(`CREATE VIEW vowasia_ro.sites AS SELECT id, slug, name FROM public.sites WHERE id = '${FIX_SITE_ID}'`);
    await c.query("REVOKE ALL ON SCHEMA public FROM vowasia_migrator");
    await c.query("GRANT USAGE ON SCHEMA vowasia_ro TO vowasia_migrator");
    await c.query("GRANT SELECT ON vowasia_ro.articles, vowasia_ro.sites TO vowasia_migrator");
    const n = await c.query("SELECT count(*)::int AS n FROM public.articles WHERE site_id = $1", [FIX_SITE_ID]);
    console.log(`[fixture] legacy vowasia rows: ${String(n.rows[0]?.n)} (+ ${otherSiteRows().length} rows of another site)`);
  } finally {
    await c.end();
  }
  const ov = {
    _note: "REHEARSAL overlay written by seed-vowasia-legacy-fixture.ts (fake site id, fake image host rewritten to the local image server).",
    source: { schema: "vowasia_ro", siteIdKind: "uuid", siteFilter: FIX_SITE_ID },
    media: { hostAllowlist: [FIX_IMAGE_HOST], hostRewrite: { [FIX_IMAGE_HOST]: "127.0.0.1:3519" } },
  };
  writeFileSync(overlay, JSON.stringify(ov, null, 2) + "\n", { mode: 0o600 });
  console.log("[fixture] overlay written");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[fixture] failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
