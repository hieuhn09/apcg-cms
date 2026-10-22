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
  "contentType": "article",
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
| 422 | `{ ok:false, status:"unprocessable", reason:"pillar not writable by engine: <slug>" }` | the pillar is engine-blocked for this tenant (`ENGINE_BLOCKED_PILLARS`: GCV `exclusive` and `pressroom`, BriefAsia `pressroom`, WAD `pressroom` (since 20-10-26), GlobalTravelPost (`gtp`) `press-room` and `events-awards`, VowAsia (`vowasia`) `press-room`, `real-weddings` and `directory`, Asia Economic Review (`aer`) `long-view`, `interviews` and `in-focus`, Pressroom / Press Room / Events & Awards articles come only from editors); the check is on the PRIMARY `pillarSlug` only (a gtp `news` primary with `sections:["events-awards"]` is not blocked by it); case/whitespace-insensitive match (the reason prints the normalised slug); applies to create AND refresh |
| 422 | `{ ok:false, status:"unprocessable", reason:"pillar rule: \"<slug>\" is a single-home pillar: …" }` | single-home pillar rule (`SINGLE_HOME_PILLARS`, BriefAsia `pressroom`, GCV `pressroom`, WAD `pressroom` (since 20-10-26), GlobalTravelPost `gtp` `press-room` and VowAsia `vowasia` `press-room`; gtp `events-awards` is not single-home): a Pressroom item may carry no other `sections[]` entry (an entry equal to the primary is ignored; for a single-home primary an unknown slug is refused too), no `subSectionSlug` / `subSectionSlugs[]` / `secondarySubSections`; and no article may list `pressroom` in `sections[]` (case/whitespace-insensitive). Checked before the idempotency lookup, so it applies to create AND refresh; logged as `integration_error`. Terminal: fix the payload, do not retry. `secondaryPillarSlugs` is never checked (ignored by intake) |
| 5xx | `{ ok:false, status:"error" }` | transient — safe to retry |

### GlobalTravelPost (`gtp`) notes

- Tenant slug / `publicationId` `gtp`. Engine-writable pillars: `news`, `destinations`,
  `business-of-travel`, `experiences-luxury`; `press-room` and `events-awards` are
  editor-only (422 above). Taxonomy source of truth: `scripts/lib/gtp-taxonomy.ts`.
- **`engineDraftId` convention:** send `content-engine:gtp:<article.id>` (stable per
  engine row, independent of the source URL; the gcv/wad clients already do this). Without
  it Central dedups on `sourceProvenance.url` only, and an article with no source URL has
  no dedupe at all (a retry creates a duplicate).
- **Secondary sections come from `sections[]`, not `secondaryPillarSlugs`** (the latter is
  accepted and ignored). Recommended for gtp: one primary pillar plus an optional
  sub-section, no secondary sections.
- `byline` must equal a gtp `authors.name` exactly (`Daniel Cheong`, `Priya Nair`,
  `Marcus Tan`, `Natalie Ong`, `Yuki Hamada`, `GTP Newsroom`); an unmatched byline
  silently creates a "ghost" author (role Staff Writer, no slug, no rank).
- The tenant is created with `autoPublishEngineDrafts=false`, so gtp intake lands
  `pending_review`.

### VowAsia (`vowasia`) notes

- Tenant slug / `publicationId` `vowasia` (one string for the content-engine registry id,
  the Central tenant slug, the hub `cmsSlug` and the intake `publicationId`).
  Engine-writable pillars: `venues`, `destination-weddings`, `style`, `planning`,
  `wedding-business`; `press-room` is single-home AND editor-only (both 422 rows above);
  `real-weddings` and `directory` are editor-only but NOT single-home (owner decision
  13-10-26). Taxonomy source of truth: `scripts/lib/vowasia-taxonomy.ts`.
- Single pillar: send one primary `pillarSlug` and no `sections[]` entries (owner decision
  13-10-26); an optional sub-section is allowed except under `press-room`.
- `engineDraftId`: `content-engine:vowasia:<article.id>`, same convention as gtp.
- `byline` must equal a vowasia `authors.name` exactly (`Serene Chia`, `Aarti Menon`,
  `Danish Iskandar`, `Hanna Pang`, `Yumi Nakagawa`, `Ishaan Bhatt`; names from the design
  team page, PENDING owner confirmation); an unmatched byline creates a "ghost" author.
- Status 13-10-26: code only. The tenant, the taxonomy rows and any engine record do NOT
  exist yet; intake for `vowasia` answers 4xx until the owner creates them.

### Asia Economic Review (`aer`) notes

- Tenant slug / `publicationId` `aer`. Engine-writable pillars: `asia-watch`, `briefings`,
  `corporate-asia`; `long-view`, `interviews`, `in-focus` are editor-only (422 `pillar not
  writable by engine`, row above). No single-home pillar. Taxonomy source of truth:
  `scripts/lib/aer-taxonomy.ts`.
- `engineDraftId`: `content-engine:aer:<article.id>`, same convention as gtp/vowasia.
- `byline` must equal an aer `authors.name` exactly (`Lena Ho`, `Arjun Menon`,
  `Mei Fong Chua`, `Rahul Sethi`); no shared "editorial team" byline.
- Status 19-10-26: code only; intake for `aer` answers 4xx until the owner creates the
  tenant, taxonomy and engine record.

### AsiaBeautyBrief (`abb`) notes

- Tenant slug / `publicationId` `abb`. Engine-writable pillars: `briefing`, `markets`,
  `supply`, `trends`, `professional`; `pressroom` is single-home AND editor-only (422).
  `press-room` is not a pillar on abb and is not blocked. Taxonomy source of truth:
  `scripts/lib/abb-taxonomy.ts` (from the canonical `abb-taxonomy_22-10-26.json`).
- `byline` must equal an abb `authors.name` exactly: `Joanne Lau`, `Kim Seo-yeon`,
  `Kavita Rao`, `Emi Fujita`, `Nathan Leong`.
- **Booths (The Beauty Exhibition) are editor-only.** The engine has no write path: intake
  only creates/refreshes articles, there is no booths engine action, and an engine token
  does not authenticate Payload REST (`/api/booths` answers 403; probe
  `npm run probe:abb-booths`). The booth-to-article link is stored on the booth.
- Status 22-10-26: code only; tenant, taxonomy and engine record do not exist yet.

### `contentType` — what the document is

Optional. `"article"` (default) or `"daily-brief"`. Set on create only; a refresh
of an existing draft never re-classifies it.

Omit it for ordinary output. Send `"daily-brief"` for a machine-composed digest
of a publication's own reporting — the content-engine's AM/PM brief — so reader
sites can keep it out of news feeds while still serving it at its own URL.

Unrecognised values fall back to `"article"` rather than returning 400: this
endpoint carries several publications' daily output and must not start rejecting
posts over a metadata field it does not recognise.

Ordinary articles carry no marker of their own — absence means article. Consumers
filter with a positive match (`content_type=article`), never by negation.

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
