import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" ADD COLUMN "exclusive" boolean DEFAULT false;
  ALTER TABLE "_articles_v" ADD COLUMN "version_exclusive" boolean DEFAULT false;
  CREATE INDEX "articles_exclusive_idx" ON "articles" USING btree ("exclusive");
  CREATE INDEX "_articles_v_version_version_exclusive_idx" ON "_articles_v" USING btree ("version_exclusive");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "articles_exclusive_idx";
  DROP INDEX "_articles_v_version_version_exclusive_idx";
  ALTER TABLE "articles" DROP COLUMN "exclusive";
  ALTER TABLE "_articles_v" DROP COLUMN "version_exclusive";`)
}
