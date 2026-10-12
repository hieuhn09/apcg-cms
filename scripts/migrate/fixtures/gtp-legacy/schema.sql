-- Synthetic legacy GTP schema (gtp-launch P4, A4). FAKE DATA ONLY.
-- Mirrors the real table names/types of the shared network DB for the 9
-- allow-listed tables, plus the non-allow-listed `article_review_queue` and four
-- NEUTRAL decoy tables holding CANARY-SECRET-* strings that the tools must never
-- name, count or read. The SELECT-only role `gtp_migrator` mirrors the
-- owner-run role of the Phase 5 runbook.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  domain text,
  config jsonb
);

CREATE TABLE articles (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  slug text,
  title jsonb NOT NULL,
  excerpt jsonb,
  kicker jsonb,
  body_sections jsonb,
  seo jsonb,
  citations jsonb,
  takeaways jsonb,
  status text NOT NULL,
  section text,
  subsection text,
  tags text[],
  label text,
  region text,
  category text,
  format text,
  featured boolean DEFAULT false,
  read_minutes integer,
  featured_image text,
  featured_image_credit text,
  source_id uuid,
  source_url text,
  byline text,
  countries text[],
  published_at timestamptz,
  scheduled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_hero boolean DEFAULT false,
  editor_hold boolean DEFAULT false,
  migrate_source text,
  ai_model text,
  ai_score integer
);

CREATE TABLE site_authors_base (
  site_id uuid NOT NULL REFERENCES sites(id),
  slug text NOT NULL,
  name text NOT NULL,
  bio text,
  beats text[],
  email text
);
CREATE VIEW site_authors AS
  SELECT b.site_id, s.slug AS site_slug, b.slug, b.name, b.bio, b.beats FROM site_authors_base b JOIN sites s ON s.id = b.site_id;

CREATE TABLE media_assets (
  site_id uuid NOT NULL REFERENCES sites(id),
  storage_path text NOT NULL,
  public_url text,
  entity_tags text[],
  region text,
  is_landmark boolean,
  width int,
  height int,
  source text,
  license text,
  license_ref text,
  credit text,
  used_count int
);

CREATE TABLE scraping_sources (
  site_id uuid NOT NULL REFERENCES sites(id),
  name text,
  feed_url text NOT NULL,
  website_url text,
  category text,
  section_hint text,
  is_active boolean,
  articles_per_week_quota int,
  last_error text,
  consecutive_failures int
);

CREATE TABLE gtp_subscribers (
  site_id uuid NOT NULL REFERENCES sites(id),
  email text NOT NULL,
  newsletter text,
  source text,
  created_at timestamptz
);

CREATE TABLE visa_rules (
  site_id uuid NOT NULL REFERENCES sites(id),
  country text,
  country_code text NOT NULL,
  region text,
  headline text,
  summary text,
  status text,
  effective_date date,
  verified_at timestamptz,
  source_name text,
  source_url text,
  related_slug text,
  active boolean,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE events (
  id text PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  date_start date,
  date_end date,
  title text NOT NULL,
  location text,
  category text,
  url text,
  note text,
  active boolean,
  sort_order int
);

CREATE TABLE press_submissions (
  site_id uuid NOT NULL REFERENCES sites(id),
  company text,
  contact_name text,
  contact_email text,
  title text,
  body text,
  category text,
  status text,
  article_id uuid,
  created_at timestamptz
);

-- NOT allow-listed: present so the guard can prove it is refused and never named.
CREATE TABLE article_review_queue (
  article_id uuid,
  status text,
  reviewer_notes text,
  reviewed_by text,
  reviewed_at timestamptz
);

-- Neutral decoys (stand-ins for the unrelated sensitive tables of the real DB).
CREATE TABLE secret_table_a (id serial PRIMARY KEY, site_id uuid, payload text);
CREATE TABLE secret_table_b (id serial PRIMARY KEY, token text);
CREATE TABLE secret_table_c (id serial PRIMARY KEY, refresh_token text);
CREATE TABLE secret_table_d (id serial PRIMARY KEY, session_secret text);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtp_migrator') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gtp_migrator';
  ELSE
    CREATE ROLE gtp_migrator LOGIN PASSWORD 'password';
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gtp_migrator;
GRANT USAGE ON SCHEMA public TO gtp_migrator;
GRANT SELECT ON public.articles, public.sites, public.site_authors, public.media_assets, public.scraping_sources,
  public.gtp_subscribers, public.visa_rules, public.events, public.press_submissions TO gtp_migrator;
ALTER ROLE gtp_migrator SET default_transaction_read_only = on;
ALTER ROLE gtp_migrator SET statement_timeout = '30s';
ALTER ROLE gtp_migrator SET idle_in_transaction_session_timeout = '60s';
