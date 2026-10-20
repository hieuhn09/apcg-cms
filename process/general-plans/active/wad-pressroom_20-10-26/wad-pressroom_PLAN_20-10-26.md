---
name: plan:wad-pressroom
description: "Make WAD Pressroom behave like BriefAsia/GCV: single-home + engine-blocked pillar (apcg-cms constants, tests, probe, docs) and a 'Distributed by World Archi Design' byline on Pressroom articles (wad-web)"
date: 20-10-26
feature: general
---

# WAD Pressroom parity with BriefAsia — PLAN (COMPLEX, 2 repos)

Complexity: COMPLEX
Status: PLANNED — validate-contract written, waiting for "ENTER EXECUTE MODE"

## Overview
WAD already has a CMS `pressroom` pillar in production; make it behave exactly like BriefAsia's and GCV's Pressroom (rules in apcg-cms, byline in wad-web). Precedent: `process/general-plans/completed/gcv-pressroom_05-10-26/`.

TL;DR: add `wad: ["pressroom"]` to both CMS maps, flip every WAD "negative control" test/probe assertion to positive, use `world-travel-brief` as the new fixture-only negative control, update docs/context; in wad-web replace "By <author>" with "Distributed by / World Archi Design" on Pressroom articles only (article page byline, OG, JSON-LD, result-row). No migration, no DB writes outside a disposable local Postgres.

## Goal / SPEC (LOCKED by the owner 20-10-26 — not re-opened)

- CMS: tenant `wad`, pillar `pressroom` becomes single-home AND engine-blocked, exactly like `brief-asia` / `gcv`. Author optional for WAD Pressroom only; every other WAD pillar keeps a required author. V1–V6 single-home rules + Pillars row guards apply. Engine intake create + refresh: 422 `pillar not writable by engine: pressroom`. Engine translation route stays ungated. No migration, no schema change.
- Slug verified: WAD-web uses `pressroom` (`src/lib/data.ts:12,63,75`, `src/components/header.tsx:64`, `pillar-page-view.tsx:47,70,89,184`); CMS probe fixture also uses `(wad, pressroom)`. The local seed's `wad` tenant has no pressroom row (`scripts/seed.ts:299-308`), and the prod row already exists (owner).
- wad-web: on a Pressroom article the author spot reads "Distributed by" + "World Archi Design" (no link, no co-authors, no "By"). OG `authors` omitted; JSON-LD author = Organization "World Archi Design"; result-row drops "By X ·". English only.
- OUT OF SCOPE: home pool / RSS / most-read exclusion, nav/footer, translating the credit, engine client changes, creating any pillar row, any non-local DB write, `BylineWired` (unused: no importer in `src/`).

## Decision Summary

### Chosen Approach
Constant flip in CMS + small import-free `single-home-pillars.ts` helper in wad-web keyed on the article's primary pillar slug — every CMS consumer is tenant-slug keyed, so the rule switches on with zero new logic (same as GCV).

### Why This Over Alternatives
| Alternative | Why Rejected |
|---|---|
| Schema field `Pillars.singleHome` | Needs a migration; precedent is a code constant |
| Keep `wad` as negative control and only document | Contradicts owner SPEC |
| Use `dtw` as the new negative control | Probe relies on dtw having NO `pressroom` row (move-to-dtw checks at `single-home-probe.ts:279,319`); creating one there would turn MOVE rejections into slug-uniqueness rejections |
| wad-web test on `view.pillar === "pressroom"` inline | Works, but the helper + node:test mirrors gcv-web/brief-asia-web and keeps one source of truth |

