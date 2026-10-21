import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Podcast series as a real, tenant-scoped collection (`podcastSeries`).
 *
 * - NEW `podcast_series` + `podcast_series_locales` (name required + localized,
 *   description optional + localized). DDL copied from the `newsletters`
 *   tables in 20260702_231336_initial_schema.
 * - `podcasts` gains a nullable `series_id` (optional relation). The free-text
 *   `show` column is untouched; no backfill.
 * - `payload_locked_documents_rels` gains `podcast_series_id`, as every added
 *   collection must (see the `video_media` precedent in 20260910).
 * - Slug uniqueness is per tenant: enforced by the `uniqueWithinTenant` hook
 *   AND a unique (tenant_id, slug) DB index, `podcast_series_tenant_slug_idx`,
 *   matching `newsletters_tenant_slug_idx` / `podcasts_tenant_slug_idx` from
 *   20260801_082303_migration_hardening.
 *
 * ORDERING IS LOAD-BEARING: the tables must exist before the FKs that
 * reference them, so FK + index statements live in a second `db.execute`.
 * Do not merge the two blocks. Idempotent throughout (IF NOT EXISTS /
 * `DO $$ ... EXCEPTION WHEN duplicate_object`).
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "podcast_series" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "podcast_series_locales" (
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );

  ALTER TABLE "podcasts" ADD COLUMN IF NOT EXISTS "series_id" integer;

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "podcast_series_id" integer;`)

  // Split out on purpose — see the ORDERING note above.
  await db.execute(sql`
  DO $$ BEGIN
   ALTER TABLE "podcast_series" ADD CONSTRAINT "podcast_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "podcast_series_locales" ADD CONSTRAINT "podcast_series_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."podcast_series"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_series_id_podcast_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."podcast_series"("id") ON DELETE set null ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
   ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_podcast_series_fk" FOREIGN KEY ("podcast_series_id") REFERENCES "public"."podcast_series"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE INDEX IF NOT EXISTS "podcast_series_tenant_idx" ON "podcast_series" USING btree ("tenant_id");
  CREATE INDEX IF NOT EXISTS "podcast_series_slug_idx" ON "podcast_series" USING btree ("slug");
  CREATE UNIQUE INDEX IF NOT EXISTS "podcast_series_tenant_slug_idx" ON "podcast_series" USING btree ("tenant_id","slug");
  CREATE INDEX IF NOT EXISTS "podcast_series_updated_at_idx" ON "podcast_series" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "podcast_series_created_at_idx" ON "podcast_series" USING btree ("created_at");
  CREATE UNIQUE INDEX IF NOT EXISTS "podcast_series_locales_locale_parent_id_unique" ON "podcast_series_locales" USING btree ("_locale","_parent_id");

  CREATE INDEX IF NOT EXISTS "podcasts_series_idx" ON "podcasts" USING btree ("series_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_podcast_series_id_idx" ON "payload_locked_documents_rels" USING btree ("podcast_series_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP INDEX IF EXISTS "podcasts_series_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_podcast_series_id_idx";
  DROP INDEX IF EXISTS "podcast_series_tenant_slug_idx";

  ALTER TABLE "podcasts" DROP CONSTRAINT IF EXISTS "podcasts_series_id_podcast_series_id_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_podcast_series_fk";

  ALTER TABLE "podcasts" DROP COLUMN IF EXISTS "series_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "podcast_series_id";

  DROP TABLE IF EXISTS "podcast_series_locales" CASCADE;
  DROP TABLE IF EXISTS "podcast_series" CASCADE;`)
}
