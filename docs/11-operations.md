# Operations

## Publish & rollback (content)

- **Publish:** an editor sets `workflowStatus = published` (and Payload `_status`
  to published). The revalidate webhook fires to the tenant frontend; translation
  jobs enqueue.
- **Unpublish:** set status to `hidden` or `archived`. The webhook fires; the
  public API stops returning it.
- **Content rollback:** Payload drafts/versions are enabled — open the article's
  **Versions** tab and restore a prior version.

## Schema migrations

- Create after a schema change: `npm run payload:migrate:create`.
- Apply: `npm run payload:migrate` (uses `DATABASE_DIRECT_URL` for DDL).
- Production build runs `node scripts/migrate-prod.mjs && next build`.
- **Add the composite per-tenant unique indexes** after the first migration
  (`UNIQUE (tenant_id, slug)` on articles/pillars/tags/sectors/newsletters/podcasts)
  — see [04-modules-and-data-model.md](04-modules-and-data-model.md).

## Backup

- **Database:** rely on Supabase automated backups + periodic `pg_dump` of the
  central DB. This is now a single backup target instead of N.
- **Media:** R2 versioning / lifecycle on the central bucket.

## Error handling & monitoring

Admin → **Activity Log** (filter by tenant + event type) is the operational view:
`engine_auth_failed`, `engine_tenant_denied`, `engine_action_denied`,
`integration_error`, `engine_write_skipped`, `conflict_logged`, `translation_failed`,
`article_published/unpublished`, `status_changed`. **Engine Conflict Log** shows
per-field blocked overwrites. **Content Engines** shows each engine's `lastSeenAt`
and status.

## Runbooks

- **A content engine stops working:** check Content Engines `lastSeenAt`; check
  Activity Log for `engine_auth_failed` (rotated/expired token) or
  `engine_tenant_denied`/`engine_action_denied` (permissions). Re-mint the token or
  fix `allowedTenants`/`allowedActions`. Intake is idempotent, so a backlog can be
  replayed safely.
- **Translation failures:** Activity Log `translation_failed`; the `translationJobs`
  row keeps `lastError` + `attempts`. Re-queue by re-publishing the source or
  resetting the job status to `queued`.
- **A website is not receiving new content:** verify the article is `published`;
  check the revalidate webhook reached `{frontendUrl}/api/revalidate` (Central logs
  `[revalidate] →`); verify `REVALIDATE_SECRET` matches `CENTRAL_SIGNING_SECRET`;
  the per-query `revalidate` window is the fallback (content appears within the
  window even if a webhook is missed).
- **A user accessed the wrong tenant:** they cannot — reads/writes are tenant-scoped
  by access control, and machine/public traffic is scoped by token. If a user
  reports missing content, check their `tenants` membership rows.
- **Engine tried to overwrite human content:** expected and safe — the write is
  refused (409) and logged in Engine Conflict Log + Activity Log. No data lost.

- **Enabling BriefAsia Pressroom (single-home pillar):** the rule ships in code
  (`SINGLE_HOME_PILLARS`); the pillar row is created by the owner, LAST, after the CMS and
  BriefAsia web deploys are Ready. Run `npm run audit:add-pressroom` (dry run, review),
  then `npm run audit:add-pressroom -- --apply --confirm-host=<prod DB host>` from an
  interactive terminal (the script refuses non-local DBs without both, never overwrites
  an existing row, and must not be run with a tunnelled prod DB open). Pressroom is
  editor-only: the content engine is blocked from it (422 `pillar not writable by
  engine: pressroom`, create and refresh). Rollback note: removing the `brief-asia`
  entry from `ENGINE_BLOCKED_PILLARS` re-enables engine writes. Never rename or delete the `pressroom` pillar slug once articles exist
  (the Pillars guards refuse it). Rollback per step: revert the PR(s); delete the row
  only while zero Pressroom articles/sub-sections exist; to remove content, stop the
  engine and archive the articles first. Before re-enabling after any rollback, audit
  articles and versions that reference the Pressroom pillar (the hook cannot see
  violations created while it was absent).

