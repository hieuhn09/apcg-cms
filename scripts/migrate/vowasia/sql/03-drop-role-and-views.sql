-- OWNER-RUN. KHÔNG tự chạy. Đọc scripts/migrate/vowasia/VOWASIA-LEGACY.md trước.
--
-- 03-drop-role-and-views.sql: DỌN sau khi xong (hoặc khi tự kiểm của 02 báo STOP).
-- Xoá schema vowasia_ro (kèm hai view), mọi quyền/đối tượng của vowasia_migrator
-- trong database này, rồi xoá role. Không đụng bảng gốc, không đụng role khác.
--   psql -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
-- Thứ tự quan trọng: DROP OWNED BY trước DROP ROLE (nếu không, DROP ROLE lỗi khi còn grant).
-- Nếu role còn quyền ở database KHÁC trong cùng cụm: chạy DROP OWNED BY ở database đó trước.
-- Chạy lại nhiều lần vẫn an toàn.

DROP SCHEMA IF EXISTS vowasia_ro CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vowasia_migrator') THEN
    EXECUTE 'DROP OWNED BY vowasia_migrator';
  END IF;
END $$;

DROP ROLE IF EXISTS vowasia_migrator;
