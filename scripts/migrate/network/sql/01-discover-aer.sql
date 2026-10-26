-- OWNER-RUN in the Supabase SQL Editor of project "globaltravelpost" (database postgres).
-- READ ONLY: one SELECT, writes nothing, changes no setting. Returns exactly ONE table
-- (section, item, detail). The Editor shows only the last result and no NOTICE, so
-- everything is in one statement.
--
-- What it does: finds the Asia Economic Review row of public.sites WITHOUT assuming its
-- slug (any column of the row containing "asiaeconomicreview" or "asia economic review"),
-- then, only when exactly ONE row matches, describes that site's articles: counts by
-- status and by section/subsection, date ranges (microseconds kept), tag counts, image
-- hosts, images inside body_sections, and 30 sample rows (no body text, no byline).
-- It also reports what file 02 checks before it creates the read-only role.
-- Send back the WHOLE result (button "Download CSV"). Nothing in it is a secret.

WITH
site_match AS (
  SELECT s.id::text AS id, s.slug::text AS slug, s.name::text AS name
  FROM public.sites s
  WHERE s::text ILIKE '%asiaeconomicreview%' OR s::text ILIKE '%asia economic review%'
),
chosen AS (SELECT id FROM site_match WHERE (SELECT count(*) FROM site_match) = 1),
a AS (SELECT x.* FROM public.articles x WHERE x.site_id::text = (SELECT id FROM chosen)),
r_site AS (
  SELECT 10 AS ord, 0 AS sub, '1 site match' AS section, 'rows matching asiaeconomicreview' AS item, count(*)::text AS detail FROM site_match
  UNION ALL
  SELECT 10, 1, '1 site match', coalesce(slug, '(null slug)'), 'id=' || id || ' name=' || coalesce(name, '') FROM site_match
  UNION ALL
  SELECT 10, 2, '1 site match', 'all site slugs (to compare)', string_agg(s.slug::text, ', ' ORDER BY s.slug) FROM public.sites s
),
r_conn AS (
  SELECT 5 AS ord, 0 AS sub, '0 connection' AS section, 'database | role' AS item, current_database() || ' | ' || current_user AS detail
  UNION ALL SELECT 5, 1, '0 connection', 'server_version', current_setting('server_version')
),
r_status AS (
  SELECT 20 AS ord, 0 AS sub, '2 articles by status' AS section, coalesce(status::text, '(null)') AS item, count(*)::text AS detail FROM a GROUP BY status
  UNION ALL SELECT 20, -1, '2 articles by status', 'TOTAL', count(*)::text FROM a
),
r_sec AS (
  SELECT 30 AS ord, 0 AS sub, '3 section/subsection x status' AS section,
         coalesce(section::text, '(null)') || '/' || coalesce(subsection::text, '') AS item,
         string_agg(st || '=' || n, ' ' ORDER BY st) AS detail
  FROM (SELECT section, subsection, coalesce(status::text, '(null)') AS st, count(*)::text AS n FROM a GROUP BY 1, 2, 3) q
  GROUP BY 1, 2, 3, 4
),
r_dates AS (
  SELECT 40 AS ord, 0 AS sub, '4 dates' AS section, 'created_at min | max' AS item, min(created_at)::text || ' | ' || max(created_at)::text AS detail FROM a
  UNION ALL SELECT 40, 1, '4 dates', 'published_at min | max', min(published_at)::text || ' | ' || max(published_at)::text FROM a
  UNION ALL SELECT 40, 2, '4 dates', 'published_at null (by status)', coalesce(string_agg(st || '=' || n, ' '), '0') FROM (SELECT coalesce(status::text, '(null)') AS st, count(*)::text AS n FROM a WHERE published_at IS NULL GROUP BY 1) q
  UNION ALL SELECT 40, 3, '4 dates', 'created_at with non-zero microseconds', count(*) FILTER (WHERE extract(microseconds FROM created_at)::bigint % 1000 <> 0)::text || ' of ' || count(*)::text FROM a
  UNION ALL SELECT 40, 4, '4 dates', 'created_at duplicates (same instant)', (SELECT count(*) FROM (SELECT created_at FROM a GROUP BY created_at HAVING count(*) > 1) d)::text
),
r_slug AS (
  SELECT 45 AS ord, 0 AS sub, '5 slugs' AS section, 'null or empty slug' AS item, count(*) FILTER (WHERE coalesce(slug::text, '') = '')::text AS detail FROM a
  UNION ALL SELECT 45, 1, '5 slugs', 'duplicate slugs', (SELECT count(*) FROM (SELECT slug FROM a GROUP BY slug HAVING count(*) > 1) d)::text
  UNION ALL SELECT 45, 2, '5 slugs', 'slugs not [a-z0-9-]', count(*) FILTER (WHERE slug::text !~ '^[a-z0-9][a-z0-9-]*$')::text FROM a
),
tag_rows AS (SELECT lower(btrim(t)) AS tag FROM a, unnest(a.tags) AS t),
r_tags AS (
  SELECT 50 AS ord, 0 AS sub, '6 tags' AS section, 'distinct tags | tag uses | articles with tags' AS item,
         (SELECT count(DISTINCT tag) FROM tag_rows)::text || ' | ' || (SELECT count(*) FROM tag_rows)::text || ' | ' || (SELECT count(*) FROM a WHERE cardinality(a.tags) > 0)::text AS detail
  UNION ALL
  SELECT 50, 1, '6 tags', 'top 40 tags', (SELECT string_agg(tag || '=' || n, ', ' ORDER BY n DESC, tag) FROM (SELECT tag, count(*) AS n FROM tag_rows GROUP BY tag ORDER BY n DESC, tag LIMIT 40) t)
),
r_img AS (
  SELECT 60 AS ord, 0 AS sub, '7 featured image hosts' AS section, coalesce(substring(featured_image::text FROM '^https?://([^/]+)'), '(none or relative)') AS item, count(*)::text AS detail FROM a GROUP BY 4
  UNION ALL
  SELECT 61, 0, '7 body_sections images', 'sections | sections with image | articles with a body image',
         (SELECT count(*) FROM a, jsonb_array_elements(CASE WHEN jsonb_typeof(a.body_sections) = 'array' THEN a.body_sections ELSE '[]'::jsonb END) e)::text || ' | ' ||
         (SELECT count(*) FROM a, jsonb_array_elements(CASE WHEN jsonb_typeof(a.body_sections) = 'array' THEN a.body_sections ELSE '[]'::jsonb END) e WHERE e ? 'image' AND e->'image' <> 'null'::jsonb AND e->>'image' <> '')::text || ' | ' ||
         (SELECT count(*) FROM a WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.body_sections) = 'array' THEN a.body_sections ELSE '[]'::jsonb END) e WHERE e ? 'image' AND e->'image' <> 'null'::jsonb AND e->>'image' <> ''))::text
  UNION ALL
  SELECT 62, 0, '7 body_sections images', 'image value shape (jsonb type)', coalesce(string_agg(ty || '=' || n, ' '), '(none)')
  FROM (SELECT jsonb_typeof(e->'image') AS ty, count(*)::text AS n FROM a, jsonb_array_elements(CASE WHEN jsonb_typeof(a.body_sections) = 'array' THEN a.body_sections ELSE '[]'::jsonb END) e WHERE e ? 'image' GROUP BY 1) q
),
r_other AS (
  SELECT 70 AS ord, 0 AS sub, '8 other tables of this site' AS section, t.name AS item,
         CASE WHEN to_regclass(t.name) IS NULL THEN 'missing'
              ELSE (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE site_id::text = %L', t.name, coalesce((SELECT id FROM chosen), '')), false, false, '')))[1]::text END AS detail
  FROM (VALUES ('public.site_authors'), ('public.media_assets'), ('public.scraping_sources')) AS t(name)
),
r_sample AS (
  SELECT 80 AS ord, row_number() OVER (ORDER BY created_at DESC, id)::int AS sub, '9 sample rows (newest 30)' AS section,
         slug::text AS item,
         'status=' || coalesce(status::text, '') || ' section=' || coalesce(section::text, '') || '/' || coalesce(subsection::text, '')
         || ' created_at=' || coalesce(created_at::text, 'null') || ' published_at=' || coalesce(published_at::text, 'null')
         || ' image=' || coalesce(featured_image::text, 'none') || ' tags=' || coalesce(array_to_string(tags, ';'), '')
         || ' title=' || left(coalesce(title->>'en', title::text, ''), 80) AS detail
  FROM a ORDER BY created_at DESC, id LIMIT 30
),
r_02 AS (
  SELECT 90 AS ord, 0 AS sub, '10 checks file 02 will make' AS section, 'role aer_migrator / schema aer_ro already exist' AS item,
         (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aer_migrator'))::text || ' / ' || (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'aer_ro'))::text AS detail
  UNION ALL
  SELECT 90, 1, '10 checks file 02 will make', 'PUBLIC-readable relations outside the allow-list (02 stops if > 0)',
         count(*)::text || coalesce(': ' || string_agg(n.nspname || '.' || c.relname, ', '), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('aer_ro', 'pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_schema_privilege('public', n.oid, 'USAGE')
    AND has_table_privilege('public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    AND NOT (c.relkind = 'r' AND n.nspname || '.' || c.relname IN ('net._http_response', 'net.http_request_queue'))
  UNION ALL
  SELECT 90, 2, '10 checks file 02 will make', 'SECURITY DEFINER functions PUBLIC can call (public schema | other schemas)',
         count(*) FILTER (WHERE n.nspname = 'public')::text || ' | ' || count(*) FILTER (WHERE n.nspname <> 'public')::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (n.nspname = 'public' OR has_schema_privilege('public', n.oid, 'USAGE'))
    AND has_function_privilege('public', p.oid, 'EXECUTE')
  UNION ALL
  SELECT 90, 3, '10 checks file 02 will make', 'schemas where PUBLIC can create objects (02 stops if any)',
         coalesce(string_agg(n.nspname, ', '), '(none)')
  FROM pg_namespace n WHERE has_schema_privilege('public', n.oid, 'CREATE')
),
r_cols AS (
  SELECT 95 AS ord, col.ordinal_position::int AS sub, '11 articles columns' AS section, col.column_name::text AS item, col.data_type::text AS detail
  FROM information_schema.columns col WHERE col.table_schema = 'public' AND col.table_name = 'articles'
),
allrows AS (
  SELECT * FROM r_conn UNION ALL SELECT * FROM r_site UNION ALL SELECT * FROM r_status UNION ALL SELECT * FROM r_sec
  UNION ALL SELECT * FROM r_dates UNION ALL SELECT * FROM r_slug UNION ALL SELECT * FROM r_tags UNION ALL SELECT * FROM r_img
  UNION ALL SELECT * FROM r_other UNION ALL SELECT * FROM r_sample UNION ALL SELECT * FROM r_02 UNION ALL SELECT * FROM r_cols
)
SELECT t.section, t.item, t.detail
FROM (
  SELECT ord, sub, section, item, detail FROM allrows
  UNION ALL SELECT 999, 0, '99 total rows', 'rows in this result (this one included)', ((SELECT count(*) FROM allrows) + 1)::text
) t
ORDER BY t.ord, t.sub, t.item;
