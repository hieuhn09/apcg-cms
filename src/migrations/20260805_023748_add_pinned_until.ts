import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_activity_log_event_type" ADD VALUE 'pin_expired';
  ALTER TABLE "articles" ADD COLUMN "pinned_until" timestamp(3) with time zone;
  ALTER TABLE "_articles_v" ADD COLUMN "version_pinned_until" timestamp(3) with time zone;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "activity_log" ALTER COLUMN "event_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_activity_log_event_type";
  CREATE TYPE "public"."enum_activity_log_event_type" AS ENUM('article_created', 'article_published', 'article_unpublished', 'article_archived', 'status_changed', 'human_edit', 'engine_write_accepted', 'engine_write_skipped', 'conflict_logged', 'translation_queued', 'translation_completed', 'translation_failed', 'engine_auth_failed', 'engine_tenant_denied', 'engine_action_denied', 'media_uploaded', 'membership_changed', 'integration_error');
  ALTER TABLE "activity_log" ALTER COLUMN "event_type" SET DATA TYPE "public"."enum_activity_log_event_type" USING "event_type"::"public"."enum_activity_log_event_type";
  ALTER TABLE "articles" DROP COLUMN "pinned_until";
  ALTER TABLE "_articles_v" DROP COLUMN "version_pinned_until";`)
}
