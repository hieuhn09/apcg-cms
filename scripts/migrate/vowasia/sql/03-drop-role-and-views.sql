-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md trước.
--
-- 03-drop-role-and-views.sql: DỌN sau khi xong (hoặc khi tự kiểm của 02 báo STOP).
-- Xoá schema vowasia_ro (kèm hai view), mọi quyền/đối tượng của vowasia_migrator
-- trong database này, rồi xoá role. Không đụng bảng gốc, không đụng role khác.
--   psql -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
-- Thứ tự quan trọng: DROP OWNED BY trước DROP ROLE (nếu không, DROP ROLE lỗi khi còn grant).
-- Nếu role còn quyền ở database KHÁC trong cùng cụm: chạy DROP OWNED BY ở database đó trước.
-- Chạy lại nhiều lần vẫn an toàn.
-- 03 KHÔNG tắt RLS: nếu đã dùng phương án 1 (02b), gỡ policy và (chỉ khi trước đó RLS
-- đang tắt) tắt RLS BẰNG TAY theo đầu file 02b; NOTICE cuối file in trạng thái để đối chiếu.

-- Đang nối vào đâu, bằng ai. Phải là DB CŨ (không phải Central /neondb). Sai: Ctrl+C ngay.
SELECT current_database() AS database_name, current_user AS running_as;

DROP SCHEMA IF EXISTS vowasia_ro CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vowasia_migrator') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY vowasia_migrator';
    EXCEPTION WHEN insufficient_privilege THEN
      -- Chủ không phải superuser (có CREATEROLE, như Supabase/Neon): PG 16 chỉ cho
      -- DROP OWNED khi có quyền của role đó. Người tạo role giữ ADMIN OPTION nên tự
      -- cấp được; quyền này mất theo role ở DROP ROLE ngay dưới.
      EXECUTE format('GRANT vowasia_migrator TO %I', current_user);
      EXECUTE 'DROP OWNED BY vowasia_migrator';
    END;
  END IF;
END $$;

DROP ROLE IF EXISTS vowasia_migrator;

-- Trạng thái RLS/policy của hai bảng gốc (chỉ đọc), để đối chiếu với bước gỡ tay của 02b.
DO $$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.articles', 'public.sites'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      SELECT c.relrowsecurity, (SELECT count(*) FROM pg_policies p WHERE p.schemaname || '.' || p.tablename = t AND p.policyname LIKE 'vowasia_migrator_%') AS n
        INTO r FROM pg_class c WHERE c.oid = to_regclass(t);
      RAISE NOTICE 'vowasia: AFTER: % rls_enabled=% vowasia_policies_left=%', t, r.relrowsecurity, r.n;
    END IF;
  END LOOP;
END $$;

-- Xác nhận cuối: phải là đúng 'CLEANUP OK'.
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vowasia_migrator') THEN 'CLEANUP STOP: role vowasia_migrator still exists'
  WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vowasia_ro') THEN 'CLEANUP STOP: schema vowasia_ro still exists'
  ELSE 'CLEANUP OK'
END AS vowasia_cleanup_check;
