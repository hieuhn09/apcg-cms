import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Absorbs dtw-web's local `aiModels` collection + `dashboardMethodology` global
 * into Central, so DailyTechWire's AI Leaderboard no longer needs a Payload
 * instance of its own (04-09-2026 "remove local Payload" pass).
 *
 * - `ai_leaderboard_rows` gains the nine columns `aiModels` had and Central did
 *   not, plus the `editorLocked` child table the cron's skip-list needs.
 * - `rank` loses NOT NULL: dtw-web's rank was optional (the reader falls back to
 *   row order), so an imported row without one must not be rejected.
 * - `tenants` gains the methodology/disclaimer copy, one blob per site.
 *
 * Additive only — nothing existing is dropped, so the seeded rows that predate
 * the port keep rendering.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "ai_leaderboard_rows_editor_locked" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" varchar
  );

  ALTER TABLE "ai_leaderboard_rows" ALTER COLUMN "rank" DROP NOT NULL;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "general" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "math" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "search" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "vision" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "input_price" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "output_price" numeric;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "released" timestamp(3) with time zone;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "source_slug_llmstats" varchar;
  ALTER TABLE "ai_leaderboard_rows" ADD COLUMN IF NOT EXISTS "as_of_scores" timestamp(3) with time zone;

  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_ai_methodology_en" varchar;
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_ai_methodology_vi" varchar;
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_ai_methodology_ind" varchar;
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_disclaimer_en" varchar;
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_disclaimer_vi" varchar;
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "dashboards_disclaimer_ind" varchar;`)

  // Split out: the FK/index statements must not run before the table exists in
  // the same batch on a re-run, and IF NOT EXISTS is unavailable for ADD CONSTRAINT.
  await db.execute(sql`
  DO $$ BEGIN
   ALTER TABLE "ai_leaderboard_rows_editor_locked" ADD CONSTRAINT "ai_leaderboard_rows_editor_locked_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."ai_leaderboard_rows"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE INDEX IF NOT EXISTS "ai_leaderboard_rows_editor_locked_order_idx" ON "ai_leaderboard_rows_editor_locked" USING btree ("_order");
  CREATE INDEX IF NOT EXISTS "ai_leaderboard_rows_editor_locked_parent_id_idx" ON "ai_leaderboard_rows_editor_locked" USING btree ("_parent_id");
  CREATE INDEX IF NOT EXISTS "ai_leaderboard_rows_source_slug_llmstats_idx" ON "ai_leaderboard_rows" USING btree ("source_slug_llmstats");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP TABLE IF EXISTS "ai_leaderboard_rows_editor_locked" CASCADE;
  DROP INDEX IF EXISTS "ai_leaderboard_rows_source_slug_llmstats_idx";

  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "general";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "math";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "search";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "vision";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "input_price";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "output_price";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "released";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "source_slug_llmstats";
  ALTER TABLE "ai_leaderboard_rows" DROP COLUMN IF EXISTS "as_of_scores";

  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_ai_methodology_en";
  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_ai_methodology_vi";
  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_ai_methodology_ind";
  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_disclaimer_en";
  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_disclaimer_vi";
  ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dashboards_disclaimer_ind";`)

  // `rank` was NOT NULL before this migration; restore it only if no row would
  // violate it, so a rollback cannot fail on data written since.
  await db.execute(sql`
  DO $$ BEGIN
   IF NOT EXISTS (SELECT 1 FROM "ai_leaderboard_rows" WHERE "rank" IS NULL) THEN
     ALTER TABLE "ai_leaderboard_rows" ALTER COLUMN "rank" SET NOT NULL;
   END IF;
  END $$;`)
}
