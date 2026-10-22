# EVL iteration 006 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
G9 pass 3: APPROVE_WITH_CONCERNS (0 BLOCKER/MAJOR, 6 MINOR). Last small fix cycle ordered (evl-iteration-005).

## Fix applied (vc-execute-agent, supplement) — commit 8f51f7b, local, not pushed
Claimed by the executor (to be confirmed independently):
- MINOR-1 every doc/header command for 02/02b/03 uses `-X -q -t -A`, so the last printed line is the status line; the probe runs the same flags.
- MINOR-2 03 wrapped in ONE transaction with `set_config(..., true)` inside the DO block; new probe cases WITHOUT ON_ERROR_STOP (wrong DB name, missing `-v legacy_db`) end in CLEANUP STOP with the role intact; doc: use the direct host for the admin URL too.
- MINOR-3 02 reports OK only when role, schema, both views and SELECT on both views exist (nested CASE); 02b also checks SELECT; doc describes 3 outcomes; probe case: 02 on a wrong DB without ON_ERROR_STOP -> SELF-CHECK FAILED: nothing created.
- MINOR-5 renew path re-reads the admin URL with `read -s`; owner fills the VALID UNTIL date (<= 14 days); cleanup deletes private files only when no re-run is planned.
- MINOR-6 + tester MINOR-1 new step O3b for 02b (record the BEFORE line), manual disable-RLS command with `SET lock_timeout`, header says "waits up to 3 s", 02 gets `SET LOCAL lock_timeout = '3s'`.
- Executor-reported gates: all green; G6 ALL PROBE CHECKS PASSED and cleaned up; 27 files, package.json +3.
Not changed (recorded): MINOR-4, URL typed in an unsynced temp note, remaining NITs.

## Next
Fresh vc-tester EVL re-run (last). Then push to PR #41.
