---
name: context:all-integrations
description: "API surface (public/engine/cron/preview), the two independent auth mechanisms (human session vs machine bearer), activity logging, and the cross-tenant read gap relevant to any new hub/bridge work — integrations context group entrypoint"
keywords: api, auth, authentication, authorization, engine, content-engine, intake, translation, bearer token, read token, tenant, cross-tenant, multi-tenant, public api, cron, preview, revalidate, webhook, activity log, console, apcghub, hub
related: [context:all-database]
date: 23-09-26
metadata:
  read_when: "API contract questions, auth/authorization design, engine intake, cross-tenant read design, or anything bridging into this CMS from outside"
---

# Integrations Context

Last updated: 2026-09-23

This is the canonical API-surface and auth context entrypoint for **apcg-cms** (Central CMS).

Use it after `process/context/all-context.md` for anything touching: what an external caller
(engine, frontend, human, or a new bridge like APCGHub) can reach, how each caller type
authenticates, and — most load-bearing for any new cross-tenant work — **what auth shape already
exists vs what does not**.

For the underlying schema those routes read/write, see `process/context/database/all-database.md`.
For the wire-level field contract of the engine intake JSON body, `docs/08-content-engine-integration.md`
is authoritative (this file summarizes and points there rather than duplicating the field list).

---

## Scope

This group covers:

- Every route under `src/app/api/` — which are public external contracts vs internal-only
- The two independent, differently-shaped auth mechanisms: human Payload session vs machine bearer
  token (engine token and per-tenant public read token are two *different* bearer schemes)
- `src/lib/engine-auth.ts`, `src/lib/public.ts`, `src/access/helpers.ts`, `src/lib/activity.ts`
- The Console's session reuse (`src/console/auth.ts`) and its `tenantScope()` cross-tenant read
  precedent — and why it does **not** generalize to machine callers today
- Preview-token minting and the per-tenant revalidation webhook

It does not cover:

- Collection/field schema detail — `process/context/database/all-database.md`
- Business rules for who is allowed to do what editorially — `docs/03-roles-and-permissions.md`
- The full engine intake JSON field-by-field contract — `docs/08-content-engine-integration.md`
  (this file gives the *shape*, not every field)

## Read When

Read this entrypoint when:

- adding, changing, or calling a route under `src/app/api/`
- deciding how a new caller (human, engine, or a new kind of bridge/hub) should authenticate
- designing anything that needs to read or write **more than one tenant** in a single logical
  operation — read the §Cross-tenant reads section below first, it is the single most
  consequential finding in this group
- debugging a 401/403/404/409/422 from any of these routes (the reason codes are enumerated below)
- working on `ActivityLog` writes/reads from a route handler or hook

## Quick Routing

- use `src/lib/engine-auth.ts` for the full machine bearer-token → engine → tenant → permission
  resolution (`authenticateEngine()`)
- use `src/lib/public.ts` for the public read-token → tenant resolution (`resolveReadToken()`), CORS,
  gzip pass-through, and the response-shaping helpers (`jsonPublic`)
- use `src/access/helpers.ts` for the human-session access-function factories
  (`readOwnTenants`, `createInWritableTenants`, `updateEditorialContent`, …) and the
  `TenantMembership`/`CmsUser` shapes
- use `src/console/auth.ts` for how the Console reuses the Payload session and its `tenantScope()`
  all-tenants-for-a-system-admin helper
- use `docs/08-content-engine-integration.md` for the engine intake wire contract (fields, example
  payloads, registration steps)
- use `docs/09-website-integration.md` for the frontend-facing public API + preview + revalidate
  integration guide
- use `docs/10-translation.md` for the translation queue/claim/submit flow narrative
- use `process/general-plans/active/cms-cost-remediation_09-09-26/` for the production PII-leak
  findings and fixes that this API surface has already been through (relationship-population
  bypass, gzip, field-drop) — read before adding a new field to any relationship that populates
  into a public response

## Source Paths

- `process/context/integrations/all-integrations.md` (this file, the entrypoint)

No deeper `integrations/` docs exist yet. If this file grows past ~800 lines, or a sub-topic (e.g.
a full auth-flow diagram set, or a dedicated write-up once a cross-tenant bridge ships) becomes
durable and reused enough, split it out and add a routing entry here.

