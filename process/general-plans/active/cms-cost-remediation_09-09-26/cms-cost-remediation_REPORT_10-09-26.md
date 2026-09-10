---
name: report:cms-cost-remediation-phase1
description: "EXECUTE phase report — Phase 1 of cms-cost-remediation: fixes 2a, 7, 5-partial, 8 in apcg-cms"
phase: phase-1-risk-independent-fixes
date: 2026-09-10
status: COMPLETE_WITH_GAPS
feature: general
plan: process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md
metadata:
  node_type: memory
  type: report
  feature: general
  phase: phase-1
---

# Phase 1 EXECUTE — cms-cost-remediation (apcg-cms only)

## TL;DR

All four scoped Phase 1 fixes landed. `npm run typecheck` and `npm run lint` both exit 0. All five
static grep guards PASS. `LIST_SELECT` untouched (E1 respected). The three Hybrid runtime gates for
Fix 2a (E3/E11) are **NOT RUN** — they are structurally impossible pre-deploy from this session and
are recorded as an open gap, not as green. Nothing committed, nothing pushed, no other repo touched.

## What Was Done

### Fix 2a — `defaultPopulate` scoping (security) — E2, E8

The leak: `scopedFind` passes `overrideAccess: true` (`src/lib/scoped.ts:68`), which bypasses
`ContentEngines.access.read = isSystemAdmin`. With `depth: 1` on the list route and `depth: 2` on
`[slug]`, any holder of a tenant read token receives `tokenHash` / `tokenPrefix` / `lastSeenIp`
(ContentEngines), staff identity + auth-adjacent fields (Users), and the hashed `readTokens` array
(Tenants). `admin: { readOnly: true }` is a UI hint, not access control.

| File | Change | Mode |
|---|---|---|
| `src/collections/ContentEngines.ts` | `defaultPopulate: { name: true, engineType: true, status: true }` | include (allowlist) |
| `src/collections/Users.ts` | `defaultPopulate: { name: true, role: true }` | include (allowlist) |
| `src/collections/Tenants.ts` | `defaultPopulate: { readTokens: false }` | exclude (denylist) |

Each carries an inline comment explaining the bypass, why `depth: 0` is forbidden, and the
include-vs-exclude reasoning.

**Why Tenants uses exclude mode (deliberate, documented deviation in shape — not in mechanism):**
ContentEngines and Users are provably unconsumed by the reader sites (the plan's 13-agent audit
found 0 hits for `lastEngine` / `lastEditedBy` across all four audited readers), so an allowlist
there is safe. The tenant document carries many fields a reader legitimately renders, and the
readers have no runtime response validation — an allowlist that accidentally omitted a consumed
field would fail at HTTP 200 with nothing in the logs. `readTokens` is the only secret-bearing field
group in `Tenants.ts` (verified by grep for token/secret/key/password/credential). The denylist
maintenance burden is recorded in the code comment.

### Fix 7 — `src/hooks/revalidate.ts`

