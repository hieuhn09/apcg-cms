# EVL iteration 007 — vowasia-legacy-migration (phase A) — loop closed

Date: 16-10-26. Loop driver: orchestrator.

## Result
Fresh independent vc-tester (4th EVL run, after fix cycle 3, commit 8f51f7b): all automated gates green and re-measured: G1 53/53, G2 0 errors (1 existing GTP warning), G3 exit 0, G4 69/69, G5 267/267, G6 probe PG16 ALL PROBE CHECKS PASSED with cleanup and port 54336 closed, G7/G7b/G7c/G8/G10/G13 green. 0 BLOCKER, 0 MAJOR, 0 MINOR, 1 NIT.
Loop status: HALTED_SUCCESS.

## What the last run confirmed beyond the gates
- 03 is one transaction; the DB-name guard uses set_config(..., true) inside it; the probe has cases WITHOUT ON_ERROR_STOP that assert the exact status line and that the role is intact.
- The probe runs the same psql flags the guide gives the owner (-X -q -t -A).
- VOWASIA-LEGACY.md: 31 command blocks, each exactly one command; no `#`, no `<...>`; secret-reading commands in their own blocks; no instruction to paste or send a secret.
- No GTP file changed; scope = 26 files under scripts/migrate/vowasia/ + 1 backlog + package.json +3 lines + plan docs.

## Open items (named)
- AC-A9 / G12: discover against the real old DB is a Known-Gap (the owner runs it). The A -> B gate stays CONDITIONAL.
- Not changed, recorded: MINOR-4 (trigger-returning SECURITY DEFINER functions and an old DB named neondb make the run STOP; needs an amendment if met), URL typed in an unsynced temp note, the doc line 81 NIT (remove the hint to share the site id), plan still lists `--site-id` in the CLI contract (fix at UPDATE PROCESS).
- G9 review rounds: round 1 REQUEST_CHANGES (7 MAJOR), round 2 and 3 APPROVE_WITH_CONCERNS (0 BLOCKER/MAJOR). No full G9 round after fix cycle 3; covered by the probe and the independent EVL.
- G11 (rehearse:gtp) not run, as agreed.
