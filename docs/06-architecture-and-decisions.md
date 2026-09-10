# Architecture & Key Decisions

## Shape

One Next.js 15 app embedding Payload 3.85. Admin + REST/GraphQL under
`src/app/(payload)`; custom machine/public APIs under `src/app/api/*`. One Postgres
(Supabase). One Cloudflare R2 bucket. No reader site — the root redirects to `/admin`.

## Decisions (recommendation + why)

| Decision | Choice | Why |
|---|---|---|
| Multi-tenancy | Official `@payloadcms/plugin-multi-tenant` + thin custom layer for machine/public traffic | Plugin owns the tedious admin scoping (tenant selector, list filters, auto-set tenant); our handlers own engine/public traffic with explicit `tenant` filters. Less net-new code to keep correct. |
| Membership model | Plugin-native `Users.tenants` array (`{tenant, roles, canPublish}`) | Avoids a second source of truth for tenant access; the plugin already reads/writes it. |
| Database | One central Postgres, shared schema, row-level `tenant` scoping | Centralized ops; isolation at access layer + composite indexes. |
| Engine auth | `content-engines` collection, **hashed** per-engine tokens | No shared all-powerful token; suspend/revoke per engine. |
| Public reads | Custom `/api/public/*` with per-tenant read token | Hard-codes tenant + published scoping; can't be escaped via query params. |
| Media | One R2 bucket, isolation at data layer | One credential/CORS surface; reuse brief-asia clientUploads + imageSizes. |
| Localization | Payload native field localization + per-tenant `supportedLanguages` subset (app-enforced) + translationStatus sidecar | Reuse proven localization; add per-language workflow. |
| Engine publishing | Engine creates `pending_review`, never publishes directly | Brief requires human-owned publish. (DTW's old auto-publish changes here — see migration notes.) |
| Revalidation | Tenant-aware signed webhook to each tenant's `frontendUrl` | Each frontend is single-tenant; Central routes by the changed doc's tenant. |

## The critical invariant

**Machine (engine intake) and public (frontend) traffic never authenticate as a
Payload user**, so the plugin's admin scoping does not apply to them. Every DB call
from a route handler MUST set/filter `tenant` explicitly via `src/lib/scoped.ts`
(`scopedFind` / `scopedCreate` / `scopedUpdate`). A forgotten tenant filter is the
one cross-tenant leak risk — never call `payload.find/create` directly in a route
handler. Countries are the only deliberate exception (global reference data).

## Security boundaries

- **Engine token** = the trust boundary for `/api/engine/*`. Hashed at rest;
  constant-time compared by hash lookup; status checked (active/suspended/revoked).
- **Read token** = the trust boundary for `/api/public/*`. Hashed; implies the
  tenant; published-only is hard-coded.
- **Preview token** = short-lived HMAC (10 min) minted only for authenticated admin
  users with access to the article's tenant.
- **Revalidate token** = short-lived HMAC (2 min) carrying the cache tags; the
  frontend verifies with the shared signing secret.

## Extensibility

- **New website** = create a tenant + grant users/engines + mint tokens + (frontend
  reads the public API). No new CMS, no schema change.
- **New engine** = create a `content-engines` row + grant tenants/actions + mint a
  token. No code change.
- **New language** = add to `src/lib/locales.ts` (platform) + a tenant's
  `supportedLanguages`. No structural change.
- **New content type** = a new collection (+ feature flag if optional). Existing
  tenants unaffected (flag off).
- **New bespoke business module** = a per-tenant collection or an external service
  linked by the stable public API + read token.

## What we did NOT build (and why it's safe to add later)

Monitoring dashboards (data is captured in `activityLog` now), per-tenant separate
buckets, reader accounts (stay in frontends), rate-limit enforcement beyond a basic
counter, page builder, multi-region DB. None require schema rewrites — they extend
the model rather than change it.

## Payload gotchas learned (from the video-support feature, 10-09-26)

Durable, repo-wide implications — not specific to video — confirmed while building
optional per-article video support (`process/general-plans/completed/article-video-support_10-09-26/`):

- **Mimetype validation is per-collection, not per-relationship-field.** Payload's
  `upload.mimeTypes` is a collection-level setting. Widening a shared upload
  collection (e.g. adding `video/*` to `media`'s existing `image/*`) would
  contaminate every field that relates to it. A separate collection (`videoMedia`)
  is the correct isolation boundary for a new upload type, not a wider
  `mimeTypes` array on an existing one. (Upstream gap: Payload GitHub Discussion
  #653 — there is no field-level mimetype constraint.)
- **`required: true` is application-layer only — it never becomes a DB `NOT
  NULL`.** Verified against the base schema: `Articles.title`, `pillar`, `author`,
  `readMin` are all `required` in the Payload field config and all nullable at
  the Postgres column level. A conditional `validate` function (fires only when
  a sibling field has a value) is therefore a safe, fully reversible way to
  enforce "required sometimes" — it never touches the DB constraint layer.
- **Named `group` fields flatten to real, individually-migrated columns.**
  `Tenants.features` is a Payload `group` field; each checkbox inside it
  (`features.articles`, `features.newsletters`, …) is its own DB column
  (`features_articles`, `features_newsletters`, …), not a JSON blob. Adding a
  new feature flag always needs a `tenants` migration — easy to miss because the
  admin UI makes it look like one nested field.
- **There is a third, hand-maintained admin surface for tenant features:**
  `src/console/data/{schema,tenants}.ts`. The separate `console` app mirrors the
  `tenants.features_*` columns in its own Drizzle schema (`schema.ts`) and reads
  them into a `Record<FeatureKey, boolean>` literal in `getSiteConfig()`
  (`tenants.ts`). Any new entry in `FEATURE_KEYS` (`src/lib/constants.ts`) must
  also land in both of these files or `console`'s typecheck fails and its
  per-tenant settings page silently drops the new flag. This was previously
  undocumented anywhere in `docs/`.
- **`admin.condition` is synchronous and cannot do a live per-tenant lookup.**
  The Payload admin's selected-tenant state (from
  `@payloadcms/plugin-multi-tenant`) is not passed into a field's
  `admin.condition(data, siblingData, {user, operation})` callback, and that
  callback cannot be async. Genuinely live per-tenant field visibility (as
  opposed to a value baked in at document-load time) requires a custom admin
  Field Component reading `useTenantSelection()` from
  `@payloadcms/plugin-multi-tenant/client` (confirmed exported at the pinned
  `3.85.1`) — see `src/components/admin/VideoFieldGate.tsx` for the working
  pattern.

## Reference: files that implement each decision

- Multi-tenant plugin + locales + R2: `payload.config.ts`
- Access layer: `src/access/helpers.ts`, `src/access/collections.ts`
- Tenant filter helpers: `src/lib/scoped.ts`
- Engine auth: `src/lib/engine-auth.ts`; intake: `src/app/api/engine/intake/route.ts`
- Public API: `src/app/api/public/*`; tokens: `src/lib/public.ts`, `src/lib/crypto.ts`
- Workflow/provenance: `src/hooks/article-workflow.ts`
- Translation: `src/hooks/translation.ts`, `src/app/api/engine/translation/route.ts`
- Revalidation: `src/hooks/revalidate.ts`
- Monitoring: `src/collections/ActivityLog.ts`, `src/lib/activity.ts`
