---
phase: article-unpublish-sync
date: 2026-09-21
status: COMPLETE_WITH_GAPS
feature: general-plans
plan: process/general-plans/active/article-unpublish-sync_09-09-26/article-unpublish-sync_PLAN_09-09-26.md
---

# EXECUTE exit summary — article unpublish sync

**TL;DR** Checklist items 1–6 done. Both automated gates green (`typecheck` exit 0, `lint` exit 0). All behavioural criteria A1–A8 remain unrun — manual script not executed. `CODE DONE`, not `VERIFIED`.

## What Was Done

1. `src/hooks/article-workflow.ts` — added exported `syncNativeUnpublish` (+ its docblock) verbatim from the plan's `## Intended change`, inserted after `syncNativePublish` and before `enforceStatusAuthority`. No existing function touched.
2. `src/collections/Articles.ts` — added `syncNativeUnpublish` to the `@/hooks/article-workflow` import block.
3. `src/collections/Articles.ts` — `beforeValidate` is now `[syncNativePublish, syncNativeUnpublish, enforceStatusAuthority]`; ordering comment replaced with the plan's 4-line version.
4. `src/collections/Articles.ts` — appended the Save-Draft caveat sentence to the `workflowStatus` field `admin.description` (A8).

Exactly two files changed (`git status --short`). No third file touched. No `_status` filter added anywhere. No migration or data-repair script written or run.

## What Was Skipped or Deferred

- Checklist item 7 (manual verification script) — handed to the user, not self-certified, per E6.

## Test Gate Outcomes

| Tier | Command | Result |
|---|---|---|
| Fully-automated | `npm run typecheck` (`tsc --noEmit`) | **PASS** — exit 0, no output |
| Fully-automated | `npm run lint` (`next lint`) | **PASS** — exit 0; only pre-existing warnings in `src/migrations/*`; zero findings in either touched file |
| Hybrid | Manual verification script (steps 1–8) | **NOT RUN** — requires deployed CMS + tenant read token |
| Agent-probe | Code read of 11 writers vs 4 trigger conditions | Inherited from PLAN; re-confirmed by adversarial diff read (see below) |
| Known-gap | Engine/cron no-op under real traffic; legacy-row invariance under prod sweep | NOT RUN — no prod DB |

`node_modules` was absent at session start; `npm ci` succeeded (756 packages, ~50s), which made both automated gates runnable.

## Adversarial Diff Re-read

`syncNativeUnpublish` early-returns unchanged `data` for all four required cases, in order:
- (a) `!data || !req.user` → return
- (b) `data._status !== "draft"` → return
- (c) stored `originalDoc?.workflowStatus !== "published"` → return
- (d) `incoming !== undefined && incoming !== stored` → return

Only after all four does it set `data.workflowStatus = "hidden"`. Condition (c) is what keeps the console actions (A4) and the ~3,300 legacy rows (A6) untouched; (a) covers every non-human writer (A5).

## Plan Deviations

None. The hook body, docblock, ordering comment, and description sentence were applied verbatim.

## Test Infra Gaps Found

`CONTEXT_PARTIAL: process/context/` — the context router `process/context/all-context.md` does not exist in this repo (harness not set up), so [E-S1] context-group routing could not run. Plan-supplied context was used instead.

No test runner exists in this repo (`package.json` has only `lint` + `typecheck`). Backlog candidate: a vitest hook-level unit harness for `beforeValidate` status-sync logic — would give A1–A7 a real automated gate. No follow-up plan stub created (out of this phase's scope).

## Closeout Packet

- Selected plan: `process/general-plans/active/article-unpublish-sync_09-09-26/article-unpublish-sync_PLAN_09-09-26.md`
- Finished: checklist 1–6.
- Verified: compile + lint only. Unverified: A1–A8 behavioural criteria.
- Remaining: user runs the manual verification script (validate-contract §Manual verification script) on the live CMS; rollback plan stands if any step fails.
- Closeout classification: **Keep in active/testing** — per Phase Completion Rule 4, code-only completion is `CODE DONE`, not `VERIFIED`; the plan may not be archived until a human confirms steps 1–8.

## Forward Preview

- **Test Infra Found:** none (no runner). `npm run typecheck` + `npm run lint` are the only gates; both now runnable since `node_modules` is installed.
- **Blast Radius Changes:** none beyond the two planned files.
- **Commands to Stay Green:** `npm run typecheck`, `npm run lint`.
- **Dependency Changes:** none to `package.json`; `npm ci` only materialised the existing lockfile.
