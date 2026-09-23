---
name: context:all-database
description: "Payload collections, Postgres schema/migrations, the tenant/engine data model, and the two data-access lanes (Payload Local API vs Console's read-only Drizzle) — database context group entrypoint"
keywords: database, schema, migration, migrations, postgres, drizzle, payload, collection, collections, tenant, tenants, multi-tenant, articles, workflow status, content type, console, dashboard, drizzle-kit
related: [context:all-integrations]
date: 23-09-26
metadata:
  read_when: "schema/collection changes, migrations, tenant data model, or the console's Drizzle read layer"
---

# Database Context

Last updated: 2026-09-23

This is the canonical database context entrypoint for **apcg-cms** (Central CMS).

Use it after `process/context/all-context.md` when the task needs the Payload schema, the
tenant/engine data model, migration workflow, or the two data-access lanes this repo uses.

For product-level "what does each module mean to an editor" narrative (not engineering schema
detail), read `docs/04-modules-and-data-model.md` instead — this group covers the *engineering*
shape; that doc covers the *business* shape. They are complementary, not duplicates.

---

## Scope

This group covers:

- The 26 Payload collections (`src/collections/*.ts`) and which are global vs tenant-scoped
- The `Tenants` collection as the site/publication registry (fields, feature flags, read tokens)
- The `ContentEngines` collection (machine identity registry) and `ActivityLog` (audit stream)
- Migration workflow (`src/migrations/`, `payload:migrate`, local `PAYLOAD_DB_PUSH`)
- The **two data-access lanes**: Payload Local API (hooks/access/versions run) vs the Console's
  read-only Drizzle layer (`src/console/data/`, bypasses Payload for aggregation speed)
- The dual article-status model (`_status` vs `workflowStatus`) and why public visibility keys off
  only one of them
- Locale/i18n configuration (`src/lib/locales.ts`) as it relates to localized fields

It does not cover:

- Auth/authorization mechanics (bearer tokens, read tokens, session, access-function factories) —
  those live in `process/context/integrations/all-integrations.md`
- API route contracts (request/response shapes) — also in the `integrations` group
- Business/editorial process (who approves what, roles) — `docs/03-roles-and-permissions.md`

---

## Read When

Read this entrypoint when:

- adding, removing, or changing a Payload collection or field
- writing or reviewing a migration
- deciding whether a new read path should use the Payload Local API or raw Drizzle
- investigating an article's public-visibility status (`_status` vs `workflowStatus`)
- working on the Console (`/console`) dashboards or its `src/console/data/` layer
- understanding what `Tenants` fields exist before adding a new per-tenant setting

## Quick Routing

- use `payload.config.ts` for the collection list, the `@payloadcms/plugin-multi-tenant`
  configuration (which collections are tenant-scoped, the `tenants` array row shape), R2 storage
  wiring, and locales
- use `src/collections/Tenants.ts` for the full site/publication registry field list (identity,
  brand, language, SEO, contact, feature flags, engine governance, hashed read tokens)
- use `src/collections/ContentEngines.ts` and `src/collections/ActivityLog.ts` for the two other
  global (non-tenant-scoped) collections
- use `src/migrations/` for the actual migration history (paired `.ts` + `.json` per migration)
- use `src/console/data/schema.ts` + `src/console/data/db.ts` for the read-only Drizzle mirror of
  the Payload-managed schema
- use `docs/04-modules-and-data-model.md` for the product-facing description of each module
- use `docs/12-migration.md` for the cross-repo cutover/import runbook (legacy site → Central)

## Source Paths

- `process/context/database/all-database.md` (this file, the entrypoint)

No deeper `database/` docs exist yet. Add routing entries here if this file grows past ~800 lines
or a sub-topic (e.g. a full migration runbook) becomes durable and reused enough to split out.

## Update Triggers

Update this group when:

- a collection is added/removed, or a tenant-scoped vs global collection changes category
- the migration workflow changes (e.g. `PAYLOAD_DB_PUSH` deprecated, a new migration tool adopted)
- the Console's Drizzle schema mirror (`src/console/data/schema.ts`) drifts from Payload's real
  schema in a way future agents should know about
- the dual-status (`_status`/`workflowStatus`) model changes (e.g. if `_status` ever becomes part
  of the public visibility filter)
- a new global (non-tenant-scoped) collection is added alongside `Tenants`/`Users`/`Countries`/
  `ContentEngines`/`ActivityLog`

---

## Collections (26 total, `payload.config.ts:93-124`)

**Global / not tenant-scoped** (5): `Tenants`, `Users`, `Countries`, `ContentEngines`, `ActivityLog`.