### Risk Predictions
- Data: existing WAD Pressroom articles may already break the rule (secondary sections, sub-section, exclusive). They are grandfathered until their taxonomy is next saved; owner runs the violator SQL first.
- Engine: WAD content engine starts getting 422 for `pressroom`; engine 4xx handling stays unverified (backlog, same as GCV).
- Hub: `hub-author-refs.ts:100` reads `ENGINE_BLOCKED_PILLARS` generically, so hub authoring into WAD pressroom also becomes `blocked_pillar` (consistent with gcv; accepted).
- Tests: removing WAD as the control could silently drop coverage of "tenant-scoped, exact slug"; mitigated by the new `world-travel-brief` pressroom fixture in every place WAD was the control.
- FE: a WAD Pressroom article with a real author would lose its author link — intended.

### Key Constraints Accepted
FE constant duplicates the CMS constant (keep in sync); English-only credit; no feed/nav changes.

## Acceptance Criteria
- AC1 CMS rejects every single-home violation (V1–V6, rename, move, in-use delete) for `(wad, pressroom)`; the new control `(world-travel-brief, pressroom)` is unaffected.
- AC2 An authorless WAD pressroom article saves; an authorless WAD non-pressroom article is rejected.
- AC3 Engine intake returns 422 `pillar not writable by engine: pressroom` for wad on create AND refresh, incl. case variant ` PRESSROOM `.
- AC4 wad-web shows "Distributed by / World Archi Design" on Pressroom articles only (byline, OG, JSON-LD, result-row); other articles unchanged.
- AC5 All gates in Verification Evidence green, no regression vs recorded baselines.

## Recorded Baselines (run 20-10-26 during RESEARCH, after `npm ci` in both repos)
| Repo | Gate | Baseline |
|---|---|---|
| apcg-cms | `npm run typecheck` | exit 0, 0 errors |
| apcg-cms | `npm run lint` | exit 0, **20 warnings**, 0 errors |
| apcg-cms | `npm run test:single-home` | **267** pass / 0 fail (6 files) |
| apcg-cms | `npm run test:media-redirect` | 175 / 0 |
| apcg-cms | `npm run test:hub-media` | 100 / 0 |
| apcg-cms | `npm run test:hub-live` | 27 / 0 |
| apcg-cms | `npm run test:hub-p56` | 127 / 0 |
| apcg-cms | `npm run test:migrate-gtp` | 83 / 0 |
| wad-web | `npm run typecheck` | exit 0 |
| wad-web | `npm run lint` | exit 0, **23 warnings**, 0 errors |
| wad-web | `npm run test:bot-detect` | 31 / 0 |
| wad-web | `rm -rf .next && <dummy env> npm run build` | exit 0 |

Environment: Docker daemon is DOWN; native PostgreSQL 16 binaries exist at `/usr/lib/postgresql/16/bin/` (initdb, pg_ctl) — the probe is runnable as a Hybrid gate on a throwaway cluster.

## Phase Completion Rules
- A stream is CODE DONE when its gates pass; VERIFIED only after post-deploy manual checks by the owner.

## Touchpoints

### Stream A — apcg-cms (/home/user/apcg-cms)
- `src/lib/constants.ts`
  - L59-64 `ENGINE_BLOCKED_PILLARS`: add `wad: ["pressroom"]`.
  - L90-95 `SINGLE_HOME_PILLARS`: add `wad: ["pressroom"]`.
  - Comments L34-40 and L79-86: WAD pressroom now editor-only + single-home (owner decision 20-10-26); remove "negative control" wording.
