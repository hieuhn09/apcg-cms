import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * APCGHub P4 / CMS-1 — adds `ContentEngines.hubRead` (checkbox, default false).
 *
 * HAND-WRITTEN on purpose, not `payload migrate:create`: the newest `.json`
 * snapshot is 20260820_084629_add_content_type, and the five migrations after it
 * were all hand-written without snapshots, so `migrate:create` would re-emit all
 * five changes (already live in production) and break `migrate-prod.mjs` with
 * "column already exists".
 *
 * REQUIRED before deploying the `hubRead` field: `authenticateEngine()` reads
 * `content-engines` with no `select`, so Payload queries every configured column;
 * without `hub_read` in the table every engine intake call for every tenant fails.
 *
 * Column shape matches exactly what Payload push generates for this field
 * (verified with `\d content_engines` on a push-synced DB): `boolean`, nullable,
 * `DEFAULT false`. No index (the field has no `index: true`). No `_v` table:
 * ContentEngines has no `versions` config.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "content_engines" ADD COLUMN "hub_read" boolean DEFAULT false;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "content_engines" DROP COLUMN "hub_read";`)
}
