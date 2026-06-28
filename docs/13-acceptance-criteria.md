# Acceptance Criteria

Sign-off checklist for the MVP. Grouped by capability; each item is verifiable in
the admin or via an API call.

## Multi-tenant isolation

- [ ] One admin manages both tenants; the tenant selector scopes all list views.
- [ ] A Website Admin / Editor / Contributor of tenant A cannot see or edit tenant
      B's content (lists return only their tenant; direct access denied).
- [ ] A System Admin sees and manages all tenants.
- [ ] A public read token for tenant A returns only tenant A's published content.

## Roles & workflow

- [ ] Article statuses flow draft → pending_review → approved → scheduled →
      published → hidden → archived.
- [ ] A contributor without `canPublish` cannot set published/scheduled (limited to
      draft/pending_review); an editor can.
- [ ] `version` increments on every write; `editedByHuman` flips true on a human
      edit.
- [ ] Status changes + creates appear in the Activity Log.

## Multiple content engines

- [ ] Two engines exist with distinct hashed tokens.
- [ ] Each engine can write only to its `allowedTenants` and `allowedActions`; a
      denied attempt returns 403 and is logged.
- [ ] Suspending/revoking an engine blocks its next request (401, logged).
- [ ] No shared all-powerful engine token exists.

## Safe automation

- [ ] Re-sending the same draft (same `engineDraftId`/`engineSourceUrl`) does not
      create a duplicate — it refreshes the engine-owned record.
- [ ] An engine cannot overwrite a human-edited article (409) or a locked field
      (skipped + Engine Conflict Log entry).
- [ ] A version mismatch (`expectedVersion`) is refused (409).
- [ ] Transient errors return 5xx (retryable); bad requests return 4xx (terminal).
- [ ] Provenance is stored: origin, lastEngine, engineSourceUrl/Name, processingVersion.

## Multi-language & translation

- [ ] Each tenant has its own `supportedLanguages` subset.
- [ ] Publishing a source enqueues translation jobs for supported targets; status
      shows pending.
- [ ] A translation result writes that locale only and sets machine_translated.
- [ ] Editing the source marks non-protected target locales `outdated`.
- [ ] approved/locked translations are never auto-overwritten (409 on engine retry).

## Frontend integration

- [ ] A frontend with a read token gets published articles (list + by slug), menus,
      and site settings, in a requested supported locale.
- [ ] Disabled features return 404 for that tenant.
- [ ] Publishing triggers a revalidate webhook the frontend verifies and acts on.
- [ ] Preview shows a draft via a signed token; a slug alone does not.

## Media

- [ ] Media belongs to a tenant; a tenant's API lists only its media.
- [ ] alt/caption are per-language.
- [ ] Uploads go to R2 (object storage), with image-size derivatives.

## Migration & rollback

- [ ] Import produces matching per-collection counts vs source, per tenant.
- [ ] Slugs, locales, relationships, and provenance are preserved (parity checklist
      passes).
- [ ] Reader data resolves to migrated articles after backfill.
- [ ] A flag flip rolls the frontend back to the old stack.

## Documentation

- [ ] Docs are sufficient for a dev to connect a new website and register a new
      engine without reading the CMS internals.

## Engineering gates (already verified in this build)

- [x] `tsc --noEmit` passes.
- [x] `next build` (production) succeeds — all routes compile.
- [x] `next lint` passes with no warnings/errors.
