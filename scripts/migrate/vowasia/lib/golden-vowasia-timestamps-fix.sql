-- timestamps-fix.sql: OWNER-RUN ONLY, never executed by tools.
-- run id: golden; tenant: vowasia; marker: legacy:vowasia; blocks (articles expected to change): 1;
-- journaled articles of this run: 3; skipped (unsafe slug or no legacy timestamps): 2.
-- Every block is limited to ONE article id created by THIS run (Q11).
-- Run it on ONE session against the DIRECT (non-pooled) URL:
--   psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix.sql
-- Do NOT add -1 (the file has its own BEGIN/COMMIT). Any RAISE aborts the whole transaction: nothing is changed.
BEGIN;
DO $$ DECLARE n int; BEGIN UPDATE articles a SET created_at = TIMESTAMPTZ '2025-08-01T01:02:03.000Z', updated_at = TIMESTAMPTZ '2025-08-02T04:05:06.000Z' FROM articles_locales l WHERE a.id = 41 AND l._parent_id = a.id AND l._locale = 'en' AND l.slug = 'hello-world' AND a.tenant_id = (SELECT id FROM tenants WHERE slug = 'vowasia') AND a.origin = 'import' AND a.engine_source_name = 'legacy:vowasia'; GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug hello-world (id 41) expected 1 article row, got %', n; END IF; UPDATE _articles_v v SET version_created_at = TIMESTAMPTZ '2025-08-01T01:02:03.000Z', version_updated_at = TIMESTAMPTZ '2025-08-02T04:05:06.000Z', updated_at = TIMESTAMPTZ '2025-08-02T04:05:06.000Z' WHERE v.latest = true AND v.parent_id = (SELECT a.id FROM articles a JOIN articles_locales l ON a.id = 41 AND l._parent_id = a.id AND l._locale = 'en' AND l.slug = 'hello-world' AND a.tenant_id = (SELECT id FROM tenants WHERE slug = 'vowasia') AND a.origin = 'import' AND a.engine_source_name = 'legacy:vowasia'); GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug hello-world (id 41) expected 1 latest version row, got %', n; END IF; END $$;
COMMIT;