- Bound the previously-discarded `fetch` response; added an `!res.ok` branch that logs
  `HTTP <status> <statusText>` plus a 200-char body slice. Previously a 401 (secret mismatch) or 503
  (reader's `REVALIDATE_SECRET` unset) logged as a success.
- Added `signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS)` with `REVALIDATE_TIMEOUT_MS = 5_000`.
  `fetch` has no default timeout, so an editorial save could hang on an unresponsive reader.
- Timeouts are distinguished from other failures in the log line (`err.name === "TimeoutError"`).
- The empty-`frontendUrl` early return now logs a warning naming the tenant slug instead of
  returning silently.
- The `catch` remains total — a webhook failure still never breaks the editorial write.

### Fix 5 (partial — the `unpin-expired` line only) — E7

`src/app/api/cron/unpin-expired/route.ts:89` — added `disableRevalidate: true` to the update
`context`. Read-time enforcement is intact and re-verified: `src/app/api/public/articles/route.ts`
lines 143-148 still filter expired pins out of `?flag=pinnedToLatest`. The route's header docstring
(which claimed the webhook fires here) was corrected to match. The inline comment records the E7
scope: verified for brief-asia-web / wad-web / dtw-web (structural, via `flag=pinnedToLatest`) and
wtb-web (contingent — safe only via its render-time re-check plus `cache: "no-store"`; re-check if
wtb-web ever adds `export const revalidate` to its home page). **GCV explicitly excluded.**

### Fix 8 — `src/lib/public.ts`

Memoized `resolveReadToken` behind a module-level `Map<string, {tenant, expiresAt}>` keyed on the
token **hash** (never the raw token). TTL = `READ_TOKEN_TTL_MS = 30_000` (bottom of the 30-60s band
the plan allows). Uncached lookup extracted to `lookupReadToken` with logic unchanged. Negative
results are cached too, so a bad-token flood does not still hit the DB. Opportunistic eviction of
expired entries once the Map exceeds 1000 keys prevents unbounded growth.

The security trade-off (revocation and tenant deactivation delayed by up to the TTL; redeploy is the
emergency propagation path) is documented in a code comment above the constant, as required.
The concurrent-request race on the Map is documented in-code as the plan's accepted known-gap; no
in-flight-promise machinery was added.

## Test Gate Outcomes

| Gate | Tier | Result |
|---|---|---|
| `npm run typecheck` | Fully-Automated | **PASS** — exit 0, no output |
| `npm run lint` | Fully-Automated | **PASS** — exit 0; 20 pre-existing warnings, all in `src/migrations/*`, none in touched files |
| `depth: 0` regression guard on `[slug]/route.ts` | Fully-Automated | **PASS** |
| A3 — refsView `select` omits `title: true` | Fully-Automated | **PASS** |
| A4 — `LIST_SELECT` does not drop `pinnedToLatest`/`pinnedUntil` | Fully-Automated | **PASS** |
| E1 — `LIST_SELECT` unchanged | Fully-Automated | **PASS** — still `{ body: false } as const` at line 39 |
| Read-time pin expiry still enforced | Fully-Automated (code inspection) | **PASS** — `route.ts:143-148` |
| Byline preservation (static half) | Fully-Automated | **PASS** — `Articles.author` → `relationTo: "authors"`; `Authors.ts` has no `defaultPopulate` |
| Inline-image population (static half) | Fully-Automated | **PASS** — `Media.ts` has no `defaultPopulate`; lexical `upload` population path unchanged |
| Fix 2a Hybrid — secrets absent at runtime | Hybrid | **NOT RUN** (see gaps) |
| Fix 2a Hybrid — byline non-null at runtime | Hybrid | **NOT RUN** (see gaps) |
| Fix 2a Hybrid — inline image URL non-null at runtime | Hybrid | **NOT RUN** (see gaps) |
| Fix 7 Hybrid — forced 401 logs as failure | Hybrid | **NOT RUN** (see gaps) |
| Fix 8 Hybrid — TTL-bounded revocation delay | Hybrid | **NOT RUN** (see gaps) |

### How the `defaultPopulate` API was verified (E2)

Both the repo's `node_modules` and any `dist/` path are blocked to Read and Bash by
`.claude/hooks/scout-block.cjs`. Verified two independent ways instead, neither guessing from
training data:

1. **Published-package source read.** `npm pack payload@3.85.1` into the session scratchpad, then
   read the type defs directly:
   - `collections/config/types.d.ts:486` —
     `defaultPopulate?: IsAny<SelectFromCollectionSlug<TSlug>> extends true ? SelectType : SelectFromCollectionSlug<TSlug>;`
     (a top-level `CollectionConfig` key)
   - `types/index.d.ts:142-149` — `SelectType = SelectExcludeType | SelectIncludeType`, i.e. an
     all-`true` include map or an all-`false` exclude map.
   - `fields/hooks/afterRead/relationshipPopulationPromise.js:38` —
     `select: populateArg?.[relatedCollection.config.slug] ?? relatedCollection.config.defaultPopulate`
     — proving it is applied as the `select` when a relationship is **populated**, and therefore that
     it does **not** affect direct `find`/`findByID` on the collection.
2. **Empirical check against the installed copy.** Renaming the key to `defaultPopulateXYZ` produced
   `error TS2561: Object literal may only specify known properties, but 'defaultPopulateXYZ' does not
   exist in type 'CollectionConfig'. Did you mean to write 'defaultPopulate'?` — the installed
   3.85.1 confirms the key.

**Non-vacuity finding (important):** the same experiment with a bogus *inner* field
(`bogusFieldXyz: false`) produced **no** type error. `SelectFromCollectionSlug<'tenants'>` resolves
through an index signature here, so **typecheck does not validate `defaultPopulate` field names.**
A typo in a field name would silently do nothing (include mode) or silently fail to exclude
(exclude mode). All field names used were therefore verified by hand against the collection
definitions: `name`/`engineType`/`status` (`ContentEngines.ts:48,50,57`), `name`/`role`
(`Users.ts:35,37`), `readTokens` (`Tenants.ts:248`).

## What Was Skipped or Deferred

- **Fix 2b (`LIST_SELECT` extension)** — hard-blocked by E1, GCV unaudited. Not touched.
- **Fix 5 (all other lines)** — `publish-scheduled`, `hooks/translation.ts`, `engine/translation`,
  `engine/intake` are out of this session's scope.
- **All Phase 2 / 3 / 4 work** — E4/E5; Phase 0 gate is only PARTIALLY MET (P1, P2b, P3 unrun).
- **E9 items** — TTL raise and `media.url` backfill: not revived, not scheduled.
- **Other repos** — `brief-asia-web`, `wad-web`, `wtb-web`, `dtw-web` untouched, not even read.

## Plan Deviations

| # | Deviation | Rationale | Class |
|---|---|---|---|
| 1 | `Tenants.defaultPopulate` uses exclude mode (`{ readTokens: false }`) where ContentEngines/Users use include mode | The plan mandates `defaultPopulate` on all three but does not specify the shape. Allowlisting tenant fields risks silently stripping a reader-consumed field with no runtime validation anywhere to catch it; `readTokens` is the only secret group. Mechanism is exactly as specified. | Within blast radius — documented in code |
| 2 | Corrected the `unpin-expired` header docstring (lines 25-27) | It asserted the webhook fires from this route, which the change makes false. Leaving it would have been an actively misleading comment. | Within blast radius — same file, comment only |

No hard-stop-class deviations. No schema change, no migration, no public API field removal, no
container/secret-management change.

## Test Infra Gaps Found

- **No test runner in `apcg-cms`** — re-confirmed this session: no jest/vitest/playwright dependency,
  no test config, no test files. Every Fully-Automated gate above is a typecheck/lint/grep gate, not
  an executed test. The plan's TDD "failing stub" entries cannot be run.
- **Typecheck is vacuous for `defaultPopulate` field names** (see above). A regression here would be
  invisible to both gates. This is a newly discovered gap, not previously recorded in the plan.

## Known Gaps (stated as gaps, not assumptions)

1. **All Hybrid runtime gates for Fix 2a are NOT RUN.** Two independent blockers: (a) `CMS_READ_TOKEN`
   lives in `.env`, which is privacy-gated and requires explicit user approval to read; (b) more
   fundamentally, the change is uncommitted and undeployed, so a curl against
   `apcg-cms.vercel.app` would exercise the *old* code and prove nothing about the fix. These gates
   are inherently post-deploy. Per E3/E11 the security fix is therefore **not** fully verified —
   static evidence only.
2. **Admin-panel display of `users` relationships** may degrade. `Users.admin.useAsTitle` is
   `"email"`, which the allowlist excludes. Whether Payload's admin renders relationship cells via
   relationship population (affected) or a separate direct find (unaffected) was not verified — the
   admin panel was not exercised this session. `useAsTitle` was deliberately left unchanged to stay
   in scope. If cells show IDs, the in-scope fix is to change `useAsTitle` to `name` (a display-only
   change) — **not** to add `email` back to the allowlist.
3. **Concurrent-request race on the `resolveReadToken` Map** — accepted per plan, documented in code.
4. **wtb-web Fix 5 clearance remains contingent**, not structural (E7 standing condition).
5. **GCV** remains unaudited for both Fix 2b and Fix 5 generalization.

## Closeout Packet

- **Selected plan:** `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md`
- **Finished:** Fixes 2a, 7, 5-partial, 8 — code complete in `apcg-cms`.
- **Verified:** typecheck, lint, 5 static guards, static byline/inline-image safety, `defaultPopulate`
  API shape (two ways).
- **Unverified:** every Hybrid runtime gate (blocked pre-deploy); admin-panel user relationship display.
- **Remaining cleanup:** post-deploy Hybrid gate run; decide on `Users.useAsTitle`; high-risk evidence
  pack for Fix 2a (public API + PII class) before this is treated as finalize-ready.
- **Classification:** **Keep in active/testing.** Code is complete but the security fix's runtime
  proof is pending, and the plan's other phases are still open.
- **Not committed, not pushed. Branch `process/cms-cost-remediation` unchanged in git state.**

## Forward Preview

- **Test Infra Found:** none — no runner exists; typecheck/lint/grep are the only automated gates.
- **Blast Radius Changes:** 6 files in `apcg-cms/src/`. Population behavior of `content-engines`,
  `users`, `tenants` now changes for **every** relationship population repo-wide, not only the public
  article routes — the widest-reaching part of this change.
- **Commands to Stay Green:** `npm run typecheck && npm run lint`.
- **Dependency Changes:** none.
