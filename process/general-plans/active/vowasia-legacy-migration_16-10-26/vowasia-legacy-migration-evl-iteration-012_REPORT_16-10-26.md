# EVL iteration 012 — vowasia-legacy-migration (phase A + Amendment 1) — loop closed

Date: 16-10-26. Loop driver: orchestrator.

## Result
Fresh independent vc-tester (last run, after the documentation-only fix cycle b0f5b89 -> cc223e1): PASS.
- Proof of "text only": 8 files changed in that range (3 SQL templates, VOWASIA-LEGACY.md, 4 bookkeeping files); every added/removed line in sql/* is a comment or blank; 0 .ts/.sh changes.
- Gates re-measured: G1 56/56, G2 0 errors (1 existing GTP warning), G3 exit 0, G4 69/69, G5 267/267, G7/G7b/G7c/G8/G13, G10a (01 and 01e), G10c, whitelist password gate green; G6 not re-run (no logic changed). 39 command blocks in the guide: 0 violations of the owner's zsh rules. 0 BLOCKER, 0 MAJOR, 1 MINOR, 2 NIT.
Loop status: HALTED_SUCCESS.

## Open items (named)
- MINOR: the guide's step B5 passes the password through a temporary note in the Notes app; macOS keeps deleted notes 30 days in "Recently Deleted" and the guide does not say to empty it there. Mitigations: read-only role, 14-day expiry, B6 drops the role. To be covered in the live instructions and fixed in the guide at UPDATE PROCESS.
- NIT: the 03e header says to search for LEGACY_DB_NAME, which still finds that comment line after Replace All; the guide's check (search `__`, expect 0) is the correct one.
- AC-A9 / G12: running discover and the SQL Editor route against the real old Supabase project is a named Known-Gap (the owner runs it); the A -> B gate stays CONDITIONAL. Never run in the real Supabase SQL Editor; pooler login `vowasia_migrator.<ref>` unconfirmed; 02p/03e only tested as superuser on PG16.
- Not done: G11 (rehearse:gtp), as agreed; UPDATE PROCESS (needs the owner's explicit command); plan still lists `--site-id` in the CLI contract.
- G9 review rounds: Amendment 1 round 1 REQUEST_CHANGES (3 MAJOR, fixed), delta round APPROVE_WITH_CONCERNS (0 BLOCKER/MAJOR); the final documentation-only fix had no separate G9 round (covered by the independent EVL's line-by-line proof).
