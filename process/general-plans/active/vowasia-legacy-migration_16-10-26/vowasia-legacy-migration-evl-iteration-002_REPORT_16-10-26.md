# EVL iteration 002 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
EVL cycle 1: gates green but G9 REQUEST_CHANGES (7 MAJOR, 9 MINOR, 4 NIT).

## Fix applied (vc-execute-agent, supplement) — commit a96e8f1, local, not pushed
Claimed by the executor (to be confirmed independently):
- M1-M4: VOWASIA-LEGACY.md rewritten for zsh (one command per block, no `#`, no `<...>`, `openssl rand -hex 24`).
- M5: SQL 02 self-check inside the transaction (RAISE rolls back before COMMIT); header order fixed; cleanup re-reads the admin URL.
- M6: SQL 02b stops without changes on FORCE RLS or other login roles; prints RLS state first; 03 prints CLEANUP OK.
- M7: SQL 01 lists PUBLIC privileges and SECURITY DEFINER functions; 02 self-check covers them.
- m1-m9, n1, n2, n4 fixed; n3 note only. Probe gained a non-superuser table-owner variant, which exposed a real bug in 03 (DROP OWNED BY) that was then fixed.
- Executor-reported gates: G1 53/53, G4 69/69, G5 267/267, G6 probe pass (parts A-G), G7/G7b/G7c/G8/G10/G13 green; 27 files, package.json +3.

## Known gaps stated by the executor
No zsh in sandbox (static scan only); PG <= 14 not run; SECURITY DEFINER functions outside `public` only reported.

## Next
Independent vc-tester re-runs the gates (fresh agent); vc-code-reviewer re-reviews the changed files (G9 pass 2).
