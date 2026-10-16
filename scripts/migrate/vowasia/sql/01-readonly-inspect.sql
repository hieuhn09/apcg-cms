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

-- 5. Các role ĐANG kết nối vào database này (site cũ): có vượt RLS không.
--    Dùng cho quyết định phương án role (HS5): phương án 1 (RLS) chỉ an toàn khi
--    MỌI role của site cũ vượt RLS hoặc là chủ bảng.
SELECT DISTINCT a.usename AS connected_role, r.rolbypassrls, r.rolsuper
FROM pg_stat_activity a
JOIN pg_roles r ON r.rolname = a.usename
WHERE a.datname = current_database()
ORDER BY 1;

-- 6. Mẫu tìm dòng site của VowAsia. Sửa tên bảng/cột nếu khác (bảng sites, cột slug).
--    Chỉ chia sẻ id site qua kênh phù hợp nếu thấy an toàn.
SELECT id, slug, name FROM public.sites WHERE lower(slug) LIKE '%vow%' ORDER BY slug;
