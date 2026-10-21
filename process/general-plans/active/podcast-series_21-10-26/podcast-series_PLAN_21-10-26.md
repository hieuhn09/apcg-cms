---
name: plan:podcast-series
description: "Podcast series as a real tenant-scoped CMS collection (name required, description optional) + optional Podcasts.series relation, migration, public API key, console picker"
date: 21-10-26
feature: none
---

# Podcast Series Collection (COMPLEX — schema/migration high-risk)

TL;DR: add `podcastSeries` collection (name required + localized, slug required + unique within tenant, description optional + localized), an optional `Podcasts.series` relation, a hand-written idempotent migration with `down`, expose it in the existing `podcasts` public module as key `podcastSeries`, and add a console manager + picker. Branch `claude/gracious-keller-bdfs7k`, draft PR, never main.

## Context
User need: every series and every episode has a name (required) and a description (optional). Episodes already comply (`Podcasts.title` required + localized, `description` optional). Series exist today only as free text `show`. FE companion: brief-asia-web plan `process/general-plans/active/podcast-series_21-10-26/podcast-series_PLAN_21-10-26.md` Amendment 1.

## Decision Summary

### Chosen Approach
New collection `podcastSeries` (table `podcast_series`) modelled on `src/collections/Newsletters.ts` + optional single relation `Podcasts.series` — a real entity with minimal additive schema.

### Why This Over Alternatives
| Alternative | Why Rejected |
|---|---|
| Keep deriving from `show` text | No description, slug drifts with spelling, no localized name |
| Array/group field on Tenants | Not queryable per series, breaks collection patterns |
| Replace `show` with the relation (drop column) | WTB and other tenants use `show`; destructive |
| New feature flag | Series are meaningless without podcasts; reuse `podcasts` flag |
| Auto-derive slug from name | No slugify hook precedent in `src/hooks/` → slug is required editor input |

### Risk Predictions
- Architect: table must exist before FKs that reference it (video_support precedent: two `db.execute` blocks).
- Security: cross-tenant series could be linked via API writes; `filterOptions` only narrows the UI → add a server-side same-tenant `validate`.
- QA: `PAYLOAD_DB_PUSH=true` hides missing/broken migrations → disposable PG with push unset.
- Ops: a merged migration runs as prod DDL at the next build → feature branch + draft PR only.
- Consumers: other frontends with strict parsing may reject the extra `podcastSeries` key (known gap; additive).

### Key Constraints Accepted
No backfill; `show` untouched; no revalidate hook (FE 300s window); no new flag.

## Requirements (SPEC: trivial)
Series: `name` required (localized), `description` optional (localized), `slug` required, unique within tenant. Episodes: unchanged.

## Acceptance Criteria
- AC1 Saving a series without name fails; without description succeeds.
- AC2 Duplicate slug in the same tenant is rejected; same slug in another tenant is allowed.
- AC3 A podcast saves with no series and with a same-tenant series; a cross-tenant series is rejected.
- AC4 Migration up → down → up succeeds on a fresh DB built from the real migration chain with `PAYLOAD_DB_PUSH` unset.
- AC5 `GET /api/public/podcasts` returns `podcasts` (each with `series` populated at depth 1, or null) and `podcastSeries`.
- AC6 Tenant with `podcasts` feature off: no series access in admin, console, or public API.

