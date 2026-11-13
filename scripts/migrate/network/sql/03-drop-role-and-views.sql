-- OWNER-RUN in the Supabase SQL Editor when the AER migration (incl. the last delta run)
-- is finished, or to start over. Paste the WHOLE file, Run. Nothing to edit.
-- Drops schema aer_ro (the three views), everything aer_migrator owns or was granted in
-- this database, then the role. Touches no shared table and no other role. Safe to re-run.
-- Result: ONE cell aer_cleanup_check, which must be 'CLEANUP OK'.

DO $$
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was dropped.';
  END IF;
  DROP SCHEMA IF EXISTS aer_ro CASCADE;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aer_migrator') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY aer_migrator';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE format('GRANT aer_migrator TO %I', current_user);
      EXECUTE 'DROP OWNED BY aer_migrator';
    END;
    DROP ROLE aer_migrator;
  END IF;
END $$;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aer_migrator') THEN 'CLEANUP STOP: role aer_migrator still exists'
  WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'aer_ro') THEN 'CLEANUP STOP: schema aer_ro still exists'
  ELSE 'CLEANUP OK'
END AS aer_cleanup_check;
