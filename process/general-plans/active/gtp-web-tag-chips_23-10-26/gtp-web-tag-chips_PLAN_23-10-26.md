---
name: plan:gtp-web-tag-chips
description: "gtp-web shows an article tag chip only if Central's GET /api/public/tags?minCount=2 lists the tag (>=2 PUBLISHED gtp articles); fail-closed on any degraded response"
date: 23-10-26
feature: none (general-plans)
---

# gtp-web: tag chips gated by Central `/api/public/tags?minCount=2`

Date: 23-10-26
Status: PLANNED (PLAN mode; SPEC/INNOVATE skipped, owner decisions recorded below)
Complexity: SIMPLE-to-COMPLEX borderline: 1 new pure module, 1 loader, 1 signature change, 2 call sites, 1 cache rule, mock route, tests. No public contract of OUR making changes; we consume an existing, live route.
Code repo: `/home/user/gtp-web` (Next.js), branch `claude/clever-gates-h5xyd8`, remote `hieuhn09/gtp-web`. This apcg-cms folder is only the plan's home. gtp-web has no `process/` folder and none is to be created. Line numbers below were read on 23-10-26 and the executor must re-verify them.

## Overview

Context: read process/context/all-context.md (apcg-cms router) for conventions; testing context is process/context/tests/all-tests.md (apcg-cms has no test framework; the tests for this plan run in gtp-web via `npm test`).

## TL;DR

Fetch the qualifying-tag list once per render (`GET /api/public/tags?minCount=2&limit=2000`, cached 60s, tag `articles:all`), turn it into a `Set<string>` of slugs, and filter `a.tags` against it inside `toArticleVM`. Any doubt (non-ok, malformed, truncated) returns `null` and hides ALL tag chips; the sub-section chip is unaffected. Rollback = revert the PR.

## Owner decisions (23-10-26, all six defaults accepted)