- `src/lib/single-home-pillars.test.ts` (new control = tenant `world-travel-brief`, fixture-only)
  - L46-54 deepEqual of both maps: add `wad: ["pressroom"]`; `singleHomeSlugUnion()` stays `["pressroom","press-room"]`.
  - L56-60: rename; assert `ENGINE_BLOCKED_PILLARS.wad` = `["pressroom"]`, `ENGINE_BLOCKED_PILLARS["world-travel-brief"]` undefined.
  - L73: `isEngineBlockedPillar("wad","pressroom")` → true; add `" PRESSROOM "` true, `("wad","architecture")` false, `("world-travel-brief","pressroom")` false.
  - L92: keep `("wad","press-room")` false (exact slug) — still valid.
  - L176-180: becomes "wad pressroom is single-home" (true; `"Pressroom"` false); new negative test on `world-travel-brief`.
  - L186-189: wad intake pre-check now returns V1/V2/V3 (mirror gcv block L190-196); `world-travel-brief` stays null.
  - L290 comment; checkSingleHome uses its own `sh` stub — no change needed beyond comment.
  - L389-390 tenant move tests: still "move" (unchanged result); keep.
  - L392-394: wad rename now `"rename"`; add `world-travel-brief` rename → null.
  - L396-400: wad<->gcv moves stay "move"; add wtb non-pressroom free case.
  - L472-476, L494, L505-509, L550: add pillar `{id:19, slug:"pressroom", tenant:6}` + tenant `{id:6, slug:"world-travel-brief"}`; L494 `m.get("12")` → `"pressroom"`; L505 test: wad resolves single-home, 19 null.
- `src/hooks/single-home-pillar.test.ts`
  - L30-55 fixtures: add `19 = world-travel-brief pressroom` (tenant 6) + tenant 6.
  - L142: the foreign-`data.tenant` case with pillar 12 now must reject (V2) → swap the positive leg to pillar 19.
  - L147-150: "wad pressroom NOT blocked" → "wad pressroom IS blocked (V1/V2/V3/V6)"; new "wtb pressroom NOT blocked" with pillar 19.
  - L326-330 secondary-row validate: 12 → V3; 19 → true.
  - L346-349 SubSections: 12 → V4; 19 → true.
  - L387-390 author: wad pressroom (12) no author → true; wad ordinary pillar → REQ (add fixture `20 = wad architecture`, tenant 2); wtb pressroom (19) → REQ.
  - L455-466 move tests: still blocked (keep).
  - L468-471: wad pressroom rename → rejects; use 19 for the allowed rename.
  - L472-475: "moving WAD's pressroom into gcv" stays blocked (keep, retitle).
  - L511-515: wad pressroom referenced delete → APIError 400; wtb (19) referenced delete allowed.
- `scripts/single-home-probe.ts`
  - Header L1-19: WAD is single-home; control = `(world-travel-brief, pressroom)`.
  - L128-131: add `wtb` tenant lookup (seed has `world-travel-brief`, `seed.ts:256`).
  - L145: keep `wadPress`; add `wtbPress` + `wtbAuthor`; L149 keep `wadAuthor`.
  - L249: sub-section under wad pressroom → `expectReject(...V4)`; add wtb control `expectOk`.
  - L251-254: control block becomes wtb (primary wtb pressroom + secondary + exclusive → ok).
  - New `[WAD]` block mirroring `[GCV]` L256-274: V3, V1, V6, V4, authorless publish ok, authorless wad ordinary pillar (`architecture`) rejected, rename/move (to dtw)/in-use delete rejected.
  - L282-285: rename control uses `wtbPress`.
  - L331: "move WAD's pressroom into brief-asia" — still MOVE; keep (or switch to wtb; either is valid, prefer keeping wad + adding wtb move leg).
  - No engine-intake leg added (covered by unit tests, as in GCV).
- `scripts/seed.ts`: NO change (wad seed has no pressroom row; probe creates it).
- `scripts/hub-probe.ts`: NO change (its `wad` uses are out-of-grant tenant controls, not pillar rules; its pressroom fixtures are gcv). `scripts/lib/gtp-taxonomy.ts` / `vowasia-taxonomy.ts`: read their own tenant key only — no change. `src/lib/hub-author-refs.ts`: generic, no change (consequence noted above).
- `docs/08-content-engine-integration.md` L67-68: add WAD `pressroom` to both rows; delete "WAD's own `pressroom` is not blocked" / "WAD's `pressroom` … not single-home".
- `docs/11-operations.md` L73-95: GCV bullet's "WAD's `pressroom` is unaffected" removed; add "Enabling WAD Pressroom" bullet (row exists; run violator SQL below before deploy; deploy; rollback = remove `wad` entries + redeploy).
- Context: `process/context/all-context.md` (Single-home paragraph + lead entry), `integrations/all-integrations.md` §Single-home pillar rule (~L700, L745, L772), `database/all-database.md` (any WAD control mention), `tests/all-tests.md` (new test:single-home + probe counts).