**Tenant-scoped** (21, listed in `multiTenantPlugin({ collections: {...} })`,
`payload.config.ts:176-199`): `Media`, `VideoMedia`, `Authors`, `Pillars`, `SubSections`, `Cities`,
`Sectors`, `Tags`, `Articles`, `Newsletters`, `Podcasts`, `Corrections`, `Subscribers`,
`SponsorSlots`, `MarketSnapshots`, `FxRates`, `FundingRows`, `AiLeaderboardRows`, `TrendingBlocks`,
`WireDrops`, `Menus`, `EngineConflictLog`, `TranslationJobs`. The `multiTenantPlugin` injects a
required `tenant` relationship field into each and scopes the Payload **admin** list/edit views by
the currently-selected tenant. It does **not** scope machine or public traffic — see
`process/context/integrations/all-integrations.md` for why every route handler must use
`src/lib/scoped.ts` instead.

`FEATURE_COLLECTIONS` (`src/lib/constants.ts:171-183`) maps each of the 11 `FeatureKey` flags
(`articles`, `newsletters`, `podcasts`, `marketData`, `sponsorSlots`, `wireDrops`, `corrections`,
`translations`, `dashboards`, `citiesMap`, `video`) to the collection slug(s) it gates. A disabled
feature is hidden in admin, 404s in the public API, and is rejected by engine intake — the gate is
checked independently in each surface, not centrally enforced by Payload.

### Tenants — the site/publication registry

`src/collections/Tenants.ts`. One row per publication (`gcv`, `wad`, `dtw`, `briefasia`, `wtb` per
`process/general-plans/` mentions of live tenants — confirm the current live set with a direct
`payload.find({collection:'tenants'})` or the Console's tenant list before relying on it, this file
does not hardcode which slugs exist). Field groups:

- **Identity** (system-admin only after creation): `slug` (stable `publicationId`, must match the
  content-engine registry id, "Never change after launch" — `Tenants.ts:88`), `status`
  (`active`/`suspended`/`archived`), `domain`/`additionalDomains`/`frontendUrl`.
- **Brand** (website-admin editable): `logo`, `brandColor`, `brand.{faviconUrl,ogImageDefault,themeTokens}`.
- **Language** (system-admin only): `defaultLanguage`, `supportedLanguages` (subset of the platform's
  20-locale list, `src/lib/locales.ts`), `timezone` (default `Asia/Singapore`).
- **SEO / contact / socials** (website-admin editable).
- **`features`** (system-admin only): the 11 `FeatureKey` checkboxes described above.
- **`dashboards`** group: DTW AI Leaderboard methodology/disclaimer copy in 3 languages
  (`en`/`vi`/`ind` — **note the Indonesian key is `ind`, not `id`**: Payload's Postgres/Drizzle
  adapter silently drops any field literally named `id` at any nesting depth, `Tenants.ts:222-226`).
- **Engine governance**: `allowedEngines` (convenience relationship; source of truth is actually
  `ContentEngines.allowedTenants`, the reverse side), `autoPublishEngineDrafts` (per-tenant: engine
  drafts land `published` instead of `pending_review` — used during cutover for a site that
  auto-published on its old standalone CMS).
- **`readTokens`** (system-admin only, hashed): the per-tenant public-API credential array. See the
  `integrations` group for how it is consumed.

**Security note carried in the collection's own comment** (`Tenants.ts:22-51`): `defaultPopulate`
here is a **deny-list** (`{readTokens:false}`), the opposite of `ContentEngines`'/`Users`' allow-list
style — deliberately, because most `Tenants` fields ARE legitimately read by frontends, so an
allow-list risks silently stripping a field a reader actually consumes. Any **new** secret-bearing
field added to `Tenants` must be added to this deny-list explicitly; nothing enforces that
automatically.

### ContentEngines — machine identity registry

`src/collections/ContentEngines.ts`. Each machine caller (crawler, AI writer, translator, finance
feed, podcast generator, importer — `ENGINE_TYPES`, `src/lib/constants.ts:103-112`) is its own row
with its own hashed token (`tokenHash` via `hashToken()`, `src/lib/crypto.ts`), its own
`allowedTenants` (relationship, `hasMany`), and its own `allowedActions` (subset of
`ENGINE_ACTIONS`, `src/lib/constants.ts:91-101`: `create_article`, `update_article`,
`create_translation`, `update_translation`, `upload_media`, `create_podcast`,
`update_market_data`, `import`). No shared all-powerful credential exists — suspending one engine
(`status: suspended|revoked`) never affects another. `rawToken` is a `virtual` field: paste a fresh
token, the `beforeChange` hook hashes it and clears the plaintext; it is shown to a human exactly
once. `defaultPopulate` here is an **allow-list** (`{name,engineType,status}`, `ContentEngines.ts:43-47`)
— see the `integrations` group for why this matters on public routes (`Articles.lastEngine`
populates through this collection).