## Implementation Checklist
1. `src/collections/PodcastSeries.ts`: slug `podcastSeries`; admin `{ useAsTitle: "name", defaultColumns: ["name","slug"], group: "Editorial" }`; access `featureGatedAccess("podcasts", tenantManagedAccess)`; fields `name` (text, required, localized), `slug` (text, required, index, `uniqueWithinTenant("slug")`), `description` (textarea, localized), `order` (number, default 0).
2. `src/collections/Podcasts.ts`: add `{ name: "series", type: "relationship", relationTo: "podcastSeries", hasMany: false }` after `show`; `filterOptions` by tenant (pattern `Articles.ts:252`); async `validate` same-tenant check returning a message string, never throwing. `show` untouched.
3. `payload.config.ts`: import + add to `collections` next to `Podcasts`; add `podcastSeries: {}` to the multi-tenant plugin `collections` map.
4. `src/lib/constants.ts`: `FEATURE_COLLECTIONS.podcasts = ["podcasts", "podcastSeries"]`.
5. `scripts/db-status.ts`: add `"podcastSeries"` to its list. `scripts/seed.ts`: no change.
6. `src/migrations/20261021_000000_add_podcast_series.ts` (idempotent, style of `20260910_000000_add_video_support.ts`). Block 1: `podcast_series` (id serial PK, tenant_id, slug varchar NOT NULL, "order" numeric DEFAULT 0, updated_at, created_at); `podcast_series_locales` (name varchar NOT NULL, description varchar, id serial PK, _locale enum NOT NULL, _parent_id integer NOT NULL); `podcasts.series_id integer` (nullable); `payload_locked_documents_rels.podcast_series_id integer`. Block 2 (separate `db.execute`): FKs inside `DO $$ … EXCEPTION WHEN duplicate_object` — tenant_id→tenants ON DELETE SET NULL; _parent_id→podcast_series ON DELETE CASCADE; podcasts.series_id→podcast_series ON DELETE SET NULL; locked_rels.podcast_series_id→podcast_series ON DELETE CASCADE; indexes IF NOT EXISTS: tenant, slug, updated_at, created_at, unique (_locale,_parent_id), `podcasts_series_idx`, locked-rels idx. Add a unique (tenant_id, slug) index only if Newsletters has one in the schema (else the hook enforces it). `down`: drop new FKs/indexes/columns on podcasts and locked_rels, drop `podcast_series_locales`, drop `podcast_series` (IF EXISTS throughout).
7. `src/migrations/index.ts`: import + append entry.
8. `src/app/api/public/[module]/route.ts`: `podcasts.collections` gains `{ slug: "podcastSeries", sort: "order", key: "podcastSeries" }`. Confirm the episode fetch depth populates `series`; if depth 0, record the bare-id shape (FE handles both).
9. Console: `src/console/data/collection-config.ts` add `podcastSeries` (titleField `name`, localized; fields name required / slug required / description textarea / order) and a `series` select field on `podcasts`. `src/app/(console)/console/sites/[tenant]/podcasts/page.tsx`: second CollectionManager for series; inject series options into the podcasts form like `taxonomy/page.tsx:19-25`. Decision: do it (~40 lines). If CollectionManager can't take a select/relation field, fall back to /admin only and record it.
10. Types: `src/payload-types.ts` is absent/untracked → no regeneration; run the loose-types gate.

## Touchpoints
New: `src/collections/PodcastSeries.ts`, `src/migrations/20261021_000000_add_podcast_series.ts`. Edit: `src/collections/Podcasts.ts`, `payload.config.ts`, `src/lib/constants.ts`, `src/migrations/index.ts`, `src/app/api/public/[module]/route.ts`, `src/console/data/collection-config.ts`, `src/app/(console)/console/sites/[tenant]/podcasts/page.tsx`, `scripts/db-status.ts`.

## Public Contracts
- DB: new tables `podcast_series`, `podcast_series_locales`; nullable columns `podcasts.series_id`, `payload_locked_documents_rels.podcast_series_id`.
- Public API `/api/public/podcasts`: new key `podcastSeries[]` `{id, name, slug, description?, order}`; episodes gain `series` (object | id | null).
- Payload REST/GraphQL: new collection `podcastSeries`.

## Blast Radius
10 files, one repo. Risk class: schema/migration + public API (additive) → high-risk evidence pack required.

## High-Risk Evidence Pack (vc-risk-evidence-pack)
1. Risk class: schema/migration; public API additive.
2. Migration file + up/down/up transcript from disposable PG16 (push unset).
3. Sample `/api/public/podcasts` response from local dev.
4. Rollback: pre-deploy = close PR; post-deploy = `migrate:down` drops only new objects.
5. Owner post-deploy check: create one series in /admin on BriefAsia, link one episode, curl the public endpoint.

