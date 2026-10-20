---
phase: vowasia-legacy-migration-b-beta-execute
date: 2026-10-20
status: COMPLETE_WITH_GAPS
feature: general-plans
plan: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
---

# VowAsia B-beta EXECUTE report

TL;DR: B-2..B-14 are built and every gate assigned to EXECUTE is green (G1 194/194). A development run of the rehearsal passed 56/56 after two fixes; the proving G19 and G11 runs, the G22 review and the owner's real run (G23) are still pending. Nothing ran against production or the old database.

## What Was Done

`BASE_BB = 9d9e5a4` (checked at start: `git diff --name-only 9d9e5a4 HEAD -- . ':(exclude)process'` empty). Branch `claude/vowasia-launch`, commits (not pushed):
- `a6c6392` libraries + red-first tests (transform, body, authors, slug plan, media, import, rollback, rewrite-links, redirects, timestamps, verify, run journal/lock, guards, planner, fake Central, fixture rows, snapshot fixture).
- `a45c510` CLI entries (`import-vowasia.ts`, `rollback-vowasia.ts`, `rewrite-links-vowasia.ts`, `build-vowasia-redirects.ts`, `verify-vowasia.ts`, all through the pinned `runGuarded`), Payload port, local test hooks, verify marker fix.
- `7e2825f` fixture seed (`seed-vowasia-legacy-fixture.ts`), fake image host (`serve-images.ts`, 3519), `rehearse-vowasia.sh`, `rehearse-bootstrap.ts`, `rehearse-assert.ts`.
- `52f3317` `VOWASIA-LEGACY.md` part B (Vietnamese owner steps OB1-OB12, stale-lock and Q12 recovery), 7 npm scripts, G23 backlog stub.
- final commit: this report, plan §4.10 + `## Deviations`, `harness/` (4 of 5 artifacts).

Checklist (§4.4): B-2 done, B-3 done, B-4 done, B-5 done, B-6 done, B-7 done, B-8 done, B-9a done, B-9b done, B-10 done, B-11 done, B-12 done, B-13 done (script; proving run is EVL), B-14 done, B-15 pending (EVL/G22).

## Red-first evidence (E1)

Each test file was run against a skeleton whose exports throw `NOT IMPLEMENTED` before the code was written:

| Test file | Red before code | Green after |
|---|---|---|
| vowasia-transform.test.ts | 7/7 fail | 7/7 |
| vowasia-body.test.ts | 10/10 fail | 10/10 |
| vowasia-author-distribution + vowasia-slug-plan | 8/8 fail | 8/8 |
| vowasia-media.test.ts | 5/6 fail (the static "no network import" check passes on any skeleton) | 6/6 |
| vowasia-timestamps + vowasia-redirects (builder) | 8/8 fail | 8/8 |
| import-vowasia-main.test.ts | 16/16 fail | 16/16 |
| rollback-vowasia-main.test.ts | 9/9 fail | 9/9 |
| rewrite-links-vowasia-main.test.ts | 10/10 fail | 10/10 |
| verify-vowasia-main.test.ts | 3/3 fail | 3/3 |
| redirects CLI tests (in vowasia-redirects.test.ts) | 2/2 fail | 2/2 |
| verify "row lost its marker" (added after rehearsal run 2) | 1 fail against the previous verify code (git stash) | pass |

Not red-first: the import test for the local hooks (`VOWASIA_TEST_FAIL_UPLOAD_AT` and the non-local refusal) was written after the hook code. G7b: 0 added `package.json` lines at `a6c6392` vs `9d9e5a4`, exactly 7 after.

E19 (G10c-local, §4.5 command): (a) `export X=postgres://u:p@db.example.invalid:5432/x` appended to `rehearse-vowasia.sh` -> exit 1, flagged `rehearse-vowasia.sh:97`; reverted -> exit 0. (b) `rehearse-bootstrap.ts` moved away -> exit 1; restored -> exit 0 (file byte-identical, `cmp`).

## Test Gate Outcomes

