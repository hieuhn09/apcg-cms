import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * APCGHub P5.1 — adds `ContentEngines.hubAuthor` (checkbox, default false),
 * the permission for the hub text-draft author routes
 * (`POST /api/hub/articles`, `PATCH /api/hub/articles/{id}`).
 *
 * HAND-WRITTEN on purpose, same reason as the `hub_read` / `hub_write` twins
 * (20260924_000000_add_content_engines_hub_read,
 * 20260925_000000_add_content_engines_hub_write): the newest `.json` snapshot is
 * still 20260820_084629_add_content_type, so `payload migrate:create` would
 * re-emit every later hand-written change (already live) and break
 * `migrate-prod.mjs` with "column already exists". No `.json` snapshot.
 *
 * REQUIRED before deploying the `hubAuthor` field: engine / hub auth read
 * `content-engines` with no `select`, so Payload queries every configured
 * column; without `hub_author` every engine intake / translation / hub call
 * fails ("column content_engines.hub_author does not exist").
 *
 * Column shape identical to `hub_read` / `hub_write`: `boolean`, nullable,
 * `DEFAULT false`. No index, no `_v` table. Existing rows get `false`, i.e. no
 * engine can author until a System Admin ticks the box. `IF NOT EXISTS` makes
 * a re-run a no-op. `lock_timeout` keeps the short ACCESS EXCLUSIVE lock on this
 * small but hot table from queuing behind a long transaction: the build fails
 * instead of stalling reads for every tenant.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   SET LOCAL lock_timeout = '5s';
   ALTER TABLE "content_engines" ADD COLUMN IF NOT EXISTS "hub_author" boolean DEFAULT false;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "content_engines" DROP COLUMN IF EXISTS "hub_author";`)
}
