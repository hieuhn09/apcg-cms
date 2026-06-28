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
