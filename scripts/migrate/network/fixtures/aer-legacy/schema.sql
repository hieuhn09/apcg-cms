-- Synthetic legacy network DB for the AER rehearsal. FAKE DATA ONLY.
-- Same table shapes as the shared network DB (public.sites, public.articles,
-- public.site_authors, public.media_assets) plus a neutral decoy table that the
-- read-only role must never reach. The role and the aer_ro views are created by
-- the REAL owner file sql/02-create-readonly-role-views.sql (exercised here).
DROP SCHEMA IF EXISTS aer_ro CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE sites (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, domain text, config jsonb);
CREATE TABLE articles (
  id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites(id), slug text, title jsonb NOT NULL, excerpt jsonb, kicker jsonb,
  body_sections jsonb, seo jsonb, citations jsonb, takeaways jsonb, status text NOT NULL, section text, subsection text, tags text[],
  label text, region text, category text, format text, featured boolean DEFAULT false, read_minutes integer, featured_image text,
  featured_image_credit text, source_id uuid, source_url text, byline text, countries text[], published_at timestamptz,
  scheduled_at timestamptz, created_at timestamptz, updated_at timestamptz, is_hero boolean DEFAULT false, editor_hold boolean DEFAULT false,
  migrate_source text, ai_model text, ai_score integer
);
CREATE TABLE site_authors (site_id uuid NOT NULL REFERENCES sites(id), slug text NOT NULL, name text NOT NULL, bio text, beats text[], email text);
CREATE TABLE media_assets (site_id uuid NOT NULL REFERENCES sites(id), storage_path text NOT NULL, public_url text);
CREATE TABLE secret_table_a (id serial PRIMARY KEY, site_id uuid, payload text);
