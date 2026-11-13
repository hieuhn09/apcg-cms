-- OWNER-RUN in the Supabase SQL Editor of project "globaltravelpost" (database postgres).
-- READ ONLY: one SELECT, writes nothing, changes no setting. Returns exactly ONE table
-- (section, item, detail). The Editor shows only the last result and no NOTICE, so
-- everything is in one statement.
--
-- What it does: prepares the later, separate step that moves the old AsiaMaterialsBrief
-- exhibitor directory (/exhibition/<booth>) into Central's `booths` collection. It is NOT
-- part of the article import. For the two old directory tables public.amb_booths and
-- public.amb_booth_applications it reports, each table guarded by its existence in
-- information_schema (a missing table prints `missing`, nothing fails):
--   - the column list (name:type, in table order);
--   - the columns whose NAME looks secret or personal (mail, phone, mobile, whatsapp, contact,
--     password, passwd, pwd, token, secret, api key, private key, salt, hash, otp): their
--     names are listed, their VALUES are never selected;
--   - rows of this site (site_id 149a9792-a169-47ca-b592-ea1ff1a9ea82, found by
--     01-discover-amb.sql on 27-10-26) and rows of all sites;
--   - every row of this site (at most 50 per table) with all other columns rendered as one
--     JSON text. A table without a site_id column shows all its rows (at most 50) and says so.
--     Only column NAMES are screened: keys inside a json/jsonb column are shown as they are.
-- Values pass through query_to_xml hex-encoded, so `&`, `<` and quotes come back unchanged.
-- Send back the WHOLE result (button "Download CSV"). Secret-looking columns are left out;
-- the rest is the public directory content of the old site.

WITH
k AS (
  SELECT '149a9792-a169-47ca-b592-ea1ff1a9ea82'::text AS site_id,
         '(mail|phone|mobile|whatsapp|contact|password|passwd|pwd|token|secret|api_?key|private_?key|salt|hash|otp)'::text AS secret_re
),
tbl AS (
  SELECT * FROM (VALUES (1, 'amb_booths'), (2, 'amb_booth_applications')) v(tord, t)
),
cols AS (
  SELECT tbl.tord, tbl.t, col.column_name::text AS c, col.data_type::text AS ty, col.ordinal_position::int AS pos,
         col.column_name::text ~* (SELECT secret_re FROM k) AS secret
  FROM tbl JOIN information_schema.columns col ON col.table_schema = 'public' AND col.table_name = tbl.t
),
meta AS (
  SELECT tbl.tord, tbl.t,
         EXISTS (SELECT 1 FROM information_schema.tables it WHERE it.table_schema = 'public' AND it.table_name = tbl.t) AS present,
         EXISTS (SELECT 1 FROM cols WHERE cols.t = tbl.t AND cols.c = 'site_id') AS has_site,
         coalesce((SELECT array_agg(cols.c ORDER BY cols.pos) FROM cols WHERE cols.t = tbl.t AND cols.secret), '{}'::text[]) AS secret_cols
  FROM tbl
),
r_conn AS (
  SELECT 5 AS ord, 0 AS sub, '0 connection' AS section, 'database | role' AS item, current_database() || ' | ' || current_user AS detail
),
r_site AS (
  SELECT 10 AS ord, 0 AS sub, '1 site' AS section, 'site id ' || (SELECT site_id FROM k) AS item,
         coalesce((SELECT 'slug=' || s.slug::text || ' name=' || coalesce(s.name::text, '') FROM public.sites s WHERE s.id::text = (SELECT site_id FROM k)), 'NOT FOUND in public.sites: stop and report') AS detail
),
r_cols AS (
  SELECT 20 + m.tord AS ord, 0 AS sub, '2 columns' AS section, m.t || ' columns (name:type)' AS item,
         CASE WHEN NOT m.present THEN 'missing'
              ELSE (SELECT string_agg(cols.c || ':' || cols.ty, ', ' ORDER BY cols.pos) FROM cols WHERE cols.t = m.t) END AS detail
  FROM meta m
  UNION ALL
  SELECT 20 + m.tord, 1, '2 columns', m.t || ' secret-looking columns (values not shown)',
         CASE WHEN NOT m.present THEN 'missing'
              ELSE coalesce(nullif(array_to_string(m.secret_cols, ', '), ''), '(none)') END
  FROM meta m
),
r_counts AS (
  SELECT 30 + m.tord AS ord, 0 AS sub, '3 row counts' AS section, m.t || ' rows of this site | rows of all sites' AS item,
         CASE WHEN NOT m.present THEN 'missing'
              WHEN NOT m.has_site THEN 'no site_id column | '
                   || (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', m.t), false, false, '')))[1]::text
              ELSE (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I WHERE site_id::text = %L', m.t, (SELECT site_id FROM k)), false, false, '')))[1]::text
                   || ' | ' || (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', m.t), false, false, '')))[1]::text END AS detail
  FROM meta m
),
r_rows AS (
  SELECT 40 + m.tord AS ord, x.n::int AS sub, '4 rows of this site (secret-looking columns left out)' AS section,
         m.t || ' row ' || x.n::text || CASE WHEN m.has_site THEN '' ELSE ' (no site_id column: all rows)' END AS item,
         convert_from(decode(x.v::text, 'hex'), 'UTF8') AS detail
  FROM meta m
  CROSS JOIN LATERAL unnest(
    CASE WHEN m.present THEN xpath('/table/row/j/text()', query_to_xml(format(
      'SELECT encode(convert_to((to_jsonb(r) - %L::text[])::text, ''UTF8''), ''hex'') AS j FROM public.%I r %s ORDER BY 1 LIMIT 50',
      m.secret_cols, m.t,
      CASE WHEN m.has_site THEN format('WHERE r.site_id::text = %L', (SELECT site_id FROM k)) ELSE '' END), false, false, ''))
    END
  ) WITH ORDINALITY AS x(v, n)
),
allrows AS (
  SELECT * FROM r_conn UNION ALL SELECT * FROM r_site UNION ALL SELECT * FROM r_cols
  UNION ALL SELECT * FROM r_counts UNION ALL SELECT * FROM r_rows
)
SELECT t.section, t.item, t.detail
FROM (
  SELECT ord, sub, section, item, detail FROM allrows
  UNION ALL SELECT 999, 0, '99 total rows', 'rows in this result (this one included)', ((SELECT count(*) FROM allrows) + 1)::text
) t
ORDER BY t.ord, t.sub, t.item;
