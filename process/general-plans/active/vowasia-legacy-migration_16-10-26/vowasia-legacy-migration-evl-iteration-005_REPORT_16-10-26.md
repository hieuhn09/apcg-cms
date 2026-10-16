# EVL iteration 005 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
Fix cycle 2 (33599bc). Independent EVL pass 3: all gates green, 0 BLOCKER/MAJOR, 3 MINOR + 3 NIT. Delta re-review (G9 pass 3): APPROVE_WITH_CONCERNS, 0 BLOCKER/MAJOR, 6 MINOR; m-A..m-H judged fixed correctly; every remaining issue fails closed.

## Decision: one last small fix cycle (owner-facing correctness only)
- MINOR-1 docs say "last line is SELF-CHECK OK" but psql shows "(1 row)" last -> fix wording (or -t -A).
- MINOR-2 03's DB-name guard depends on ON_ERROR_STOP and a session setting; a wrong cluster database would still lose the cluster-wide role -> wrap 03 in one transaction so the guard aborts it; docs: use the direct host for the admin URL too.
- MINOR-3 final "OK" line should also check that the views exist and the role can SELECT them; document the third outcome (SELF-CHECK FAILED).
- MINOR-5 renew path: re-read the admin URL before use; fix the VALID UNTIL example (<= 14 days); do not delete 02-filled.sql if the owner plans a re-run.
- MINOR-6 + tester MINOR-1: add a short 02b run step to the docs, lock_timeout for the manual DISABLE RLS step, and SET LOCAL lock_timeout in 02.
Recorded, not changed: MINOR-4 (trigger-returning SECURITY DEFINER functions and a legacy DB named neondb stop the run; loosening a security guard needs its own decision); URL typed in an unsynced temp note (accepted); other NITs go to UPDATE PROCESS / backlog.

## Next
vc-execute-agent (supplement) -> fresh vc-tester EVL re-run. No full G9 round; the changed SQL is covered by the probe.
