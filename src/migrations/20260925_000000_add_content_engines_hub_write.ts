import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * APCGHub P4 / CMS-3 — adds `ContentEngines.hubWrite` (checkbox, default false),
 * the permission for the single hub write route
 * `POST /api/hub/articles/{id}/status`.
 *
 * HAND-WRITTEN on purpose, same reason as the `hub_read` twin
 * (20260924_000000_add_content_engines_hub_read): the newest `.json` snapshot is
 * still 20260820_084629_add_content_type, so `payload migrate:create` would
 * re-emit every later hand-written change (already live) and break
 * `migrate-prod.mjs` with "column already exists".
 *
 * REQUIRED before deploying the `hubWrite` field: `authenticateEngine()` and
 * `authenticateHubEngine()` read `content-engines` with no `select`, so Payload
 * queries every configured column; without `hub_write` every engine intake /
 * translation call and every `/api/hub/*` call fails ("column
 * content_engines.hub_write does not exist" — reproduced on a disposable PG16
 * with PAYLOAD_DB_PUSH=false before this file existed).
 *
 * Column shape identical to `hub_read` (same field shape: checkbox,
 * defaultValue false): `boolean`, nullable, `DEFAULT false`. No index, no `_v`
 * table (ContentEngines has no `versions` config). Existing rows get `false`,
 * i.e. no engine can write until a System Admin ticks the box.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "content_engines" ADD COLUMN "hub_write" boolean DEFAULT false;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "content_engines" DROP COLUMN "hub_write";`)
}
