---
name: context:all-tests
description: "Verification quick-start for apcg-cms — there is no automated test framework here; the real gates are typecheck + lint + manual/live verification. Read before claiming any change is verified."
keywords: test, tests, testing, verify, verification, typecheck, lint, gate, validate-contract, evl, pvl, ci
related: [context:all-database, context:all-integrations]
date: 23-09-26
metadata:
  read_when: "running verification after implementation, deciding what a validate-contract's test gates should be, or debugging a failing typecheck/lint"
---

# apcg-cms — All Tests

Last updated: 2026-09-23

Attach this file first when the task involves testing, verification, or gate design.

**The single most important fact in this file: apcg-cms has no automated test framework and no
CI.** Do not assume `npm test` exists, do not invent a test command, and do not design a
validate-contract around a test runner this repo does not have.

---

## How This File Works

This is the `all-tests.md` entrypoint for the `tests/` context group, following the `all-*.md`
routing convention: agents read `process/context/all-context.md` first and get routed here for
testing/verification tasks.

## What This Covers

- what verification commands actually exist in this repo (two: typecheck, lint)
- why there is no test-runner command to route to
- the verification pattern this repo's own plans have actually used in practice
- known testing/CI gaps worth remembering so nobody re-discovers them from scratch

## Read This When

Use this file when you need to:

- verify a change before calling it done
- decide what a validate-contract's test gates should be for this repo
- explain why `npm test` does not work here

## Quick Routing

No deeper `tests/` docs exist. This repo's verification surface is small enough (2 real commands,
no framework) that it fits entirely in this entrypoint — do not create a deeper doc for it unless a
real test framework is adopted later.

## Quick Decision Guide

### Use `npm run typecheck` for

any TypeScript change — `tsc --noEmit`, whole repo, strict mode is on
(`noUncheckedIndexedAccess` / `noImplicitOverride` / `noFallthroughCasesInSwitch`). No
package-scoped variant; it always checks the whole repo.

### Use `npm run lint` for

code-style / `next/core-web-vitals` concerns — but `next.config.ts` sets
`eslint: { ignoreDuringBuilds: true }`, so a lint failure will **not** block a Vercel deploy. Treat
it as a manual/review-quality signal, never as something that automatically gates anything.

### There is no automated behavioral test tier

No unit tests, no integration tests, no e2e tests, and no `vitest` / `jest` / `playwright` /
`mocha` dependency anywhere in `package.json` (confirmed by direct inspection, not inference). A
validate-contract for this repo cannot cite a "run the tests" command that asserts pass/fail on
behavior — design test gates around the tiers that actually exist here (typecheck/lint as the
fully-automated tier; manual/live verification as the remaining tier), per the tier model in
`.claude/skills/vc-test-coverage-plan/SKILL.md`.

### Use manual/live verification for

anything behavioral: a route's actual response shape, a hook's actual side effect, a migration's
actual effect on data. This repo's own completed plans do exactly this —
`process/general-plans/active/cms-cost-remediation_09-09-26/` is a fully worked example: curl
probes against a live Preview/Production deployment, direct admin-panel/SQL counts, and Vercel
Observability dashboard reads, all recorded as verification evidence in the plan body and its EVL
iteration reports (`cms-cost-remediation-pvl-iteration-*.md`, `results.tsv`).

## Default Verification Order

1. `npm run typecheck` — cheapest, catches the most common class of break
2. `npm run lint` — cheap, style/best-practice only, non-blocking for deploy
3. manual/live verification scoped to exactly what changed — the only tier that can confirm
   *behavior*, not just that the code compiles and lints

## Commands

| Command | What it does | Notes |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`, whole repo | strict; no partial/package-scoped variant |
| `npm run lint` | `next lint` (flat config, `eslint.config.mjs`) | not a deploy gate |
| `npm run build` | `payload generate:importmap && next build` | closest thing to an integration check — a bad Payload config or an import cycle can fail here even when `typecheck` passed clean |
| `npm run db:status` | `tsx scripts/db-status.ts` | quick live DB-connectivity/migration-state check — closest thing to a smoke test |

There is no `npm test`. Do not add one to a plan's test-gate list without first adding an actual
test framework as its own, explicitly-scoped piece of work — that is a real, separate project, not
a one-line addition.

## Debugging Quick Reference

- **No CI**: `.github/` does not exist in this repo at all (not just an empty `workflows/` — the
  whole directory is absent, confirmed directly). Nothing runs typecheck/lint automatically on push
  or PR; a broken build is only caught at Vercel deploy time or by a human running the commands
  above locally.
- **Lint never gates a deploy**: see `next.config.ts`'s `eslint.ignoreDuringBuilds`. Do not report
  "lint failed, so I stopped" as equivalent to a blocking error.
- **Local dev DB vs. deployed DB use different schema-sync strategies**: local Docker Postgres uses
  `PAYLOAD_DB_PUSH=true` (schema synced live from collection config on boot, no migration file
  needed); deployed environments use committed migrations only, applied automatically as part of
  `vercel-build`. A local-only schema drift will not show up as a typecheck/lint failure — it shows
  up as a runtime DB error. See `process/context/database/all-database.md` §Migrations.
- **`src/payload-types.ts` can go stale**: if a collection's fields change, regenerate it
  (`npm run payload:generate-types`) before trusting `typecheck` — a stale generated-types file can
  make `typecheck` pass against types that no longer match the real schema.

## Known Gaps

- No automated test framework of any kind (unit / integration / e2e) — the single largest testing
  gap in this repo.
- No CI.
- No automated regression check for the public API's response *shape* (the cross-repo wire
  contracts in `process/context/integrations/all-integrations.md`) — a field accidentally dropped or
  renamed would currently only be caught by a consuming frontend breaking, not by anything in this
  repo itself.