1. If every tag chip is hidden, the sub-section chip still renders.
2. Cache: revalidate 60s, tag `articles:all` (Central's Articles hook sends it, apcg-cms `src/collections/Articles.ts:30`); add a `/tags` branch to `cachePolicy` (`src/lib/central-api.ts:40-49`).
3. Preview uses the same >=2 published rule as the live page.
4. Static exclusions in `visibleTagChips` (zz-probe, format-*, pr-*, partner-content) still apply IN ADDITION to the count rule.
5. Transient `/tags` failure: hide all chips until next revalidation; no last-good fallback.
6. A truncated response (`docs.length < totalDocs`) logs one distinct line with a stable prefix; other failures are already logged by `cmsFetchResult`.

Degraded rule: any non-ok result, `docs` not an array, `totalDocs` missing or non-finite, or `docs.length < totalDocs` => `null` => hide ALL tag chips. Never show an unfiltered or partial set. Chips stay non-clickable. Match on tag slug. Defensive entry rule: an entry is kept only if `typeof slug === "string"` and `typeof count === "number" && count >= 2` (guards against Central ignoring or clamping `minCount`).

## Scope

In: new pure module, loader, `cachePolicy` branch, `toArticleVM` signature, two page call sites, mock route + scenarios, tests, visual-spec check.
Out of scope: tag pages, clickable chips, any Central/apcg-cms change, env or secret changes, REVALIDATE_SECRET work, JSON-LD keywords (none exist), Press Room tag chips (`src/lib/sections.ts:103`, separate feature), `labelFor` behavior.

## Verified facts

- Live route (production, verified): `minCount=2` -> 1,206 docs, totalDocs 1,206, min count 2; `minCount=1` -> docs 2000 vs totalDocs 5037 (truncation signal); no token -> 401. Response `{docs:[{slug,title,count}], totalDocs}`.
- Headroom: 1,206 qualifying tags vs limit 2,000. Verified live 23-10-26 by the owner against production with a gtp read token (apcg-cms G12 check): `minCount=2&limit=2000` -> n=1206, totalDocs=1206, min count 2; `minCount=5` -> 299; `minCount=1` -> n=2000 of totalDocs 5037 (truncated). apcg-cms `docs/09-website-integration.md` says "about 1,673 at minCount=2 on 21-10-26, 84% of cap"; that figure is a stale estimate (cause not established; the earlier plan's 21-10-26 measurement was 1,239 + 434 tags; the 23-10-26 live check shows 1,206). Both figures are recorded here with dates; correcting docs/09 is an apcg-cms docs follow-up OUT OF SCOPE for this plan. Cap-exceeded risk stays: if qualifying tags ever exceed 2,000 all chips hide site-wide (intentional; the decision 6 log makes it visible), and the legacy migration `gtp-real-3` will add articles before cutover.
- Single render path: `src/components/article/ArticleView.tsx:75-79` (wrapper shown when `subName || tags.length>0`, `data-testid="tag-chips"`, tags as `span.tag-chip`).
- `toArticleVM` `src/lib/article-model.ts:50-84`; tags line 77 `visibleTagChips(tags)`; `labelFor` at line 56 uses unfiltered `tags.map(slug)` (partner-content) and must stay untouched.
- Callers: `src/app/article/[slug]/page.tsx:42` (ISR revalidate 60) and `src/app/preview/[slug]/page.tsx:22` (force-dynamic). No other callers (grep over src, tests, scripts).
- `cmsFetchResult` never throws, returns `{ok,data}|{ok:false,status,reason}`, logs non-404 failures (`central-api.ts:97-170`); `/tags` presently falls to default policy (300s, no tags).
- Mock `tests/mock-central/server.ts` has no `/api/public/tags`; unknown path would not 200, so every mock run would hide all chips. Failure injection: `x-mock-fail` header / `MOCK_FAIL` env (lines ~225-232), scenario via `x-mock-scenario` / `MOCK_SCENARIO` (line 234).

## Touchpoints

| File | Change |
|---|---|
| `src/lib/tag-allowlist.ts` (new) | pure `classifyTags(result): {kind:"ok",slugs:Set<string>} \| {kind:"truncated",returned:number,total:number} \| {kind:"degraded",reason:string}`; `allowedTagSlugs(result) = c.kind==="ok" ? c.slugs : null`; `TAGS_PATH`, `TAGS_PARAMS` constants |
| `src/lib/cms-client.ts` (near `tagsOf` l.134) | `loadAllowedTags(f?: Fetcher): Promise<Set<string> \| null>`: one `cmsFetchResult("/tags", {searchParams:{minCount:2,limit:2000}, ...f})` (forwards `fetchImpl`/`timeoutMs`/`retryDelayMs`), runs `classifyTags`, and `console.warn("[tag-chips] truncated: returned=N total=M")` ONLY for kind `truncated`; returns the Set for `ok`, else `null` |
| `src/lib/central-api.ts:40-49` | add `if (path === "/tags") return { revalidate: 60, tags: ["articles:all"] };` before the default |
| `src/lib/article-model.ts:50,77` | `toArticleVM(a, allowedTags: Set<string> \| null)`; tags = `visibleTagChips(tags).filter(t => allowedTags?.has(t.slug))` (null => empty) |
| `src/app/article/[slug]/page.tsx:42` | `const allowedTags = await loadAllowedTags();` then `toArticleVM(a, allowedTags)` (independent of `loadRelated`; may run in `Promise.all`) |
| `src/app/preview/[slug]/page.tsx:22` | same loader; `toArticleVM(doc, await loadAllowedTags())` |
| `tests/mock-central/server.ts` | `/api/public/tags` route (spec below) |
| `tests/tag-chips.test.ts` (new), `src/lib/tag-allowlist.test.ts` (new), `tests/central-api.test.ts`, `src/lib/article-model.test.ts` (new) | tests |
| `tests/visual/fidelity.spec.ts:104` | expectation `["Rail"]` stays valid if fixtures give rail count 2; verify, do not edit unless needed |

No change to `labels.ts` (`visibleTagChips` stays pure and static) or `ArticleView.tsx` (wrapper logic already handles empty tags with a sub-section).

## Public Contracts

Consumed (not changed): Central `GET /api/public/tags` per apcg-cms `docs/09-website-integration.md`. Internal: `toArticleVM` gains a REQUIRED second parameter (tsc then catches any missed call site). `classifyTags` contract: input `CmsResult<unknown>`, output a tagged result (`ok`/`truncated`/`degraded`); `allowedTagSlugs` returns the `Set<string>` for `ok`, else `null`; neither throws. No exported page or API route of gtp-web changes.

## Blast Radius

Files: 6 source, 1 mock, 3-4 test. Risk class: low (read-only consumer, fail-closed to FEWER chips, not to broken pages). Worst case: all tag chips vanish site-wide (visible, non-breaking, self-heals on next revalidation). Page render never throws because `cmsFetchResult` never throws; do NOT use `unwrap` for this call. Extra cost: one cached request per 60s (deduped within a render).

## Mock route spec (`tests/mock-central/server.ts`)

- Path `/api/public/tags`, GET, behind the existing Bearer check (401 without token is already enforced above it; the global `x-mock-fail` modes already cover 500/502/timeout/invalid-json/404/401).
- Compute counts from `ARTICLES` (published fixtures only, exclude `DRAFT`), joined to `TAGS` for title; params parity with `/home/user/apcg-cms/src/lib/public-tags.ts`: `minCount` default 1, clamp [1,1000], non-numeric -> 1; `limit` default 500, floored value <1 -> 500, clamp 2000; sort count desc then slug asc; return `{docs: docs.slice(0,limit), totalDocs: <count BEFORE slicing>}`.
- Scenario `tags-truncated` (header `x-mock-scenario` or env): return `docs` shorter than `totalDocs` (e.g. all qualifying tags but report `totalDocs = docs.length + 1`).
- Scenario `tags-bad-shape`: return `{docs:{}, totalDocs:1}`; scenario `tags-no-total`: return `{docs:[...]}` without `totalDocs`; scenario `tags-empty`: `{docs:[], totalDocs:0}`.
- The existing `empty` scenario must not change `/tags` behavior.
- Fixture check: `rail` is on lagoon-town-tourist-levy and rail-pass-price-change (count 2); mock counts: rail 2, format-guide 2 (lagoon + first-time-capital-primer), pr-aviation 2 (lagoon + pr-airline-new-service), zz-probe 1, partner-content 1. So the allowed set is {rail, format-guide, pr-aviation} and the fidelity expectation stays ["Rail"] via the static exclusions (executor confirms by running the route).

## Test plan

New unit file `src/lib/tag-allowlist.test.ts` (pure, no network), cases for `allowedTagSlugs`:
Cases assert `classifyTags` kinds (and `allowedTagSlugs` null/Set). `noUncheckedIndexedAccess` is on, so tests need `!`. 1. happy path -> kind ok, Set of slugs; 2. empty docs with totalDocs 0 -> empty Set (NOT null; legitimately nothing qualifies, chips all hidden); 3. `!ok` status 0 timeout -> null; 4. `!ok` 401 -> null; 5. `!ok` 404 -> null; 6. `!ok` invalid-json -> null; 7. `docs` not an array -> null; 8. `totalDocs` missing -> null; 9. `totalDocs` NaN/string -> null; 10. `docs.length < totalDocs` -> kind `truncated` with returned/total (allowedTagSlugs null); 11. `docs.length > totalDocs` -> null (inconsistent, fail closed); 12. docs entries lacking string `slug` are ignored but do not crash; 12b. entries with `count` 1 or missing `count` are ignored (the mock must return `count`).

New `src/lib/article-model.test.ts` (not labels.test.ts) for `toArticleVM(a, allowed)`:
13. allowed contains rail -> tags `["rail"]`; 14. allowed lacks rail -> `[]`; 15. allowed `null` -> `[]`; 16. static exclusions still applied even if allowed contains zz-probe/format-guide/pr-aviation/partner-content; 17. sub-section data (`subName`, `subHref`) unchanged when tags hidden (wrapper still renders); 18. `label` for a sponsored article tagged partner-content is still "Partner Content" with `allowed = null` (labelFor unaffected); 19. preview parity (source-text test in `tests/tag-chips.test.ts`, same style as `tests/outage.test.ts`, because the preview page imports `server-only` and `next/headers`): both `src/app/article/[slug]/page.tsx` and `src/app/preview/[slug]/page.tsx` contain `loadAllowedTags(` and a 2-argument `toArticleVM(...)` whose second argument is not a `null` or empty-Set literal; the article page contains no `try {` (`tests/outage.test.ts:48` forbids it).

Mock-backed test `tests/tag-chips.test.ts` using `withMockEnv`. Mechanics: `loadAllowedTags(f?)` forwards `fetchImpl`/`timeoutMs`/`retryDelayMs`; failure cases use `{fetchImpl: headerFetch({"x-mock-fail": m}), timeoutMs: 150, retryDelayMs: 1}`; scenario cases use `headerFetch({"x-mock-scenario": s})` for the `tags-*` scenarios; the `console.warn` spy filters on the `[tag-chips]` prefix (it also sees `[central-api]` lines), and loader cases 22-24 assert zero `[tag-chips] truncated` lines. 20. `loadAllowedTags()` against default mock returns Set containing `rail`; request logged with `minCount=2&limit=2000` and Bearer; 21. `tags-truncated` -> null, classify kind `truncated`, and exactly one warn line with the stable prefix `[tag-chips] truncated` (spy on console.warn); 22. `MOCK_FAIL`/`x-mock-fail` 401, 500, timeout, invalid-json -> null; 23. `tags-bad-shape`, `tags-no-total` -> null; 24. `tags-empty` -> empty Set. Extend `tests/central-api.test.ts` with 25. `cachePolicy("/tags")` equals `{revalidate:60, tags:["articles:all"]}`.

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| Cases 3-11 (`tag-allowlist.test.ts`) plus loader cases 22-23 (`tag-chips.test.ts`), `npm test` | Fully-Automated | AC1 degraded response hides all chips; AC2 truncation detected via case 10 and loader case 21 |
| Cases 1, 2, 12, 12b and loader cases 20, 24, `npm test` | Fully-Automated | AC3 allowed-set formation |
| Cases 13-19 `toArticleVM` filtering, labelFor unaffected, exclusions kept, sub-section chip kept | Fully-Automated | AC3 chip only if tag in allowed set; AC4 static exclusions + sub-section preserved; AC5 preview parity |
| Cases 20, 25 loader request shape + cache policy via mock (cases 21-24 are mapped to AC1-AC3 above) | Fully-Automated | AC6 request shape and 60s `articles:all` caching |
| `npm run typecheck` (required param catches missed call sites) | Fully-Automated | AC7 no unupdated caller |
| `npm run lint` | Fully-Automated | AC8 hygiene |
| `npm run build:mock`, `npm run check:build-outage`, `npm run check:build-empty` | Fully-Automated | AC9 regression gate only: build still green with the mock route and under outage/empty scenarios; these do NOT exercise `/tags` (article pages are not prerendered, `tests/build-routes.test.ts`); /tags failure behavior is proven by cases 3-11 and 22-24 |
| `npm run test:visual` (fidelity.spec.ts:104 expects `["Rail"]`) | Hybrid (needs Playwright browsers + mock) | AC3 end-to-end chip rendering |
| Preview deploy check (the preview page is force-dynamic, so `/tags` is fetched uncached there; preview deploys call production Central by design, the hard stop covers tests/CI only): article with a >=2-count tag shows it; article with only 1-count tags shows none | Agent-Probe / owner (hybrid) | AC10 real-data behavior on production Central |
| Real Central outage/truncation behavior | Known-gap (never call production `/tags` from tests/CI; covered by mock scenarios) | residual, stub: none needed, behavior is covered by cases 3-11 |

AC1-AC10 are the acceptance criteria implied by owner decisions 1-6 and the Degraded rule: each "Proves" cell names its criterion and each gate names `proven by:` the listed case (strategy tag in column 2); Known-Gap is only the residual row, never a proving strategy.

## Test Infra Improvement Notes

(none identified yet) Candidate: mock scenarios are global per header, so a per-route scenario would be cleaner; not needed now.

## Verification Evidence (commands, run in /home/user/gtp-web)

`npm run typecheck`; `npm run lint`; `npm test`; `npm run build:mock`; `npm run check:build-outage`; `npm run check:build-empty`; `npm run test:visual`. All must exit 0. Never run any of them with real production `CMS_URL`/token.

## Rollout and rollback

Pure code change on gtp-web, no env/secret/Central change. gtp-web is not public (`SITE_INDEXABLE=false`). Order: PR draft -> Vercel preview deploy -> owner acceptance -> owner says "merge". Rollback: revert the PR (chips return to the unfiltered pre-change behavior); no data to undo. Preview check order: (1) open one article whose tag has count >=2 (pick one via a one-off read-only `curl -H "Authorization: Bearer $CMS_READ_TOKEN" "$CMS_URL/api/public/tags?minCount=2&limit=5"` run by the owner, token never pasted into chat; the owner also records `totalDocs` from this response) and confirm the chip shows; (2) open one article whose only tags are 1-count and confirm no tag chips, sub-section chip still present; (3) confirm no "[tag-chips] truncated" line in the preview runtime logs.

## Hard stops

- No merge without the owner's explicit "merge".
- No push to any gtp-web branch other than `claude/clever-gates-h5xyd8`.
- No production writes needed; none allowed. Tests/CI never call the production tags route.
- If Central's `/tags` shape differs from `{docs:[{slug,title,count}], totalDocs}`, stop and report (do not loosen the degraded rule).
- Do not create a `process/` folder or harness files in gtp-web.

## Owner acceptance steps

1. Open the draft PR's Vercel preview URL (pattern `https://gtp-web-git-claude-clever-gates-h5xyd8-<team>.vercel.app/article/<slug>`; the executor posts the exact URL).
2. Article A (a tag with count >=2): the tag chip is visible, non-clickable.
3. Article B (only 1-count tags): no tag chip; sub-section chip (if any) still visible.
4. Reply "ok" or list differences. Merge only on the owner's explicit "merge".

## Phase Completion Rules

Code-only completion is `CODE DONE`, not `VERIFIED`. `VERIFIED` requires all gates in Verification Evidence green, the post-phase testing run (`npm test`, `test:visual`) recorded, and the owner's preview acceptance.

## Implementation Checklist (Execute checklist, ordered)

1. In `/home/user/gtp-web` confirm branch `claude/clever-gates-h5xyd8` and a clean tree; `git fetch origin`; confirm `git merge-base --is-ancestor b39affb origin/main` (if it fails, stop and report; do not merge or push; the branch is already merged into remote main via PR #6, merge commit `a3088d0`, and a stale local `origin/main` ref makes a plain `git pull --ff-only` misleading); merge or fast-forward `origin/main` into the branch so the draft PR (base main) contains only this change; keep the push-only-to-this-branch hard stop; re-read the touchpoint files and confirm line numbers.
2. Create `src/lib/tag-allowlist.ts` with `classifyTags` and `allowedTagSlugs` per the degraded rule and defensive entry rule (pure; no I/O).
3. Create `src/lib/tag-allowlist.test.ts` (cases 1-12, 12b) and run it red then green.
4. Add the `/tags` branch to `cachePolicy` (`central-api.ts:40-49`); add case 25.
5. Add `loadAllowedTags(f?)` to `src/lib/cms-client.ts`, forwarding fetch options and warning `[tag-chips] truncated: returned=N total=M` only for classify kind `truncated`.
6. Change `toArticleVM` to take `allowedTags` and filter; add cases 13-18 in `src/lib/article-model.test.ts` (case 19 goes in `tests/tag-chips.test.ts`).
7. Update both page call sites (article l.42, preview l.22); run `npm run typecheck`.
8. Add the mock `/api/public/tags` route and scenarios; add `tests/tag-chips.test.ts` (cases 20-24).
9. Run `npm run lint`, `npm test`, `npm run build:mock`, `npm run check:build-outage`, `npm run check:build-empty`, `npm run test:visual`; fix any fixture drift (e.g. rail count) in fixtures/mock, not by weakening the rule.
10. Commit `feat(tags): show tag chips only for tags used by 2+ published articles` on `claude/clever-gates-h5xyd8`; push to that branch only; open a DRAFT PR to `hieuhn09/gtp-web` main; executor appends the attribution footer lines from its system reminder.
11. Post the preview URL and acceptance steps to the owner; wait for explicit "merge".

## PVL Supplement Notes

Cycle 1 (9 gaps: G1-G8, G10) applied: classifyTags/truncation kind (G1), loader test mechanics (G2), preview-parity as source-text test (G3), headroom facts and docs/09 discrepancy (G4), defensive count rule and case 12b (G5), mock param parity with apcg-cms (G6), branch/main sync step (G7), AC9 relabel (G8), fixture counts and article-model.test.ts placement (G10). Plan notes (not gaps): a transient `/tags` failure during ISR regeneration replaces good HTML with chip-less HTML for up to 60s (owner decision 5, accepted); there is no browser case for "all tags hidden, sub-section chip still renders", covered by view-model unit assertions plus `ArticleView.tsx:75-79` reading; `noUncheckedIndexedAccess` is on so tests need `!`.

Cycle 2 (3 gaps: H1, H2, NITs N3-N6) applied: Touchpoints test row now lists `article-model.test.ts (new)`; loader-only zero-warn wording; gate table remapped (cases 3-11/22-23 to AC1/AC2, new AC3 row for cases 1, 2, 12, 12b, 20, 24, AC6 limited to cases 20 and 25); "6 source" recount; 1,673 cause reworded; step-1 stop branch; Resume item 3 updated.

## Notes for VALIDATE

- Confirm `allowedTagSlugs` returns empty Set (not null) for a valid empty response, and that this is the intended behavior.
- Confirm `cmsFetchResult` retries 502/503/504 once; timeout default 8s: acceptable for ISR.
- Check the preview page: `centralPreviewFetch` uses noAuth, but `/tags` needs Bearer; `loadAllowedTags` uses the default (authed) path, and `CMS_READ_TOKEN` must exist in the preview environment (it does for article pages).
- Check that no other test snapshot asserts tag chip output (grep `tag-chips`, `tag-chip`).

## Resume and Execution Handoff

1. Selected plan: `/home/user/apcg-cms/process/general-plans/active/gtp-web-tag-chips_23-10-26/gtp-web-tag-chips_PLAN_23-10-26.md`
2. Last completed step: PLAN written; nothing executed.
3. Validate-contract: written in `## Validate Contract` (PVL cycle 3, final verdict recorded there).
4. Context loaded: gtp-web sources named in Touchpoints; apcg-cms `docs/09-website-integration.md` route contract; previous plan `gtp-public-tags-route_21-10-26/`.
5. Next step: ENTER EXECUTE MODE in `/home/user/gtp-web` per the checklist (step 1 first: branch, clean tree, fetch, ancestor check).

## Validate Contract

Status: PASS
Date: 23-10-26
date: 2026-10-23
generated-by: outer-pvl
supersedes: 2026-10-23 (outer-pvl, cycle 2) — cycle-3 PVL re-validated from V1 against current gtp-web code and apcg-cms `src/lib/public-tags.ts`; cycle-2 contract replaced, not appended

Parallel strategy: sequential
Rationale: 7-signal score 1/7 (only S7, 5+ source files in blast radius); LOW, single-package read-only consumer. One execute-agent (opus) in /home/user/gtp-web, then one vc-tester confirmation run (sonnet). Layer 1 and Layer 2 checks for this pass were run sequentially by the validate agent reading the live gtp-web and apcg-cms code (no subagents spawned).

Baseline measured this pass (read-only, no network, no build): `tsc --noEmit` exit 0; `npx eslint .` (what `npm run lint` runs) exit 0; `npx eslint src/lib` exit 0; branch `claude/clever-gates-h5xyd8`, tree clean.

Test gates (C3 5-column table):

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC1 | Any degraded `/tags` result (non-ok, bad shape, missing/non-finite totalDocs, truncated, inconsistent) yields `null` and hides ALL tag chips | Fully-Automated | `npm test` -> `src/lib/tag-allowlist.test.ts` cases 3-11 + `tests/tag-chips.test.ts` cases 22-23 (loader level) | B |
| AC2 | Truncation (`docs.length < totalDocs`) is detected and logged once with prefix `[tag-chips] truncated`; no other failure kind logs that prefix | Fully-Automated | `npm test` -> `src/lib/tag-allowlist.test.ts` case 10 + `tests/tag-chips.test.ts` case 21 (one warn line) and cases 22-24 (zero such lines) | B |
| AC3 | A tag chip renders only if its slug is in the allowed set (ok kind, entries with string slug and count >= 2); `null` set renders none; a valid empty response yields an empty Set | Fully-Automated | `npm test` -> `src/lib/article-model.test.ts` cases 13-15 + `src/lib/tag-allowlist.test.ts` cases 1, 2, 12, 12b + `tests/tag-chips.test.ts` cases 20, 24 | B |
| AC3b | Same rule end to end in a browser (lagoon article shows exactly `Rail`) | Hybrid | `npm run test:visual` (precondition: preinstalled Chromium at /opt/pw-browsers/chromium + mock on 3599; `tests/visual/fidelity.spec.ts:104`) | B |
| AC4 | Static exclusions (zz-probe, format-*, pr-*, partner-content) still apply on top of the count rule; sub-section data unchanged when tags hidden; `labelFor` unaffected | Fully-Automated | `npm test` -> `src/lib/article-model.test.ts` cases 16-18 | B |
| AC5 | Preview and live pages pass tags through the same loader and function | Fully-Automated | `npm test` -> structural source-text test `tests/tag-chips.test.ts` case 19 | B |
| AC6 | Loader request is `GET /api/public/tags?minCount=2&limit=2000` with Bearer; cache policy is `{revalidate:60, tags:["articles:all"]}` | Fully-Automated | `npm test` -> `tests/tag-chips.test.ts` case 20 + `tests/central-api.test.ts` case 25 | B |
| AC7 | No caller of `toArticleVM` left on the old signature | Fully-Automated | `npm run typecheck` (exit 0) | B |
| AC8 | Lint hygiene on new files | Fully-Automated | `npm run lint` (exit 0) | B |
| AC9 | Build commands still behave (regression only: article pages are not prerendered, so these do NOT exercise `/tags`) | Fully-Automated | `npm run build:mock`, `npm run check:build-outage`, `npm run check:build-empty` | B |
| AC10 | Real-data behavior on the preview deploy (>=2-count tag shows; only 1-count tags show none; sub-section chip stays; no truncation log) | Agent-Probe | Owner acceptance steps + Rollout preview check order (owner runs the one-off read-only curl; token never pasted) | B |

Residual (gap-resolution D, keep-active): behavior against a real production Central outage or a real >2000-tag truncation is never tested from tests/CI (hard stop); it is covered only by mock scenarios and cases 3-11 and 22-24.

gap-resolution legend: A proven now; B fixed in this plan (gate added by this plan's checklist); C deferred to a named later phase/plan; D backlog test-building stub (named residual). Known-Gap is never a `strategy:` value.

Failing stubs (Fully-Automated test rows; copy into the new test files as the red-first start). AC7, AC8 and AC9 are command gates (typecheck, lint, build scripts) with no test() to stub:

- AC1: `test("should hide all chips for every degraded /tags result", () => { throw new Error("NOT IMPLEMENTED — TDD stub: degraded matrix returns null") })`
- AC2: `test("should detect truncation and log one [tag-chips] truncated line", () => { throw new Error("NOT IMPLEMENTED — TDD stub: truncation log") })`
- AC3: `test("should show a tag chip only when its slug is allowed", () => { throw new Error("NOT IMPLEMENTED — TDD stub: toArticleVM filters by allowed set") })`
- AC4: `test("should keep static exclusions and sub-section data when tags are hidden", () => { throw new Error("NOT IMPLEMENTED — TDD stub: exclusions plus sub-section kept") })`
- AC5: `test("should route preview and live pages through loadAllowedTags", () => { throw new Error("NOT IMPLEMENTED — TDD stub: preview parity guard") })`
- AC6: `test("should request /tags with minCount=2 and limit=2000 and cache 60s articles:all", () => { throw new Error("NOT IMPLEMENTED — TDD stub: request shape and cache policy") })`

Legacy line form:
- gtp-web allowlist/model/loader: [Fully-automated: `cd /home/user/gtp-web && npm test`] | [Fully-automated: `npm run typecheck`, `npm run lint`] | [Fully-automated regression: `npm run build:mock`, `npm run check:build-outage`, `npm run check:build-empty`] | [hybrid: `npm run test:visual` + preinstalled Chromium + mock] | [agent-probe: owner preview check on production-backed Central] | [known-gap: real Central outage/truncation never called from tests/CI, documented]

Dimension findings:
- Infra fit: PASS — re-verified 23-10-26 in /home/user/gtp-web: `cachePolicy` (`central-api.ts:40-49`) has no `/tags` branch so the new branch goes before the default `return`; `cmsFetchResult` never throws, retries only 502/503/504 once, passes `next.revalidate/tags`; article page `revalidate = 60`; preview page `force-dynamic`; exactly two `toArticleVM` callers (`article/[slug]/page.tsx:42`, `preview/[slug]/page.tsx:22`), no test or script calls it. `npm test` glob covers `src/**/*.test.ts` and `tests/**/*.test.ts` (new test files are picked up). Response size at the 2,000 cap (~170 KB) is under Next's 2 MB fetch-cache item limit.
- Test coverage: PASS — H2 closed: AC1/AC2/AC3/AC6 case mappings in the test plan, the gate table and this contract agree; the zero-warn assertion is attributed to loader cases 22-24 only. Case numbering 1-12, 12b (allowlist), 13-18 (article-model), 19-24 (tag-chips, 19 source-text test), 25 (central-api) is gapless and consistent with checklist steps 3, 4, 6, 8. Non-gating NITs only (see Open gaps).
- Breaking changes: PASS — internal signature only (required second param, `tsc` includes tests so a missed call site fails typecheck); no exported page or API route changes; the only tag-chip assertion is `tests/visual/fidelity.spec.ts:104` and it stays `["Rail"]`.
- Security surface: PASS — server-side Bearer only, no token/tenant in logs (counts only), no new client exposure, fail-closed to fewer chips; preview deploy reads production Central read-only by design; tests/CI never call production.
- Loader + allowlist module: PASS — `classifyTags` ok/truncated/degraded and `allowedTagSlugs` consistent across Touchpoints, Public Contracts, Test plan and checklist steps 2 and 5; defensive entry rule (`typeof slug === "string"`, `typeof count === "number" && count >= 2`) consistent with case 12/12b; truncation compares raw `docs.length` to `totalDocs`, so entries dropped by the entry rule cannot cause a false truncation; loader forwards `Fetcher` options matching `cms-client.ts:57`.
- Mock route spec: PASS — parity with apcg-cms `src/lib/public-tags.ts` re-read (`parseMinCount` default 1 clamp 1..1000; `parseLimit` default 500, <1 -> 500, cap 2000; `totalDocs` = pre-LIMIT total; order count desc, slug asc); fixture counts re-verified in `tests/fixtures/data.ts` (rail 2, format-guide 2, pr-aviation 2, zz-probe 1, partner-content 1, pr-hotels-hospitality 1, pr-destinations-dmo 1, pr-people-on-the-move 1; `DRAFT` is a separate export, not in `ARTICLES`), so the allowed set is {rail, format-guide, pr-aviation} and lagoon still renders exactly `Rail`. The mock Bearer check is at `server.ts:247`; the new route must be registered after it (preview, media and failure injection run before it by design). No existing test counts all mock log entries or enumerates mock paths.
- Checklist / rollout: PASS — H1 closed (Touchpoints test row lists `src/lib/article-model.test.ts (new)`), N3-N6 closed ("6 source" recount, 1,673 vs 1,206 cause marked unestablished, step-1 stop branch if the ancestor check fails, Resume items updated). No literal gate-pass string exists in the plan body outside this contract's verdict line, so the EXECUTE grep gate cannot be falsely satisfied.

Open gaps: none gating (0 FAIL, 0 unresolved CONCERN). Non-gating NITs for the executor to tidy if touching the plan, not blockers: N7 the visual-test row of the gate table says "AC3" while this contract labels it AC3b; N8 the first lines of the Test plan read "cases for `allowedTagSlugs`" followed by a sentence saying cases assert `classifyTags` kinds (wording only); N9 gate-table row 1 names loader case 21 only in its Proves cell, not in the Gate cell (the contract AC2 row is authoritative).
Known gaps and execute-time checks (unverifiable from this pass, recorded, not blockers): (1) whether `b39affb` is an ancestor of the REAL `origin/main` (local `origin/main` ref is `6d2c6ea`, stale by design, not fetched here): checklist step 1 runs `git fetch` and the ancestor check and stops and reports if it fails; (2) the 1,206 qualifying-tag headroom figure is owner-asserted (live check 23-10-26), not re-measured here; (3) real-Central outage/truncation behavior (residual D above). Accepted-by-owner behavior (not a gap): a transient `/tags` failure during ISR regeneration replaces good HTML with chip-less HTML for up to 60s (owner decision 5).

What This Coverage Does NOT Prove:
- Unit cases 1-12b do not prove the live Central response shape; only apcg-cms `src/lib/public-tags.ts` and `route.ts` were read, production was not called.
- Cases 13-19 and the visual lagoon check do not prove the "every tag hidden, sub-section chip still renders" browser outcome (no test renders that wrapper state); that rests on unit VM assertions and `ArticleView.tsx:75-79`.
- Mock scenarios (cases 20-24) do not prove behavior under a real Central outage, an expired token, or real >2000-tag truncation; `npm run test:visual` covers only the default mock.
- AC9 build gates do not prove the new loader: article pages are not prerendered at build (`generateStaticParams` returns `[]`).
- Nothing automated proves the Vercel Preview environment has `CMS_READ_TOKEN` (owner-asserted); if absent, preview shows no chips (fail-closed).
- ISR timing (60s window, `articles:all` revalidation from Central) is not exercised by any test; gtp-web may not receive Central's revalidate webhook (REVALIDATE_SECRET not set), in which case only the 60s time-based refresh applies.
- The 1,206 qualifying-tag headroom figure and the `b39affb` / PR #6 merge-commit claim are owner/plan-asserted; not re-measured or re-fetched in this pass.

Gate: PASS (0 FAIL, 0 CONCERN after cycle 3; all cycle-1 and cycle-2 gaps verified closed with no regression; only non-gating NITs and recorded known gaps remain)
Accepted by: n/a — nothing to accept (no CONCERN open). Validated autonomously in PVL cycle 3 (session, outer-pvl); known gaps above are recorded, not accepted-away.

## Autonomous Goal Block

SESSION GOAL: gtp-web shows an article tag chip only if Central `GET /api/public/tags?minCount=2&limit=2000` lists the tag (>=2 published gtp articles); fail-closed (hide all tag chips) on any degraded response.
Charter + umbrella plan: N/A — single plan: /home/user/apcg-cms/process/general-plans/active/gtp-web-tag-chips_23-10-26/gtp-web-tag-chips_PLAN_23-10-26.md
Autonomy: standing /goal rules (feedback_autonomous_phase_execution.md): autonomy removes approval pauses only; spawned agents still do all edits and gate runs; no inline execution by the orchestrator.
Hard stop conditions / safety constraints:
- No merge without the owner's explicit "merge".
- Push only to gtp-web branch claude/clever-gates-h5xyd8; open a DRAFT PR to main.
- Tests/CI never call the production tags route; no production writes; no env, secret or Central change.
- If Central's /tags shape differs from {docs:[{slug,title,count}], totalDocs}, stop and report; never loosen the degraded rule.
- If the ancestor check in checklist step 1 fails after git fetch, stop and report; do not merge or push.
- Do not create a process/ folder or harness files in gtp-web.
Next phase: EXECUTE (spawn vc-execute-agent, opus) with this plan: /home/user/apcg-cms/process/general-plans/active/gtp-web-tag-chips_23-10-26/gtp-web-tag-chips_PLAN_23-10-26.md (work in /home/user/gtp-web); then EVL via a spawned vc-tester re-running the contract gate commands
Validate contract: inline in plan (## Validate Contract)
Execute start: cd /home/user/gtp-web && npm test && npm run typecheck && npm run lint && npm run build:mock && npm run check:build-outage && npm run check:build-empty | hybrid: npm run test:visual (preinstalled Chromium, one run at a time) | probe: owner preview check on the branch preview URL | high-risk pack: no