### Stream B — wad-web (/home/user/wad-web)
- NEW `src/lib/single-home-pillars.ts`: import-free; `SINGLE_HOME_PILLAR_SLUGS = ["pressroom"] as const`; `isDistributedPillar(slug?: string | null): boolean` (exact slug); `DISTRIBUTED_BY_LABEL = "Distributed by"`.
- NEW `src/lib/single-home-pillars.test.ts` (node:test, pattern of `bot-detect.test.ts`): pressroom true; `Pressroom`/` pressroom `/undefined/null/`journal` false.
- `package.json`: add `"test:single-home": "tsx --test src/lib/single-home-pillars.test.ts"` (`tsx ^4.19.2` already a devDependency).
- `src/lib/article-view.ts`: L43-50 add `distributed: boolean` to `ArticleView`; ~L330 set `distributed: isDistributedPillar(pillar?.slug)`; when distributed set `coAuthors: []` (author string unchanged so nothing else breaks). Check every other `ArticleView` builder in the file/repo (`grep -rn "ArticleView = \|: ArticleView" src`) and set `distributed:false` where a literal is built.
- `src/components/article/article-content.tsx` L309-370: if `article.distributed` render `<span>Distributed by</span><br/><span className="font-bold text-ink">{SITE_NAME}</span>` (no Link, no co-authors, no "By"), then the existing date/readMin line; else existing markup unchanged. Tokens only from existing classes (`text-muted`, `text-ink`, `font-bold`, `text-faint`).
- `src/app/(reader)/[locale]/article/[slug]/page.tsx`: L77 `authors` only when not distributed (spread); L136-138 JSON-LD author `Organization SITE_NAME` when distributed.
- `src/components/article-result-row.tsx` L77: when `a.distributed` render `{a.readMin} min · <TimeAgo/>` only.

## Public Contracts
- CMS engine intake: new 422 for `wad` `pressroom` (gate 3b + single-home pre-check). Hub authoring: `blocked_pillar` for wad pressroom. Admin/Console: new rule errors for WAD pressroom. Public read API unchanged (author may now be `null` for WAD pressroom).
- wad-web: rendered byline/OG/JSON-LD change for Pressroom articles only. `ArticleView` gains `distributed` (internal type).

## Blast Radius
- apcg-cms: 1 source constant file + 2 test files + 1 probe + 2 docs + 4 context docs. Risk class: public API contract (engine intake 422) + editorial write rules. No schema/migration.
- wad-web: 2 new files + `package.json` + 4 edited files, display only. No auth/billing/schema.
- Stream file sets are disjoint (different repos).

