-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md trước.
--
-- 01-readonly-inspect.sql: CHỈ ĐỌC (chỉ SELECT). Chạy trên DB cũ (dùng chung
-- VowAsia + site khác) bằng role hiện có của chủ, ví dụ:
--   psql -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/01-readonly-inspect.sql
-- (URL kết nối lấy từ biến môi trường đã nhập bằng `read -s`, không gõ trên dòng lệnh.)
--
-- Khi báo lại: CHỈ nêu tên bảng LIÊN QUAN tới VowAsia (bài viết, site).
-- KHÔNG báo tên các bảng nhạy cảm khác của DB dùng chung.
-- Không file nào ở đây sửa dữ liệu, quyền hay cấu trúc.
-- Dòng SET dưới đây chỉ đổi mặc định của PHIÊN psql này (không ghi gì vào DB):
-- mọi câu sau chạy trong giao dịch chỉ-đọc, nên nếu lỡ có câu ghi, nó bị từ chối.

SET default_transaction_read_only = on;

-- 1. Đang nối vào đâu, bằng ai, role có vượt RLS không.
SELECT current_database() AS database_name, current_user AS current_role_name, version() AS server_version;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

-- 2. Bảng/view trong schema public: chủ sở hữu, cờ RLS (relrowsecurity) và FORCE RLS.
SELECT c.relname AS table_name,
       c.relkind,
       pg_get_userbyid(c.relowner) AS table_owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
ORDER BY c.relname;

-- 3. Policy RLS hiện có trong schema public.
SELECT schemaname, tablename, policyname, permissive, roles, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;

-- 4. Kiểu của các cột site_id (để chọn siteIdKind: uuid | integer | text-safe).
SELECT table_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'site_id'
ORDER BY table_name;

-- 5. Quyền trên hai bảng gốc (relacl) và TOÀN BỘ role đăng nhập được của cụm
--    (không chỉ phiên đang mở: site cũ có thể dùng role chưa kết nối lúc này).
--    Dùng cho quyết định phương án role (HS5): phương án 1 (RLS) chỉ an toàn khi
--    MỌI role đọc/ghi được hai bảng là chủ bảng hoặc vượt RLS.
--    Sửa tên bảng nếu khác (articles, sites).
SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS table_owner, coalesce(c.relacl::text, '(default: owner only)') AS acl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('articles', 'sites')
ORDER BY 1;

SELECT r.rolname, r.rolsuper, r.rolbypassrls,
       has_table_privilege(r.oid, 'public.articles', 'SELECT') AS reads_articles,
       has_table_privilege(r.oid, 'public.sites', 'SELECT') AS reads_sites
FROM pg_roles r
WHERE r.rolcanlogin
ORDER BY 1;

-- 5a. Role KHÔNG đăng nhập được (NOLOGIN, ví dụ anon/authenticated) mà vẫn
--     ĐỌC được hai bảng (trực tiếp, kế thừa hoặc qua PUBLIC; file 02b kiểm thêm quyền ghi). Role đăng nhập dùng chúng
--     qua SET ROLE; khi bật RLS chúng cũng thấy 0 dòng. Bỏ qua role hệ thống pg_*.
SELECT r.rolname, r.rolinherit, r.rolbypassrls,
       has_table_privilege(r.oid, 'public.articles', 'SELECT') AS reads_articles,
       has_table_privilege(r.oid, 'public.sites', 'SELECT') AS reads_sites
FROM pg_roles r
WHERE NOT r.rolcanlogin AND r.rolname NOT LIKE 'pg\_%'
  AND (has_table_privilege(r.oid, 'public.articles', 'SELECT')
       OR has_table_privilege(r.oid, 'public.sites', 'SELECT'))
ORDER BY 1;

-- 5e. Đồ thị thành viên role (ai là thành viên của ai; inherit_option trên PG 16+
--     nằm ở pg_auth_members, trước đó theo rolinherit của thành viên).
SELECT g.rolname AS granted_role, m.rolname AS member, m.rolcanlogin AS member_can_login, m.rolinherit AS member_inherits
FROM pg_auth_members am
JOIN pg_roles g ON g.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE g.rolname NOT LIKE 'pg\_%'
ORDER BY 1, 2;

-- 5b. Các role ĐANG kết nối vào database này (để đối chiếu với 5).
SELECT DISTINCT a.usename AS connected_role, r.rolbypassrls, r.rolsuper
FROM pg_stat_activity a
JOIN pg_roles r ON r.rolname = a.usename
WHERE a.datname = current_database()
ORDER BY 1;

-- 5c. Quyền của PUBLIC mà MỌI role (kể cả role mới) thừa hưởng.
--     ACL của schema public, và quyền trên database này:
SELECT n.nspname, coalesce(n.nspacl::text, '(default)') AS schema_acl
FROM pg_namespace n WHERE n.nspname = 'public';
SELECT has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
       has_database_privilege('public', current_database(), 'TEMP') AS public_temp;

-- 5d. Hàm SECURITY DEFINER (chạy bằng quyền chủ hàm) mà PUBLIC thực thi được,
--     ngoài pg_catalog / information_schema. Role mới cũng gọi được các hàm này.
SELECT n.nspname AS schema_name, p.proname AS function_name, pg_get_userbyid(p.proowner) AS function_owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND has_function_privilege('public', p.oid, 'EXECUTE')
ORDER BY 1, 2;

-- 6b. Cột của hai bảng (dùng để điền __ARTICLE_COLUMNS__ tường minh ở file 02;
--     bỏ cột cá nhân như email, IP, ghi chú nội bộ). Sửa tên bảng nếu khác.
SELECT table_name, column_name, data_type, ordinal_position
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('articles', 'sites')
ORDER BY table_name, ordinal_position;

-- 6. Mẫu tìm dòng site của VowAsia. Sửa tên bảng/cột nếu khác (bảng sites, cột slug).
--    Chỉ chia sẻ id site qua kênh phù hợp nếu thấy an toàn.
SELECT id, slug, name FROM public.sites WHERE lower(slug) LIKE '%vow%' ORDER BY slug;
