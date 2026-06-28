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
