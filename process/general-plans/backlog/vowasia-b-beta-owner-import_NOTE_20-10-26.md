---
name: note:vowasia-b-beta-owner-import
description: "Owner-run steps of VowAsia stage B-beta on production Central (neondb) with real R2; the named residual G23 / KB-3 / KB-6 of the B-beta validate contract."
date: 20-10-26
feature: general-plans
---

# VowAsia B-beta: owner import on neondb (residual G23)

TL;DR: The B-beta code is built and rehearsed locally; nothing proves it on the real 370-row snapshot, real Neon `neondb` or real R2 until the owner runs these steps. B-beta stays CONDITIONAL in closeout until the owner reports them.

Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (Amendment 4 §4.6). Runbook (Vietnamese): `scripts/migrate/vowasia/VOWASIA-LEGACY.md` part B.

| Step | What the owner runs | What it proves |
|---|---|---|
| OB1 | `audit:add-vowasia-taxonomy` dry run on Central | tenant vowasia + 49 rows exist on `neondb` (taxonomy presence gate will pass) |
| OB5 | import dry run (`--expect-sha256 50c431a1...0c105`) | real counts match §4.1 (358 imported, 12 rejected, 0 C8 rejects, 140 date fallbacks over all rows, 9 no-cover split, 349 expected map entries); the `/neondb` banner and `--confirm-host` on the real host; the 4 links with their class. STOP: owner writes the per-link answer file (O-B5) |
| OB6 | import `--apply --limit 50 --run-id A` | create path on real Neon + real R2 upload (KB-3), Media prefix `vowasia/`, author/pillar/body images in /admin |
| OB7 | import `--apply --run-id B` | the rest; run A skipped |
| OB8 | rewrite-links per run with the answer file | O-B5 answers applied only to same-run published targets |
| OB9 | `timestamps-fix.sql` per run (psql, ON_ERROR_STOP) | legacy dates restored; rollback still covers the rows |
| OB10 | verify | `VERIFY OK` on real data |
| OB11 | redirects (`--min-coverage 100`) | 349 entries; O-B12 STOP only if a published row became draft from a broken stored image (expected 0) |
| OB12 | keep journals, then delete/encrypt private files | data hygiene |

Known gaps carried: KB-3 (real R2 upload and credential errors), KB-6 (real data shapes beyond the measured facts), TTY prompts on macOS, Neon latency/locks. Open owner items: O-B5 (answer file, hard STOP before OB6), O-B12 (redirect builder STOP, no default).
