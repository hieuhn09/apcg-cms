-- timestamps-fix.sql: OWNER-RUN ONLY, never executed by tools.
-- run id: golden; tenant: gtp; blocks (articles expected to change): 1;
-- slug-map entries: 1; skipped slugNotSqlSafe: 0; skipped timestampsNoSource: 0.
-- Run it on ONE session against the DIRECT (non-pooled) URL, never through a transaction-mode pooler or a GUI client that splits statements:
--   psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix.sql
-- Do NOT add -1 (the file has its own BEGIN/COMMIT). Read the counts above first.
-- Any RAISE aborts the whole transaction: nothing is changed.
BEGIN;
DO $$ DECLARE n int; BEGIN UPDATE articles a SET created_at = TIMESTAMPTZ '2026-08-01T01:02:03.000Z', updated_at = TIMESTAMPTZ '2026-08-02T04:05:06.000Z' FROM articles_locales l WHERE l._parent_id = a.id AND l._locale = 'en' AND l.slug = 'hello-world' AND a.tenant_id = (SELECT id FROM tenants WHERE slug = 'gtp') AND a.origin = 'import' AND a.engine_source_name = 'legacy:globaltravelpost'; GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug hello-world expected 1 article row, got %', n; END IF; UPDATE _articles_v v SET version_created_at = TIMESTAMPTZ '2026-08-01T01:02:03.000Z', version_updated_at = TIMESTAMPTZ '2026-08-02T04:05:06.000Z', updated_at = TIMESTAMPTZ '2026-08-02T04:05:06.000Z' WHERE v.latest = true AND v.parent_id = (SELECT a.id FROM articles a JOIN articles_locales l ON l._parent_id = a.id AND l._locale = 'en' AND l.slug = 'hello-world' WHERE a.tenant_id = (SELECT id FROM tenants WHERE slug = 'gtp') AND a.origin = 'import' AND a.engine_source_name = 'legacy:globaltravelpost'); GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug hello-world expected 1 latest version row, got %', n; END IF; END $$;
COMMIT;
