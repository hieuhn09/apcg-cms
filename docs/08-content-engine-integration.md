# Content-Engine Integration

For engine developers. The Central CMS accepts the **same draft contract** the
existing engine already sends to brief-asia/DTW, extended with optional
`publicationId` (tenant routing) and `engineDraftId` (idempotency). The
content-engine repo itself does **not** change beyond config/token/registry entries.

## Register an engine (System Admin)

1. Admin → **Content Engines → Create**: name, type, status `active`.
2. Paste a freshly generated token (≥16 chars) into **rawToken** — it is hashed on
   save and shown nowhere again. (Or `tsx scripts/mint-token.ts engine --engine "<name>"`.)
3. Set **allowedTenants** (which sites it may write) and **allowedActions**
   (`create_article`, `update_article`, `create_translation`, `update_translation`,
   `upload_media`, …). Optionally **rateLimitPerMin**.

Each engine has its own credential — never a shared admin token. Suspend or revoke
by flipping **status**.

## Send a draft

```
POST {CMS_URL}/api/engine/intake
Authorization: Bearer <engine token>
Content-Type: application/json
```

```json
{
  "publicationId": "brief-asia",
  "engineDraftId": "engine:briefasia:2026-06-28:abc123",
  "title": "Headline for editor review",
  "dek": "Short standfirst.",
  "pillarSlug": "asia",
  "body_markdown": "# Markdown body...",
  "tags": ["Policy", "Markets"],
  "takeaways": ["Point one", "Point two"],
  "byline": "Mei Lin Tan",
  "heroImageUrl": "https://example.com/image.jpg",
  "sections": ["finance"],
  "countries": ["sg", "vn"],
  "sourceProvenance": { "url": "https://source", "name": "Source Publisher", "accessedAt": "2026-06-28T02:00:00Z" },
  "publishedAt": "2026-06-28T03:00:00Z",
  "expectedVersion": 3
}
```

- `publicationId` is required only if the engine is allowed on more than one
  tenant; otherwise it defaults to the engine's single allowed tenant.
- `engineDraftId` is the idempotency key (per tenant). If omitted, `sourceProvenance.url`
  is used.
- Drafts are created in **`pending_review`** — the engine does NOT publish. An
  editor reviews and publishes.

## Responses

| Status | Body | Meaning |
|---|---|---|
| 201 | `{ ok:true, articleId, status:"pending_review", engineDraftId }` | new draft created |
| 200 | `{ ok:true, articleId, status:"refreshed", skippedLockedFields }` | engine-owned draft refreshed |
| 409 | `{ ok:false, status:"conflict", reason:"human_edited_content_not_overwritten", articleId }` | a human edited it — not overwritten |
| 409 | `{ ok:false, status:"conflict", reason:"version_mismatch", currentVersion }` | `expectedVersion` stale |
| 401 | `{ ok:false, status:"unauthorized" }` | bad/suspended token |
| 403 | `{ ok:false, status:"forbidden", reason }` | tenant/action not allowed |
| 422 | `{ ok:false, status:"unprocessable", reason }` | feature disabled / unknown pillar |
| 5xx | `{ ok:false, status:"error" }` | transient — safe to retry |

**Retry rule:** retry on 5xx (transient). Do NOT retry 4xx/409 (terminal).

## Duplicate handling

The CMS dedups per tenant on `engineDraftId`, then `engineSourceUrl`. Re-sending
the same draft refreshes the existing engine-owned record (no duplicate). Once a
human edits it, re-sends return 409 and are not applied.

## Conflict handling

On a refresh, any field listed in the article's **lockedFields** is skipped and
recorded in **Engine Conflict Log** (with `engineValue` vs `currentValue`). A
human-edited article is refused entirely (409). All outcomes are recorded in the
**Activity Log**.

## Translation jobs

A translation engine (action `create_translation`) claims work and returns results:

```
GET  {CMS_URL}/api/engine/translation?publicationId=brief-asia      → { jobs:[...] }
POST {CMS_URL}/api/engine/translation
     { "articleId": 123, "locale": "vi", "jobId": "...",
       "fields": { "title": "...", "dek": "...", "body_markdown": "..." } }
```

Approved/locked translations are never overwritten (409). See
[10-translation.md](10-translation.md).

## Check activity

Admin → **Activity Log** filters by tenant + event type (engine_write_accepted /
_skipped, engine_auth_failed, engine_tenant_denied, engine_action_denied,
conflict_logged, translation_*). **Content Engines** shows each engine's
`lastSeenAt` + status.

## Revoke

Set the engine **status** to `suspended` or `revoked` — the next request is
rejected with 401 and logged.
