# EVL iteration 003 — vowasia-legacy-migration (phase A)

Date: 16-10-26. Loop driver: orchestrator.

## Before
Fix a96e8f1 applied. Independent EVL re-run (fresh vc-tester): all gates green (G1 53/53, G4 69/69, G5 267/267, G6 probe pass, G7-G13), 0 BLOCKER/MAJOR, 2 MINOR + 2 NIT.

## G9 independent re-review: APPROVE_WITH_CONCERNS
0 BLOCKER, 0 MAJOR. All 7 first-round MAJOR items fixed correctly. 9 new MINOR (m-A..m-I) + NITs. The recommended path (01 -> 02 -> discover -> 03) is low risk for the old sites.
Chosen for a last small fix cycle (all inside existing Touchpoints):
- m-A: last line of 02 prints SELF-CHECK OK unconditionally -> make it conditional.
- m-B: doc recovery after VALID UNTIL is wrong (changing the password does not extend it) -> run cleanup then re-run 02 (or ALTER ROLE ... VALID UNTIL).
- m-C: 02b guard ignores NOLOGIN roles used through SET ROLE (e.g. anon/authenticated); no lock_timeout; lacks NOINHERIT / VALID UNTIL / PUBLIC self-check -> fix guard.
- m-D: view locks the old tables' columns -> doc sentence "no column migrations on articles/sites between 02 and 03".
- m-E: no in-SQL database-name guard ("Ctrl+C now" is not feasible) -> RAISE if the database is the Central one or does not match an owner-filled old-DB name.
- m-F: SECURITY DEFINER outside `public` is a NOTICE only -> doc: if count > 0 do not set the password; consider STOP.
- m-G: 01 does not list columns of articles/sites -> add information_schema query.
- m-H: removal order of 02b contradicts between header and doc; 03-after-02b not probed -> unify, add probe.
- Cheap NITs: nano instead of TextEdit (smart quotes), mkdir -m 700, direct host not pooler, delete private files after cleanup, PG <= 14 STOP note, do not export LEGACY_ADMIN_URL.
Left for the record (accepted): m-I (role is cluster-wide; check 01 5c/5d per database), plan still lists --site-id in the CLI contract (fix at UPDATE PROCESS).

## Limits stated by the reviewer
No zsh in sandbox; no proof yet for 03 after 02b, STOP on PUBLIC privilege, PG <= 14.

## Next
vc-execute-agent (supplement) fixes the list above; fresh vc-tester EVL re-run; short delta re-review.
