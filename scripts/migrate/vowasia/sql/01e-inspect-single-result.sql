-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md (Cách B) trước.
--
-- 01e-inspect-single-result.sql: bản của 01-readonly-inspect.sql cho SQL Editor của
-- Supabase. Editor chỉ hiện kết quả của CÂU CUỐI, nên toàn bộ nội dung 01 (mục 1, 2,
-- 3, 4, 5, 5a, 5b, 5c, 5d, 5e, 6, 6b) được gộp thành MỘT câu SELECT duy nhất.
--
-- Cách dùng: dán CẢ file vào SQL Editor (New query), bấm Run. Kết quả là MỘT bảng
-- ba cột (section, item, detail), xếp theo thứ tự mục. Hàng đầu: tên database và
-- role đang dùng.
--
-- CHỈ ĐỌC: một câu SELECT, không lệnh psql, không đổi cấu hình phiên, không ghi gì.
-- Không in nội dung bài, mật khẩu hay dữ liệu cá nhân: chỉ tên bảng/cột/role, quyền,
-- và dòng site có slug chứa 'vow' (id, slug, name), như file 01.
-- Khi báo lại: CHỈ nêu tên bảng LIÊN QUAN tới VowAsia (bài viết, site); không báo
-- tên các bảng nhạy cảm khác của DB dùng chung.
-- Tên bảng public.articles / public.sites: nếu DB cũ dùng tên khác, sửa trong file
-- (bảng thiếu thì các mục liên quan in 'missing', không báo lỗi).

