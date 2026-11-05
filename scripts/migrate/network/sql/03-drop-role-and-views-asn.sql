-- OWNER-RUN in the Supabase SQL Editor when the ASN migration (incl. the last delta run)
-- is finished, or to start over. Paste the WHOLE file, Run. Nothing to edit.
-- Drops schema asn_ro (the three views), everything asn_migrator owns or was granted in
-- this database, then the role. Touches no shared table and no other role. Safe to re-run.
-- Result: ONE cell asn_cleanup_check, which must be 'CLEANUP OK'.

DO $$
BEGIN
  IF current_database() = 'neondb' THEN
    RAISE EXCEPTION 'DB NAME STOP: connected to neondb (Central), not the old database; nothing was dropped.';
  END IF;
  DROP SCHEMA IF EXISTS asn_ro CASCADE;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asn_migrator') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY asn_migrator';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE format('GRANT asn_migrator TO %I', current_user);
      EXECUTE 'DROP OWNED BY asn_migrator';
    END;
    DROP ROLE asn_migrator;
  END IF;
END $$;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asn_migrator') THEN 'CLEANUP STOP: role asn_migrator still exists'
  WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'asn_ro') THEN 'CLEANUP STOP: schema asn_ro still exists'
  ELSE 'CLEANUP OK'
END AS asn_cleanup_check;
