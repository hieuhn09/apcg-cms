# PVL iteration 005 (B-beta supplement cycle 2), 20-10-26

**Result: the 3 CONCERNs from B-beta PVL pass 2 are addressed in the plan; re-validation from V1 (pass 3) next.**

- Input: `vowasia-legacy-migration-pvl-b-beta-pass2_REPORT_20-10-26.md` (Gate CONDITIONAL, 0 FAIL, 3 CONCERN).
- Gap 1: precedence line "for B-beta, §4.x governs wherever §3.x differs"; stale §3 passages (3.4 steps 4/8, 3.5 items 2 and 9-13, 3.7 gate list) prefixed as superseded, kept as history; §3.9 Q2/Q3/KB-2 closed; 349 caveat restated (importer rejects of published/archived rows or O-B12 rows).
- Gap 2: §4.5 lists kept phase-A gates with commands (SQL-unchanged diff at 9d9e5a4, G10c with excludes for the 3 rehearsal/fixture files, new G10c-local localhost-only check, G13, G6/G14 via probe:migrate-vowasia); G22 replaces G9.
- Gap 3: per-link answer file `--old-site-links-file` (outside repo, no default, refuses missing/extra/malformed/duplicate lines); rewrite to `/<pillar>/<slug>` only for rows the same run created and published; external links untouched; 10 red-first tests.
- Planner concern: G10c-local regex untested until the files exist; EXECUTE must prove it red on a non-local URL.
- Plan validator: 0 failures, 0 warnings.

Next: re-spawn vc-validate-agent from V1 (B-beta pass 3).
