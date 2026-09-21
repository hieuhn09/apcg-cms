import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Optional short-video support for articles.
 *
 * - NEW `video_media` table: the `videoMedia` upload collection (video/* only,
 *   no imageSizes, so none of media's `sizes_*` columns and no `_locales`
 *   child table — it has no localized fields).
 * - `articles` / `_articles_v` gain `video_id` + three plain text columns.
 *   Additive and nullable throughout: every existing article stays valid, and
 *   no content is backfilled.
 * - `tenants` gains `features_video`. Tenants.features is a named Payload group
 *   field, so it flattens to real columns — the checkbox is NOT config-only.
 *   Defaults false, so no existing tenant gains the feature.
 * - `payload_locked_documents_rels` gains `video_media_id`, as every added
 *   collection must (see the `cities` precedent in 20260714_add_wtb_schema);
 *   without it admin document locking errors on the new collection.
 *
 * ORDERING IS LOAD-BEARING: `video_media` must exist before the articles /
 * _articles_v / payload_locked_documents_rels FKs that REFERENCE it. That is why
 * the FK + index statements are split into a second `db.execute` below — on a
 * re-run they must not be batched ahead of the CREATE TABLE. Do not merge these
 * two blocks. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, hence the
 * `DO $$ ... EXCEPTION WHEN duplicate_object` wrappers.
 *
 * Style mirrors 20260904_000000_dtw_dashboards_port.ts (idempotent), not the
 * older 20260824 flag migration.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "video_media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"prefix" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric
  );

  ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "video_id" integer;
  ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "video_caption" varchar;
  ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "video_credit" varchar;
  ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "video_description" varchar;

  ALTER TABLE "_articles_v" ADD COLUMN IF NOT EXISTS "version_video_id" integer;
  ALTER TABLE "_articles_v" ADD COLUMN IF NOT EXISTS "version_video_caption" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN IF NOT EXISTS "version_video_credit" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN IF NOT EXISTS "version_video_description" varchar;

  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "features_video" boolean DEFAULT false;

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "video_media_id" integer;`)

  // Split out on purpose — see the ORDERING note above.
  await db.execute(sql`
  DO $$ BEGIN
   ALTER TABLE "video_media" ADD CONSTRAINT "video_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "articles" ADD CONSTRAINT "articles_video_id_video_media_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video_media"("id") ON DELETE set null ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_video_id_video_media_id_fk" FOREIGN KEY ("version_video_id") REFERENCES "public"."video_media"("id") ON DELETE set null ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_video_media_fk" FOREIGN KEY ("video_media_id") REFERENCES "public"."video_media"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE INDEX IF NOT EXISTS "video_media_tenant_idx" ON "video_media" USING btree ("tenant_id");
  CREATE INDEX IF NOT EXISTS "video_media_prefix_idx" ON "video_media" USING btree ("prefix");
  CREATE INDEX IF NOT EXISTS "video_media_updated_at_idx" ON "video_media" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "video_media_created_at_idx" ON "video_media" USING btree ("created_at");
  CREATE UNIQUE INDEX IF NOT EXISTS "video_media_filename_idx" ON "video_media" USING btree ("filename");

  CREATE INDEX IF NOT EXISTS "articles_video_idx" ON "articles" USING btree ("video_id");
  CREATE INDEX IF NOT EXISTS "_articles_v_version_version_video_idx" ON "_articles_v" USING btree ("version_video_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_video_media_id_idx" ON "payload_locked_documents_rels" USING btree ("video_media_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP INDEX IF EXISTS "articles_video_idx";
  DROP INDEX IF EXISTS "_articles_v_version_version_video_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_video_media_id_idx";

  ALTER TABLE "articles" DROP CONSTRAINT IF EXISTS "articles_video_id_video_media_id_fk";
  ALTER TABLE "_articles_v" DROP CONSTRAINT IF EXISTS "_articles_v_version_video_id_video_media_id_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_video_media_fk";

  ALTER TABLE "articles" DROP COLUMN IF EXISTS "video_id";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "video_caption";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "video_credit";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "video_description";

  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_video_id";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_video_caption";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_video_credit";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_video_description";

  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "video_media_id";

  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "features_video";

  DROP TABLE IF EXISTS "video_media" CASCADE;`)
}
