---
phase: podcast-series-execute
date: 2026-10-21
status: COMPLETE_WITH_GAPS
feature: none
plan: process/general-plans/active/podcast-series_21-10-26/podcast-series_PLAN_21-10-26.md
---

# Podcast series — EXECUTE report

TL;DR: all 10 checklist items are implemented and all 6 gates are green, including the migration up/down/up on a disposable PG16 and the AC1–AC6 probe. Nothing is committed. The open gaps are known and minor.

## What Was Done
- New: `src/collections/PodcastSeries.ts`, `src/migrations/20261021_000000_add_podcast_series.ts`.
- Edited: `src/collections/Podcasts.ts` (optional `series` relation, tenant `filterOptions`, async same-tenant `validate` that returns a message and never throws), `payload.config.ts` (collection + plugin map), `src/lib/constants.ts` (`FEATURE_COLLECTIONS.podcasts`), `src/migrations/index.ts`, `src/app/api/public/[module]/route.ts` (key `podcastSeries`, sort `order`), `src/console/data/collection-config.ts` (`podcastSeries` def + `series` relation field), console podcasts page (series manager + injected options), `scripts/db-status.ts`.
- DDL copied from the Newsletters DDL in the initial schema (`"_locales"` enum, `"order" numeric DEFAULT 0`, index names). FKs and indexes are in a second `db.execute`. Newsletters has no unique (tenant_id, slug) index, so none was added here.

## Test Gate Outcomes
| Gate | Result |
|---|---|
| typecheck | PASS (exit 0) |
| lint | PASS (exit 0; warnings only in older migrations) |
| loose-types tsc | PASS (`src/payload-types.ts` is absent, so this is the same run as typecheck) |
| build | PASS (BUILD_EXIT 0); importMap restored |
| disposable PG16 up → down → up → status, push unset | PASS; new migration `Yes`; after down, `podcast_series` and `podcasts.series_id` are gone |
| next dev probe | AC1, AC3, AC5, AC6 PASS; AC2 PASS with a gap (see below) |

## Plan Deviations
- `scripts/db-status.ts` lists table names, so the entry is `"podcast_series"`, not `"podcastSeries"`.
- In the console, the series `slug` is not marked required because the console action fills it from the name when blank. Payload still requires it.

## Test Infra Gaps Found
- A duplicate slug is rejected and not saved, but the API returns 500 "Something went wrong." instead of 400. The cause is the shared `uniqueWithinTenant` hook, which throws a plain Error. Newsletters returns the same 500. Fixing the shared hook is out of scope.
- A system admin with no tenant selected skips the feature gate (existing design; Podcasts behaves the same). AC6 holds for the public API (404) and the console (404).
- The FE contract is met: `data.podcasts[].series` is an object at depth 1 or null, and `data.podcastSeries[]` is sorted by `order`. The populated `tenant` object on each row is existing behaviour.

## Closeout Packet
- Classification: Keep in active/testing. Still needed: EVL, a commit and draft PR by the orchestrator, and the owner's post-deploy check.
- Rollback: before deploy, close the PR. After deploy, `migrate:down` drops only the new objects.

## Forward Preview
- Test Infra Found: disposable PG16 via `su postgres initdb` under /tmp; `mint-token.ts read --tenant` gives probe tokens.
- Blast Radius Changes: none beyond the plan's 10 files.
- Commands to Stay Green: typecheck, lint, build (+ importMap restore), migrate up/down/up.
- Dependency Changes: none.

## EVL Cycle 1 (21-10-26)

- Finding: `podcast_series` had no unique (tenant_id, slug) DB index, unlike its siblings (`newsletters_tenant_slug_idx`, `podcasts_tenant_slug_idx` in 20260801_082303_migration_hardening).
- Fix (`src/migrations/20261021_000000_add_podcast_series.ts`): `CREATE UNIQUE INDEX IF NOT EXISTS "podcast_series_tenant_slug_idx" ON "podcast_series" USING btree ("tenant_id","slug")` in up() (second block, after the table exists); `DROP INDEX IF EXISTS "podcast_series_tenant_slug_idx"` in down() before the table drops; header comment corrected (newsletters does have a unique DB index).
- Verified: typecheck pass; lint 0 errors (pre-existing warnings); disposable local PG16 (127.0.0.1:55439, /tmp, PAYLOAD_DB_PUSH unset): migrate applied, status Yes, index unique, duplicate (tenant_id, slug) insert rejected with 23505, migrate:down removed tables + index (batch 1 rolled back to empty), re-migrate succeeded with index present. DB stopped and deleted.
