-- OWNER-RUN in the Supabase SQL Editor, ONLY after 02 returned 'SELF-CHECK OK'.
-- Paste the WHOLE file, Run once. Nothing to type: the file makes a random password of
-- 48 hex characters (0-9, a-f; the same alphabet as `openssl rand -hex 24`, never
-- base64, so no + or / that would break a connection URL), sets it on abb_migrator,
-- and shows it ONCE in the result cell new_secret. The query text holds no secret, so
-- the Editor history does not keep the password.
-- Copy the cell with its copy button, then paste it into the Terminal at the read -s
-- step of NETWORK-LEGACY.md. No screenshot, no chat. Close the query tab afterwards.
-- Each run makes a NEW password (the old one stops working). It does not extend the
-- 14-day VALID UNTIL.
-- Statement log: the password is generated and applied INSIDE the DO block by a nested
-- EXECUTE format(...). log_statement / log_min_duration_statement log only the top-level
-- statement text (this file, which holds no secret), so the literal never reaches the
-- Postgres log (checked 19-10-26 on a local PG16 with log_statement=all: 0 occurrences).
-- Residual risk: pgaudit (with nested-statement logging), auto_explain with
-- log_nested_statements, or an error raised from inside the EXECUTE could still record
-- the ALTER ROLE text with the password; Supabase does not enable these by default. The
-- value also leaves the server once, in the result cell new_secret.

DO $$
DECLARE
  pw text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abb_migrator') OR to_regclass('abb_ro.articles') IS NULL
     OR NOT has_table_privilege('abb_migrator', 'abb_ro.articles', 'SELECT') THEN
    RAISE EXCEPTION '02P STOP: role abb_migrator / views abb_ro are missing (02 did not end in SELF-CHECK OK); nothing was changed.';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'abb_migrator')
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'abb_migrator') THEN
    RAISE EXCEPTION '02P STOP: abb_migrator is superuser, bypasses RLS or is a member of another role; nothing was changed.';
  END IF;
  pw := left(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 48);
  EXECUTE format('ALTER ROLE abb_migrator PASSWORD %L', pw);
  PERFORM set_config('abb.new_secret', pw, true);
END $$;

SELECT coalesce(nullif(current_setting('abb.new_secret', true), ''), 'NOT SHOWN: run the whole file as ONE query in the SQL Editor') AS new_secret,
       'copy once with the cell copy button, then read -s; no screenshot; close this tab after' AS warning;
