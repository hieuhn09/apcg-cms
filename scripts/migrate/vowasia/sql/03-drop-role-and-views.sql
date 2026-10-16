-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md trước.
--
-- 03-drop-role-and-views.sql: DỌN sau khi xong (hoặc khi tự kiểm của 02 báo STOP).
-- Xoá schema vowasia_ro (kèm hai view), mọi quyền/đối tượng của vowasia_migrator
-- trong database này, rồi xoá role. Không đụng bảng gốc, không đụng role khác.
--   psql "$LEGACY_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 -v legacy_db=TÊN_DB_CŨ -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
-- -v legacy_db là BẮT BUỘC: tên database CŨ. Toàn bộ phần xoá nằm trong MỘT giao dịch
-- (BEGIN ... COMMIT): thiếu -v legacy_db (lỗi cú pháp ở dòng set_config), nối vào
-- 'neondb' (Central) hoặc database khác tên đã đưa => lỗi, giao dịch bị huỷ, KHÔNG xoá
-- gì, kể cả khi quên -v ON_ERROR_STOP=1 (các lệnh sau lỗi đều bị từ chối, COMMIT thành
-- ROLLBACK). Với -t -A, dòng cuối in ra là đúng 'CLEANUP OK' khi xong.
-- Thứ tự quan trọng: DROP OWNED BY trước DROP ROLE (nếu không, DROP ROLE lỗi khi còn grant).
-- Nếu role còn quyền ở database KHÁC trong cùng cụm: chạy DROP OWNED BY ở database đó trước.
-- Chạy lại nhiều lần vẫn an toàn.
-- 03 KHÔNG tắt RLS: nếu đã dùng phương án 1 (02b), gỡ policy và (chỉ khi trước đó RLS
-- đang tắt) tắt RLS BẰNG TAY TRƯỚC, theo đầu file 02b; NOTICE cuối file in trạng thái để đối chiếu.

-- Đang nối vào đâu, bằng ai (chỉ để ghi lại; chốt thật là khối DO ngay dưới).
SELECT current_database() AS database_name, current_user AS running_as;

BEGIN;

-- set_config(..., true): chỉ sống trong giao dịch này; khối DO ngay dưới đọc nó trong
-- cùng giao dịch. Lỗi ở bất kỳ dòng nào => cả giao dịch huỷ, không xoá gì.
SELECT set_config('vowasia.legacy_db', :'legacy_db', true) IS NOT NULL AS legacy_db_given;
DO $$
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was dropped.';
  END IF;
  IF coalesce(current_setting('vowasia.legacy_db', true), '') = '' OR current_database() <> current_setting('vowasia.legacy_db', true) THEN
    RAISE EXCEPTION 'DB NAME STOP: connected database is not the given legacy_db; nothing was dropped.';
  END IF;
END $$;

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

COMMIT;

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