WITH
s1 AS (
  SELECT 10 AS ord, 0 AS sub, '1 connection' AS section, 'database | role' AS item,
         current_database() || ' | ' || current_user AS detail
  UNION ALL
  SELECT 10, 1, '1 connection', 'server_version', version()
  UNION ALL
  SELECT 10, 2, '1 connection', 'role flags',
         'rolsuper=' || r.rolsuper || ' rolbypassrls=' || r.rolbypassrls
  FROM pg_roles r WHERE r.rolname = current_user
),
s2 AS (
  SELECT 20 AS ord, 0 AS sub, '2 public tables/views' AS section, c.relname::text AS item,
         'relkind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
         || ' rls_enabled=' || c.relrowsecurity || ' rls_forced=' || c.relforcerowsecurity AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
),
s3 AS (
  SELECT 30 AS ord, 0 AS sub, '3 rls policies (public)' AS section,
         p.tablename || '.' || p.policyname AS item,
         'permissive=' || p.permissive || ' roles=' || p.roles::text || ' cmd=' || p.cmd AS detail
  FROM pg_policies p WHERE p.schemaname = 'public'
),
s4 AS (
  SELECT 40 AS ord, 0 AS sub, '4 site_id column types' AS section, col.table_name::text AS item,
         col.data_type::text AS detail
  FROM information_schema.columns col
  WHERE col.table_schema = 'public' AND col.column_name = 'site_id'
),
s5 AS (
  SELECT 50 AS ord, 0 AS sub, '5 acl of articles/sites' AS section, t.name AS item,
         CASE WHEN c.oid IS NULL THEN 'missing'
              ELSE 'owner=' || pg_get_userbyid(c.relowner) || ' acl=' || coalesce(c.relacl::text, '(default: owner only)') END AS detail
  FROM (VALUES ('public.articles'), ('public.sites')) AS t(name)
  LEFT JOIN pg_class c ON c.oid = to_regclass(t.name)
  UNION ALL
  SELECT 51, 0, '5 login roles', r.rolname::text,
         'rolsuper=' || r.rolsuper || ' rolbypassrls=' || r.rolbypassrls
         || ' reads_articles=' || coalesce(has_table_privilege(r.oid, to_regclass('public.articles'), 'SELECT')::text, 'missing')
         || ' reads_sites=' || coalesce(has_table_privilege(r.oid, to_regclass('public.sites'), 'SELECT')::text, 'missing')
  FROM pg_roles r WHERE r.rolcanlogin
),
s5a AS (
  SELECT 52 AS ord, 0 AS sub, '5a nologin roles reading the tables' AS section, r.rolname::text AS item,
         'rolinherit=' || r.rolinherit || ' rolbypassrls=' || r.rolbypassrls
         || ' reads_articles=' || coalesce(has_table_privilege(r.oid, to_regclass('public.articles'), 'SELECT')::text, 'missing')
         || ' reads_sites=' || coalesce(has_table_privilege(r.oid, to_regclass('public.sites'), 'SELECT')::text, 'missing') AS detail
  FROM pg_roles r
  WHERE NOT r.rolcanlogin AND r.rolname NOT LIKE 'pg\_%'
    AND (coalesce(has_table_privilege(r.oid, to_regclass('public.articles'), 'SELECT'), false)
         OR coalesce(has_table_privilege(r.oid, to_regclass('public.sites'), 'SELECT'), false))
),
s5e AS (
  SELECT 53 AS ord, 0 AS sub, '5e role membership' AS section,
         g.rolname || ' <- ' || m.rolname AS item,
         'member_can_login=' || m.rolcanlogin || ' member_inherits=' || m.rolinherit AS detail
  FROM pg_auth_members am
  JOIN pg_roles g ON g.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
  WHERE g.rolname NOT LIKE 'pg\_%'
),
s5b AS (
  SELECT DISTINCT 54 AS ord, 0 AS sub, '5b connected roles' AS section, a.usename::text AS item,
         'rolbypassrls=' || r.rolbypassrls || ' rolsuper=' || r.rolsuper AS detail
  FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
  WHERE a.datname = current_database()
),
s5c AS (
  SELECT 55 AS ord, 0 AS sub, '5c public privileges' AS section, 'schema public acl' AS item,
         coalesce(n.nspacl::text, '(default)') AS detail
  FROM pg_namespace n WHERE n.nspname = 'public'
  UNION ALL
  SELECT 55, 1, '5c public privileges', 'database CONNECT | TEMP',
         has_database_privilege('public', current_database(), 'CONNECT') || ' | '
         || has_database_privilege('public', current_database(), 'TEMP')
),
s5d AS (
  SELECT 56 AS ord, 0 AS sub, '5d security definer callable by PUBLIC' AS section,
         n.nspname || '.' || p.proname AS item,
         'owner=' || pg_get_userbyid(p.proowner) AS detail
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND has_function_privilege('public', p.oid, 'EXECUTE')
  UNION ALL
  SELECT 56, -1, '5d security definer callable by PUBLIC', 'count by schema',
         coalesce(string_agg(x.nspname || '=' || x.n, ', ' ORDER BY x.nspname), '0')
  FROM (
    SELECT n.nspname::text AS nspname, count(*) AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND has_function_privilege('public', p.oid, 'EXECUTE')
    GROUP BY n.nspname
  ) x
),
s6b AS (
  SELECT 60 AS ord, col.ordinal_position::int AS sub, '6b columns' AS section,
         col.table_name || '.' || col.column_name AS item, col.data_type::text AS detail
  FROM information_schema.columns col
  WHERE col.table_schema = 'public' AND col.table_name IN ('articles', 'sites')
),
s6 AS (
  -- Dòng site của VowAsia (slug chứa 'vow'). Chạy qua query_to_xml chỉ khi bảng
  -- public.sites có thật, để câu này không lỗi khi tên bảng khác.
  SELECT 70 AS ord, 0 AS sub, '6 vowasia site row' AS section,
         coalesce((xpath('/row/slug/text()', r))[1]::text, '') AS item,
         'id=' || coalesce((xpath('/row/id/text()', r))[1]::text, '')
         || ' name=' || coalesce((xpath('/row/name/text()', r))[1]::text, '') AS detail
  FROM unnest(xpath('/table/row',
         CASE WHEN to_regclass('public.sites') IS NOT NULL
              THEN query_to_xml('SELECT id, slug, name FROM public.sites WHERE lower(slug) LIKE ''%vow%'' ORDER BY slug', false, false, '')
         END)) AS r
  UNION ALL
  SELECT 70, -1, '6 vowasia site row', 'public.sites',
         CASE WHEN to_regclass('public.sites') IS NULL THEN 'missing' ELSE 'present' END
),
allrows AS (
  SELECT ord, sub, section, item, detail FROM s1
  UNION ALL SELECT ord, sub, section, item, detail FROM s2
  UNION ALL SELECT ord, sub, section, item, detail FROM s3
  UNION ALL SELECT ord, sub, section, item, detail FROM s4
  UNION ALL SELECT ord, sub, section, item, detail FROM s5
  UNION ALL SELECT ord, sub, section, item, detail FROM s5a
  UNION ALL SELECT ord, sub, section, item, detail FROM s5e
  UNION ALL SELECT ord, sub, section, item, detail FROM s5b
  UNION ALL SELECT ord, sub, section, item, detail FROM s5c
  UNION ALL SELECT ord, sub, section, item, detail FROM s5d
  UNION ALL SELECT ord, sub, section, item, detail FROM s6b
  UNION ALL SELECT ord, sub, section, item, detail FROM s6
),
-- Mục không có dòng nào vẫn hiện một dòng '(none)', để thấy là đã kiểm.
emptyrows AS (
  SELECT x.ord, 0 AS sub, x.section, '(none)' AS item, '' AS detail
  FROM (VALUES (20, '2 public tables/views'), (30, '3 rls policies (public)'), (40, '4 site_id column types'),
               (52, '5a nologin roles reading the tables'), (53, '5e role membership'), (54, '5b connected roles'),
               (60, '6b columns')) AS x(ord, section)
  WHERE NOT EXISTS (SELECT 1 FROM allrows a WHERE a.section = x.section)
)
SELECT t.section, t.item, t.detail
FROM (
  SELECT ord, sub, section, item, detail FROM allrows
  UNION ALL SELECT ord, sub, section, item, detail FROM emptyrows
) AS t
ORDER BY t.ord, t.sub, t.item;
