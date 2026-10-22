---
name: report:vowasia-legacy-migration-evl-b-beta
description: "EVL confirmation run, stage B-beta, VowAsia legacy migration (independent re-run of every contract gate at 7390d6c)"
date: 20-10-26
metadata:
  node_type: memory
  type: report
  phase: B-beta EVL
---

# EVL B-beta — independent gate re-run (20-10-26)

TL;DR: every gate of `### Validate Contract (Chặng B-β)` re-run by vc-tester at HEAD `7390d6c` (branch `claude/vowasia-launch`) is GREEN. Execute report numbers reproduced. Only residuals: G22 review and G23 owner run (not tester gates).

BASE_BB check: `git diff --name-only 9d9e5a4 HEAD -- . ':(exclude)process'` = `package.json` + files under `scripts/migrate/vowasia/` only (expected: B-beta code is in HEAD; contract G7 is the scope check).

| Gate | Command | Result |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | exit 0, 194/194 |
| G2 | `npm run lint:migrate` | exit 0, 0 errors, 1 allowed warning (`seed-gtp-legacy-fixture.ts:179`) |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | exit 0, 69/69 |
| G5 | `npm run test:single-home` | exit 0, 267/267 |
| G7 | diff 9d9e5a4 excl. vowasia/process | only `package.json` |
| G7b | package.json added/removed lines | 7 added, all contain `vowasia`; 0 removed |
| G7c | untracked outside allowed dirs | none (exit 0) |
| SQL unchanged | `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/sql` | exit 0 |
| pins frozen | `git diff --quiet 9d9e5a4 -- .../gtp-import-pins.ts` | exit 0 |
| G8 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 |
| G10c | §4.5 grep form | exit 0 (no hits) |
| G10c-local | §4.5 V-W4 form | exit 0 |
| G13 | `test -f .../vowasia-real-db-validation_NOTE_16-10-26.md` | exit 0 |
| E15 stub | `test -f .../vowasia-b-beta-owner-import_NOTE_20-10-26.md` | exit 0 |
| G6 | `npm run probe:migrate-vowasia` (alone) | exit 0, "ALL PROBE CHECKS PASSED" |
| G19 | `REHEARSE_MODE=native npm run rehearse:vowasia` (once, alone, background, 7200000 ms) | exit 0, 56/56 assertions in 128 s; prefix === 'vowasia' asserted; mutants red; crash + stale lock, Q12 upload stop, per-run rollback all ok; tmp dir removed |
| G11 | `REHEARSE_MODE=native REHEARSE_SKIP_NPM_CI=1 npm run rehearse:gtp` (after G19 exited, alone) | exit 0, 133/133, UNPROVEN: none |

E19 spot-check (on a scratch COPY of `scripts/migrate/vowasia`, repo untouched):
- appended `export X=postgres://u:p@db.example.invalid:5432/x` to the copy of `rehearse-vowasia.sh` -> exit 1, flagged `rehearse-vowasia.sh:97`;
- reverted -> exit 0;
- removed `rehearse-bootstrap.ts` from the copy -> exit 1 (guard non-vacuous).

`git status --short` clean at end (apart from this report).

Note: a grep for "FAIL" in the G19 log matched 3 `ok` lines ("0 image failures", "outcome failed/uploadError" x2) — expected-path assertions, not failures.

Not run by tester (out of tester scope): G22 reviewer verdict (`harness/review-decision.json`), evidence-pack validator closeout, G23 owner run on `neondb`. No production access, no network writes, no legacy DB used.

## EVL HANDOFF SUMMARY

EVL HANDOFF SUMMARY:
```yaml
gates_green: [G1, G2, G3, G4, G5, G6, G7, G7b, G7c, SQL-unchanged, pins-frozen, G8, G10c, G10c-local, G13, E15-stub, G19, G11, E19-red-spot-check]
known_gaps: ["G22 vc-code-reviewer verdict pending", "G23 owner run on neondb with real R2 (KB-3, KB-6) — backlog stub", "O-B5 / O-B12 owner STOP items", "high-risk evidence pack validator not re-run here"]
follow_up_stubs: ["process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md"]
context_partial: []
preliminary_packet_path: none
closeout_classification: WITH_GAPS
```
