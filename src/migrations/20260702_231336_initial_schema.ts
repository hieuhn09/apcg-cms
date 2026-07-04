import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."_locales" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_tenants_supported_languages" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_tenants_read_tokens_status" AS ENUM('active', 'revoked');
  CREATE TYPE "public"."enum_tenants_status" AS ENUM('active', 'suspended', 'archived');
  CREATE TYPE "public"."enum_tenants_default_language" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_users_tenants_roles" AS ENUM('websiteAdmin', 'editor', 'contributor');
  CREATE TYPE "public"."enum_users_role" AS ENUM('systemAdmin', 'standard');
  CREATE TYPE "public"."enum_countries_region" AS ENUM('southeast-asia', 'east-asia', 'south-asia');
  CREATE TYPE "public"."enum_content_engines_allowed_actions" AS ENUM('create_article', 'update_article', 'create_translation', 'update_translation', 'upload_media', 'create_podcast', 'update_market_data', 'import');
  CREATE TYPE "public"."enum_content_engines_engine_type" AS ENUM('crawler', 'writer', 'translator', 'finance', 'podcast', 'importer', 'other');
  CREATE TYPE "public"."enum_content_engines_status" AS ENUM('active', 'suspended', 'revoked');
  CREATE TYPE "public"."enum_activity_log_event_type" AS ENUM('article_created', 'article_published', 'article_unpublished', 'article_archived', 'status_changed', 'human_edit', 'engine_write_accepted', 'engine_write_skipped', 'conflict_logged', 'translation_queued', 'translation_completed', 'translation_failed', 'engine_auth_failed', 'engine_tenant_denied', 'engine_action_denied', 'media_uploaded', 'membership_changed', 'integration_error');
  CREATE TYPE "public"."enum_activity_log_actor_type" AS ENUM('human', 'engine', 'system');
  CREATE TYPE "public"."enum_articles_translation_status_locale" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_articles_translation_status_state" AS ENUM('none', 'pending', 'translating', 'machine_translated', 'needs_review', 'approved', 'locked', 'outdated', 'failed');
  CREATE TYPE "public"."enum_articles_workflow_status" AS ENUM('draft', 'pending_review', 'approved', 'scheduled', 'published', 'hidden', 'archived');
  CREATE TYPE "public"."enum_articles_origin" AS ENUM('engine', 'manual', 'import');
  CREATE TYPE "public"."enum_articles_source_language" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_articles_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__articles_v_version_translation_status_locale" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum__articles_v_version_translation_status_state" AS ENUM('none', 'pending', 'translating', 'machine_translated', 'needs_review', 'approved', 'locked', 'outdated', 'failed');
  CREATE TYPE "public"."enum__articles_v_version_workflow_status" AS ENUM('draft', 'pending_review', 'approved', 'scheduled', 'published', 'hidden', 'archived');
  CREATE TYPE "public"."enum__articles_v_version_origin" AS ENUM('engine', 'manual', 'import');
  CREATE TYPE "public"."enum__articles_v_version_source_language" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum__articles_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__articles_v_published_locale" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_sponsor_slots_slot" AS ENUM('homepage_strip', 'dashboard_funding', 'dashboard_ai');
  CREATE TYPE "public"."enum_menus_type" AS ENUM('header', 'footer');
  CREATE TYPE "public"."enum_engine_conflict_log_reason" AS ENUM('locked', 'human_edited', 'version_mismatch');
  CREATE TYPE "public"."enum_translation_jobs_source_locale" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_translation_jobs_target_locale" AS ENUM('en', 'vi', 'ko', 'ja', 'zh-hans', 'zh-hant', 'th', 'id', 'ms', 'tl', 'hi', 'bn', 'ta', 'si', 'km', 'my', 'ar', 'fr', 'es', 'de');
  CREATE TYPE "public"."enum_translation_jobs_status" AS ENUM('queued', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled');
  CREATE TABLE "tenants_additional_domains" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"domain" varchar
  );
  
  CREATE TABLE "tenants_supported_languages" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_tenants_supported_languages",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "tenants_socials" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"platform" varchar,
  	"url" varchar
  );
  
  CREATE TABLE "tenants_read_tokens" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"token_hash" varchar NOT NULL,
  	"token_prefix" varchar,
  	"status" "enum_tenants_read_tokens_status" DEFAULT 'active'
  );
  
  CREATE TABLE "tenants" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"status" "enum_tenants_status" DEFAULT 'active' NOT NULL,
  	"domain" varchar,
  	"frontend_url" varchar,
  	"logo_id" integer,
  	"brand_color" varchar,
  	"brand_favicon_url" varchar,
  	"brand_og_image_default_id" integer,
  	"brand_theme_tokens" jsonb,
  	"default_language" "enum_tenants_default_language" DEFAULT 'en' NOT NULL,
  	"timezone" varchar DEFAULT 'Asia/Singapore',
  	"seo_title_suffix" varchar,
  	"seo_default_og_image_id" integer,
  	"seo_twitter_handle" varchar,
  	"contact_general_email" varchar,
  	"contact_editorial_email" varchar,
  	"contact_advertising_email" varchar,
  	"contact_partnerships_email" varchar,
  	"features_articles" boolean DEFAULT true,
  	"features_newsletters" boolean DEFAULT false,
  	"features_podcasts" boolean DEFAULT false,
  	"features_market_data" boolean DEFAULT false,
  	"features_sponsor_slots" boolean DEFAULT false,
  	"features_wire_drops" boolean DEFAULT false,
  	"features_corrections" boolean DEFAULT true,
  	"features_translations" boolean DEFAULT true,
  	"features_dashboards" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "tenants_locales" (
  	"seo_default_meta_description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "tenants_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"content_engines_id" integer
  );
  
  CREATE TABLE "users_tenants_roles" (
  	"order" integer NOT NULL,
  	"parent_id" varchar NOT NULL,
  	"value" "enum_users_tenants_roles",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "users_tenants" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"tenant_id" integer NOT NULL,
  	"can_publish" boolean DEFAULT false
  );
  
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"role" "enum_users_role" DEFAULT 'standard' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "countries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"slug" varchar NOT NULL,
  	"code" varchar NOT NULL,
  	"region" "enum_countries_region",
  	"order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "countries_locales" (
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "content_engines_allowed_actions" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_content_engines_allowed_actions",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "content_engines" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"engine_type" "enum_content_engines_engine_type" DEFAULT 'writer' NOT NULL,
  	"status" "enum_content_engines_status" DEFAULT 'active' NOT NULL,
  	"token_hash" varchar,
  	"token_prefix" varchar,
  	"rate_limit_per_min" numeric,
  	"last_seen_at" timestamp(3) with time zone,
  	"last_seen_ip" varchar,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "content_engines_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tenants_id" integer
  );
  
  CREATE TABLE "activity_log" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_type" "enum_activity_log_event_type" NOT NULL,
  	"tenant_id" integer,
  	"actor_type" "enum_activity_log_actor_type" NOT NULL,
  	"actor_user_id" integer,
  	"actor_engine_id" integer,
  	"target_collection" varchar,
  	"target_id" varchar,
  	"from_status" varchar,
  	"to_status" varchar,
  	"detail" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"credit" varchar,
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
  	"focal_y" numeric,
  	"sizes_thumbnail_url" varchar,
  	"sizes_thumbnail_width" numeric,
  	"sizes_thumbnail_height" numeric,
  	"sizes_thumbnail_mime_type" varchar,
  	"sizes_thumbnail_filesize" numeric,
  	"sizes_thumbnail_filename" varchar,
  	"sizes_card_url" varchar,
  	"sizes_card_width" numeric,
  	"sizes_card_height" numeric,
  	"sizes_card_mime_type" varchar,
  	"sizes_card_filesize" numeric,
  	"sizes_card_filename" varchar,
  	"sizes_hero_url" varchar,
  	"sizes_hero_width" numeric,
  	"sizes_hero_height" numeric,
  	"sizes_hero_mime_type" varchar,
  	"sizes_hero_filesize" numeric,
  	"sizes_hero_filename" varchar
  );
  
  CREATE TABLE "media_locales" (
  	"alt" varchar NOT NULL,
  	"caption" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "authors" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"name" varchar NOT NULL,
  	"role" varchar,
  	"city" varchar,
  	"user_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "authors_locales" (
  	"bio" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "pillars" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"color" varchar,
  	"icon" varchar,
  	"order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "pillars_locales" (
  	"title" varchar NOT NULL,
  	"heading" varchar,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "subsections" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"pillar_id" integer NOT NULL,
  	"order" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "subsections_locales" (
  	"title" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "sectors" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sectors_locales" (
  	"title" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "tags" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "tags_locales" (
  	"title" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "articles_secondary_sections" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"pillar_id" integer,
  	"sub_section_id" integer
  );
  
  CREATE TABLE "articles_locked_fields" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" varchar
  );
  
  CREATE TABLE "articles_translation_status" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"locale" "enum_articles_translation_status_locale",
  	"state" "enum_articles_translation_status_state" DEFAULT 'none',
  	"engine_id" integer,
  	"source_version_at_translation" numeric,
  	"updated_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "articles" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"section" varchar,
  	"takeaways" varchar,
  	"read_min" numeric DEFAULT 5,
  	"workflow_status" "enum_articles_workflow_status" DEFAULT 'draft',
  	"published_at" timestamp(3) with time zone,
  	"scheduled_for" timestamp(3) with time zone,
  	"assigned_to_id" integer,
  	"last_edited_by_id" integer,
  	"pillar_id" integer,
  	"sub_section_id" integer,
  	"country_id" integer,
  	"author_id" integer,
  	"ai_assisted" boolean DEFAULT false,
  	"sponsored" boolean DEFAULT false,
  	"sponsor" varchar,
  	"affiliate" boolean DEFAULT false,
  	"deep_dive" boolean DEFAULT false,
  	"pinned_to_latest" boolean DEFAULT false,
  	"breaking" boolean DEFAULT false,
  	"translation_assisted" boolean DEFAULT false,
  	"origin" "enum_articles_origin" DEFAULT 'manual',
  	"edited_by_human" boolean DEFAULT true,
  	"version" numeric DEFAULT 1,
  	"engine_draft_id" varchar,
  	"engine_source_url" varchar,
  	"engine_source_name" varchar,
  	"engine_source_context" varchar,
  	"last_engine_id" integer,
  	"processing_version" varchar,
  	"source_language" "enum_articles_source_language" DEFAULT 'en',
  	"hero_image_id" integer,
  	"image_url" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_articles_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "articles_locales" (
  	"title" varchar,
  	"slug" varchar,
  	"dek" varchar,
  	"body" jsonb,
  	"image_label" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "articles_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"countries_id" integer,
  	"tags_id" integer,
  	"sectors_id" integer,
  	"authors_id" integer
  );
  
  CREATE TABLE "_articles_v_version_secondary_sections" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"pillar_id" integer,
  	"sub_section_id" integer,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_articles_v_version_locked_fields" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"field" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_articles_v_version_translation_status" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"locale" "enum__articles_v_version_translation_status_locale",
  	"state" "enum__articles_v_version_translation_status_state" DEFAULT 'none',
  	"engine_id" integer,
  	"source_version_at_translation" numeric,
  	"updated_at" timestamp(3) with time zone,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_articles_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_tenant_id" integer,
  	"version_section" varchar,
  	"version_takeaways" varchar,
  	"version_read_min" numeric DEFAULT 5,
  	"version_workflow_status" "enum__articles_v_version_workflow_status" DEFAULT 'draft',
  	"version_published_at" timestamp(3) with time zone,
  	"version_scheduled_for" timestamp(3) with time zone,
  	"version_assigned_to_id" integer,
  	"version_last_edited_by_id" integer,
  	"version_pillar_id" integer,
  	"version_sub_section_id" integer,
  	"version_country_id" integer,
  	"version_author_id" integer,
  	"version_ai_assisted" boolean DEFAULT false,
  	"version_sponsored" boolean DEFAULT false,
  	"version_sponsor" varchar,
  	"version_affiliate" boolean DEFAULT false,
  	"version_deep_dive" boolean DEFAULT false,
  	"version_pinned_to_latest" boolean DEFAULT false,
  	"version_breaking" boolean DEFAULT false,
  	"version_translation_assisted" boolean DEFAULT false,
  	"version_origin" "enum__articles_v_version_origin" DEFAULT 'manual',
  	"version_edited_by_human" boolean DEFAULT true,
  	"version_version" numeric DEFAULT 1,
  	"version_engine_draft_id" varchar,
  	"version_engine_source_url" varchar,
  	"version_engine_source_name" varchar,
  	"version_engine_source_context" varchar,
  	"version_last_engine_id" integer,
  	"version_processing_version" varchar,
  	"version_source_language" "enum__articles_v_version_source_language" DEFAULT 'en',
  	"version_hero_image_id" integer,
  	"version_image_url" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__articles_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"snapshot" boolean,
  	"published_locale" "enum__articles_v_published_locale",
  	"latest" boolean
  );
  
  CREATE TABLE "_articles_v_locales" (
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_dek" varchar,
  	"version_body" jsonb,
  	"version_image_label" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "_articles_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"countries_id" integer,
  	"tags_id" integer,
  	"sectors_id" integer,
  	"authors_id" integer
  );
  
  CREATE TABLE "newsletters" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"cadence" varchar,
  	"vertical_id" integer,
  	"subscribers" varchar,
  	"active" boolean DEFAULT true,
  	"order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "newsletters_locales" (
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "podcasts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"show" varchar,
  	"episode" varchar,
  	"slug" varchar NOT NULL,
  	"duration" varchar,
  	"host" varchar,
  	"audio_url" varchar,
  	"published_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "podcasts_locales" (
  	"title" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "corrections" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"article_id" integer NOT NULL,
  	"correction_date" timestamp(3) with time zone,
  	"editor_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "corrections_locales" (
  	"summary" varchar NOT NULL,
  	"was_text" varchar,
  	"now_text" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "sponsor_slots" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slot" "enum_sponsor_slots_slot" NOT NULL,
  	"article_id" integer,
  	"starts_at" timestamp(3) with time zone,
  	"ends_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "market_snapshots" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"order" numeric DEFAULT 0,
  	"country" varchar,
  	"market" varchar NOT NULL,
  	"value" varchar,
  	"change_pct" numeric,
  	"summary" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "fx_rates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"order" numeric DEFAULT 0,
  	"pair" varchar NOT NULL,
  	"value" varchar,
  	"change_pct" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "funding_rows" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"order" numeric DEFAULT 0,
  	"ticker" varchar NOT NULL,
  	"name" varchar NOT NULL,
  	"country" varchar,
  	"sector" varchar,
  	"px" numeric,
  	"chg" numeric,
  	"mcap" varchar,
  	"funding" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ai_leaderboard_rows" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"rank" numeric NOT NULL,
  	"model" varchar NOT NULL,
  	"maker" varchar,
  	"reasoning" numeric,
  	"coding" numeric,
  	"speed" numeric,
  	"price" numeric,
  	"ctx" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "trending_blocks" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"term" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "wire_drops" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"time" varchar,
  	"city" varchar,
  	"published_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "wire_drops_locales" (
  	"text" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "menus_items_children" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"href" varchar NOT NULL
  );
  
  CREATE TABLE "menus_items_children_locales" (
  	"label" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" varchar NOT NULL
  );
  
  CREATE TABLE "menus_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"href" varchar NOT NULL
  );
  
  CREATE TABLE "menus_items_locales" (
  	"label" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" varchar NOT NULL
  );
  
  CREATE TABLE "menus" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"type" "enum_menus_type" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "engine_conflict_log" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"article_id" integer NOT NULL,
  	"engine_id" integer,
  	"field" varchar NOT NULL,
  	"engine_value" jsonb,
  	"current_value" jsonb,
  	"reason" "enum_engine_conflict_log_reason" NOT NULL,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "translation_jobs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"article_id" integer NOT NULL,
  	"source_locale" "enum_translation_jobs_source_locale" NOT NULL,
  	"target_locale" "enum_translation_jobs_target_locale" NOT NULL,
  	"status" "enum_translation_jobs_status" DEFAULT 'queued' NOT NULL,
  	"engine_id" integer,
  	"attempts" numeric DEFAULT 0,
  	"last_error" varchar,
  	"source_version" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tenants_id" integer,
  	"users_id" integer,
  	"countries_id" integer,
  	"content_engines_id" integer,
  	"activity_log_id" integer,
  	"media_id" integer,
  	"authors_id" integer,
  	"pillars_id" integer,
  	"subsections_id" integer,
  	"sectors_id" integer,
  	"tags_id" integer,
  	"articles_id" integer,
  	"newsletters_id" integer,
  	"podcasts_id" integer,
  	"corrections_id" integer,
  	"sponsor_slots_id" integer,
  	"market_snapshots_id" integer,
  	"fx_rates_id" integer,
  	"funding_rows_id" integer,
  	"ai_leaderboard_rows_id" integer,
  	"trending_blocks_id" integer,
  	"wire_drops_id" integer,
  	"menus_id" integer,
  	"engine_conflict_log_id" integer,
  	"translation_jobs_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "tenants_additional_domains" ADD CONSTRAINT "tenants_additional_domains_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_supported_languages" ADD CONSTRAINT "tenants_supported_languages_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_socials" ADD CONSTRAINT "tenants_socials_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_read_tokens" ADD CONSTRAINT "tenants_read_tokens_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants" ADD CONSTRAINT "tenants_logo_id_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tenants" ADD CONSTRAINT "tenants_brand_og_image_default_id_media_id_fk" FOREIGN KEY ("brand_og_image_default_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tenants" ADD CONSTRAINT "tenants_seo_default_og_image_id_media_id_fk" FOREIGN KEY ("seo_default_og_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tenants_locales" ADD CONSTRAINT "tenants_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_rels" ADD CONSTRAINT "tenants_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_rels" ADD CONSTRAINT "tenants_rels_content_engines_fk" FOREIGN KEY ("content_engines_id") REFERENCES "public"."content_engines"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "users_tenants_roles" ADD CONSTRAINT "users_tenants_roles_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."users_tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "users_tenants" ADD CONSTRAINT "users_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_tenants" ADD CONSTRAINT "users_tenants_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "countries_locales" ADD CONSTRAINT "countries_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "content_engines_allowed_actions" ADD CONSTRAINT "content_engines_allowed_actions_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."content_engines"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "content_engines_rels" ADD CONSTRAINT "content_engines_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."content_engines"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "content_engines_rels" ADD CONSTRAINT "content_engines_rels_tenants_fk" FOREIGN KEY ("tenants_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_engine_id_content_engines_id_fk" FOREIGN KEY ("actor_engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "media_locales" ADD CONSTRAINT "media_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "authors" ADD CONSTRAINT "authors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "authors" ADD CONSTRAINT "authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "authors_locales" ADD CONSTRAINT "authors_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pillars" ADD CONSTRAINT "pillars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pillars_locales" ADD CONSTRAINT "pillars_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subsections" ADD CONSTRAINT "subsections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subsections" ADD CONSTRAINT "subsections_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subsections_locales" ADD CONSTRAINT "subsections_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."subsections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sectors" ADD CONSTRAINT "sectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sectors_locales" ADD CONSTRAINT "sectors_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tags_locales" ADD CONSTRAINT "tags_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_secondary_sections" ADD CONSTRAINT "articles_secondary_sections_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles_secondary_sections" ADD CONSTRAINT "articles_secondary_sections_sub_section_id_subsections_id_fk" FOREIGN KEY ("sub_section_id") REFERENCES "public"."subsections"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles_secondary_sections" ADD CONSTRAINT "articles_secondary_sections_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_locked_fields" ADD CONSTRAINT "articles_locked_fields_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_translation_status" ADD CONSTRAINT "articles_translation_status_engine_id_content_engines_id_fk" FOREIGN KEY ("engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles_translation_status" ADD CONSTRAINT "articles_translation_status_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_last_edited_by_id_users_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_sub_section_id_subsections_id_fk" FOREIGN KEY ("sub_section_id") REFERENCES "public"."subsections"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_last_engine_id_content_engines_id_fk" FOREIGN KEY ("last_engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_hero_image_id_media_id_fk" FOREIGN KEY ("hero_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles_locales" ADD CONSTRAINT "articles_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_countries_fk" FOREIGN KEY ("countries_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_sectors_fk" FOREIGN KEY ("sectors_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_authors_fk" FOREIGN KEY ("authors_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_version_secondary_sections" ADD CONSTRAINT "_articles_v_version_secondary_sections_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v_version_secondary_sections" ADD CONSTRAINT "_articles_v_version_secondary_sections_sub_section_id_subsections_id_fk" FOREIGN KEY ("sub_section_id") REFERENCES "public"."subsections"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v_version_secondary_sections" ADD CONSTRAINT "_articles_v_version_secondary_sections_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_version_locked_fields" ADD CONSTRAINT "_articles_v_version_locked_fields_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_version_translation_status" ADD CONSTRAINT "_articles_v_version_translation_status_engine_id_content_engines_id_fk" FOREIGN KEY ("engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v_version_translation_status" ADD CONSTRAINT "_articles_v_version_translation_status_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_parent_id_articles_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_tenant_id_tenants_id_fk" FOREIGN KEY ("version_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_assigned_to_id_users_id_fk" FOREIGN KEY ("version_assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_last_edited_by_id_users_id_fk" FOREIGN KEY ("version_last_edited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_pillar_id_pillars_id_fk" FOREIGN KEY ("version_pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_sub_section_id_subsections_id_fk" FOREIGN KEY ("version_sub_section_id") REFERENCES "public"."subsections"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_country_id_countries_id_fk" FOREIGN KEY ("version_country_id") REFERENCES "public"."countries"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_author_id_authors_id_fk" FOREIGN KEY ("version_author_id") REFERENCES "public"."authors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_last_engine_id_content_engines_id_fk" FOREIGN KEY ("version_last_engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_hero_image_id_media_id_fk" FOREIGN KEY ("version_hero_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v_locales" ADD CONSTRAINT "_articles_v_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_countries_fk" FOREIGN KEY ("countries_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_sectors_fk" FOREIGN KEY ("sectors_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_authors_fk" FOREIGN KEY ("authors_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_vertical_id_pillars_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "newsletters_locales" ADD CONSTRAINT "newsletters_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."newsletters"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "podcasts_locales" ADD CONSTRAINT "podcasts_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "corrections" ADD CONSTRAINT "corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "corrections" ADD CONSTRAINT "corrections_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "corrections" ADD CONSTRAINT "corrections_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "corrections_locales" ADD CONSTRAINT "corrections_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."corrections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sponsor_slots" ADD CONSTRAINT "sponsor_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sponsor_slots" ADD CONSTRAINT "sponsor_slots_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "funding_rows" ADD CONSTRAINT "funding_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ai_leaderboard_rows" ADD CONSTRAINT "ai_leaderboard_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "trending_blocks" ADD CONSTRAINT "trending_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wire_drops" ADD CONSTRAINT "wire_drops_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wire_drops_locales" ADD CONSTRAINT "wire_drops_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."wire_drops"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "menus_items_children" ADD CONSTRAINT "menus_items_children_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."menus_items"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "menus_items_children_locales" ADD CONSTRAINT "menus_items_children_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."menus_items_children"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "menus_items" ADD CONSTRAINT "menus_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "menus_items_locales" ADD CONSTRAINT "menus_items_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."menus_items"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "menus" ADD CONSTRAINT "menus_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "engine_conflict_log" ADD CONSTRAINT "engine_conflict_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "engine_conflict_log" ADD CONSTRAINT "engine_conflict_log_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "engine_conflict_log" ADD CONSTRAINT "engine_conflict_log_engine_id_content_engines_id_fk" FOREIGN KEY ("engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "translation_jobs" ADD CONSTRAINT "translation_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "translation_jobs" ADD CONSTRAINT "translation_jobs_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "translation_jobs" ADD CONSTRAINT "translation_jobs_engine_id_content_engines_id_fk" FOREIGN KEY ("engine_id") REFERENCES "public"."content_engines"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tenants_fk" FOREIGN KEY ("tenants_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_countries_fk" FOREIGN KEY ("countries_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_content_engines_fk" FOREIGN KEY ("content_engines_id") REFERENCES "public"."content_engines"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_activity_log_fk" FOREIGN KEY ("activity_log_id") REFERENCES "public"."activity_log"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_authors_fk" FOREIGN KEY ("authors_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_pillars_fk" FOREIGN KEY ("pillars_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subsections_fk" FOREIGN KEY ("subsections_id") REFERENCES "public"."subsections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sectors_fk" FOREIGN KEY ("sectors_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_articles_fk" FOREIGN KEY ("articles_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_newsletters_fk" FOREIGN KEY ("newsletters_id") REFERENCES "public"."newsletters"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_podcasts_fk" FOREIGN KEY ("podcasts_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_corrections_fk" FOREIGN KEY ("corrections_id") REFERENCES "public"."corrections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sponsor_slots_fk" FOREIGN KEY ("sponsor_slots_id") REFERENCES "public"."sponsor_slots"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_market_snapshots_fk" FOREIGN KEY ("market_snapshots_id") REFERENCES "public"."market_snapshots"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_fx_rates_fk" FOREIGN KEY ("fx_rates_id") REFERENCES "public"."fx_rates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_funding_rows_fk" FOREIGN KEY ("funding_rows_id") REFERENCES "public"."funding_rows"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ai_leaderboard_rows_fk" FOREIGN KEY ("ai_leaderboard_rows_id") REFERENCES "public"."ai_leaderboard_rows"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_trending_blocks_fk" FOREIGN KEY ("trending_blocks_id") REFERENCES "public"."trending_blocks"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_wire_drops_fk" FOREIGN KEY ("wire_drops_id") REFERENCES "public"."wire_drops"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_menus_fk" FOREIGN KEY ("menus_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_engine_conflict_log_fk" FOREIGN KEY ("engine_conflict_log_id") REFERENCES "public"."engine_conflict_log"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_translation_jobs_fk" FOREIGN KEY ("translation_jobs_id") REFERENCES "public"."translation_jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "tenants_additional_domains_order_idx" ON "tenants_additional_domains" USING btree ("_order");
  CREATE INDEX "tenants_additional_domains_parent_id_idx" ON "tenants_additional_domains" USING btree ("_parent_id");
  CREATE INDEX "tenants_supported_languages_order_idx" ON "tenants_supported_languages" USING btree ("order");
  CREATE INDEX "tenants_supported_languages_parent_idx" ON "tenants_supported_languages" USING btree ("parent_id");
  CREATE INDEX "tenants_socials_order_idx" ON "tenants_socials" USING btree ("_order");
  CREATE INDEX "tenants_socials_parent_id_idx" ON "tenants_socials" USING btree ("_parent_id");
  CREATE INDEX "tenants_read_tokens_order_idx" ON "tenants_read_tokens" USING btree ("_order");
  CREATE INDEX "tenants_read_tokens_parent_id_idx" ON "tenants_read_tokens" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");
  CREATE INDEX "tenants_logo_idx" ON "tenants" USING btree ("logo_id");
  CREATE INDEX "tenants_brand_brand_og_image_default_idx" ON "tenants" USING btree ("brand_og_image_default_id");
  CREATE INDEX "tenants_seo_seo_default_og_image_idx" ON "tenants" USING btree ("seo_default_og_image_id");
  CREATE INDEX "tenants_updated_at_idx" ON "tenants" USING btree ("updated_at");
  CREATE INDEX "tenants_created_at_idx" ON "tenants" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenants_locales_locale_parent_id_unique" ON "tenants_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "tenants_rels_order_idx" ON "tenants_rels" USING btree ("order");
  CREATE INDEX "tenants_rels_parent_idx" ON "tenants_rels" USING btree ("parent_id");
  CREATE INDEX "tenants_rels_path_idx" ON "tenants_rels" USING btree ("path");
  CREATE INDEX "tenants_rels_content_engines_id_idx" ON "tenants_rels" USING btree ("content_engines_id");
  CREATE INDEX "users_tenants_roles_order_idx" ON "users_tenants_roles" USING btree ("order");
  CREATE INDEX "users_tenants_roles_parent_idx" ON "users_tenants_roles" USING btree ("parent_id");
  CREATE INDEX "users_tenants_order_idx" ON "users_tenants" USING btree ("_order");
  CREATE INDEX "users_tenants_parent_id_idx" ON "users_tenants" USING btree ("_parent_id");
  CREATE INDEX "users_tenants_tenant_idx" ON "users_tenants" USING btree ("tenant_id");
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE UNIQUE INDEX "countries_slug_idx" ON "countries" USING btree ("slug");
  CREATE UNIQUE INDEX "countries_code_idx" ON "countries" USING btree ("code");
  CREATE INDEX "countries_updated_at_idx" ON "countries" USING btree ("updated_at");
  CREATE INDEX "countries_created_at_idx" ON "countries" USING btree ("created_at");
  CREATE UNIQUE INDEX "countries_locales_locale_parent_id_unique" ON "countries_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "content_engines_allowed_actions_order_idx" ON "content_engines_allowed_actions" USING btree ("order");
  CREATE INDEX "content_engines_allowed_actions_parent_idx" ON "content_engines_allowed_actions" USING btree ("parent_id");
  CREATE INDEX "content_engines_token_hash_idx" ON "content_engines" USING btree ("token_hash");
  CREATE INDEX "content_engines_updated_at_idx" ON "content_engines" USING btree ("updated_at");
  CREATE INDEX "content_engines_created_at_idx" ON "content_engines" USING btree ("created_at");
  CREATE INDEX "content_engines_rels_order_idx" ON "content_engines_rels" USING btree ("order");
  CREATE INDEX "content_engines_rels_parent_idx" ON "content_engines_rels" USING btree ("parent_id");
  CREATE INDEX "content_engines_rels_path_idx" ON "content_engines_rels" USING btree ("path");
  CREATE INDEX "content_engines_rels_tenants_id_idx" ON "content_engines_rels" USING btree ("tenants_id");
  CREATE INDEX "activity_log_event_type_idx" ON "activity_log" USING btree ("event_type");
  CREATE INDEX "activity_log_tenant_idx" ON "activity_log" USING btree ("tenant_id");
  CREATE INDEX "activity_log_actor_user_idx" ON "activity_log" USING btree ("actor_user_id");
  CREATE INDEX "activity_log_actor_engine_idx" ON "activity_log" USING btree ("actor_engine_id");
  CREATE INDEX "activity_log_updated_at_idx" ON "activity_log" USING btree ("updated_at");
  CREATE INDEX "activity_log_created_at_idx" ON "activity_log" USING btree ("created_at");
  CREATE INDEX "media_tenant_idx" ON "media" USING btree ("tenant_id");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "media_sizes_thumbnail_sizes_thumbnail_filename_idx" ON "media" USING btree ("sizes_thumbnail_filename");
  CREATE INDEX "media_sizes_card_sizes_card_filename_idx" ON "media" USING btree ("sizes_card_filename");
  CREATE INDEX "media_sizes_hero_sizes_hero_filename_idx" ON "media" USING btree ("sizes_hero_filename");
  CREATE UNIQUE INDEX "media_locales_locale_parent_id_unique" ON "media_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "authors_tenant_idx" ON "authors" USING btree ("tenant_id");
  CREATE INDEX "authors_user_idx" ON "authors" USING btree ("user_id");
  CREATE INDEX "authors_updated_at_idx" ON "authors" USING btree ("updated_at");
  CREATE INDEX "authors_created_at_idx" ON "authors" USING btree ("created_at");
  CREATE UNIQUE INDEX "authors_locales_locale_parent_id_unique" ON "authors_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "pillars_tenant_idx" ON "pillars" USING btree ("tenant_id");
  CREATE INDEX "pillars_slug_idx" ON "pillars" USING btree ("slug");
  CREATE INDEX "pillars_updated_at_idx" ON "pillars" USING btree ("updated_at");
  CREATE INDEX "pillars_created_at_idx" ON "pillars" USING btree ("created_at");
  CREATE UNIQUE INDEX "pillars_locales_locale_parent_id_unique" ON "pillars_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "subsections_tenant_idx" ON "subsections" USING btree ("tenant_id");
  CREATE INDEX "subsections_slug_idx" ON "subsections" USING btree ("slug");
  CREATE INDEX "subsections_pillar_idx" ON "subsections" USING btree ("pillar_id");
  CREATE INDEX "subsections_updated_at_idx" ON "subsections" USING btree ("updated_at");
  CREATE INDEX "subsections_created_at_idx" ON "subsections" USING btree ("created_at");
  CREATE UNIQUE INDEX "subsections_locales_locale_parent_id_unique" ON "subsections_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "sectors_tenant_idx" ON "sectors" USING btree ("tenant_id");
  CREATE INDEX "sectors_slug_idx" ON "sectors" USING btree ("slug");
  CREATE INDEX "sectors_updated_at_idx" ON "sectors" USING btree ("updated_at");
  CREATE INDEX "sectors_created_at_idx" ON "sectors" USING btree ("created_at");
  CREATE UNIQUE INDEX "sectors_locales_locale_parent_id_unique" ON "sectors_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "tags_tenant_idx" ON "tags" USING btree ("tenant_id");
  CREATE INDEX "tags_slug_idx" ON "tags" USING btree ("slug");
  CREATE INDEX "tags_updated_at_idx" ON "tags" USING btree ("updated_at");
  CREATE INDEX "tags_created_at_idx" ON "tags" USING btree ("created_at");
  CREATE UNIQUE INDEX "tags_locales_locale_parent_id_unique" ON "tags_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "articles_secondary_sections_order_idx" ON "articles_secondary_sections" USING btree ("_order");
  CREATE INDEX "articles_secondary_sections_parent_id_idx" ON "articles_secondary_sections" USING btree ("_parent_id");
  CREATE INDEX "articles_secondary_sections_pillar_idx" ON "articles_secondary_sections" USING btree ("pillar_id");
  CREATE INDEX "articles_secondary_sections_sub_section_idx" ON "articles_secondary_sections" USING btree ("sub_section_id");
  CREATE INDEX "articles_locked_fields_order_idx" ON "articles_locked_fields" USING btree ("_order");
  CREATE INDEX "articles_locked_fields_parent_id_idx" ON "articles_locked_fields" USING btree ("_parent_id");
  CREATE INDEX "articles_translation_status_order_idx" ON "articles_translation_status" USING btree ("_order");
  CREATE INDEX "articles_translation_status_parent_id_idx" ON "articles_translation_status" USING btree ("_parent_id");
  CREATE INDEX "articles_translation_status_engine_idx" ON "articles_translation_status" USING btree ("engine_id");
  CREATE INDEX "articles_tenant_idx" ON "articles" USING btree ("tenant_id");
  CREATE INDEX "articles_workflow_status_idx" ON "articles" USING btree ("workflow_status");
  CREATE INDEX "articles_assigned_to_idx" ON "articles" USING btree ("assigned_to_id");
  CREATE INDEX "articles_last_edited_by_idx" ON "articles" USING btree ("last_edited_by_id");
  CREATE INDEX "articles_pillar_idx" ON "articles" USING btree ("pillar_id");
  CREATE INDEX "articles_sub_section_idx" ON "articles" USING btree ("sub_section_id");
  CREATE INDEX "articles_country_idx" ON "articles" USING btree ("country_id");
  CREATE INDEX "articles_author_idx" ON "articles" USING btree ("author_id");
  CREATE INDEX "articles_engine_draft_id_idx" ON "articles" USING btree ("engine_draft_id");
  CREATE INDEX "articles_engine_source_url_idx" ON "articles" USING btree ("engine_source_url");
  CREATE INDEX "articles_last_engine_idx" ON "articles" USING btree ("last_engine_id");
  CREATE INDEX "articles_hero_image_idx" ON "articles" USING btree ("hero_image_id");
  CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");
  CREATE INDEX "articles_created_at_idx" ON "articles" USING btree ("created_at");
  CREATE INDEX "articles__status_idx" ON "articles" USING btree ("_status");
  CREATE INDEX "articles_slug_idx" ON "articles_locales" USING btree ("slug","_locale");
  CREATE UNIQUE INDEX "articles_locales_locale_parent_id_unique" ON "articles_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "articles_rels_order_idx" ON "articles_rels" USING btree ("order");
  CREATE INDEX "articles_rels_parent_idx" ON "articles_rels" USING btree ("parent_id");
  CREATE INDEX "articles_rels_path_idx" ON "articles_rels" USING btree ("path");
  CREATE INDEX "articles_rels_countries_id_idx" ON "articles_rels" USING btree ("countries_id");
  CREATE INDEX "articles_rels_tags_id_idx" ON "articles_rels" USING btree ("tags_id");
  CREATE INDEX "articles_rels_sectors_id_idx" ON "articles_rels" USING btree ("sectors_id");
  CREATE INDEX "articles_rels_authors_id_idx" ON "articles_rels" USING btree ("authors_id");
  CREATE INDEX "_articles_v_version_secondary_sections_order_idx" ON "_articles_v_version_secondary_sections" USING btree ("_order");
  CREATE INDEX "_articles_v_version_secondary_sections_parent_id_idx" ON "_articles_v_version_secondary_sections" USING btree ("_parent_id");
  CREATE INDEX "_articles_v_version_secondary_sections_pillar_idx" ON "_articles_v_version_secondary_sections" USING btree ("pillar_id");
  CREATE INDEX "_articles_v_version_secondary_sections_sub_section_idx" ON "_articles_v_version_secondary_sections" USING btree ("sub_section_id");
  CREATE INDEX "_articles_v_version_locked_fields_order_idx" ON "_articles_v_version_locked_fields" USING btree ("_order");
  CREATE INDEX "_articles_v_version_locked_fields_parent_id_idx" ON "_articles_v_version_locked_fields" USING btree ("_parent_id");
  CREATE INDEX "_articles_v_version_translation_status_order_idx" ON "_articles_v_version_translation_status" USING btree ("_order");
  CREATE INDEX "_articles_v_version_translation_status_parent_id_idx" ON "_articles_v_version_translation_status" USING btree ("_parent_id");
  CREATE INDEX "_articles_v_version_translation_status_engine_idx" ON "_articles_v_version_translation_status" USING btree ("engine_id");
  CREATE INDEX "_articles_v_parent_idx" ON "_articles_v" USING btree ("parent_id");
  CREATE INDEX "_articles_v_version_version_tenant_idx" ON "_articles_v" USING btree ("version_tenant_id");
  CREATE INDEX "_articles_v_version_version_workflow_status_idx" ON "_articles_v" USING btree ("version_workflow_status");
  CREATE INDEX "_articles_v_version_version_assigned_to_idx" ON "_articles_v" USING btree ("version_assigned_to_id");
  CREATE INDEX "_articles_v_version_version_last_edited_by_idx" ON "_articles_v" USING btree ("version_last_edited_by_id");
  CREATE INDEX "_articles_v_version_version_pillar_idx" ON "_articles_v" USING btree ("version_pillar_id");
  CREATE INDEX "_articles_v_version_version_sub_section_idx" ON "_articles_v" USING btree ("version_sub_section_id");
  CREATE INDEX "_articles_v_version_version_country_idx" ON "_articles_v" USING btree ("version_country_id");
  CREATE INDEX "_articles_v_version_version_author_idx" ON "_articles_v" USING btree ("version_author_id");
  CREATE INDEX "_articles_v_version_version_engine_draft_id_idx" ON "_articles_v" USING btree ("version_engine_draft_id");
  CREATE INDEX "_articles_v_version_version_engine_source_url_idx" ON "_articles_v" USING btree ("version_engine_source_url");
  CREATE INDEX "_articles_v_version_version_last_engine_idx" ON "_articles_v" USING btree ("version_last_engine_id");
  CREATE INDEX "_articles_v_version_version_hero_image_idx" ON "_articles_v" USING btree ("version_hero_image_id");
  CREATE INDEX "_articles_v_version_version_updated_at_idx" ON "_articles_v" USING btree ("version_updated_at");
  CREATE INDEX "_articles_v_version_version_created_at_idx" ON "_articles_v" USING btree ("version_created_at");
  CREATE INDEX "_articles_v_version_version__status_idx" ON "_articles_v" USING btree ("version__status");
  CREATE INDEX "_articles_v_created_at_idx" ON "_articles_v" USING btree ("created_at");
  CREATE INDEX "_articles_v_updated_at_idx" ON "_articles_v" USING btree ("updated_at");
  CREATE INDEX "_articles_v_snapshot_idx" ON "_articles_v" USING btree ("snapshot");
  CREATE INDEX "_articles_v_published_locale_idx" ON "_articles_v" USING btree ("published_locale");
  CREATE INDEX "_articles_v_latest_idx" ON "_articles_v" USING btree ("latest");
  CREATE INDEX "_articles_v_version_version_slug_idx" ON "_articles_v_locales" USING btree ("version_slug","_locale");
  CREATE UNIQUE INDEX "_articles_v_locales_locale_parent_id_unique" ON "_articles_v_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "_articles_v_rels_order_idx" ON "_articles_v_rels" USING btree ("order");
  CREATE INDEX "_articles_v_rels_parent_idx" ON "_articles_v_rels" USING btree ("parent_id");
  CREATE INDEX "_articles_v_rels_path_idx" ON "_articles_v_rels" USING btree ("path");
  CREATE INDEX "_articles_v_rels_countries_id_idx" ON "_articles_v_rels" USING btree ("countries_id");
  CREATE INDEX "_articles_v_rels_tags_id_idx" ON "_articles_v_rels" USING btree ("tags_id");
  CREATE INDEX "_articles_v_rels_sectors_id_idx" ON "_articles_v_rels" USING btree ("sectors_id");
  CREATE INDEX "_articles_v_rels_authors_id_idx" ON "_articles_v_rels" USING btree ("authors_id");
  CREATE INDEX "newsletters_tenant_idx" ON "newsletters" USING btree ("tenant_id");
  CREATE INDEX "newsletters_slug_idx" ON "newsletters" USING btree ("slug");
  CREATE INDEX "newsletters_vertical_idx" ON "newsletters" USING btree ("vertical_id");
  CREATE INDEX "newsletters_updated_at_idx" ON "newsletters" USING btree ("updated_at");
  CREATE INDEX "newsletters_created_at_idx" ON "newsletters" USING btree ("created_at");
  CREATE UNIQUE INDEX "newsletters_locales_locale_parent_id_unique" ON "newsletters_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "podcasts_tenant_idx" ON "podcasts" USING btree ("tenant_id");
  CREATE INDEX "podcasts_slug_idx" ON "podcasts" USING btree ("slug");
  CREATE INDEX "podcasts_updated_at_idx" ON "podcasts" USING btree ("updated_at");
  CREATE INDEX "podcasts_created_at_idx" ON "podcasts" USING btree ("created_at");
  CREATE UNIQUE INDEX "podcasts_locales_locale_parent_id_unique" ON "podcasts_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "corrections_tenant_idx" ON "corrections" USING btree ("tenant_id");
  CREATE INDEX "corrections_article_idx" ON "corrections" USING btree ("article_id");
  CREATE INDEX "corrections_editor_idx" ON "corrections" USING btree ("editor_id");
  CREATE INDEX "corrections_updated_at_idx" ON "corrections" USING btree ("updated_at");
  CREATE INDEX "corrections_created_at_idx" ON "corrections" USING btree ("created_at");
  CREATE UNIQUE INDEX "corrections_locales_locale_parent_id_unique" ON "corrections_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "sponsor_slots_tenant_idx" ON "sponsor_slots" USING btree ("tenant_id");
  CREATE INDEX "sponsor_slots_article_idx" ON "sponsor_slots" USING btree ("article_id");
  CREATE INDEX "sponsor_slots_updated_at_idx" ON "sponsor_slots" USING btree ("updated_at");
  CREATE INDEX "sponsor_slots_created_at_idx" ON "sponsor_slots" USING btree ("created_at");
  CREATE INDEX "market_snapshots_tenant_idx" ON "market_snapshots" USING btree ("tenant_id");
  CREATE INDEX "market_snapshots_created_at_idx" ON "market_snapshots" USING btree ("created_at");
  CREATE INDEX "fx_rates_tenant_idx" ON "fx_rates" USING btree ("tenant_id");
  CREATE INDEX "fx_rates_created_at_idx" ON "fx_rates" USING btree ("created_at");
  CREATE INDEX "funding_rows_tenant_idx" ON "funding_rows" USING btree ("tenant_id");
  CREATE INDEX "funding_rows_updated_at_idx" ON "funding_rows" USING btree ("updated_at");
  CREATE INDEX "funding_rows_created_at_idx" ON "funding_rows" USING btree ("created_at");
  CREATE INDEX "ai_leaderboard_rows_tenant_idx" ON "ai_leaderboard_rows" USING btree ("tenant_id");
  CREATE INDEX "ai_leaderboard_rows_updated_at_idx" ON "ai_leaderboard_rows" USING btree ("updated_at");
  CREATE INDEX "ai_leaderboard_rows_created_at_idx" ON "ai_leaderboard_rows" USING btree ("created_at");
  CREATE INDEX "trending_blocks_tenant_idx" ON "trending_blocks" USING btree ("tenant_id");
  CREATE INDEX "trending_blocks_updated_at_idx" ON "trending_blocks" USING btree ("updated_at");
  CREATE INDEX "trending_blocks_created_at_idx" ON "trending_blocks" USING btree ("created_at");
  CREATE INDEX "wire_drops_tenant_idx" ON "wire_drops" USING btree ("tenant_id");
  CREATE INDEX "wire_drops_updated_at_idx" ON "wire_drops" USING btree ("updated_at");
  CREATE INDEX "wire_drops_created_at_idx" ON "wire_drops" USING btree ("created_at");
  CREATE UNIQUE INDEX "wire_drops_locales_locale_parent_id_unique" ON "wire_drops_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "menus_items_children_order_idx" ON "menus_items_children" USING btree ("_order");
  CREATE INDEX "menus_items_children_parent_id_idx" ON "menus_items_children" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "menus_items_children_locales_locale_parent_id_unique" ON "menus_items_children_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "menus_items_order_idx" ON "menus_items" USING btree ("_order");
  CREATE INDEX "menus_items_parent_id_idx" ON "menus_items" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "menus_items_locales_locale_parent_id_unique" ON "menus_items_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "menus_tenant_idx" ON "menus" USING btree ("tenant_id");
  CREATE INDEX "menus_updated_at_idx" ON "menus" USING btree ("updated_at");
  CREATE INDEX "menus_created_at_idx" ON "menus" USING btree ("created_at");
  CREATE INDEX "engine_conflict_log_tenant_idx" ON "engine_conflict_log" USING btree ("tenant_id");
  CREATE INDEX "engine_conflict_log_article_idx" ON "engine_conflict_log" USING btree ("article_id");
  CREATE INDEX "engine_conflict_log_engine_idx" ON "engine_conflict_log" USING btree ("engine_id");
  CREATE INDEX "engine_conflict_log_updated_at_idx" ON "engine_conflict_log" USING btree ("updated_at");
  CREATE INDEX "engine_conflict_log_created_at_idx" ON "engine_conflict_log" USING btree ("created_at");
  CREATE INDEX "translation_jobs_tenant_idx" ON "translation_jobs" USING btree ("tenant_id");
  CREATE INDEX "translation_jobs_article_idx" ON "translation_jobs" USING btree ("article_id");
  CREATE INDEX "translation_jobs_target_locale_idx" ON "translation_jobs" USING btree ("target_locale");
  CREATE INDEX "translation_jobs_status_idx" ON "translation_jobs" USING btree ("status");
  CREATE INDEX "translation_jobs_engine_idx" ON "translation_jobs" USING btree ("engine_id");
  CREATE INDEX "translation_jobs_updated_at_idx" ON "translation_jobs" USING btree ("updated_at");
  CREATE INDEX "translation_jobs_created_at_idx" ON "translation_jobs" USING btree ("created_at");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_tenants_id_idx" ON "payload_locked_documents_rels" USING btree ("tenants_id");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_countries_id_idx" ON "payload_locked_documents_rels" USING btree ("countries_id");
  CREATE INDEX "payload_locked_documents_rels_content_engines_id_idx" ON "payload_locked_documents_rels" USING btree ("content_engines_id");
  CREATE INDEX "payload_locked_documents_rels_activity_log_id_idx" ON "payload_locked_documents_rels" USING btree ("activity_log_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_locked_documents_rels_authors_id_idx" ON "payload_locked_documents_rels" USING btree ("authors_id");
  CREATE INDEX "payload_locked_documents_rels_pillars_id_idx" ON "payload_locked_documents_rels" USING btree ("pillars_id");
  CREATE INDEX "payload_locked_documents_rels_subsections_id_idx" ON "payload_locked_documents_rels" USING btree ("subsections_id");
  CREATE INDEX "payload_locked_documents_rels_sectors_id_idx" ON "payload_locked_documents_rels" USING btree ("sectors_id");
  CREATE INDEX "payload_locked_documents_rels_tags_id_idx" ON "payload_locked_documents_rels" USING btree ("tags_id");
  CREATE INDEX "payload_locked_documents_rels_articles_id_idx" ON "payload_locked_documents_rels" USING btree ("articles_id");
  CREATE INDEX "payload_locked_documents_rels_newsletters_id_idx" ON "payload_locked_documents_rels" USING btree ("newsletters_id");
  CREATE INDEX "payload_locked_documents_rels_podcasts_id_idx" ON "payload_locked_documents_rels" USING btree ("podcasts_id");
  CREATE INDEX "payload_locked_documents_rels_corrections_id_idx" ON "payload_locked_documents_rels" USING btree ("corrections_id");
  CREATE INDEX "payload_locked_documents_rels_sponsor_slots_id_idx" ON "payload_locked_documents_rels" USING btree ("sponsor_slots_id");
  CREATE INDEX "payload_locked_documents_rels_market_snapshots_id_idx" ON "payload_locked_documents_rels" USING btree ("market_snapshots_id");
  CREATE INDEX "payload_locked_documents_rels_fx_rates_id_idx" ON "payload_locked_documents_rels" USING btree ("fx_rates_id");
  CREATE INDEX "payload_locked_documents_rels_funding_rows_id_idx" ON "payload_locked_documents_rels" USING btree ("funding_rows_id");
  CREATE INDEX "payload_locked_documents_rels_ai_leaderboard_rows_id_idx" ON "payload_locked_documents_rels" USING btree ("ai_leaderboard_rows_id");
  CREATE INDEX "payload_locked_documents_rels_trending_blocks_id_idx" ON "payload_locked_documents_rels" USING btree ("trending_blocks_id");
  CREATE INDEX "payload_locked_documents_rels_wire_drops_id_idx" ON "payload_locked_documents_rels" USING btree ("wire_drops_id");
  CREATE INDEX "payload_locked_documents_rels_menus_id_idx" ON "payload_locked_documents_rels" USING btree ("menus_id");
  CREATE INDEX "payload_locked_documents_rels_engine_conflict_log_id_idx" ON "payload_locked_documents_rels" USING btree ("engine_conflict_log_id");
  CREATE INDEX "payload_locked_documents_rels_translation_jobs_id_idx" ON "payload_locked_documents_rels" USING btree ("translation_jobs_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "tenants_additional_domains" CASCADE;
  DROP TABLE "tenants_supported_languages" CASCADE;
  DROP TABLE "tenants_socials" CASCADE;
  DROP TABLE "tenants_read_tokens" CASCADE;
  DROP TABLE "tenants" CASCADE;
  DROP TABLE "tenants_locales" CASCADE;
  DROP TABLE "tenants_rels" CASCADE;
  DROP TABLE "users_tenants_roles" CASCADE;
  DROP TABLE "users_tenants" CASCADE;
  DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "countries" CASCADE;
  DROP TABLE "countries_locales" CASCADE;
  DROP TABLE "content_engines_allowed_actions" CASCADE;
  DROP TABLE "content_engines" CASCADE;
  DROP TABLE "content_engines_rels" CASCADE;
  DROP TABLE "activity_log" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "media_locales" CASCADE;
  DROP TABLE "authors" CASCADE;
  DROP TABLE "authors_locales" CASCADE;
  DROP TABLE "pillars" CASCADE;
  DROP TABLE "pillars_locales" CASCADE;
  DROP TABLE "subsections" CASCADE;
  DROP TABLE "subsections_locales" CASCADE;
  DROP TABLE "sectors" CASCADE;
  DROP TABLE "sectors_locales" CASCADE;
  DROP TABLE "tags" CASCADE;
  DROP TABLE "tags_locales" CASCADE;
  DROP TABLE "articles_secondary_sections" CASCADE;
  DROP TABLE "articles_locked_fields" CASCADE;
  DROP TABLE "articles_translation_status" CASCADE;
  DROP TABLE "articles" CASCADE;
  DROP TABLE "articles_locales" CASCADE;
  DROP TABLE "articles_rels" CASCADE;
  DROP TABLE "_articles_v_version_secondary_sections" CASCADE;
  DROP TABLE "_articles_v_version_locked_fields" CASCADE;
  DROP TABLE "_articles_v_version_translation_status" CASCADE;
  DROP TABLE "_articles_v" CASCADE;
  DROP TABLE "_articles_v_locales" CASCADE;
  DROP TABLE "_articles_v_rels" CASCADE;
  DROP TABLE "newsletters" CASCADE;
  DROP TABLE "newsletters_locales" CASCADE;
  DROP TABLE "podcasts" CASCADE;
  DROP TABLE "podcasts_locales" CASCADE;
  DROP TABLE "corrections" CASCADE;
  DROP TABLE "corrections_locales" CASCADE;
  DROP TABLE "sponsor_slots" CASCADE;
  DROP TABLE "market_snapshots" CASCADE;
  DROP TABLE "fx_rates" CASCADE;
  DROP TABLE "funding_rows" CASCADE;
  DROP TABLE "ai_leaderboard_rows" CASCADE;
  DROP TABLE "trending_blocks" CASCADE;
  DROP TABLE "wire_drops" CASCADE;
  DROP TABLE "wire_drops_locales" CASCADE;
  DROP TABLE "menus_items_children" CASCADE;
  DROP TABLE "menus_items_children_locales" CASCADE;
  DROP TABLE "menus_items" CASCADE;
  DROP TABLE "menus_items_locales" CASCADE;
  DROP TABLE "menus" CASCADE;
  DROP TABLE "engine_conflict_log" CASCADE;
  DROP TABLE "translation_jobs" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TYPE "public"."_locales";
  DROP TYPE "public"."enum_tenants_supported_languages";
  DROP TYPE "public"."enum_tenants_read_tokens_status";
  DROP TYPE "public"."enum_tenants_status";
  DROP TYPE "public"."enum_tenants_default_language";
  DROP TYPE "public"."enum_users_tenants_roles";
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_countries_region";
  DROP TYPE "public"."enum_content_engines_allowed_actions";
  DROP TYPE "public"."enum_content_engines_engine_type";
  DROP TYPE "public"."enum_content_engines_status";
  DROP TYPE "public"."enum_activity_log_event_type";
  DROP TYPE "public"."enum_activity_log_actor_type";
  DROP TYPE "public"."enum_articles_translation_status_locale";
  DROP TYPE "public"."enum_articles_translation_status_state";
  DROP TYPE "public"."enum_articles_workflow_status";
  DROP TYPE "public"."enum_articles_origin";
  DROP TYPE "public"."enum_articles_source_language";
  DROP TYPE "public"."enum_articles_status";
  DROP TYPE "public"."enum__articles_v_version_translation_status_locale";
  DROP TYPE "public"."enum__articles_v_version_translation_status_state";
  DROP TYPE "public"."enum__articles_v_version_workflow_status";
  DROP TYPE "public"."enum__articles_v_version_origin";
  DROP TYPE "public"."enum__articles_v_version_source_language";
  DROP TYPE "public"."enum__articles_v_version_status";
  DROP TYPE "public"."enum__articles_v_published_locale";
  DROP TYPE "public"."enum_sponsor_slots_slot";
  DROP TYPE "public"."enum_menus_type";
  DROP TYPE "public"."enum_engine_conflict_log_reason";
  DROP TYPE "public"."enum_translation_jobs_source_locale";
  DROP TYPE "public"."enum_translation_jobs_target_locale";
  DROP TYPE "public"."enum_translation_jobs_status";`)
}
