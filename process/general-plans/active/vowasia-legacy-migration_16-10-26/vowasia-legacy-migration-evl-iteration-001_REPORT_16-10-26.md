# EVL iteration 001 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
EXECUTE phase A done (commits 885e85a, 96abef4). EVL confirmation by an independent vc-tester: all automated gates green (G1 47/47, G4 69/69, G5 267/267, G6 probe PG16 pass, G7/G7b/G7c/G8/G10/G13), 0 BLOCKER/MAJOR/MINOR.

## G9 independent review (vc-code-reviewer): REQUEST_CHANGES
No BLOCKER. 7 MAJOR (M1-M7), 9 MINOR (m1-m9), 4 NIT (n1-n4). Core design (security_barrier view filtered by site, SELECT-only role, closed SQL builder, keyset) judged sound.
- M1 `#` inside pasted zsh commands. M2 `<file>` placeholder is stdin redirection in zsh. M3 several secret-reading commands pasted in one block. M4 `openssl rand -base64` passwords break the URL ~65% of the time. M5 self-check in SQL 02 runs after COMMIT and does not stop anything; header order wrong; cleanup uses an `unset` variable. M6 SQL 02b enables RLS on shared tables with no in-SQL guard; 03 does not turn RLS off. M7 PUBLIC function/CONNECT/TEMP privileges not inspected.
- Limits of the review: no zsh in sandbox; probe proves only a superuser owner (no Supabase-style non-superuser owner case).

## Decision
Fix cycle: vc-execute-agent (supplement mode) fixes M1-M7 and the cheap MINOR/NIT items inside existing Touchpoints; then a fresh independent vc-tester (EVL) and a G9 re-review of the changed files.
