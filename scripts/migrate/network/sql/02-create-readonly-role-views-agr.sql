-- OWNER-RUN in the Supabase SQL Editor of project "globaltravelpost" (database postgres),
-- ONLY after 01-discover-agr.sql showed exactly ONE matching site row.
-- Paste the WHOLE file, press Run once. Nothing to edit: the site id is found by the file.
--
-- Creates a SEPARATE read-only login role agr_migrator (cannot log in until 02p sets a
-- password) and a SEPARATE schema agr_ro with three views filtered to the AsiaGolfReview
-- site: agr_ro.sites (id, slug, name), agr_ro.articles (every column of
-- public.articles except personal-looking ones), agr_ro.site_authors (no email).
-- It does NOT change any shared table, grant, policy or RLS, does NOT touch any other
-- site's role (gtp_migrator, vowasia_migrator, aer_migrator), and never runs REVOKE ... FROM PUBLIC on
-- schema public.
--
-- Everything happens inside ONE DO block, which is atomic: any STOP rolls back the whole
-- block and nothing is created. The result is ONE cell, agr_self_check:
--   'SELF-CHECK OK'      role, schema, three views and the role's SELECT on them exist;
--   'SELF-CHECK FAILED'  something is missing: stop and send the result;
--   an ERROR '... STOP: ...' instead of a result: nothing was created; send the text.
--
-- Honest limits (same as VowAsia Amendment 2, option A):
--   - The role inherits what PUBLIC has: CONNECT, TEMP, EXECUTE of functions PUBLIC may
--     call. The block STOPs if the role could call a SECURITY DEFINER function
--     (trigger functions excepted) or reach any table outside agr_ro.
--   - Allowed, by name only: the two Supabase pg_net tables net._http_response and
--     net.http_request_queue (PUBLIC has grants on them by default). The role can READ
--     them (HTTP responses of the old site's other integrations), and if it switched off
--     its own default_transaction_read_only it could WRITE net.http_request_queue, which
--     can make the database send outbound HTTP requests. So a leaked agr_migrator
--     password exposes MORE than AGR data. Mitigation: create, use and drop the role in
--     one sitting (files 02 -> 02p -> tools -> 03); it expires after 14 days anyway.
--   - default_transaction_read_only is only a session default; the real fence is that
--     the role has SELECT on the three views and nothing else.
--   - Do not run a migration that changes public.articles columns while the views exist.

DO $$
DECLARE
  site_id text;
  n_match int;
  art_cols text;
  auth_cols text;
  bad text;
  n_definer int;
  allow_public_relations constant text[] := ARRAY['net._http_response', 'net.http_request_queue'];
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was created.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agr_migrator') OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'agr_ro') THEN
    RAISE EXCEPTION 'ALREADY STOP: role agr_migrator or schema agr_ro already exists (run 03-drop-role-and-views-agr.sql first); nothing was created.';
  END IF;
  SELECT count(*), min(s.id::text) INTO n_match, site_id FROM public.sites s
  WHERE s::text ILIKE '%asiagolfreview%' OR s::text ILIKE '%asia golf review%' OR s::text ILIKE '%asia-golf-review%' OR s.slug::text = 'agr';
  IF n_match <> 1 THEN
    RAISE EXCEPTION 'SITE STOP: % site rows match asiagolfreview (need exactly 1); nothing was created.', n_match;
  END IF;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO art_cols
  FROM pg_attribute a WHERE a.attrelid = 'public.articles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname !~* '(email|phone|password|passwd|token|secret|contact|ip_address|user_agent|reviewer_notes)';
  IF art_cols NOT LIKE '%site_id%' THEN
    RAISE EXCEPTION 'COLUMN STOP: public.articles has no site_id column; nothing was created.';
  END IF;
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO auth_cols
  FROM pg_attribute a WHERE a.attrelid = to_regclass('public.site_authors') AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname !~* '(email|phone|password|token|secret|contact)';

  CREATE ROLE agr_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  EXECUTE format('ALTER ROLE agr_migrator VALID UNTIL %L', (now() + interval '14 days')::text);
  ALTER ROLE agr_migrator SET default_transaction_read_only = on;
  ALTER ROLE agr_migrator SET statement_timeout = '30s';
  ALTER ROLE agr_migrator SET idle_in_transaction_session_timeout = '60s';

  CREATE SCHEMA agr_ro;
  REVOKE ALL ON SCHEMA agr_ro FROM PUBLIC;
  EXECUTE format('CREATE VIEW agr_ro.sites WITH (security_barrier = true) AS SELECT "id", "slug", "name" FROM public.sites WHERE "id"::text = %L', site_id);
  EXECUTE format('CREATE VIEW agr_ro.articles WITH (security_barrier = true) AS SELECT %s FROM public.articles WHERE "site_id"::text = %L', art_cols, site_id);
  IF auth_cols IS NOT NULL AND auth_cols LIKE '%site_id%' THEN
    EXECUTE format('CREATE VIEW agr_ro.site_authors WITH (security_barrier = true) AS SELECT %s FROM public.site_authors WHERE "site_id"::text = %L', auth_cols, site_id);
  ELSE
    -- Keeps the tools' allow-list valid: an empty view with the columns they read.
    EXECUTE format('CREATE VIEW agr_ro.site_authors AS SELECT %L::uuid AS site_id, NULL::text AS slug, NULL::text AS name, NULL::text AS bio, NULL::text[] AS beats WHERE false', site_id);
  END IF;
  REVOKE ALL ON agr_ro.sites, agr_ro.articles, agr_ro.site_authors FROM PUBLIC;
  GRANT USAGE ON SCHEMA agr_ro TO agr_migrator;
  GRANT SELECT ON agr_ro.sites, agr_ro.articles, agr_ro.site_authors TO agr_migrator;

  -- SELF-CHECK (any STOP undoes everything above).
  IF (SELECT count(*) FROM agr_ro.sites) <> 1 THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_ro.sites does not return exactly 1 row; nothing was created.';
  END IF;
  IF (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'agr_migrator') THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator bypasses RLS or is superuser; nothing was created.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'agr_migrator') THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator is a member of another role; nothing was created.';
  END IF;
  IF has_database_privilege('agr_migrator', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator can CREATE in this database (PUBLIC grant?); nothing was created.';
  END IF;
  SELECT string_agg(n.nspname, ', ') INTO bad FROM pg_namespace n WHERE has_schema_privilege('agr_migrator', n.oid, 'CREATE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator can CREATE in schema(s) %; nothing was created.', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('agr_ro', 'pg_catalog', 'information_schema', 'pg_toast')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_schema_privilege('agr_migrator', n.oid, 'USAGE')
    AND (has_table_privilege('agr_migrator', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         OR has_any_column_privilege('agr_migrator', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
    AND NOT (c.relkind = 'r' AND n.nspname || '.' || c.relname = ANY (allow_public_relations));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator reaches table(s) outside agr_ro: % (PUBLIC grant?); nothing was created.', left(bad, 300);
  END IF;
  SELECT count(*) INTO n_definer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
    AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
    AND (n.nspname = 'public' OR has_schema_privilege('agr_migrator', n.oid, 'USAGE'))
    AND has_function_privilege('agr_migrator', p.oid, 'EXECUTE');
  IF n_definer > 0 THEN
    RAISE EXCEPTION 'SELF-CHECK STOP: agr_migrator can EXECUTE % SECURITY DEFINER function(s) (see 01, section 10); nothing was created.', n_definer;
  END IF;
END $$;

SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agr_migrator') THEN 'SELF-CHECK FAILED'
  WHEN to_regclass('agr_ro.articles') IS NULL OR to_regclass('agr_ro.sites') IS NULL OR to_regclass('agr_ro.site_authors') IS NULL THEN 'SELF-CHECK FAILED'
  WHEN has_table_privilege('agr_migrator', 'agr_ro.articles', 'SELECT') AND has_table_privilege('agr_migrator', 'agr_ro.sites', 'SELECT')
   AND has_table_privilege('agr_migrator', 'agr_ro.site_authors', 'SELECT') THEN 'SELF-CHECK OK'
  ELSE 'SELF-CHECK FAILED'
END AS agr_self_check,
(SELECT count(*) FROM agr_ro.articles) AS agr_articles_visible;