## Update Triggers

Update this group when:

- a new route is added under `src/app/api/`, or an existing one's auth model changes
- `authenticateEngine()` or `resolveReadToken()` change shape (e.g. if either ever gains a
  multi-tenant resolution mode)
- a new `ACTIVITY_EVENTS` value is added, or `ActivityLog` gains a consumer beyond raw admin list +
  Console stats
- **a cross-tenant read/write bridge (e.g. APCGHub) is designed or shipped** — this file's
  §Cross-tenant reads section is a snapshot of "no such mechanism exists yet"; once one does, this
  section must be rewritten to describe it, not just appended to

---

## API surface — public contract vs internal

| Route(s) | Auth | Contract status | Notes |
|---|---|---|---|
| `POST /api/engine/intake` | Engine bearer token (`authenticateEngine`, action `create_article`/`update_article`) | **External contract** — shape defined by the separate `content-engine` repo's intake clients | Idempotent (`engineDraftId`/`engineSourceUrl`), never overwrites `editedByHuman:true` (409), per-field lock list, optimistic `expectedVersion` lock. See `docs/08-content-engine-integration.md`. |
| `GET`/`POST /api/engine/translation` | Engine bearer token (action `create_translation`/`update_translation`) | **External contract** | GET lists queued jobs for the engine's tenant; POST submits a per-locale translation result. Never overwrites `approved`/`locked` translations (`PROTECTED_TRANSLATION_STATES`). |
| `GET /api/public/articles`, `/articles/[slug]`, `/authors`, `/cities`, `/menus`, `/site`, `/subscribers` (POST), `/views`, `/[module]` (podcasts/newsletters/corrections/wire/market/dashboards/sponsors), `/preview` | Per-tenant read token (`resolveReadToken`) | **External contract** — consumed by every live frontend | A disabled feature 404s (never an empty 200 — see `Tenants.features`). CORS via `PUBLIC_API_ALLOWED_ORIGINS`. Response gzip'd above 1 KB when the caller accepts it (`src/lib/public.ts`). |
| `GET /api/cron/publish-scheduled`, `/unpin-expired`, `/refresh-ai-leaderboard` | `CRON_SECRET` bearer (fail-**closed** in production if unset; open in non-production for local `curl`) | **Internal** — Vercel Cron only | Run across **all tenants** in one pass; there is no per-tenant cron entry. |
| `GET /api/preview/mint` | Payload human session (`payload.auth()`) | **Internal** — the admin "Preview" button | Verifies the signed-in user can access the article's tenant, mints a short-lived HMAC token (`signPayload`, 10 min), redirects to that tenant's own `frontendUrl`. |
| `/(payload)` route group | Payload's own admin session | **Framework-managed** | Payload-generated `/admin` UI + its own REST/GraphQL under `/api` — not a hand-written contract, changes with the Payload version. |
| `/(console)/console/*` | Payload human session (reused, `src/console/auth.ts`) | **Internal** — staff-only alternate admin UI | See §Cross-tenant reads — this is the one surface with an existing "see multiple tenants at once" shape, and it is human-session-only. |

**Rule of thumb:** anything under `api/public/*` or `api/engine/*` is a **cross-repo wire contract**
— changing a field name, status code, or response shape there requires coordinating with the
consuming repo(s) (the five frontend sites for `public/*`; the `content-engine` repo for
`engine/*`). Everything else (`cron/*`, `preview/*`, `(console)/*`, `(payload)/*`) is internal to
this repo and can change freely with normal review.

---

## Two independent auth mechanisms (they do not share code or a resolution shape)

### 1. Human session — Payload-native, reused by both `/admin` and `/console`

Payload's own cookie-based auth (`Users` collection has `auth: {...}`, `Users.ts:33-37`).
`req.user.role` is `systemAdmin` (cross-tenant superuser, `isSystemAdmin()`) or `standard`
(tenant-scoped via the `Users.tenants[]` array the multi-tenant plugin injects — each row is
`{tenant, roles: MembershipRole[], canPublish}`, `MembershipRole ∈ {websiteAdmin, editor,
contributor}`). `src/access/helpers.ts` is the **security core**: it exposes both raw membership
lookups (`memberTenantIds`, `writableTenantIds`, `adminTenantIds`, `canPublishInTenant`) and ready
`access` function factories (`readOwnTenants`, `createInWritableTenants`, `deleteInAdminTenants`,
`updateEditorialContent`) that individual collections compose.