- **Enabling GCV Pressroom (single-home pillar, GCV Pressroom parity):** the GCV
  `pressroom` pillar row already exists in production, so there is NO
  `audit:add-pressroom` step. The rule ships in code (`gcv` entries in
  `SINGLE_HOME_PILLARS` and `ENGINE_BLOCKED_PILLARS`): GCV Pressroom articles may carry
  no secondary sections, no sub-section, no `exclusive` flag; no article may add GCV
  Pressroom as a secondary section; the pillar can have no sub-sections; author is
  optional; the content engine gets 422 `pillar not writable by engine: pressroom` on
  create and refresh. WAD's `pressroom` is unaffected. Steps: (1) the violator query below
  is OPTIONAL when the tenant has no Pressroom articles (true for GCV at merge); otherwise,
  BEFORE deploying the CMS, the owner runs it READ-ONLY (never by agents against prod)
  and fixes or accepts the hits — existing violators are grandfathered until their
  taxonomy is next saved, when the hook rejects the save; version-table (`v_*`) hits are
  history only; (2) deploy the CMS and gcv-web (any order). Rollback: remove the two
  `gcv` `pressroom` entries from the constants and redeploy (re-run the query before
  re-enabling).

  ```sql
  WITH t AS (SELECT id FROM tenants WHERE slug='gcv'),
  p AS (SELECT id FROM pillars WHERE slug='pressroom' AND tenant_id=(SELECT id FROM t))
  SELECT 'secondary_on_pressroom_article' k, count(*) FROM articles_secondary_sections s JOIN articles a ON a.id=s._parent_id WHERE a.pillar_id IN (SELECT id FROM p)
  UNION ALL SELECT 'subsection_on_pressroom_article', count(*) FROM articles WHERE pillar_id IN (SELECT id FROM p) AND sub_section_id IS NOT NULL
  UNION ALL SELECT 'exclusive_pressroom_article', count(*) FROM articles WHERE pillar_id IN (SELECT id FROM p) AND exclusive
  UNION ALL SELECT 'pressroom_as_secondary_elsewhere (V3)', count(*) FROM articles_secondary_sections WHERE pillar_id IN (SELECT id FROM p)
  UNION ALL SELECT 'subsections_under_pressroom', count(*) FROM subsections WHERE pillar_id IN (SELECT id FROM p)
  UNION ALL SELECT 'v_secondary_on_pressroom', count(*) FROM _articles_v_version_secondary_sections s JOIN _articles_v v ON v.id=s._parent_id WHERE v.version_pillar_id IN (SELECT id FROM p)
  UNION ALL SELECT 'v_pressroom_as_secondary', count(*) FROM _articles_v_version_secondary_sections WHERE pillar_id IN (SELECT id FROM p)
  UNION ALL SELECT 'v_subsection', count(*) FROM _articles_v WHERE version_pillar_id IN (SELECT id FROM p) AND version_sub_section_id IS NOT NULL
  UNION ALL SELECT 'v_exclusive', count(*) FROM _articles_v WHERE version_pillar_id IN (SELECT id FROM p) AND version_exclusive;
  ```

## Token rotation

`tsx scripts/mint-token.ts read --tenant <slug>` / `engine --engine "<name>"`.
Revoke a read token by setting its `readTokens` row status to `revoked`; suspend an
engine by setting its status. Tokens are stored hashed; rotate freely.

## Scaling notes

- One DB, one bucket — back up and monitor once.
- `activityLog` grows fast; index `(tenant, eventType, createdAt)` and add a
  retention/rollup job before volume is large (deferred).
- Add read replicas / connection pooling (PgBouncer) as read traffic grows; the
  public API is read-heavy and cache-fronted.
