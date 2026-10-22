-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md (Cách B) trước.
--
-- 01e-inspect-single-result.sql: bản của 01-readonly-inspect.sql cho SQL Editor của
-- Supabase. Editor chỉ hiện kết quả của CÂU CUỐI, nên toàn bộ nội dung 01 được gộp
-- thành MỘT câu SELECT duy nhất, cộng các mục báo trước chỗ file 02 có thể DỪNG.
--
-- Cách dùng: dán CẢ file vào SQL Editor (New query), bấm Run. Kết quả là MỘT bảng
-- ba cột (section, item, detail). Thứ tự: mục 6 (dòng site VowAsia) ĐẦU TIÊN, rồi 1
-- (database, role), 2, 3, 4, 5, 5a, 5e, 5b, 5c, 5d, 5f, 5g, 6b; hàng CUỐI là
-- 'total rows' (tổng số hàng): nếu Editor cắt bớt hàng, so số đó với số hàng thấy.
--
-- CHỈ ĐỌC: một câu SELECT, không lệnh psql, không đổi cấu hình phiên, không ghi gì.
-- Không in nội dung bài, mật khẩu hay dữ liệu cá nhân: chỉ tên bảng/cột/role, quyền,
-- và dòng site có slug chứa 'vow' (id, slug, name), như file 01.
-- Khi báo lại: CHỈ nêu tên bảng LIÊN QUAN tới VowAsia (bài viết, site); không báo
-- tên các bảng nhạy cảm khác của DB dùng chung.
-- Tên bảng public.articles / public.sites: nếu DB cũ dùng tên khác, sửa trong file
-- (bảng thiếu thì các mục liên quan in 'missing', không báo lỗi). Nếu public.sites
-- thiếu cột id/slug/name, mục 6 in 'columns missing' (không lỗi); khi đó chạy riêng
-- truy vấn dự phòng một dòng ở VOWASIA-LEGACY.md (B2).
-- Mục 5d, 5f, 5g đếm ĐÚNG như điều kiện DỪNG của 02 (không tính hàm trả trigger;
-- 5f: 02 KHÔNG dừng với hàng mang nhãn '(allowed by 02 allow-list)', Amendment 2).

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
  SELECT 55, 1, '5c public privileges', 'database CONNECT | TEMP | can add schemas (02 stops if true)',
         has_database_privilege('public', current_database(), 'CONNECT') || ' | '
         || has_database_privilege('public', current_database(), 'TEMP') || ' | '
         || EXISTS (SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                    WHERE d.datname = current_database() AND a.grantee = 0
                      AND a.privilege_type NOT IN ('CONNECT', 'TEMPORARY'))
  UNION ALL
  SELECT 55, 2, '5c public privileges', 'databases PUBLIC can CONNECT to',
         coalesce(string_agg(d.datname, ', ' ORDER BY d.datname), '(none)')
  FROM pg_database d
  WHERE d.datallowconn AND has_database_privilege('public', d.datname, 'CONNECT')
  UNION ALL
  SELECT 55, 3, '5c public privileges', 'password_encryption',
         coalesce(current_setting('password_encryption', true), 'unknown')
),
s5d AS (
  -- Như 02: hàm trong schema public (02 LUÔN dừng) + hàm ở schema khác mà PUBLIC có
  -- USAGE trên schema (02 dừng trừ khi allow_definer_outside_public = 'yes').
  -- Không tính hàm trả trigger / event_trigger (không gọi trực tiếp được).
  SELECT 56 AS ord, CASE WHEN d.nspname = 'public' THEN 0 ELSE 1 END AS sub,
         '5d security definer callable by PUBLIC' AS section,
         d.nspname || '.' || d.proname AS item,
         CASE WHEN d.nspname = 'public' THEN 'in_public=yes (02 always stops)'
              ELSE 'in_public=no (02 stops unless allowed)' END
         || ' owner=' || d.owner AS detail
  FROM (
    SELECT n.nspname::text AS nspname, p.proname::text AS proname, pg_get_userbyid(p.proowner)::text AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (n.nspname = 'public' OR has_schema_privilege('public', n.oid, 'USAGE'))
      AND has_function_privilege('public', p.oid, 'EXECUTE')
  ) d
  UNION ALL
  SELECT 56, -1, '5d security definer callable by PUBLIC', 'count by schema',
         coalesce(string_agg(x.nspname || '=' || x.n, ', ' ORDER BY x.nspname), '0')
  FROM (
    SELECT n.nspname::text AS nspname, count(*) AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (n.nspname = 'public' OR has_schema_privilege('public', n.oid, 'USAGE'))
      AND has_function_privilege('public', p.oid, 'EXECUTE')
    GROUP BY n.nspname
  ) x
),
s5f AS (
  -- Như 02: mọi bảng/view mà PUBLIC có quyền (bảng hoặc cột; grantee 0 = PUBLIC).
  -- 02 dừng nếu có BẤT KỲ hàng nào KHÔNG mang nhãn '(allowed by 02 allow-list)'
  -- (Amendment 2: đúng net._http_response và net.http_request_queue, relkind 'r').
  SELECT 57 AS ord, 0 AS sub, '5f PUBLIC-readable relations (02 stops on any not allowed by its allow-list)' AS section,
         n.nspname || '.' || c.relname AS item,
         'relkind=' || c.relkind::text
         || CASE WHEN c.relkind = 'r' AND n.nspname || '.' || c.relname IN ('net._http_response', 'net.http_request_queue') THEN ' (allowed by 02 allow-list)'
                 WHEN n.nspname || '.' || c.relname IN ('public.articles', 'public.sites') THEN ' (articles/sites)'
                 ELSE ' (outside articles/sites)' END
         || ' PUBLIC privileges=' || coalesce((SELECT string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type)
                                              FROM aclexplode(c.relacl) a WHERE a.grantee = 0), '(column-level only)') AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('vowasia_ro', 'pg_catalog', 'information_schema', 'pg_toast')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_schema_privilege('public', n.oid, 'USAGE')
    AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0)
         OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                    WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped AND a.grantee = 0))
),
s5g AS (
  -- Như 02: schema mà PUBLIC được tạo đối tượng (quyền schema chỉ có USAGE và quyền
  -- tạo, nên 'khác USAGE' = quyền tạo; 02 dừng nếu có hàng nào).
  SELECT 58 AS ord, 0 AS sub, '5g schemas where PUBLIC can add objects (02 stops on any)' AS section,
         n.nspname::text AS item, 'owner=' || pg_get_userbyid(n.nspowner) AS detail
  FROM pg_namespace n
  WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                WHERE a.grantee = 0 AND a.privilege_type <> 'USAGE')
),
s6b AS (
  SELECT 60 AS ord, CASE col.table_name WHEN 'articles' THEN 0 ELSE 100000 END + col.ordinal_position::int AS sub,
         '6b columns' AS section,
         col.table_name || '.' || col.column_name AS item, col.data_type::text AS detail
  FROM information_schema.columns col
  WHERE col.table_schema = 'public' AND col.table_name IN ('articles', 'sites')
),
s6 AS (
  -- Dòng site của VowAsia (slug chứa 'vow'). Chạy qua query_to_xml chỉ khi bảng
  -- public.sites có thật VÀ có đủ cột id, slug, name, để câu này không lỗi.
  SELECT 1 AS ord, 0 AS sub, '6 vowasia site row' AS section,
         coalesce((xpath('/row/slug/text()', r))[1]::text, '') AS item,
         'id=' || coalesce((xpath('/row/id/text()', r))[1]::text, '')
         || ' name=' || coalesce((xpath('/row/name/text()', r))[1]::text, '') AS detail
  FROM unnest(xpath('/table/row',
         CASE WHEN (SELECT count(*) FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.sites') AND a.attname IN ('id', 'slug', 'name')
                      AND a.attnum > 0 AND NOT a.attisdropped) = 3
              THEN query_to_xml('SELECT id, slug, name FROM public.sites WHERE lower(slug::text) LIKE ''%vow%'' ORDER BY slug', false, false, '')
         END)) AS r
  UNION ALL
  SELECT 1, -1, '6 vowasia site row', 'public.sites',
         CASE WHEN to_regclass('public.sites') IS NULL THEN 'missing'
              WHEN (SELECT count(*) FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.sites') AND a.attname IN ('id', 'slug', 'name')
                      AND a.attnum > 0 AND NOT a.attisdropped) <> 3 THEN 'columns missing (need id, slug, name): run the fallback query'
              ELSE 'present' END
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
  UNION ALL SELECT ord, sub, section, item, detail FROM s5f
  UNION ALL SELECT ord, sub, section, item, detail FROM s5g
  UNION ALL SELECT ord, sub, section, item, detail FROM s6b
  UNION ALL SELECT ord, sub, section, item, detail FROM s6
),
-- Mục không có dòng nào vẫn hiện một dòng '(none)', để thấy là đã kiểm.
emptyrows AS (
  SELECT x.ord, 0 AS sub, x.section, '(none)' AS item, '' AS detail
  FROM (VALUES (20, '2 public tables/views'), (30, '3 rls policies (public)'), (40, '4 site_id column types'),
               (52, '5a nologin roles reading the tables'), (53, '5e role membership'), (54, '5b connected roles'),
               (57, '5f PUBLIC-readable relations (02 stops on any not allowed by its allow-list)'), (58, '5g schemas where PUBLIC can add objects (02 stops on any)'),
               (60, '6b columns')) AS x(ord, section)
  WHERE NOT EXISTS (SELECT 1 FROM allrows a WHERE a.section = x.section)
),
combined AS (
  SELECT ord, sub, section, item, detail FROM allrows
  UNION ALL SELECT ord, sub, section, item, detail FROM emptyrows
)
SELECT t.section, t.item, t.detail
FROM (
  SELECT ord, sub, section, item, detail FROM combined
  UNION ALL
  SELECT 999, 0, '9 total rows', 'rows in this result (this one included)', ((SELECT count(*) FROM combined) + 1)::text
) AS t
ORDER BY t.ord, t.sub, t.item;
