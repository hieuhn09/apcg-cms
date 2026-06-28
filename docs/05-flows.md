# Key Flows

## 1. Article workflow

```
draft → pending_review → approved → scheduled → published → hidden → archived
```

- Created by admin, editor, contributor, content engine, or import.
- `version` bumps on every write; `editedByHuman` flips true on any human write
  (`articleBookkeeping`).
- Publish authority is role-gated: a contributor without `canPublish` is limited to
  `draft`/`pending_review` (`enforceStatusAuthority`); editors+ may publish/schedule.
- Every status change + create is recorded in `activityLog` (`articleActivity`).
- On publish, the revalidate webhook fires to the tenant frontend, and translation
  jobs are enqueued for supported target languages.

## 2. Content-engine flow

```
engine ──POST /api/engine/intake (Bearer engine token)──▶ Central CMS
  1. token → engine (hashed lookup) → must be active
  2. tenant ← body.publicationId (or the engine's single allowed tenant)
            → must be in engine.allowedTenants
  3. action create_article must be in engine.allowedActions
  4. tenant feature `articles` must be enabled
  5. idempotency: find existing by (tenant, engineDraftId) else (tenant, engineSourceUrl)
       - existing & human-edited        → 409 conflict (logged)
       - existing & engine-owned        → refresh; skip locked fields (logged);
                                          requires update_article
       - none                           → create in pending_review (NOT published)
  6. resolve pillar/tags/author/sections/countries (tenant-scoped, find-or-create)
  7. markdown → Lexical; best-effort hero upload
  8. write with provenance (origin=engine, lastEngine, version); ActivityLog
```

Responses: `201 {ok, articleId, status:"pending_review"}` on create;
`200 {ok, articleId, status:"refreshed", skippedLockedFields}` on refresh;
`409 {ok:false, status:"conflict", reason}` on human-edited / version mismatch;
`401/403/422` for auth/permission/feature; `5xx` transient (engine retries).

## 3. Translation flow

```
publish article
  → enqueueTranslations: targets = tenant.supportedLanguages − sourceLanguage
      for each target not approved/locked/up-to-date:
        create translationJob(queued, sourceVersion); set translationStatus=pending
translation engine
  → GET  /api/engine/translation?publicationId=  (claims queued jobs)
  → POST /api/engine/translation { articleId, locale, fields:{title,dek,body_markdown} }
        - approved/locked target → 409 (never overwritten)
        - else write that locale only; state=machine_translated; complete the job
editor reviews in admin → state=approved (or locked)
frontend reads the STORED translation for the requested locale (no on-request translation)
source content changes → non-protected targets marked `outdated` (re-queued on next publish)
```

## 4. Website integration flow

```
frontend (CMS_URL + CMS_READ_TOKEN)
  → GET /api/public/articles?pillar=&locale=        (list)
  → GET /api/public/articles/:slug?locale=          (single)
  → GET /api/public/site?locale=                    (brand/SEO/contact/socials/pillars/features)
  → GET /api/public/menus?type=header|footer&locale=
  → GET /api/public/{podcasts|newsletters|corrections|wire|market}  (feature-gated → 404 if off)
  all responses: published-only, this-tenant-only, locale clamped to supportedLanguages

publish in Central → afterChange hook POSTs signed { token } to {tenant.frontendUrl}/api/revalidate
  → frontend verifies (REVALIDATE_SECRET == CENTRAL_SIGNING_SECRET) → revalidateTag(tags)

preview: admin "Preview" → /api/preview/mint (auth + tenant check) → signed token →
  redirect to {frontendUrl}/preview?token= → frontend → GET /api/public/preview?token= (draft)
```

See [08-content-engine-integration.md](08-content-engine-integration.md) and
[09-website-integration.md](09-website-integration.md) for the full contracts.
