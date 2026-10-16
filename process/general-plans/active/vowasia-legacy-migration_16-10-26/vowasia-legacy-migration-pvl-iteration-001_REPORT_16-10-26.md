# PVL iteration 001 — vowasia-legacy-migration

Date: 16-10-26. Loop driver: orchestrator.

## Before
VALIDATE pass 1 (outer-pvl): Gate CONDITIONAL, 0 FAIL, 8 CONCERN (S1-S8).

## Fix applied (vc-plan-agent, PVL-supplement)
SUPPLEMENT_APPLIED: 8 gap(s) addressed.
- S1 (high): run-id/--resume rewritten to follow owner rule 4 (each --apply gets a NEW run-id; no --resume of an old run; existing articles skipped; rollback per run; "second run" case added to the phase B rehearsal).
- S2: gate G7c added (untracked files outside scripts/migrate/vowasia/ and process/general-plans/ must be empty).
- S3: AC-A8 raised to Hybrid (local PG16 probe applies SQL 02 and 03, connects as the new role).
- S4: SQL 02 hardening and SQL 03 DROP OWNED BY.
- S5: G10 rewritten as `! grep` with word boundaries.
- S6: all 8 builders listed; overlay gains source.columnRoles; IDENT limit stated.
- S7: args.ts and out-dir.ts copied into scripts/migrate/vowasia/lib (default), plus two short tests.
- S8: numbers corrected (cli-common.ts 55-59; 23 new files after the 2 helper copies; test:single-home 267).

## Open caveats
The planner did not re-read the whole file after editing and added labels outside the 8 gaps. Re-validation from V1 must confirm no stale text contradicts the contract.

## Next
Re-spawn vc-validate-agent from V1.