The Console (`src/console/auth.ts`) **reuses this exact session** — "no second auth system" per its
own docstring — and layers `tenantScope()` on top: `{all:true, ids:[]}` for a system admin (no
filter — see all tenants), otherwise `{all:false, ids:[...memberTenantIds]}`.

### 2. Machine bearer — two *different* schemes, each resolving to exactly ONE tenant per call

**Engine token** (`authenticateEngine()`, `src/lib/engine-auth.ts:46-142`): `Authorization: Bearer
<token>` → sha256 hash lookup on `ContentEngines.tokenHash` → the engine row must be `status:
active` → resolve **one** target `Tenant`, either from an explicit `publicationId` in the request
body or, only when the engine has exactly one `allowedTenants` entry, that single tenant (an engine
allowed on >1 tenant **must** pass `publicationId` or the call 400s) → the resolved tenant must be
in `allowedTenants` → the requested `action` must be in `allowedActions` → the tenant must be
`status: active`. Every failure branch calls `logActivity()` first (auth failed / tenant denied /
action denied). On success it best-effort stamps `lastSeenAt`/`lastSeenIp` on the engine row.

**Public read token** (`resolveReadToken()`, `src/lib/public.ts:129-171`): `Authorization: Bearer
<token>` → sha256 hash lookup against **`Tenants.readTokens[].tokenHash`** (a different table than
the engine token) → the matching tenant must be `active` and the token row `status !== "revoked"`.
Memoized 30s per token hash (`READ_TOKEN_TTL_MS`) — a deliberate trade-off documented in
`public.ts:92-106`: revocation is not instant, in exchange for removing an uncached tenant lookup
from every one of ~2.96M/month public requests.

**Both machine schemes resolve to exactly one tenant per authenticated call.** Neither has a
"list of tenants this credential may read" resolution mode analogous to `tenantScope()`.

---

## Cross-tenant reads — the structural gap most relevant to APCGHub/hub-style bridging

This is the single most consequential finding in this group for any work that bridges an external
console/hub into this CMS across multiple tenants at once (5 tenants, per the calling task's
framing).

**What already exists, today, verified by direct code reading:**

1. `authenticateEngine()` — machine bearer, resolves to **exactly one** `Tenant` per call. An
   engine allowed on multiple tenants makes one call per tenant (`publicationId` selects which).
   There is no "give me everything across my `allowedTenants`" mode.
2. `resolveReadToken()` — public bearer, resolves to **exactly one** `Tenant` per token, by
   construction (`src/lib/public.ts:1-10`: *"The read token implies the tenant, so callers never
   pass a tenant and cross-tenant reads are impossible by construction"*). This is a deliberate,
   load-bearing design choice for the public API, not an oversight — a reader site must never be
   able to pull another site's unpublished content by swapping a query param.
3. `tenantScope()` (`src/console/auth.ts:63-67`) — the **only** place in this codebase today that
   resolves "every tenant a caller may see" in one value (`{all:true}` for a system admin). It is
   gated on an authenticated **human Payload session**, not a bearer token, and it is consumed only
   by the Console's own Drizzle read layer (`src/console/data/stats.ts` etc. — see the `database`
   group).

**What does not exist:** any bearer-token/machine-credential shape that resolves to "N tenants in
one authenticated call." A hub/bridge that needs to read (or write) across all five tenants from a
non-interactive process cannot reuse `authenticateEngine()` or `resolveReadToken()` unmodified —
both are architecturally single-tenant-per-call. The realistic options, none of which are decided
in code today, are roughly:

- **(a) Extend `ContentEngines`** with a new capability class — e.g. an engine whose
  `allowedActions` includes a new "read" action and whose `authenticateEngine()` call is allowed to
  omit `publicationId` when the caller explicitly wants "all of `allowedTenants`" — this is a real
  code change to `engine-auth.ts`'s tenant-resolution branch (`engine-auth.ts:74-96`), not just a
  new `ContentEngines` row.
