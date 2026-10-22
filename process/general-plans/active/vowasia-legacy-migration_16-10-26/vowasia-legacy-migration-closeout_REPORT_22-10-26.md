---
name: report:vowasia-legacy-migration-closeout
description: "Closeout of VowAsia legacy migration stage B (B-alpha + B-beta + owner's real production run G23, 20-10-26)"
date: 22-10-26
feature: general-plans
---

# VowAsia legacy migration, stage B closeout

TL;DR: The import is done and verified on production Central (`neondb`): 358 articles imported, VERIFY OK, 0 failures. The plan stays in `active/` only for cutover-bound items (redirect PR merge, OB12 cleanup).

## Closeout packet

1. Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`
2. Classification: **Keep in active/testing** (import proven; cutover items and named residuals remain).
3. Finished: tooling (`migrate:vowasia:*`, 199 tests in `test:migrate-vowasia`), G22 review fixes, owner run G23 on production Central, redirect map committed to vowasia-web (draft PR #3).
4. Verified (owner screenshots, 20-10-26, Mac, Neon `neondb`):
   - OB1 taxonomy dry run: tenant vowasia + 49 rows all exist.
   - OB5 dry run: banner `/neondb`; snapshot 370 articles, snapshot sha `95d017cd...df01`, manifest sha `50c431a1...c105`.
   - OB6 run A (`--limit 50`): created 50, media created 54 reused 0, failed 0, timestamps-fix 50 blocks.
   - OB7 run B: created 308, media created 304, failed 0, timestamps-fix 308 blocks. A second accidental run B was refused ("run directory already exists"), nothing written, journal intact (the new-run-id guard works on production).
   - OB8 rewrite-links skipped: 0 old-site-article links (3 external links kept).
   - OB9 timestamps-fix.sql via psql on the DIRECT (non-pooler) URL: run A COMMIT, run B COMMIT.
   - OB10 verify: status archived 100 / draft 28 / published 230; pillars 48/7/69/92/142; tags 88/31/32/119/88; planned 358, marker 358, journaled 358; all expected = found; VERIFY OK.
   - OB11 redirects: `redirect-map.json` 349 entries (12 x 410, 230 to /pillar/slug, 107 to /pillar); 21 old drafts no entry. vowasia-web branch `claude/tender-wright-482jab` commit `b6d2572`, draft PR https://github.com/hieuhn09/vowasia-web/pull/3 (NOT merged).
   - Unverified: public rendering on the live vowasia site (site is dark until cutover); redirect map behaviour in production.
4b. Validate-contract: B-alpha and B-beta contracts present, Gate PASS.
5. Cleanup done: backlog notes updated, context updated. Still needed: OB12 data cleanup (after cutover), PR #3 merge at cutover.
6. Next valid state: keep plan active; resume at cutover (no date, C10).
7. Commit checkpoint: process commit (this closeout, context, backlog, runbook note) belongs after UPDATE PROCESS; orchestrator commits. Source commits were done earlier.
8. Regression: GTP files unchanged since 7390d6c (EVL cycle 2, G19 56/56).
9. SPEC achievement: no separate `*_SPEC_*.md` for this plan; acceptance covered by plan gates G1-G29. G23 (owner production run) is now satisfied; B-beta is VERIFIED on production for the import itself.

Drift score: HIGH (agent/harness untouched, but protocol-free; signals: files touched >=10 across the branch, new task-folder artefacts, 3+ memory-worthy lessons, backlog notes written = 4). Strongly recommend UPDATE PROCESS -- done in this session.

## Lessons

- Mac branch had no upstream tracking, so `git pull` failed; use `git pull --ff-only origin <branch>` and set upstream.
- `--confirm-host` can be derived from `.env.local` for dry runs; type it literally for `--apply`.
- pg DeprecationWarning and SSL-mode warnings are harmless noise.
- Run `timestamps-fix.sql` on the direct (non-pooler) URL.
- The real snapshot directory name is dated, not literally `snapshot`.

## Open items

See backlog `process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md`.
