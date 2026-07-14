import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_cities_region" AS ENUM('europe', 'asia', 'americas', 'africa-middle-east', 'oceania');
  CREATE TYPE "public"."enum_articles_tone" AS ENUM('up', 'dn', 'dl', 'flat');
  CREATE TYPE "public"."enum__articles_v_version_tone" AS ENUM('up', 'dn', 'dl', 'flat');
  ALTER TYPE "public"."enum_sponsor_slots_slot" ADD VALUE 'promo_card';
  CREATE TABLE "cities" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"region" "enum_cities_region",
  	"lat" numeric,
  	"lng" numeric,
  	"best_time" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "cities_locales" (
  	"name" varchar NOT NULL,
  	"country" varchar,
  	"blurb" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "articles_briefs" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"value" varchar,
  	"source" varchar
  );
  
  CREATE TABLE "_articles_v_version_briefs" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"value" varchar,
  	"source" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "sponsor_slots_locales" (
  	"headline" varchar,
  	"body" varchar,
  	"cta_label" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  ALTER TABLE "tenants" ADD COLUMN "features_cities_map" boolean DEFAULT false;
  ALTER TABLE "authors" ADD COLUMN "slug" varchar;
  ALTER TABLE "authors" ADD COLUMN "avatar_id" integer;
  ALTER TABLE "pillars_locales" ADD COLUMN "nav_label" varchar;
  ALTER TABLE "articles" ADD COLUMN "metric" varchar;
  ALTER TABLE "articles" ADD COLUMN "tone" "enum_articles_tone";
  ALTER TABLE "articles" ADD COLUMN "long_haul" boolean DEFAULT false;
  ALTER TABLE "articles" ADD COLUMN "views" numeric DEFAULT 0;
  ALTER TABLE "articles_locales" ADD COLUMN "lead_image_caption" varchar;
  ALTER TABLE "articles_rels" ADD COLUMN "cities_id" integer;
  ALTER TABLE "_articles_v" ADD COLUMN "version_metric" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_tone" "enum__articles_v_version_tone";
  ALTER TABLE "_articles_v" ADD COLUMN "version_long_haul" boolean DEFAULT false;
  ALTER TABLE "_articles_v" ADD COLUMN "version_views" numeric DEFAULT 0;
  ALTER TABLE "_articles_v_locales" ADD COLUMN "version_lead_image_caption" varchar;
  ALTER TABLE "_articles_v_rels" ADD COLUMN "cities_id" integer;
  ALTER TABLE "podcasts" ADD COLUMN "poster_id" integer;
  ALTER TABLE "podcasts_locales" ADD COLUMN "tag" varchar;
  ALTER TABLE "sponsor_slots" ADD COLUMN "name" varchar;
  ALTER TABLE "sponsor_slots" ADD COLUMN "cta_url" varchar;
  ALTER TABLE "sponsor_slots" ADD COLUMN "active" boolean DEFAULT false;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cities_id" integer;
  ALTER TABLE "cities" ADD CONSTRAINT "cities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cities_locales" ADD CONSTRAINT "cities_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_briefs" ADD CONSTRAINT "articles_briefs_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_version_briefs" ADD CONSTRAINT "_articles_v_version_briefs_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sponsor_slots_locales" ADD CONSTRAINT "sponsor_slots_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."sponsor_slots"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "cities_tenant_idx" ON "cities" USING btree ("tenant_id");
  CREATE INDEX "cities_slug_idx" ON "cities" USING btree ("slug");
  CREATE INDEX "cities_updated_at_idx" ON "cities" USING btree ("updated_at");
  CREATE INDEX "cities_created_at_idx" ON "cities" USING btree ("created_at");
  CREATE UNIQUE INDEX "cities_locales_locale_parent_id_unique" ON "cities_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "articles_briefs_order_idx" ON "articles_briefs" USING btree ("_order");
  CREATE INDEX "articles_briefs_parent_id_idx" ON "articles_briefs" USING btree ("_parent_id");
  CREATE INDEX "_articles_v_version_briefs_order_idx" ON "_articles_v_version_briefs" USING btree ("_order");
  CREATE INDEX "_articles_v_version_briefs_parent_id_idx" ON "_articles_v_version_briefs" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "sponsor_slots_locales_locale_parent_id_unique" ON "sponsor_slots_locales" USING btree ("_locale","_parent_id");
  ALTER TABLE "authors" ADD CONSTRAINT "authors_avatar_id_media_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_cities_fk" FOREIGN KEY ("cities_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_cities_fk" FOREIGN KEY ("cities_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_poster_id_media_id_fk" FOREIGN KEY ("poster_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cities_fk" FOREIGN KEY ("cities_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "authors_slug_idx" ON "authors" USING btree ("slug");
  CREATE INDEX "authors_avatar_idx" ON "authors" USING btree ("avatar_id");
  CREATE INDEX "articles_rels_cities_id_idx" ON "articles_rels" USING btree ("cities_id");
  CREATE INDEX "_articles_v_rels_cities_id_idx" ON "_articles_v_rels" USING btree ("cities_id");
  CREATE INDEX "podcasts_poster_idx" ON "podcasts" USING btree ("poster_id");
  CREATE INDEX "payload_locked_documents_rels_cities_id_idx" ON "payload_locked_documents_rels" USING btree ("cities_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "cities" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cities_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "articles_briefs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_articles_v_version_briefs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sponsor_slots_locales" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "cities" CASCADE;
  DROP TABLE "cities_locales" CASCADE;
  DROP TABLE "articles_briefs" CASCADE;
  DROP TABLE "_articles_v_version_briefs" CASCADE;
  DROP TABLE "sponsor_slots_locales" CASCADE;
  ALTER TABLE "authors" DROP CONSTRAINT "authors_avatar_id_media_id_fk";
  
  ALTER TABLE "articles_rels" DROP CONSTRAINT "articles_rels_cities_fk";
  
  ALTER TABLE "_articles_v_rels" DROP CONSTRAINT "_articles_v_rels_cities_fk";
  
  ALTER TABLE "podcasts" DROP CONSTRAINT "podcasts_poster_id_media_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cities_fk";
  
  ALTER TABLE "sponsor_slots" ALTER COLUMN "slot" SET DATA TYPE text;
  DROP TYPE "public"."enum_sponsor_slots_slot";
  CREATE TYPE "public"."enum_sponsor_slots_slot" AS ENUM('homepage_strip', 'dashboard_funding', 'dashboard_ai');
  ALTER TABLE "sponsor_slots" ALTER COLUMN "slot" SET DATA TYPE "public"."enum_sponsor_slots_slot" USING "slot"::"public"."enum_sponsor_slots_slot";
  DROP INDEX "authors_slug_idx";
  DROP INDEX "authors_avatar_idx";
  DROP INDEX "articles_rels_cities_id_idx";
  DROP INDEX "_articles_v_rels_cities_id_idx";
  DROP INDEX "podcasts_poster_idx";
  DROP INDEX "payload_locked_documents_rels_cities_id_idx";
  ALTER TABLE "tenants" DROP COLUMN "features_cities_map";
  ALTER TABLE "authors" DROP COLUMN "slug";
  ALTER TABLE "authors" DROP COLUMN "avatar_id";
  ALTER TABLE "pillars_locales" DROP COLUMN "nav_label";
  ALTER TABLE "articles" DROP COLUMN "metric";
  ALTER TABLE "articles" DROP COLUMN "tone";
  ALTER TABLE "articles" DROP COLUMN "long_haul";
  ALTER TABLE "articles" DROP COLUMN "views";
  ALTER TABLE "articles_locales" DROP COLUMN "lead_image_caption";
  ALTER TABLE "articles_rels" DROP COLUMN "cities_id";
  ALTER TABLE "_articles_v" DROP COLUMN "version_metric";
  ALTER TABLE "_articles_v" DROP COLUMN "version_tone";
  ALTER TABLE "_articles_v" DROP COLUMN "version_long_haul";
  ALTER TABLE "_articles_v" DROP COLUMN "version_views";
  ALTER TABLE "_articles_v_locales" DROP COLUMN "version_lead_image_caption";
  ALTER TABLE "_articles_v_rels" DROP COLUMN "cities_id";
  ALTER TABLE "podcasts" DROP COLUMN "poster_id";
  ALTER TABLE "podcasts_locales" DROP COLUMN "tag";
  ALTER TABLE "sponsor_slots" DROP COLUMN "name";
  ALTER TABLE "sponsor_slots" DROP COLUMN "cta_url";
  ALTER TABLE "sponsor_slots" DROP COLUMN "active";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cities_id";
  DROP TYPE "public"."enum_cities_region";
  DROP TYPE "public"."enum_articles_tone";
  DROP TYPE "public"."enum__articles_v_version_tone";`)
}
