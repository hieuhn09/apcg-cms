import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `videoMedia` gains the same `alt` / `caption` / `credit` trio `Media` has, so
 * a video dropped mid-body is described exactly like an image dropped mid-body.
 *
 * TWO storage shapes, because the three fields do not localize the same way:
 *
 * - `alt` + `caption` are LOCALIZED, so Payload puts them in a child
 *   `video_media_locales` table. 20260910_000000_add_video_support.ts created
 *   `video_media` with NO `_locales` child at all (the collection had no
 *   localized field then), so that table DOES NOT EXIST YET and must be created
 *   here — shape copied from `media_locales` in the initial schema: same column
 *   order (`alt`, `caption`, `id`, `_locale`, `_parent_id`), the same shared
 *   `"public"."_locales"` enum type, a cascading `_parent_id` FK, and the
 *   `(_locale, _parent_id)` unique index. Missing this table is exactly the
 *   class of defect that shipped once on this feature already.
 * - `credit` is NOT localized, so it is a plain `varchar` column on
 *   `video_media` — mirroring `media"."credit"`.
 *
 * `alt` is `required: true` in the collection, matching `media_locales.alt`'s
 * `NOT NULL`. That is safe for the table itself (it is brand new and empty) but
 * NOT free at the application layer: any `videoMedia` document uploaded before
 * this migration has no alt text, and Payload will reject the next save of it
 * until an editor fills the field in. Deliberately no `defaultValue` and no
 * backfill — a fabricated alt string is worse for a screen-reader user than a
 * visible validation error is for an editor.
 *
 * ORDERING IS LOAD-BEARING, same as the migration this composes with: the FK
 * and index statements REFERENCE `video_media_locales`, so they are split into
 * a second `db.execute` and must not be merged into the first block. Postgres
 * has no `ADD CONSTRAINT IF NOT EXISTS`, hence the
 * `DO $$ ... EXCEPTION WHEN duplicate_object` wrapper.
 *
 * Idempotent style mirrors 20260904_000000_dtw_dashboards_port.ts and
 * 20260910_000000_add_video_support.ts.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "video_media_locales" (
  	"alt" varchar NOT NULL,
  	"caption" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );

  ALTER TABLE "video_media" ADD COLUMN IF NOT EXISTS "credit" varchar;`)

  // Split out on purpose — see the ORDERING note above.
  await db.execute(sql`
  DO $$ BEGIN
   ALTER TABLE "video_media_locales" ADD CONSTRAINT "video_media_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."video_media"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE UNIQUE INDEX IF NOT EXISTS "video_media_locales_locale_parent_id_unique" ON "video_media_locales" USING btree ("_locale","_parent_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP INDEX IF EXISTS "video_media_locales_locale_parent_id_unique";

  ALTER TABLE "video_media_locales" DROP CONSTRAINT IF EXISTS "video_media_locales_parent_id_fk";

  DROP TABLE IF EXISTS "video_media_locales" CASCADE;

  ALTER TABLE "video_media" DROP COLUMN IF EXISTS "credit";`)
}
