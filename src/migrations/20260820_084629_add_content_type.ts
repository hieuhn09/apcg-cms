import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `articles.content_type` — WHAT a document is, next to `origin`'s WHO wrote it.
 * Only the engine's daily brief is marked; every existing row is an article.
 *
 * The NOT NULL on `articles` is deliberate and is NOT what Payload's adapter
 * emits on its own (see `origin`: required in the config, still nullable in the
 * schema). Postgres fills the default in place, so `ADD COLUMN … DEFAULT …
 * NOT NULL` rewrites nothing on the ~2.5k existing rows — and it means readers
 * can filter with a plain `equals` instead of guarding for null. The snapshot
 * keeps Payload's own `notNull: false` so the next `migrate:create` sees no
 * drift and never diffs the constraint back off.
 *
 * The version table stays nullable to match how Payload treats every other
 * versioned column; the UPDATE backfills the rows that already exist there.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_articles_content_type" AS ENUM('article', 'daily-brief');
  CREATE TYPE "public"."enum__articles_v_version_content_type" AS ENUM('article', 'daily-brief');
  ALTER TABLE "articles" ADD COLUMN "content_type" "enum_articles_content_type" DEFAULT 'article' NOT NULL;
  ALTER TABLE "_articles_v" ADD COLUMN "version_content_type" "enum__articles_v_version_content_type" DEFAULT 'article';
  UPDATE "_articles_v" SET "version_content_type" = 'article' WHERE "version_content_type" IS NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" DROP COLUMN "content_type";
  ALTER TABLE "_articles_v" DROP COLUMN "version_content_type";
  DROP TYPE "public"."enum_articles_content_type";
  DROP TYPE "public"."enum__articles_v_version_content_type";`)
}
