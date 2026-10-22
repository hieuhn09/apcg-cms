-- OWNER-RUN in the Supabase SQL Editor when the ABB migration (incl. the last delta run)
-- is finished, or to start over. Paste the WHOLE file, Run. Nothing to edit.
-- Drops schema abb_ro (the three views), everything abb_migrator owns or was granted in
-- this database, then the role. Touches no shared table and no other role. Safe to re-run.
-- Result: ONE cell abb_cleanup_check, which must be 'CLEANUP OK'.

DO $$
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was dropped.';
  END IF;
  DROP SCHEMA IF EXISTS abb_ro CASCADE;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abb_migrator') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY abb_migrator';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE format('GRANT abb_migrator TO %I', current_user);
      EXECUTE 'DROP OWNED BY abb_migrator';
    END;
    DROP ROLE abb_migrator;
  END IF;
END $$;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abb_migrator') THEN 'CLEANUP STOP: role abb_migrator still exists'
  WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'abb_ro') THEN 'CLEANUP STOP: schema abb_ro still exists'
  ELSE 'CLEANUP OK'
END AS abb_cleanup_check;