| Gate | Command | Result |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | 194 tests, 194 pass, 0 fail (baseline 113) |
| G2 | `npm run lint:migrate` | 0 errors, 1 warning (the known `seed-gtp-legacy-fixture.ts:179`) |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | 69/69 |
| G5 | `npm run test:single-home` | 267/267 |
| G6 | `npm run probe:migrate-vowasia` (alone) | ALL PROBE CHECKS PASSED, exit 0 |
| G7 | `git diff --name-only 9d9e5a4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | `package.json` only |
| G7b | added / removed lines in `package.json` vs `9d9e5a4` | 7 added (all contain `vowasia`), 0 removed |
| G7c | untracked files outside `scripts/migrate/vowasia/`, `process/general-plans/` | none |
| SQL unchanged | `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/sql` | exit 0 |
| pins frozen | `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/lib/gtp-import-pins.ts` (+ pin test in G1) | exit 0 |
| G8 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 |
| G10c | §4.5 command | exit 0 |
| G10c-local | §4.5 command (V-W4 form) | exit 0 after the E19 red runs |
| G13 | `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | exit 0 |
| E15 stub | `test -f process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md` | exit 0 |
| G19 | `REHEARSE_MODE=native npm run rehearse:vowasia` | NOT the gate run. Three development runs, each alone, in the background: run 1 failed at the snapshot (fixture role lacked privileges on base tables; fixed with `vowasia_ro` views like the owner SQL 02); run 2 55/56 (verify missed a row that lost its marker; fixed + unit test); run 3 56/56 in 124 s, exit 0. EVL must run G19 itself. |
| G11 | `REHEARSE_MODE=native REHEARSE_SKIP_NPM_CI=1 npm run rehearse:gtp` | not run (EVL gate, after G19) |
| G22 | `vc-code-reviewer` | pending |
| evidence pack | `validate-risk-artifacts.mjs .../harness` | exit 1: `review-decision.json` missing (it records the G22 verdict; the executor does not write it) |

## What Was Skipped or Deferred

- G19/G11 proving runs (EVL), G22 review, `harness/review-decision.json` (from G22).
- G23 owner run on `neondb` with R2 (OB1, OB5-OB12): backlog stub `process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md`.
- Owner items O-B5 (per-link answer file, hard STOP before OB6) and O-B12 (redirect builder STOP) stay open; no default coded (E21).

## Plan Deviations

All within the blast radius (only `scripts/migrate/vowasia/**`, 7 `package.json` lines, `process/general-plans/**`); written to the plan under `## Deviations`:
1. Extra helper files in `lib/` (port, Payload port, guards, Central lookups, planner, run journal, CLI wrapper, `redirects-vowasia-main.ts`) and test fixtures (`fake-central.ts`, `fixture-rows.ts`, `snapshot-fixture.ts`, `serve-images.ts`).
2. Lexical body built directly as text nodes instead of escaped HTML through `htmlToLexical`; same "text, never HTML" semantics.
3. A broken store file refuses the whole run at load (§4.3 step 1); the importer's reachable store failures are manifest failures and URLs missing from the manifest; the 2% budget is checked before any write.
4. Rehearsal fixture uses `vowasia_ro` views; no dev server on 3518.
5. Local-only hooks `VOWASIA_TEST_KILL_BEFORE_JOURNAL`, `VOWASIA_TEST_FAIL_UPLOAD_AT`.
6. rewrite-links skips rows edited since import; blank answer-file lines ignored; `--expect-sha256` optional on dry-runs.
7. verify plans from the snapshot alone (marker-loss detection).

## Test Infra Gaps Found

- The fixture legacy role needs views (base-table column grants are not enough for the closed builders); the fixture now mirrors the owner SQL 02 shape.
- The rehearsal does not exercise the public read API (no Central dev server).

## High-risk evidence pack (§4.7)

`process/general-plans/active/vowasia-legacy-migration_16-10-26/harness/`: `risk-gate.json` (high, `mustStopBeforeFinalize: true`), `context-snippets.json`, `verification.json` (EXECUTE results), `adversarial-validation.json` (executor self-check, 11 scenarios, 1 not fully ruled out: unknown driver error text). Missing: `review-decision.json` (G22). B-beta must not be treated as finalised.

## Closeout Packet

- Selected plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`
- Finished: B-2..B-14 code, tests, rehearsal script, runbook part B, 7 scripts, backlog stub, 4/5 evidence artifacts.
- Verified: EXECUTE gates above. Unverified: G19/G11 proving runs, G22, real data/R2 (G23).
- Classification: `Keep in active/testing`.
- Next: EVL by `vc-tester` (G19 alone in the background, then G11), then G22 `vc-code-reviewer` writing `harness/review-decision.json`.

## Forward Preview

### Test Infra Found
- Unit tests use an in-memory `FakeCentral` (`fixtures/vowasia-legacy/fake-central.ts`) and a synthetic snapshot writer (`snapshot-fixture.ts`); no Payload, no DB.
- Rehearsal: `fixtures/rehearse-vowasia.sh` (native PG16, ports 54346/54347/3519, 3518 checked free), about 2 minutes plus bootstrap.

### Blast Radius Changes
- New CLIs write to Central only with `--apply`; journals and reports live outside the repo (`--runs-dir`).

### Commands to Stay Green
- `npm run test:migrate-vowasia`, `npm run lint:migrate`, `npm run typecheck`, `npm run test:migrate-gtp`, `npm run test:single-home`, `npm run probe:migrate-vowasia` (alone), `REHEARSE_MODE=native npm run rehearse:vowasia` (alone, background).

### Dependency Changes
- None (no new package; `sharp`, `pg`, `payload` already present).

CONTEXT_PARTIAL: none.
Follow-up stubs created: `process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md`.
