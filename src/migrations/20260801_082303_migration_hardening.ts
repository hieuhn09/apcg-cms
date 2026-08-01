/**
 * Multi-tenant hardening, required BEFORE the first real tenant import.
 *
 * Two halves:
 *  1. Config-derived (generated): the `subscribers` collection, the per-tenant
 *     `media.prefix` used as the R2 key prefix, `tenants.auto_publish_engine_drafts`,
 *     and `authors.rank` (WTB masthead order, feedback round 2 m15).
 *  2. Hand-written (below the marker): uniqueness that Payload's field config
 *     cannot express — every one of these is a latent data-corruption bug in a
 *     multi-tenant database:
 *       - `media.filename` was UNIQUE GLOBALLY. The engine names hero files
 *         `<slug>.<ext>`, and one source story pushed to two publications yields
 *         the same slug, so tenant #2's upload silently became `foo-1.jpg` — the
 *         R2 key then no longer matches what copy-media pre-copied.
 *       - slug had only a plain index, so nothing at the DB level stopped two
 *         rows in the SAME tenant from sharing a slug. The application hook
 *         (src/hooks/unique-within-tenant.ts) closes the common case but not the
 *         race; these indexes are the real constraint the hook's comment promises.
 *
 * If this migration fails on a duplicate, that is the point — it means real
 * duplicate data exists and must be reconciled before the import, not after.
 */
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_subscribers_status" AS ENUM('subscribed', 'unsubscribed');
  CREATE TABLE "subscribers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"email" varchar NOT NULL,
  	"status" "enum_subscribers_status" DEFAULT 'subscribed' NOT NULL,
  	"token" varchar,
  	"locale" varchar,
  	"subscribed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "subscribers_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"newsletters_id" integer
  );
  
  ALTER TABLE "tenants" ADD COLUMN "auto_publish_engine_drafts" boolean DEFAULT false;
  ALTER TABLE "media" ADD COLUMN "prefix" varchar;
  ALTER TABLE "authors" ADD COLUMN "rank" numeric;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "subscribers_id" integer;
  ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscribers_rels" ADD CONSTRAINT "subscribers_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscribers_rels" ADD CONSTRAINT "subscribers_rels_newsletters_fk" FOREIGN KEY ("newsletters_id") REFERENCES "public"."newsletters"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "subscribers_tenant_idx" ON "subscribers" USING btree ("tenant_id");
  CREATE INDEX "subscribers_email_idx" ON "subscribers" USING btree ("email");
  CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");
  CREATE INDEX "subscribers_token_idx" ON "subscribers" USING btree ("token");
  CREATE INDEX "subscribers_updated_at_idx" ON "subscribers" USING btree ("updated_at");
  CREATE INDEX "subscribers_created_at_idx" ON "subscribers" USING btree ("created_at");
  CREATE INDEX "subscribers_rels_order_idx" ON "subscribers_rels" USING btree ("order");
  CREATE INDEX "subscribers_rels_parent_idx" ON "subscribers_rels" USING btree ("parent_id");
  CREATE INDEX "subscribers_rels_path_idx" ON "subscribers_rels" USING btree ("path");
  CREATE INDEX "subscribers_rels_newsletters_id_idx" ON "subscribers_rels" USING btree ("newsletters_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscribers_fk" FOREIGN KEY ("subscribers_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "media_prefix_idx" ON "media" USING btree ("prefix");
  CREATE INDEX "authors_rank_idx" ON "authors" USING btree ("rank");
  CREATE INDEX "payload_locked_documents_rels_subscribers_id_idx" ON "payload_locked_documents_rels" USING btree ("subscribers_id");`)

  // ── Hand-written below this line: tenant-scoped uniqueness ───────────────────
  // Not generated from the Payload config — migrate:create cannot emit these, so
  // re-generating a later migration will NOT recreate them. Keep them.
  await db.execute(sql`
  DROP INDEX IF EXISTS "media_filename_idx";
  CREATE UNIQUE INDEX "media_tenant_filename_idx" ON "media" USING btree ("tenant_id","filename");

  -- NOTE: "articles" is deliberately absent. Its slug is a LOCALIZED field, so it
  -- lives in "articles_locales" while tenant_id lives on "articles" — a composite
  -- unique across the two tables is not expressible as an index, and adding a
  -- denormalized tenant_id to the locales table would not be maintained by Payload.
  -- Article slugs therefore stay enforced by uniqueWithinTenant() in
  -- src/collections/Articles.ts alone. Documented as a known gap in docs/11-operations.md.
  CREATE UNIQUE INDEX "pillars_tenant_slug_idx" ON "pillars" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tags_tenant_slug_idx" ON "tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "sectors_tenant_slug_idx" ON "sectors" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "authors_tenant_slug_idx" ON "authors" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "cities_tenant_slug_idx" ON "cities" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "newsletters_tenant_slug_idx" ON "newsletters" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "podcasts_tenant_slug_idx" ON "podcasts" USING btree ("tenant_id","slug");
  -- Sub-sections are unique per (tenant, pillar, slug): two pillars may each own a
  -- "trends" child. Mirrors uniqueWithinTenant("slug", ["pillar"]) in SubSections.ts.
  CREATE UNIQUE INDEX "subsections_tenant_pillar_slug_idx" ON "subsections" USING btree ("tenant_id","pillar_id","slug");
  -- One opt-in per address per publication; the same person may subscribe to two.
  CREATE UNIQUE INDEX "subscribers_tenant_email_idx" ON "subscribers" USING btree ("tenant_id","email");
  -- Masthead order: one author per rank per publication. NULL rank = not on the
  -- masthead, and Postgres allows many NULLs under a unique index, which is what
  -- every engine-created byline relies on.
  CREATE UNIQUE INDEX "authors_tenant_rank_idx" ON "authors" USING btree ("tenant_id","rank");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Reverse of the hand-written half — restore the global filename unique first,
  // otherwise a re-run of `up` would find the old index already gone AND the new
  // one still present.
  await db.execute(sql`
  DROP INDEX IF EXISTS "authors_tenant_rank_idx";
  DROP INDEX IF EXISTS "subscribers_tenant_email_idx";
  DROP INDEX IF EXISTS "subsections_tenant_pillar_slug_idx";
  DROP INDEX IF EXISTS "podcasts_tenant_slug_idx";
  DROP INDEX IF EXISTS "newsletters_tenant_slug_idx";
  DROP INDEX IF EXISTS "cities_tenant_slug_idx";
  DROP INDEX IF EXISTS "authors_tenant_slug_idx";
  DROP INDEX IF EXISTS "sectors_tenant_slug_idx";
  DROP INDEX IF EXISTS "tags_tenant_slug_idx";
  DROP INDEX IF EXISTS "pillars_tenant_slug_idx";
  DROP INDEX IF EXISTS "media_tenant_filename_idx";
  CREATE UNIQUE INDEX IF NOT EXISTS "media_filename_idx" ON "media" USING btree ("filename");`)

  await db.execute(sql`
   ALTER TABLE "subscribers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscribers_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "subscribers" CASCADE;
  DROP TABLE "subscribers_rels" CASCADE;
  -- IF EXISTS added by hand: the generated SQL drops this constraint AFTER the
  -- CASCADE above has already removed it, which aborts the whole rollback. Same
  -- for the indexes below. Without this, migrate:down is unusable — and down IS
  -- the rollback lever the cutover plan depends on.
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_subscribers_fk";

  DROP INDEX IF EXISTS "media_prefix_idx";
  DROP INDEX IF EXISTS "authors_rank_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_subscribers_id_idx";
  ALTER TABLE "tenants" DROP COLUMN "auto_publish_engine_drafts";
  ALTER TABLE "media" DROP COLUMN "prefix";
  ALTER TABLE "authors" DROP COLUMN "rank";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "subscribers_id";
  DROP TYPE "public"."enum_subscribers_status";`)
}