- **(b) Mint N per-tenant credentials** (either N engine tokens or N `readTokens`) and have the hub
  make N sequential/parallel calls, one per tenant — reuses existing auth unmodified, at the cost of
  N round trips and N credentials to manage/rotate.
- **(c) Model a new mechanism on `tenantScope()`** — a system-admin-scoped, human-session-adjacent
  credential (e.g. a signed service token minted for a specific admin-equivalent identity) rather
  than an engine-shaped one. Closer in spirit to the Console than to the engine intake pattern.

This is a genuine design decision for INNOVATE/PLAN, not something this scan can resolve — it is
flagged here specifically so the next agent does not assume a cross-tenant read path already exists
and start "finding" it in the wrong file.

---

## Security patterns already load-bearing in this API surface

Both verified in `process/general-plans/active/cms-cost-remediation_09-09-26/` and directly in code:

- **`overrideAccess: true` (used by every `scopedFind`/`scopedCreate`/`scopedUpdate` call) bypasses
  a collection's `access.read` for the outer document, but relationship *population* into another
  document is a separate mechanism (`defaultPopulate`) that is NOT bypassed.** Three collections
  currently carry an explicit `defaultPopulate` allow/deny-list specifically to stop a
  secret/PII-bearing field from leaking through a populated relationship on a public response:
  `ContentEngines` (allow-list: `name`/`engineType`/`status` — keeps `tokenHash`/`tokenPrefix`/
  `lastSeenIp` off `Articles.lastEngine`), `Users` (allow-list: `name`/`role` — keeps
  email/session/auth state off `Articles.lastEditedBy`), `Tenants` (deny-list: `{readTokens:false}`
  — keeps the hashed public-API credentials off `Articles.tenant`, which the public `[slug]` route
  populates at `depth:2`). **A new collection with a secret-bearing field, or a new relationship to
  an existing one, needs the same treatment — this is not automatic.**
- The public articles list route (`src/app/api/public/articles/route.ts:62-73`) uses an
  **exclusion-mode** `select` (`LIST_SELECT`, all keys `false`) rather than an allow-list, on
  purpose: the reader contract keeps growing fields, and an allow-list would silently drop each new
  one until a reader noticed a blank card. It excludes `body` (weight), the four `video*` fields
  (no list surface renders them), and `tenant`/`translationStatus`/`lastEngine`/`lastEditedBy`/
  `assignedTo` (internal bookkeeping, confirmed zero reader usage by a cross-repo audit). Keep this
  select in exclusion mode if extending it.
- Response bodies are gzip'd server-side (`jsonPublic()`, `src/lib/public.ts`) rather than relying
  on the edge, specifically so the compressed byte count is what Vercel bills as Fast Origin
  Transfer — a cost-driven design choice, not just a performance one.

---

## Activity logging from a route handler

Call `logActivity({payload, eventType, tenantId, actorType, ...})` (`src/lib/activity.ts`) — never
`payload.create({collection:'activityLog', ...})` directly (the collection's `access.create` is
hardcoded `false`; only `logActivity()`'s internal `overrideAccess: true` can write it).
`logActivity()` **never throws into its caller** — a logging failure must not break the real write
it is annotating, so failures are caught and logged via `payload.logger.error` instead. When adding
a new significant event to a route handler, check whether it fits an existing `ACTIVITY_EVENTS`
value (`src/lib/constants.ts:142-163`) before adding a new one.

## Revalidation (cache invalidation on the reader side)

`src/hooks/revalidate.ts` — an `afterChange`/`afterDelete` hook on tenant-scoped collections. Unlike
some sibling repos that used one global revalidate target, this resolves the **changed document's
own tenant** and POSTs an HMAC-signed webhook (`CENTRAL_SIGNING_SECRET`) to that tenant's
`frontendUrl + /api/revalidate` only. Bulk/out-of-request callers (seed, import scripts) set
`context.disableRevalidate` to avoid hammering frontends during a large import, then trigger one
explicit warm at the end.

## Preview

`GET /api/preview/mint` (human session only) → verifies tenant access → mints a 10-minute HMAC
token (`signPayload`) → redirects to `<tenant.frontendUrl>/preview?token=...&slug=...`. The
frontend then calls the **public** `GET /api/public/preview` with that token to fetch the draft — a
leaked article slug alone is not enough to view an unpublished draft, the signed token is required.