### ActivityLog — append-only event stream

`src/collections/ActivityLog.ts`. `create: () => false` at the Payload access layer — the **only**
way a row is written is `logActivity()` (`src/lib/activity.ts`) calling `payload.create` with
`overrideAccess: true`. `read` is scoped to `memberTenantIds` (or all, for `isSystemAdmin`); `tenant`
is a **plain optional** relationship (not plugin-managed) because some events are global (e.g. an
engine-auth failure before any tenant is resolved). `eventType` is one of 19 values
(`ACTIVITY_EVENTS`, `src/lib/constants.ts:142-163`: article lifecycle, engine write
accepted/skipped, conflict logged, translation lifecycle, auth/tenant/action denials, media
uploaded, membership changed, integration error, pin expired). Per its own docstring this exists so
monitoring reports (counts per tenant/status, human vs engine, translation health, engine health,
blocked overwrites) "can be built later WITHOUT new modeling" — as of this scan there is no such
dashboard beyond the raw admin list and the Console's `stats.ts` aggregations (below); treat it as
instrumentation-only today, not a finished reporting feature.

### Countries — global reference data

Looked up by ISO code, **not** tenant-scoped (`src/app/api/engine/intake/route.ts:479-491`
resolves country ids via a plain `payload.find` with no tenant filter — this is the one collection
where that is correct, not a bug).

---

## The dual article-status model (read this before touching Articles visibility)

`Articles` carries **two independent status fields** that are easy to confuse:

| Field | Owner | Surface |
|---|---|---|
| `_status` (`draft` \| `published`) | Payload's native versions engine | Admin's Publish / Unpublish / Save Draft buttons |
| `workflowStatus` (7 values: `draft`, `pending_review`, `approved`, `scheduled`, `published`, `hidden`, `archived` — `ARTICLE_STATUSES`, `src/lib/constants.ts:48-57`) | This repo's own editorial model | The Workflow tab / engine intake / cron publish |

**Public visibility is gated on `workflowStatus === "published"` alone** — `_status` is
deliberately **not** filtered (`src/lib/scoped.ts:36-51` docblock; enforced at
`src/app/api/public/articles/route.ts:108` and the `[slug]` route). This is load-bearing, not an
oversight: roughly 3,300 imported articles (the August 2026 cutover import, across all live
tenants) sit at `_status:"draft"` + `workflowStatus:"published"` and are correctly live — an
`_status` filter would hide most of every site's archive.

`syncNativePublish` (`src/hooks/article-workflow.ts`) syncs **one direction only**: a human clicking
the native Payload "Publish" button raises `workflowStatus` to `published`. A companion
`syncNativeUnpublish` was added recently (per
`process/general-plans/active/article-unpublish-sync_09-09-26/`, status `COMPLETE_WITH_GAPS`, shipped
at HEAD `141035e`/PR #6) to close the reverse gap — clicking native "Unpublish" previously left
`workflowStatus` at `published` so the article stayed live on the public site while looking taken
down in admin. The **Save-Draft** path (as opposed to Unpublish) is a separate, still-open, and
explicitly *accepted* gap per that plan's own scoping — do not assume it is fixed without checking
that plan/report directly.

**Any new read surface must key off `workflowStatus`, never `_status`, to match the platform's
public-visibility contract.**

`contentType` (`article` | `daily-brief`, `CONTENT_TYPES`/`toContentTypeValue()`,
`src/lib/constants.ts:74-86`) is a third, unrelated field: it says **what the document is**, not its
publication state. It carries a `NOT NULL DEFAULT`, so an absent/legacy value reads as the ordinary
`"article"` case rather than needing null-safe handling everywhere.

---

## Two data-access lanes

This codebase deliberately runs **two different ways of talking to Postgres**, chosen per caller
type. Getting this wrong is the concrete mechanism behind at least one real production PII leak
(see `process/context/integrations/all-integrations.md` and
`process/general-plans/active/cms-cost-remediation_09-09-26/`).

### Lane 1 — Payload Local API (the default; hooks/access/versions run)

Used by: `/admin` (Payload-generated), the Console's **writes** (`src/console/data/payload.ts`,
`overrideAccess: false` + the real signed-in `user`), and every machine/public route via the
`src/lib/scoped.ts` wrappers (`overrideAccess: true` + an **explicit tenant filter merged into
every `where`**). `scoped.ts`'s own docstring states the rule for reviewers plainly: *"a route
handler must not call `payload.find` / `payload.create` / `payload.update` directly. Use
scopedFind / scopedCreate / scopedUpdate."* Forgetting the tenant filter on a raw call is exactly
the cross-tenant leak class that plan exists to close.

