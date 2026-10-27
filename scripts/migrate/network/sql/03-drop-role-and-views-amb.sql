-- OWNER-RUN in the Supabase SQL Editor when the AMB migration (incl. the last delta run)
-- is finished, or to start over. Paste the WHOLE file, Run. Nothing to edit.
-- Drops schema amb_ro (the three views), everything amb_migrator owns or was granted in
-- this database, then the role. Touches no shared table and no other role. Safe to re-run.
-- Result: ONE cell amb_cleanup_check, which must be 'CLEANUP OK'.

DO $$
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was dropped.';
  END IF;
  DROP SCHEMA IF EXISTS amb_ro CASCADE;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amb_migrator') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY amb_migrator';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE format('GRANT amb_migrator TO %I', current_user);
      EXECUTE 'DROP OWNED BY amb_migrator';
    END;
    DROP ROLE amb_migrator;
  END IF;
END $$;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amb_migrator') THEN 'CLEANUP STOP: role amb_migrator still exists'
  WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'amb_ro') THEN 'CLEANUP STOP: schema amb_ro still exists'
  ELSE 'CLEANUP OK'
END AS amb_cleanup_check;
