import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `podcasts` gains `youtube_url` + `youtube_id` — an episode IS a YouTube video.
 *
 * BOTH COLUMNS ARE NULLABLE ON PURPOSE. `youtubeUrl` is `required: true` in the
 * collection config, but "required" is enforced at the application layer
 * (Payload field validation + the `beforeValidate` parser hook), NOT with a DB
 * `NOT NULL`. Rationale, same shape as the `videoMedia.alt` decision in
 * 20260910_010000_add_video_media_credit_fields.ts: a `NOT NULL` added to a
 * table that turns out to hold real rows breaks every existing document until
 * someone backfills it. `podcasts` is believed near-empty (the feature is off
 * for every tenant but BriefAsia) but that is UNVERIFIED — no database was
 * reachable when this migration was written. App-level `required` gives the
 * same block-at-save behaviour with no destructive edge if the assumption is
 * wrong: pre-existing rows keep reading fine everywhere (admin list/detail,
 * `payload.find`, `GET /api/public/podcasts`) and are blocked only on their own
 * next save, until an editor fills the link in. Deliberately no backfill and no
 * `defaultValue` — a fabricated YouTube link is worse than a visible error.
 *
 * NEITHER FIELD IS LOCALIZED, so there is deliberately NO `podcasts_locales`
 * child-table work here: a YouTube link is identical in every locale. The
 * missing-`_locales`-table defect that shipped once on `video_media` is the
 * mirror image of this decision — getting it wrong in either direction is the
 * bug class to avoid.
 *
 * Idempotent `IF NOT EXISTS` style mirrors 20260910_010000_add_video_media_credit_fields.ts.
 * No `.json` snapshot pairs this file — the snapshot convention was dropped
 * after the first five migrations, and `src/migrations/index.ts` only ever
 * imports the `up`/`down` exports.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "podcasts" ADD COLUMN IF NOT EXISTS "youtube_url" varchar;

  ALTER TABLE "podcasts" ADD COLUMN IF NOT EXISTS "youtube_id" varchar;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "podcasts" DROP COLUMN IF EXISTS "youtube_id";

  ALTER TABLE "podcasts" DROP COLUMN IF EXISTS "youtube_url";`)
}
