# Modules & Data Model

## Classification (the data strategy)

The rule: **content + taxonomy + media = per-tenant; reference data + identities =
global; site configuration = per-tenant config.** Feature-gated modules keep their
table but stay empty/hidden for tenants that disabled them — no schema bloat.

| Collection | Class | Notes |
|---|---|---|
| `tenants` | per-tenant config (registry) | identity, brand, domains, languages, timezone, SEO defaults, `features`, allowedEngines, readTokens, status |
| `users` | global | global identity + top-level role; per-tenant roles on the `tenants` array |
| `content-engines` | global, system-managed | hashed tokens, allowedTenants, allowedActions, status, rateLimit, lastSeen |
| `countries` | **global shared** | ISO reference data |
| `activityLog` | global + per-tenant events | append-only monitoring stream |
| `articles` | per-tenant | workflow + provenance + lockedFields + version + translationStatus |
| `authors` | per-tenant | bylines per publication |
| `pillars` / `sectors` / `tags` | per-tenant | taxonomy differs per site |
| `media` | per-tenant | R2; localized alt/caption |
| `newsletters` | per-tenant + feature `newsletters` | |
| `podcasts` | per-tenant + feature `podcasts` | |
| `marketSnapshots` / `fxRates` / `trendingBlocks` | per-tenant + feature `marketData` | |
| `sponsorSlots` | per-tenant + feature `sponsorSlots` | |
| `wireDrops` | per-tenant + feature `wireDrops` | |
| `corrections` | per-tenant + feature `corrections` | |
| `menus` | per-tenant config | header + footer |
| `translationJobs` | per-tenant + feature `translations` | translation queue |
| `engineConflictLog` | per-tenant | per-field skipped-write audit |

The per-tenant collections get their `tenant` relationship injected by the
multi-tenant plugin (configured in `payload.config.ts`). Global collections carry
no tenant field (or, for `activityLog`, a plain optional one).

## Shared vs per-tenant — the decisions

- **Shared system-wide:** the country reference list, user identities, content-engine
  identities, and the activity event stream. One copy avoids N duplicate tables.
- **Per-tenant:** all editorial content, taxonomy, and media. Carries a `tenant`
  FK; isolation enforced at the access layer + per-tenant composite uniqueness.
- **Per-tenant config:** the tenant record itself (site settings) and menus.
- **Outside the CMS but linked:** reader accounts, bookmarks, analytics, billing —
  these stay in each frontend (or a future service) and reference CMS content by
  stable id/slug. The stable public API + read tokens are the seam.

## Relationships (business level)

- Tenant 1—N {articles, authors, pillars, sectors, tags, media, newsletters,
  podcasts, corrections, sponsorSlots, market*, menus, translationJobs,
  engineConflictLog, activityLog}.
- Users N—N Tenants via the `tenants` array (role, canPublish).
- ContentEngines N—N Tenants via `allowedTenants`.
- Countries is global, referenced by Articles (`country`, `countries`).
- Article → pillar / sections / country / countries / tags / sectors / author /
  coAuthors / heroImage; carries provenance + `translationStatus[]`.
- Localized fields: article title/slug/dek/body/imageLabel; media alt/caption;
  taxonomy titles/descriptions; etc.

## Per-tenant uniqueness

brief-asia made `slug` globally unique — wrong for multi-tenant. The Central CMS
enforces uniqueness **within a tenant**:
1. a `beforeValidate` hook (`uniqueWithinTenant`, application-level), and
2. a composite DB index `UNIQUE (tenant_id, slug)` to be added by migration (the
   hard constraint). Add it on `articles`, `pillars`, `tags`, `sectors`,
   `newsletters`, `podcasts` after the first `payload:migrate:create`.

## Article workflow statuses

`draft → pending_review → approved → scheduled → published → hidden → archived`
(the `workflowStatus` field). Payload's native draft/publish `_status` is also
enabled for version history. The two are complementary: `workflowStatus` is the
editorial lifecycle; `_status` powers version snapshots + draft preview.

## Provenance & no-overwrite fields (on Articles)

`origin` (engine/manual/import), `editedByHuman`, `lockedFields[]`, `version`
(optimistic lock), `engineDraftId`, `engineSourceUrl/Name/Context`, `lastEngine`,
`processingVersion`. The intake handler enforces: idempotency per tenant; never
overwrite a locked or human-edited field (logs to `engineConflictLog`); version
mismatch → conflict.

## Translation model

`Articles.sourceLanguage` + `Articles.translationStatus[]` (per-locale `state`,
`engine`, `sourceVersionAtTranslation`, `updatedAt`) on top of Payload native
field localization. `translationJobs` is the queue. States:
none / pending / translating / machine_translated / needs_review / approved /
locked / outdated / failed. Approved + locked are never auto-overwritten.