## Owner runbook — READ-ONLY violator SQL for `wad` (run BEFORE CMS deploy; agents never run it against prod)
Column names re-grepped 20-10-26 against `src/migrations/20260702_231336_initial_schema.ts` (L305 `pillar_id NOT NULL`, L354-355 / L387-388 / L442-443 `pillar_id`, `sub_section_id`, L479-480 `version_pillar_id`, `version_sub_section_id`) and the exclusive-flag migration; identical to the GCV query already in `docs/11-operations.md` ~L90, tenant swapped.
```sql
WITH t AS (SELECT id FROM tenants WHERE slug='wad'),
p AS (SELECT id FROM pillars WHERE slug='pressroom' AND tenant_id=(SELECT id FROM t))
SELECT 'secondary_on_pressroom_article' k, count(*) FROM articles_secondary_sections s JOIN articles a ON a.id=s._parent_id WHERE a.pillar_id IN (SELECT id FROM p)
UNION ALL SELECT 'subsection_on_pressroom_article', count(*) FROM articles WHERE pillar_id IN (SELECT id FROM p) AND sub_section_id IS NOT NULL
UNION ALL SELECT 'exclusive_pressroom_article', count(*) FROM articles WHERE pillar_id IN (SELECT id FROM p) AND exclusive
UNION ALL SELECT 'pressroom_as_secondary_elsewhere (V3)', count(*) FROM articles_secondary_sections WHERE pillar_id IN (SELECT id FROM p)
UNION ALL SELECT 'subsections_under_pressroom', count(*) FROM subsections WHERE pillar_id IN (SELECT id FROM p)
UNION ALL SELECT 'v_secondary_on_pressroom', count(*) FROM _articles_v_version_secondary_sections s JOIN _articles_v v ON v.id=s._parent_id WHERE v.version_pillar_id IN (SELECT id FROM p)
UNION ALL SELECT 'v_pressroom_as_secondary', count(*) FROM _articles_v_version_secondary_sections WHERE pillar_id IN (SELECT id FROM p)
UNION ALL SELECT 'v_subsection', count(*) FROM _articles_v WHERE version_pillar_id IN (SELECT id FROM p) AND version_sub_section_id IS NOT NULL
UNION ALL SELECT 'v_exclusive', count(*) FROM _articles_v WHERE version_pillar_id IN (SELECT id FROM p) AND version_exclusive;
```
Version-table rows are history only (informational). Unlike GCV, WAD likely HAS Pressroom articles, so this query is NOT optional.

## Rollout
1. Owner runs the violator SQL; fixes or accepts each non-zero row. 2. Deploy wad-web PR (harmless before CMS change) and CMS PR. 3. Check: a WAD Pressroom article shows "Distributed by World Archi Design"; engine 422 for wad pressroom; an ordinary WAD article still shows "By <author>". Rollback: remove `wad` entries from both maps + redeploy; wad-web revert.

## Implementation Checklist
### Stream A (apcg-cms)
- [x] A1 `constants.ts` both maps + comments.
- [x] A2 `single-home-pillars.test.ts` flips + wtb control fixtures.
- [x] A3 `single-home-pillar.test.ts` flips + fixtures 19/20 + tenant 6.
- [x] A4 `single-home-probe.ts` [WAD] block + wtb control.
- [x] A5 `docs/08` rows, `docs/11` bullet + SQL.
- [x] A6 context docs (counts filled from A7 results).
- [x] A7 gates (below), then disposable-PG probe.
### Stream B (wad-web)
- [ ] B1 `single-home-pillars.ts` + test + `test:single-home` script.
- [ ] B2 `article-view.ts` `distributed`.
- [ ] B3 `article-content.tsx` credit.
- [ ] B4 article `page.tsx` OG + JSON-LD.
- [ ] B5 `article-result-row.tsx`.
- [ ] B6 gates.

## Verification Evidence
| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| CMS `npm run typecheck` 0 errors | Fully-Automated | AC5 |
| CMS `npm run lint` ≤ 20 warnings, 0 errors | Fully-Automated | AC5 |
| CMS `npm run test:single-home` 0 fail, count > 267 (exact recorded) | Fully-Automated | AC1, AC2, AC3 (unit: intake pre-check + `isEngineBlockedPillar` case variants) |
| CMS `test:media-redirect` 175, `test:hub-media` 100, `test:hub-live` 27, `test:hub-p56` 127, `test:migrate-gtp` 83 — all 0 fail | Fully-Automated | AC5 (shared constants, no collateral) |
| CMS `npm run probe:single-home` and `-- --http` on a disposable native PG16 cluster (random localhost port, `db:seed` first, recipe in `tests/all-tests.md`) all PASS | Hybrid | AC1, AC2 through real Payload hooks |
| wad-web `npm run typecheck`, `npm run lint` (≤ 23 warnings), `npm run test:single-home`, `npm run test:bot-detect` 31 | Fully-Automated | AC4 helper, AC5 |
| wad-web `rm -rf .next && DATABASE_URL=postgres://x:x@127.0.0.1:1/x AUTH_DATABASE_URL=postgres://x:x@127.0.0.1:1/x CMS_URL=http://127.0.0.1:1 CMS_READ_TOKEN=dummy BETTER_AUTH_SECRET=dummydummydummydummydummydummy12 NEXT_TELEMETRY_DISABLED=1 npm run build` exit 0 | Fully-Automated | AC5 (build + server-only boundary) |
| Post-deploy: Pressroom vs ordinary article byline, page source OG/JSON-LD, tag page row | Agent-Probe (owner) | AC4 |