### Lane 2 — Console's read-only Drizzle mirror (dashboard aggregation only)

`src/console/data/db.ts` opens a **separate**, read-only `drizzle-orm/postgres-js` client (singleton
on `globalThis` to survive Next.js dev hot-reload) against the **same** `DATABASE_URL`.
`src/console/data/schema.ts` is a **hand-maintained, intentionally partial** mirror of the
Payload-managed table shape — "If Payload's schema changes, update the touched columns here (or
regenerate with `drizzle-kit pull`)" (`schema.ts:10-11`). `src/console/data/stats.ts` runs
`GROUP BY`/`count()` aggregations straight against this schema for dashboard cards — bypassing
Payload's access-control layer entirely, which is why every query there takes an explicit `Scope`
(`{all:boolean, ids:number[]}`, sourced from `tenantScope()` in `src/console/auth.ts`) and filters
manually. **Writes never go through this client** — `db.ts`'s own comment states it outright.

**Why this matters for anyone extending or reusing this pattern:** the Console's `tenantScope()` is
currently the **only** place in this codebase that resolves "every tenant a single caller may see"
in one shot (`{all:true}` for a system admin, or an explicit id list otherwise) — and it only exists
for an already-authenticated **human Payload session**. See
`process/context/integrations/all-integrations.md` §Cross-tenant reads for why this is directly
relevant to any new machine/API-shaped cross-tenant read surface, and why no equivalent exists yet
on the bearer-token (engine / public-read-token) side.

---

## Migrations

`src/migrations/` — Payload's Postgres migration format (paired `<timestamp>_<name>.ts` +
matching `.json`), 8 migrations as of this scan (`20260702_231336_initial_schema` through
`20260915_000000_add_podcast_youtube_fields`), run via `npm run payload:migrate`
(`payload migrate`) / created via `npm run payload:migrate:create`. `payload.config.ts:148`:
`migrationDir` points here.

**Deployed environments** always use committed migrations (`push: false`, gated on
`PAYLOAD_DB_PUSH === "true"`, `payload.config.ts:147`). The Vercel build itself applies pending
migrations before building: `package.json`'s `vercel-build` script runs
`node scripts/migrate-prod.mjs && npm run build` — migration application is part of every
production deploy, not a separate manual step.

**Local dev against the Docker Postgres** (no Supabase) sets `PAYLOAD_DB_PUSH=true` (see
`.env.docker.example`) so Payload syncs the schema directly from the collection config on boot —
no migration file is created or needed for that flow, per `docker-compose.yml`'s own header comment
("no committed migrations yet" for that path).

`DATABASE_URL` (pooled) vs `DATABASE_DIRECT_URL` (direct) — the direct URL is required for DDL
(migrations); the pooled one serves ordinary runtime queries. Both point at the same Supabase
Postgres instance in deployed environments.

---

## Locales / i18n

`src/lib/locales.ts` declares a **platform-wide** 20-locale list (`LOCALE_CODES`) because
Payload's `localization.locales` config (`payload.config.ts:88-92`) is global and cannot vary per
tenant. Each `Tenant` additionally declares its own `supportedLanguages` subset; `clampLocale()`
enforces that subset everywhere a locale is requested (admin locale switcher, translation-job
target selection, the public API's `?locale=` param) — a request for an unsupported locale falls
back to the tenant's `defaultLanguage`, never to an arbitrary platform default the tenant didn't
opt into. Adding a **new** platform locale is a code change (edit `LOCALE_CODES`/`LOCALE_LABELS`)
plus a migration, not just an admin toggle.

## Known related gap (verified directly, not yet fixed)

`src/collections/Users.ts:39` sets `useAsTitle: "email"`, but `defaultPopulate`
(`Users.ts:29-32`) only allow-lists `{name, role}` — `email` is excluded from what populates into
another document's relationship field. Net effect: anywhere a `Users` row is shown via a *populated
relationship* (e.g. an admin "Last Edited By" column, not the Users list itself), the title field
Payload tries to render may come back empty/ID-shaped instead of the email string. This was flagged
unverified in `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_CLOSEOUT_10-09-26.md`;
this scan confirms the field-shape mismatch directly at the two line numbers above but did not
check it against a running admin UI. The documented fix (in that closeout, not yet applied) is
`useAsTitle: "name"` (a required field) — never re-add `email` to the `defaultPopulate` allow-list,
that would reopen the PII-leak class the allow-list exists to close.
