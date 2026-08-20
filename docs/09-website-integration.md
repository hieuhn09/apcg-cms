# Website (Frontend) Integration

For frontend developers connecting a website to the Central CMS. Enough to connect
a new site without knowing the CMS internals.

## What the frontend needs

| Env var | Value |
|---|---|
| `CMS_URL` | Central CMS base URL, e.g. `https://cms.yourdomain.com` |
| `CMS_READ_TOKEN` | this tenant's read token (mint in admin) — published content only |
| `REVALIDATE_SECRET` | equals the Central CMS `CENTRAL_SIGNING_SECRET` (verifies revalidate webhooks) |

The frontend never connects to the database and never holds an engine/admin token.

## Public read API

All endpoints require `Authorization: Bearer <CMS_READ_TOKEN>`. The token implies
the tenant; responses are **published-only**, **this-tenant-only**, and the
`locale` is clamped to the tenant's `supportedLanguages` (falling back to its
default). Disabled features return **404**.

| Endpoint | Returns |
|---|---|
| `GET /api/public/articles?locale=&pillar=&country=&tag=&page=&limit=&sort=` | list envelope `{ docs, totalDocs, page, hasNextPage, totalPages }` |
| `GET /api/public/articles?content_type=article\|daily-brief` | narrow by what the document is; **omit to get everything** (default). Combines with every other filter above |
| `GET /api/public/articles?ids=1,2,3&locale=` | resolve a set by id (saved/history rails) |
| `GET /api/public/articles?q=&locale=` | search (title/dek) |
| `GET /api/public/articles?flag=deepDive\|sponsored\|pinnedToLatest\|breaking` | one-flag feed; `pinnedToLatest` excludes articles whose `pinnedUntil` has passed (empty `pinnedUntil` = pinned until manually unticked; the hourly `cron/unpin-expired` sweep clears the stale checkbox) |
| `GET /api/public/articles/:slug?locale=` | single `{ doc }` |

#### `content_type` — keeping daily briefs out of news feeds

The content-engine publishes a machine-composed AM/PM digest through the same
intake as ordinary articles, marked `contentType: "daily-brief"`. Left alone it
lands in every surface a site treats as "articles" — hero, latest, section
feeds, related, RSS, sitemap.

A site opts into filtering per call site:

- news surfaces → `content_type=article`
- a brief archive page → `content_type=daily-brief`
- single article (`/:slug`) → never filtered; the brief's own page must resolve
- **`ids=` → do not filter.** The saved/history rails resolve by id, and a reader
  who saved a brief has to get it back. The endpoint never infers the filter, so
  this is only wrong if a caller passes `content_type` alongside `ids`.

Filtering is a positive match. Never invert it client-side: ordinary articles
carry `"article"` and briefs carry `"daily-brief"`, so `equals` is always
sufficient and never risks dropping rows.
| `GET /api/public/site?locale=` | `{ site:{name,brand,seo,contact,socials,features,…}, pillars:[…] }` |
| `GET /api/public/menus?type=header\|footer&locale=` | `{ menus:[…] }` |
| `GET /api/public/podcasts\|newsletters\|corrections\|wire\|market?locale=` | `{ data:{ … } }` (feature-gated) |
| `GET /api/public/preview?token=&locale=` | draft `{ doc, preview:true }` (signed preview token) |

Docs are Payload documents (same shape as the CMS), depth-populated (pillar,
author, hero image, etc.).

## Drop-in client (reference)

`brief-asia/src/lib/central-api.ts` + `brief-asia/src/lib/cms-client.ts` are a
worked example: `cms-client.ts` mirrors the old `payload-server.ts` function
surface (same names, args, return shapes) but fetches from the public API. Cutover
is a single import change per reader page (`@/lib/payload-server` →
`@/lib/cms-client`). DTW gets the same treatment (`dtw-web/.../lib/central-api.ts`
ships; clone the cms-client pattern). See [12-migration.md](12-migration.md).

## Caching + revalidation

Wrap reads in `unstable_cache` with stable tags (the reference client reuses
`articles:all`, `pillars:all`, `wire-drops`, `market-snapshots`, …). On publish,
the Central CMS POSTs `{ token }` to `{frontendUrl}/api/revalidate`; the frontend
verifies the HMAC (with `REVALIDATE_SECRET`) and calls `revalidateTag()` for the
tags in the token. A reference receiver ships at
`brief-asia/src/app/api/revalidate/route.ts` and
`dtw-web/apps/web/src/app/api/revalidate/route.ts`. Per-query `revalidate` windows
are the fallback if a webhook is missed.

## Locale handling

Pass `?locale=<code>`. The API clamps to the tenant's supported set and falls back
to the default. The CMS stores translations; the frontend never translates on a
reader request.

## Preview

The admin "Preview" button opens `{frontendUrl}/preview?token=...&slug=...`. The
frontend's `/preview` route enables draft mode and calls
`GET /api/public/preview?token=...` to fetch the draft. The token is a short-lived
HMAC; a leaked slug alone is not enough.

## Onboarding checklist (new site)

1. Create the tenant in admin; set domain, languages, features, frontendUrl.
2. Mint a read token; set `CMS_URL` + `CMS_READ_TOKEN` + `REVALIDATE_SECRET` in the
   frontend.
3. Add the frontend origin to `PUBLIC_API_ALLOWED_ORIGINS` (Central env).
4. Build the reader data layer against `/api/public/*` (clone the brief-asia
   client).
5. Add the `/api/revalidate` receiver.
6. Add the `/preview` route for draft mode.
7. Verify: list + article render in each locale; images load; publish busts cache;
   preview shows a draft.