## Test Infra Improvement Notes
- wad-web gains a second scoped `node:test` script (`test:single-home`). No component-render tests exist in wad-web; the byline JSX is verified by build + post-deploy check only.

## Resume and Execution Handoff
1. Plan: /home/user/apcg-cms/process/general-plans/active/wad-pressroom_20-10-26/wad-pressroom_PLAN_20-10-26.md
2. Last completed: PLAN + VALIDATE (fast mode, 20-10-26).
3. Validate-contract: written (below).
4. Context: apcg-cms all-context, integrations/all-integrations §Single-home pillar rule, tests/all-tests; completed plans gcv-pressroom_05-10-26 and pressroom-optional-author_05-10-26; wad-web CLAUDE.md, DESIGN.md.
5. Next: on "ENTER EXECUTE MODE", run Stream A and Stream B as two parallel opus execute agents (disjoint repos); no commits/pushes.

## Validate Contract
generated-by: outer-pvl
date: 2026-10-20
Date: 20-10-26
Gate: CONDITIONAL

| Layer 1 | Status |
|---|---|
| Infra fit | PASS (no migration; constant-driven; native PG16 present for probe) |
| Test coverage | CONCERN (wad-web byline JSX has no render test — build + manual only) |
| Breaking changes | CONCERN (engine intake + hub authoring now refuse wad pressroom; engine 4xx handling unverified; possible existing violators in prod) |
| Security | PASS (no auth/secret change; login.json untouched) |

| Layer 2 | Status |
|---|---|
| Stream A | PASS (all line targets confirmed by grep 20-10-26; dtw kept free of pressroom on purpose) |
| Stream B | PASS (targets confirmed; `tsx` present; build green with dummy env) |

Totals: 0 FAIL / 2 CONCERN / 4 PASS. Both concerns are owner-accepted scope limits (same as GCV) → known-gaps, not plan fixes.

Execute-agent instructions:
- E1 Never connect to any non-local DB or network service. Probe only on a throwaway PG16 cluster (`/usr/lib/postgresql/16/bin/initdb` into a scratch dir, random localhost port), `db:seed` then probe; stop and delete the cluster after.
- E2 Never open/quote `login.json`. No commit, no push; leave git branch `claude/vigilant-knuth-7tvio3` alone.
- E3 New negative control is `world-travel-brief` (fixture only). Do NOT create a `pressroom` row on `dtw` in the probe (it breaks the move-to-dtw checks).
- E4 Every WAD assertion that was a negative control must be flipped AND replaced by an equivalent wtb control; grep `wad` in both test files and the probe after editing and justify any remaining hit.
- E5 If `next build` rewrites `src/app/(payload)/importMap.js` in apcg-cms (not a planned gate here), `git checkout --` it.
- E6 Record exact new counts (test:single-home both repos, probe PASS totals) and write them into `tests/all-tests.md` and the plan's EVL section.
- E7 wad-web: if any other `ArticleView` literal exists, set `distributed:false`; do not change `BylineWired`, feeds, nav or footer.

