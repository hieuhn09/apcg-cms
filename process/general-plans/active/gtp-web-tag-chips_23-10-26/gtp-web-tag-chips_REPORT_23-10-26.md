---
phase: gtp-web-tag-chips-execute-evl
date: 2026-10-23
status: COMPLETE_WITH_GAPS
feature: none (general-plans)
plan: process/general-plans/active/gtp-web-tag-chips_23-10-26/gtp-web-tag-chips_PLAN_23-10-26.md
---

# EXECUTE + EVL closeout: gtp-web tag chips

TL;DR: code is merged and independently tested green. The owner's live visual check is not done, so this is NOT verified and the plan stays in `active/`.

## What was done (repo hieuhn09/gtp-web)
- EXECUTE by an opus agent, commit `a4f42c5`: 11 files (6 source, 1 mock, 4 test).
- PR `gtp-web#7` merged by the owner ("merge", 23-10-26), merge commit `e2aa7b2` on `main`. Vercel production deploy of `e2aa7b2` was BUILDING at last look; Ready not confirmed.
- Rule shipped: a tag chip shows only if Central lists the tag at `minCount=2` (>= 2 published gtp articles). Fail-closed (hide ALL tag chips) on any degraded response, including `docs.length < totalDocs` and `docs.length > totalDocs`. Entries kept only with a string slug and numeric `count >= 2`. `/tags` cached 60 s with tag `articles:all`. Preview uses the same rule. Sub-section chip and static exclusions unchanged.

## Gates (EXECUTE, reproduced by independent EVL)
- Tests 127: 126 pass, 0 fail, 1 pre-existing skip.
- typecheck, lint, build:mock, check:build-outage, check:build-empty: exit 0.
- test:visual: 71 passed.
- Mutation check (`count >= 2` -> `count >= 1`): test 12b went red, as intended.
- EVL verdict: all gates green, no deviation. Bookkeeping: `results.tsv` rows 0-4.

## Verified vs unverified
| Item | State |
|---|---|
| Unit/typecheck/lint/build/visual gates | Verified (EXECUTE + independent EVL) |
| Route contract live on production (apcg-cms#49, G12) | Verified 23-10-26 (see `process/context/integrations/all-integrations.md`) |
| Vercel production deploy of `e2aa7b2` Ready | Unverified |
| Owner preview/live visual check of chips | NOT done |
| Behaviour against a real Central outage | Not tested (EVL could not) |
| `CMS_READ_TOKEN` for gtp-web on Vercel | Seen by key name only (production and preview); value unverified |

## Closeout classification
CODE-COMPLETE, MERGED, EVL GREEN, LIVE OWNER CHECK PENDING. Keep in `active/`; do not archive.

## Residual risks and gaps
- More than 2,000 qualifying tags would hide every tag chip site-wide (1,206 now; legacy migration run `gtp-real-3` adds articles before cutover).
- A transient `/tags` failure strips chips for up to 60 s.
- Non-gating plan wording nits N7-N9 left as is.

## Owner's remaining step
Open the gtp-web production (or preview) site, confirm tag chips appear only on tags with 2+ articles and nothing broken, and confirm the deploy of `e2aa7b2` is Ready. Then this plan can be archived.
