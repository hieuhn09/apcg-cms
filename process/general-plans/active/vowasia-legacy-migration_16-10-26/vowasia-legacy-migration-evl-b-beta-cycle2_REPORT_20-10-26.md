---
name: report:vowasia-legacy-migration-evl-b-beta-cycle2
description: "EVL confirmation run (cycle 2) for VowAsia stage B-beta after G22 fix cycle 1 — all gates green"
date: 20-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-legacy-migration
  phase: B-beta
---

# EVL B-beta, cycle 2 (after G22 fix cycle 1)

TL;DR: every gate of `### Validate Contract (Chặng B-β)` re-run independently at HEAD `edfabee`: all green. G19 rehearsal 56/56 assertions, exit 0. G22 fixes F-1..F-4 confirmed. Evidence pack validator exit 0. No production, network write or legacy DB touched; no code changed.

Repo `/home/user/apcg-cms`, branch `claude/vowasia-launch`, HEAD `edfabee`, tree clean before and after (only this report added, uncommitted).

## Gate table

| Gate | Command | Result |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | exit 0, 199/199 pass, 0 fail |
| G2 | `npm run lint:migrate` | exit 0, 0 errors, 1 allowed warning (`seed-gtp-legacy-fixture.ts:179`) |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | exit 0, 69/69 |
| G5 | `npm run test:single-home` | exit 0, 267/267 |
| G6 | `npm run probe:migrate-vowasia` (alone) | exit 0, "ALL PROBE CHECKS PASSED", cleanup done |
| G7 | diff 9d9e5a4 outside vowasia/process | only `package.json` |
| G7b | added/removed lines in package.json | 7 added, all `vowasia`; 0 removed |
| G7c | untracked outside allowed dirs | none, exit 0 |
| SQL unchanged | `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/sql` | exit 0 |
| pins | `git diff --quiet 9d9e5a4 -- .../gtp-import-pins.ts` | exit 0 |
| G8 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 |
| G10c | §4.5 form | exit 0 |
| G10c-local | §4.5 V-W4 form (3 `test -f` guards) | exit 0 |
| G13 | `test -f .../vowasia-real-db-validation_NOTE_16-10-26.md` | exit 0 |
| E15 | `test -f .../vowasia-b-beta-owner-import_NOTE_20-10-26.md` | exit 0 |
| G19 | `REHEARSE_MODE=native npm run rehearse:vowasia` (once, alone, background, 7200000 ms) | exit 0; `rehearse-assert: 56/56 assertions ok in 121 s`; taxonomy 49 created; Media prefix `vowasia`; mutants red; Q12 upload stop ok |
| G11 | not run (per instruction) | replaced by: `git diff --quiet 7390d6c -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` exit 0 — no GTP file changed since 7390d6c |
| evidence pack | `node .claude/skills/vc-risk-evidence-pack/scripts/validate-risk-artifacts.mjs .../harness` | exit 0, 0 failures, 0 warnings (5 artifacts present) |

## G22 fix checks

- F-1: test `F-1: a create that commits but then errors (lost reply) is journaled as created, ...` (G1 #37) passes.
- F-2: `rehearse-vowasia.sh` exports the four R2 names as empty strings; `rehearse-assert.ts` refuses (exit 2) unless all four are `""`. G19 reached `56/56 assertions ok` with exit 0, so this check ran and passed (it is silent on success; no log line of its own).
- F-3: `F-3: report.failed reasons and report.stop are redacted ...` (#38) and `F-3: redact masks the Central DATABASE_URL password and the four R2 values when set` (#118) pass.
- F-4: `F-4: an outcome \`created\` line with an id but no slug-map line is still rolled back` (#73) and `F-4: an outcome-only row edited since the import (version != 1) is kept` (#74) pass.

## Notes

- `harness/verification.json` was NOT updated: the caller required a clean repo except this report. The orchestrator should record this run there if needed.
- G19 does not prove real R2, real snapshot, macOS TTY, `neondb` banner (named residual G23, unchanged).

EVL HANDOFF SUMMARY:
```yaml
gates_green: [G1, G2, G3, G4, G5, G6, G7, G7b, G7c, SQL-unchanged, pins, G8, G10c, G10c-local, G13, E15, G19, GTP-unchanged-since-7390d6c, evidence-pack-validator]
known_gaps: ["G23 owner run on neondb / real R2 / real 370-row snapshot (backlog vowasia-b-beta-owner-import_NOTE_20-10-26.md)", "G11 not re-run this cycle (GTP diff since 7390d6c empty instead)", "harness/verification.json not updated by tester (clean-repo instruction)"]
follow_up_stubs: none
context_partial: []
preliminary_packet_path: none
closeout_classification: WITH_GAPS
```