## Verification Evidence
| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| `npm run typecheck` | Fully-Automated | compile |
| `npm run lint` | Fully-Automated | conventions |
| Loose-types: move `src/payload-types.ts` aside if present, `npx tsc --noEmit`, restore | Fully-Automated | loose-types trap |
| `npm run build`, then `git checkout -- 'src/app/(payload)/admin/importMap.js'` | Fully-Automated | build/importmap |
| Disposable PG16 per tests/all-tests.md (random port, `/tmp/podser-pg.*`), `PAYLOAD_DB_PUSH` unset: `npx payload migrate` → `npx payload migrate:down` → `npx payload migrate` → `npx payload migrate:status`; delete cluster | Hybrid | AC4 |
| Same DB + `next dev` (webpack): create series w/o name (fail), w/o description (ok), dup slug, cross-tenant link; curl `/api/public/podcasts` with feature on/off | Hybrid | AC1–AC3, AC5, AC6 |

## Test Infra Improvement Notes
(none identified yet)

## Resume and Execution Handoff
1. Plan: `/home/user/apcg-cms/process/general-plans/active/podcast-series_21-10-26/podcast-series_PLAN_21-10-26.md`
2. Last completed: PLAN + VALIDATE (FAST). EXECUTE not started.
3. Validate-contract: written below, Gate: PASS.
4. Context: CMS `process/context/all-context.md`, `database/all-database.md`, `integrations/all-integrations.md`, `tests/all-tests.md`.
5. Next: checklist 1→10, then gates in order. Do not commit.

## Validate Contract

generated-by: outer-pvl
date: 2026-10-21
Date: 21-10-26
Gate: PASS

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | PASS — collection + tenant map + FEATURE_COLLECTIONS patterns verified |
| Test coverage | PASS — static gates + hybrid disposable PG (docker + psql available) |
| Breaking changes | PASS — additive; strict-consumer risk logged as known gap |
| Security surface | PASS — plugin tenant scoping + server-side same-tenant validate |

| Layer 2 sections | Status |
|---|---|
| Items 1–5 collection/config | PASS |
| Items 6–7 migration | PASS — two-block ordering + DO $$ precedent |
| Item 8 public API | PASS — module supports multiple collections |
| Item 9 console | PASS — taxonomy option-injection precedent, fallback defined |

Totals: 0 FAILs / 0 CONCERNs.

Test gates (in order): 1 `npm run typecheck`; 2 `npm run lint`; 3 loose-types tsc; 4 `npm run build` + restore importMap; 5 disposable PG16 migrate up/down/up, push unset, cluster deleted; 6 dev-server API probe.

Execute-agent instructions:
- E1: No commit/push. Run migrations only against a localhost `DATABASE_URL`.
- E2: Copy exact DDL names (locale enum, column naming, quoting of "order", indexes) from the Newsletters DDL in `20260702_231336_initial_schema.ts`; do not guess.
- E3: FK/index block in a separate `db.execute` after the CREATE TABLEs.
- E4: If disposable PG can't be provisioned, mark gates 5–6 `known-gap: owner-run` in the report.
- E5: `validate` returns strings, never throws.

Known gaps: no revalidate hook (FE 300s window); strict other frontends vs `podcastSeries` key; no backfill.

## Autonomous Goal Block

SESSION GOAL: Podcast series CMS collection
Charter: N/A — single plan (paired with brief-asia-web Amendment 1)
Hard stops: no commit to main; no non-local DB; no prod migration
Next phase: EXECUTE: /home/user/apcg-cms/process/general-plans/active/podcast-series_21-10-26/podcast-series_PLAN_21-10-26.md
Validate contract: inline
Execute start: typecheck, lint, loose tsc, build, disposable PG up/down/up | high-risk pack: yes