Test gates (exact, in order):
- apcg-cms: `npm run typecheck`; `npm run lint` (≤ 20 warnings); `npm run test:single-home` (> 267, 0 fail); `npm run test:media-redirect`; `npm run test:hub-media`; `npm run test:hub-live`; `npm run test:hub-p56`; `npm run test:migrate-gtp`; `npm run probe:single-home` and `npm run probe:single-home -- --http` (Hybrid, disposable PG16 + local dev server only).
- wad-web: `npm run typecheck`; `npm run lint` (≤ 23 warnings); `npm run test:single-home`; `npm run test:bot-detect`; `rm -rf .next && DATABASE_URL=postgres://x:x@127.0.0.1:1/x AUTH_DATABASE_URL=postgres://x:x@127.0.0.1:1/x CMS_URL=http://127.0.0.1:1 CMS_READ_TOKEN=dummy BETTER_AUTH_SECRET=dummydummydummydummydummydummy12 NEXT_TELEMETRY_DISABLED=1 npm run build`.

Known-gaps (backlog note at UPDATE PROCESS, `process/general-plans/backlog/wad-pressroom-followups_NOTE_20-10-26.md`): engine translation route ungated; engine 4xx handling of the new wad 422 unverified; credit English-only; wad-web byline has no render test; Pressroom still in WAD home pool/RSS/most-read (out of scope by owner).

## Autonomous Goal Block
SESSION GOAL: WAD Pressroom parity (single-home + engine-blocked in apcg-cms; Distributed-by byline in wad-web)
Charter + umbrella plan: N/A — single plan
Hard stops: no non-local DB/network writes; no commit/push; never open login.json; no migration.
Next phase: EXECUTE: /home/user/apcg-cms/process/general-plans/active/wad-pressroom_20-10-26/wad-pressroom_PLAN_20-10-26.md
Validate contract: inline in plan (Gate: CONDITIONAL, 2 known-gaps)
Execute start: test gates above | probe on disposable PG16 | high-risk pack: no

## EVL Section — Stream A execute results (20-10-26, vc-execute-agent; awaiting independent vc-tester EVL)
| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0, 0 errors |
| `npm run lint` | exit 0, 20 warnings (= baseline), 0 errors |
| `npm run test:single-home` | 276 pass / 0 fail (6 files; was 267; single-home-pillars.test 87, hook test 79) |
| `npm run test:media-redirect` | 175 / 0 |
| `npm run test:hub-media` | 100 / 0 |
| `npm run test:hub-live` | 27 / 0 |
| `npm run test:hub-p56` | 127 / 0 |
| `npm run test:migrate-gtp` | 83 / 0 |
| `npm run probe:single-home` (fresh seed, disposable PG16 `/tmp/wadpr-pg.*`, port 57585) | 76/76 PASS (was 66/66) |
| `npm run probe:single-home -- --http` (`next dev -p 3511`, webpack) | 86/86 PASS (was 76/76); one benign pre-existing `(cleanup) could not delete pillars N: Not Found` line |
Cluster stopped and deleted; dev server process group killed; `src/app/(payload)/importMap.js` not modified.

E4 remaining `wad` hits (justified): tenant-move tests (`brief-asia<->wad`, `wad<->gcv`) still assert "move"; `isSingleHomePillar("wad","press-room")` false (exact slug); fixture tenant/pillar rows (id 2, 12, 20); WAD positive assertions; probe `[WAD]` block and "move WAD's pressroom into brief-asia" (still MOVE).

Deviations (within blast radius): (1) the disposable cluster lived in `/tmp/wadpr-pg.*` instead of the session scratchpad, because the `postgres` user cannot enter the scratchpad (parent `/tmp/claude-0` is root-only; same reason documented in `tests/all-tests.md`). (2) `src/hooks/single-home-pillar.test.ts` filterOptions "unconfigured tenant" case moved from `(tenant 2, pillar 12)` to `(tenant 6, pillar 19)` (not listed in touchpoints; required because wad is now configured). (3) `database/all-database.md` got a one-line WAD mention (it had no WAD control text). (4) the `all-context.md` npm-scripts row for `test:single-home` (stale "3 files, 181") was refreshed to 6 files / 276.
