# EVL iteration 004 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
G9 pass 2: APPROVE_WITH_CONCERNS (9 MINOR). Last small fix cycle ordered for m-A..m-H + cheap NITs.

## Fix applied (vc-execute-agent, supplement) — commit 33599bc, local, not pushed
Claimed by the executor (to be confirmed independently):
- m-A conditional "SELF-CHECK OK" in 02; "RLS SETUP OK" only when everything is in place in 02b.
- m-B doc recovery after the 14-day expiry corrected.
- m-C 02b guard catches NOLOGIN roles and PUBLIC; lock_timeout 3s; NOINHERIT + VALID UNTIL; PUBLIC self-check; final-state check; 01 lists NOLOGIN readers (5a) and membership graph (5e).
- m-D doc sentence: no column migrations on articles/sites between 02 and 03.
- m-E `__LEGACY_DB_NAME__` placeholder, STOP on neondb or name mismatch; 03 requires `-v legacy_db=...`.
- m-F SECURITY DEFINER outside `public` now STOPs by default (owner can loosen with `allow_definer_outside_public`).
- m-G 01 section 6b lists columns of articles/sites.
- m-H one removal order for 02b; probe covers both orders (03 right after 02b leaves RLS ON, which is why the manual step must come first).
- NITs fixed; m-I accepted with a doc note.
- Executor-reported gates: G1 53/53, G4 69/69, G5 267/267, G6 probe pass incl. new cases, G7-G13 green; 27 files, package.json +3. (G10a first caught a new query in 01; the executor narrowed it.)

## Known gaps stated by the executor
No zsh in sandbox; PG <= 14 by logic only.

## Next
Fresh vc-tester EVL re-run; short delta re-review of the changed files (G9 pass 3).
