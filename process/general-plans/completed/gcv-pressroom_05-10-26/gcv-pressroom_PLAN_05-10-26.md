---
name: plan:gcv-pressroom
description: "Make GCV Pressroom behave like BriefAsia's: single-home pillar + engine-blocked (apcg-cms) and Distributed-by credit, filtered feeds, data-driven nav link, /press redirect (gcv-web)"
date: 05-10-26
feature: general
---

# GCV Pressroom parity with BriefAsia — PLAN (COMPLEX, 2 repos)

Complexity: COMPLEX
Status: COMPLETE_WITH_GAPS — executed, merged (apcg-cms#29, gcv-web#10), archived

## Overview
GCV already has a CMS `pressroom` pillar; make it behave exactly like BriefAsia Pressroom across apcg-cms (rules) and gcv-web (display). Reference implementation: brief-asia-web (read-only).

TL;DR: flip two CMS constants (`SINGLE_HOME_PILLARS.gcv`, `ENGINE_BLOCKED_PILLARS.gcv += pressroom`) and update tests/probe/docs; port brief-asia-web's FE Pressroom display (Distributed credit, feed filters, nav link, grid) into gcv-web and redirect `/press` to `/pressroom`. No migration. No DB writes outside a disposable local Postgres.

## Goal / SPEC (locked, trivial-lock — owner decisions in the request)

- A GCV Pressroom article belongs only to Pressroom (no secondary sections, no sub-section, not added as a secondary elsewhere, no sub-sections under the pillar, not `exclusive`). Author optional.
- Engine cannot create/refresh GCV Pressroom articles (422 `pillar not writable by engine: pressroom`). Engine translation route stays ungated (owner decision, same as BriefAsia).
- gcv-web: credit "Distributed by / Global Chic Voyage" (two lines, weight 600, no link, no avatar); cards show only "N min"; Pressroom excluded from home pool + RSS + most-read; data-driven Pressroom link at END of nav rail with a divider; footer "Press room" → `/pressroom`; `/press` permanently redirects to `/pressroom`; Pressroom page = Exclusive-style grid, single-tab pillar bar hidden; sitemap keeps Pressroom articles.
- Out of scope: GCV Pressroom row creation (already exists in prod), translations of the credit string (EN only), engine client changes, WAD.

## Decision Summary

### Chosen Approach
Constant flip in CMS + port of brief-asia-web's proven FE pattern — every CMS consumer is tenant-slug keyed, so the rule switches on with zero new logic.

### Why This Over Alternatives
| Alternative | Why Rejected |
|---|---|
| Schema field `Pillars.singleHome` | Needs a migration; BriefAsia chose a code constant on purpose; two sources of truth |
| Keep gcv-web static `/press` page and hide CMS pillar | Contradicts owner decision (1) |
| Filter Pressroom in the CMS public API | Breaks other consumers; BriefAsia filters FE-only |

### Risk Predictions
- Data: existing GCV Pressroom articles may already violate the rule; they are grandfathered until next save, where the hook will reject — owner runs the violator SQL first.
- Editorial: an editor saving an old violator gets the rule error (Console full text, /admin generic toast).
- FE: Pressroom must not be picked up by GCV's Exclusive reserved/featured logic or the home pool.
- Engine: new 422 for gcv pressroom; engine 4xx handling unverified (backlog).
- Nav: GCV `gcv-nav` layout differs from BriefAsia; divider must use DESIGN.md tokens only.

### Key Constraints Accepted
FE constant duplicates CMS constant (keep in sync); `PillarId` widened but `PILLARS` not extended (footer/facets do not list Pressroom); English-only credit.

## Acceptance Criteria
- AC1 CMS rejects every single-home violation for gcv pressroom; wad pressroom unaffected.
- AC2 Authorless gcv pressroom article saves.
- AC3 Engine intake returns 422 `pillar not writable by engine: pressroom` for gcv (create+refresh).
- AC4 gcv-web shows Distributed credit, filters home/RSS/most-read, links nav/footer to `/pressroom`, redirects `/press`.
- AC5 All gates in Verification Evidence green.

## Phase Completion Rules
- Stream is CODE DONE when its gates pass; VERIFIED only after post-deploy manual checks.

## Touchpoints

### Stream A — apcg-cms (/home/user/apcg-cms)
- `src/lib/constants.ts` (~L30-62): `ENGINE_BLOCKED_PILLARS = { gcv: ["exclusive", "pressroom"], "brief-asia": ["pressroom"] }`; `SINGLE_HOME_PILLARS = { "brief-asia": ["pressroom"], gcv: ["pressroom"] }`; update both comment blocks (GCV pressroom = editor-only, single-home; WAD stays the negative control).
- `src/lib/single-home-pillars.test.ts`: L47 deepEqual; L50-60 rename test + assert gcv = ["exclusive","pressroom"], add `isEngineBlockedPillar("gcv"," Pressroom ")===true`; L87-92 gcv pressroom now flagged (split into positive gcv + wad negative); L98-100 intake pre-check: gcv pressroom with extra section → error, gcv finance listing `pressroom` in sections → error, wad stays null; ~L195 fixtures + ~L297-299 (gcv pressroom rename/move now blocked; wad→gcv move into pressroom slug: decide per `checkPillarRowChange` semantics — assert actual rule, moving a row INTO a single-home slug is blocked); L326 rule-error test keep with a non-single-home case; L367-392 add a gcv pressroom fixture id, keep wad pressroom `null`.
- `src/hooks/single-home-pillar.test.ts`: L30-40 add fixture `14 = gcv pressroom`; L347 split: wad pressroom still requires author; new: gcv pressroom without author passes; add one gcv secondary-row rejection.
- `scripts/single-home-probe.ts`: L16-17 header; L145 gcvPress stays; L254-257 control flips to `expectReject` (gcv article with secondary gcv pressroom row → V3 error); add gcv primary=pressroom with exclusive/secondary → reject, gcv pressroom without author → ok; sub-section under gcv pressroom → reject; gcv pressroom rename/delete-in-use → reject; wad stays the only control. Probe has no engine-intake leg (only REST/GraphQL `--http`) — do NOT add one; intake covered by unit tests.
- `scripts/seed.ts` L146-148: optionally add the same fixture to the gcv tenant under the existing default-OFF `SEED_INCLUDE_PRESSROOM` guard (local-only refusal kept). Do only if the gcv pillar list has the same shape; otherwise skip and note.
- `scripts/audit/add-pressroom-pillar.ts`: NO change (GCV row exists in prod).
- `docs/08-content-engine-integration.md` L67-68: add GCV `pressroom` to both 422 rows.
- `docs/11-operations.md` L58-70: add "Enabling GCV Pressroom" bullet: row exists; run violator SQL before deploy; deploy; rollback = remove `gcv` entries.
- `process/context/all-context.md`, `integrations/all-integrations.md` §Single-home pillar rule, `database/all-database.md`, `tests/all-tests.md` (new test count, probe counts).

### Stream B — gcv-web (/home/user/gcv-web)
- NEW `src/lib/single-home-pillars.ts` (copy of brief-asia-web, `SINGLE_HOME_PILLAR_SLUGS = ["pressroom"]`, import-free) + `src/lib/single-home-pillars.test.ts`; `package.json` script `"test:single-home": "tsx --test src/lib/single-home-pillars.test.ts"` (only if `tsx` is already a dependency — it is used by `ui:translate`).
- `src/lib/cms-client.central.ts`: add `getRecentNewsArticles(limit, locale)` (fetch limit+10, cap 50, filter single-home, new cache key); optionally filter `getPinnedLatest` (~L464, unused) only if a one-liner. `src/lib/cms-client.ts`: export it.
- `src/app/(reader)/[locale]/page.tsx` ~L80 → `getRecentNewsArticles(24, locale)`; `feed.xml/route.ts` → `getRecentNewsArticles(40)`. Sitemap + health keep `getRecentArticles`.
- `src/lib/most-read.ts`: filter single-home + cache-key bump.
- `src/lib/article-view.ts` (~L262-340): `distributed` boolean (pillar single-home), author "Distributed by Global Chic Voyage" when distributed, empty city/role/coAuthors; `cardByline(a)` helper.
- `byline-wired.tsx` + `@gcv/ui` Byline: no "By" prefix / stray space when distributed.
- `article-content.tsx` ~L350-362: two-line credit, weight 600, no `/author/` link, no avatar.
- `article/[slug]/page.tsx` ~L72 omit OG authors; ~L130 JSON-LD author `Organization` "Global Chic Voyage" when distributed.
- Card bylines: `hub-view.tsx:6`, `home/frontispiece.tsx:46`, `article-result-row.tsx:77`, plus any related-rows / exclusive-band / pillar-showcase equivalents found by `grep -rn "\.author" src/components` → "N min" only.
- `src/components/header.tsx:195-199`: remove hardcoded `/press`; add data-driven link (`pillarBySlug.has("pressroom")`) at END of rail with a divider styled from DESIGN.md tokens (mirror `.ba-nav-sep`; reuse existing clay-dot/hairline idiom in `gcv-nav`); drawer too.
- `src/components/footer.tsx:35` → `["Press room", "/pressroom"]`.
- `/press` redirect: `next.config.*` `redirects()` permanent for `/press` and `/:locale/press` → `/pressroom` (respect locale prefix pattern used by middleware); delete `src/app/(reader)/[locale]/press/page.tsx` (and `/press/[slug]` if present).
- `src/lib/data.ts` ~L5/~L92: widen `PillarId` with `"pressroom"`, `asPillarId`/`pillarLabelFor`/`PILLAR_ICONS` mapping; do NOT add to `PILLARS`.
- `[pillar]` page: Pressroom uses Exclusive-style grid (extract shared `ArticleGridFeed` like brief-asia-web #33); hide single-tab pillar bar; ensure Exclusive reserved-story logic keys only on `EXCLUSIVE_PILLAR_SLUG`.
- `DESIGN.md` §Press room (L56, L78-79): short note that Press room now = CMS pillar `/pressroom`.

## Public Contracts
- CMS engine intake: new 422 for gcv `pressroom` (gate 3b + single-home pre-check). Admin/Console writes: new rule errors for gcv pressroom. Public read API unchanged.
- gcv-web: `/press` URL → 308/301 to `/pressroom`; RSS no longer lists Pressroom items.

## Blast Radius
- apcg-cms: 1 source constant + 3 test/probe files + seed (optional) + 2 docs + 4 context docs. Risk class: public API contract (engine intake) + editorial write rules. No schema/migration.
- gcv-web: ~15 files, display only. No auth/billing/schema.
- File sets are disjoint across repos.

## Owner runbook — READ-ONLY violator SQL (run BEFORE CMS deploy; never by agents against prod)
```sql
WITH t AS (SELECT id FROM tenants WHERE slug='gcv'),
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
Column names verified against `src/migrations/20260702_231336_initial_schema.ts` (L301, L350, L438, L480) and `20260824_000000_add_exclusive_flag.ts`; `articles.pillar_id` / `_articles_v.version_pillar_id` follow the same Payload naming — EXECUTE re-greps to confirm before writing into docs. Version-table hits are history only (informational). Violators are grandfathered until their taxonomy is next saved.

## Rollout
1. Owner runs violator SQL; fixes or accepts. 2. Deploy CMS PR + gcv-web PR (any order; both before announcing). 3. Check: `/press` redirects, Pressroom page grid, article credit, RSS, engine 422. GCV row already exists — no `audit:add-pressroom`.

## Implementation Checklist
### Stream A (apcg-cms)
A1 constants.ts both maps + comments. A2 single-home-pillars.test.ts updates. A3 hook test updates. A4 probe updates. A5 seed (optional, guarded). A6 docs/08 + docs/11 (+ SQL runbook). A7 context docs (counts after gates). A8 gates.
### Stream B (gcv-web)
B1 single-home module + test + script. B2 getRecentNewsArticles + home/feed. B3 most-read. B4 article-view distributed + cardByline. B5 byline/article-content/page OG+JSON-LD. B6 card bylines. B7 data.ts PillarId. B8 header link+divider, footer, /press redirect + delete static page. B9 pillar page grid + hide tab bar + exclusive non-collision. B10 DESIGN.md note. B11 gates.

## Verification Evidence
| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| CMS `npm run typecheck` (loose + strict per tests/all-tests.md) | Fully-Automated | no type regressions |
| CMS `npm run lint` baseline warnings only | Fully-Automated | hygiene |
| CMS `npm run test:single-home` 0 fail, count ≥ 175 (171 + ≥4 new gcv cases; exact recorded) | Fully-Automated | single-home + engine-block for gcv; wad control |
| CMS `npm run test:media-redirect` | Fully-Automated | no collateral |
| CMS `npm run probe:single-home` and `-- --http` on disposable local PG (random localhost port, recipe in tests/all-tests.md + brief-asia-web evl-iteration-002 report) all pass | Hybrid | real Payload hooks reject gcv violations, allow authorless gcv pressroom |
| gcv-web `npm run typecheck`, `npm run lint`, `npm run test:single-home` | Fully-Automated | FE helpers |
| gcv-web `rm -rf .next && DATABASE_URL=postgres://x@localhost/x npm run build` | Fully-Automated | build incl. server-only boundary |
| Manual: `/press`→`/pressroom`, credit, nav divider, RSS | Agent-Probe (post-deploy) | display criteria |

## Test Infra Improvement Notes
- gcv-web gains its first scoped `node:test` script. (none else identified yet)

## Resume and Execution Handoff
1. Plan: /home/user/apcg-cms/process/general-plans/active/gcv-pressroom_05-10-26/gcv-pressroom_PLAN_05-10-26.md
2. Last completed: PLAN + VALIDATE (fast mode).
3. Validate-contract: written (below).
4. Context: apcg-cms all-context, integrations/all-integrations §Single-home, tests/all-tests; gcv-web CLAUDE.md, DESIGN.md; brief-asia-web src/lib/single-home-pillars.ts + Pressroom plan (completed/pressroom-pillar_05-10-26).
5. Next: on "ENTER EXECUTE MODE", run Stream A and Stream B as two parallel opus execute agents; no commits/pushes.

## Validate Contract
generated-by: outer-pvl
date: 2026-10-05
Date: 05-10-26
Gate: CONDITIONAL

| Layer 1 | Status |
|---|---|
| Infra fit | PASS (no migration; constant-driven) |
| Test coverage | CONCERN (gcv-web has no runtime tests beyond new scoped helper; display verified manually) |
| Breaking changes | CONCERN (engine intake 422 for gcv pressroom; engine handling unverified) |
| Security | PASS (no auth/secret change; login.json untouched) |

| Layer 2 | Status |
|---|---|
| Stream A | PASS (all line targets confirmed by grep) |
| Stream B | CONCERN (nav divider fit + Exclusive reserved-logic interplay need on-site judgement) |

Totals: 0 FAIL / 3 CONCERN. Known-gaps accepted per owner-locked scope (backlog).

Execute-agent instructions:
- E1 Never connect to any non-local DB; probes only on a disposable local Postgres on a random localhost port; tear down after.
- E2 Never open/quote login.json. No commit, no push.
- E3 Re-grep column names before putting the SQL in docs/11.
- E4 gcv-web: if `checkPillarRowChange`-style or Exclusive reserved logic would pick Pressroom, exclude it explicitly; record any deviation in the report.
- E5 If the GCV pillar rail cannot fit the divider cleanly, ship the link without divider and note it.
- E6 Record exact new test counts and update tests/all-tests.md.

Test gates: as in Verification Evidence.

Backlog (write `process/general-plans/backlog/gcv-pressroom-followups_NOTE_05-10-26.md` at UPDATE PROCESS): engine translation route ungated; engine 4xx handling of new 422 unverified; Distributed string English-only; gcv-web test coverage; /admin Save Draft generic toast.

## EVL and Closeout
Date: 05-10-26. Merged: apcg-cms#29 (9e92fc4, Stream A), gcv-web#10 (28d3457, Stream B).

### Stream A (apcg-cms) — EVL CLEAN
- Shipped: `SINGLE_HOME_PILLARS = { "brief-asia": ["pressroom"], gcv: ["pressroom"] }`, `ENGINE_BLOCKED_PILLARS = { gcv: ["exclusive","pressroom"], "brief-asia": ["pressroom"] }` (`src/lib/constants.ts`). No migration; `add-pressroom-pillar.ts` unchanged (GCV row already in prod).
- Gates (independent vc-tester): `test:single-home` 181 (was 171), `test:media-redirect` 173, probe 66/66 and 76/76 `--http`, typecheck loose + strict 0 errors, lint 20 baseline warnings.
- Behavior confirmed: engine create / refresh / ` PRESSROOM ` variant 422 with rows unchanged; gcv exclusive still 422; gcv ordinary pillar 201/200; brief-asia pressroom 422; wad pressroom 201 (negative control); author-less gcv Pressroom publishes with public API `author:null`; author-less ordinary article rejected; secondary / rename / move / delete-in-use rejected; docs/11 violator SQL ran cleanly on the disposable DB.

### Stream B (gcv-web) — EVL WITH_GAPS
- F1: footer link and `/press` -> `/pressroom` redirect 404 until the CMS pillar row is visible to the site (footer link is unconditional).
- F2: the media-enquiries chip/email line lived on the deleted static `/press` page; it is gone (address remains in footer and /contact).
- F3: Pressroom items that do carry an author still list on author/tag/search pages as a bare "N min".
- F4: `BylineWired` unused, so its `distributed` prop is untested; most-read is code-reviewed only.

### Deviations
- No `ArticleGridFeed` extraction: GCV Exclusive already uses the shared `PillarContent`.
- A5 (seed fixture) skipped on purpose: it would collide with the probe's gcv row.
- JSON-LD author name is "The Global Chic Voyage".

### Post-merge fact
GCV has NO Pressroom articles yet, so the docs/11 pre-deploy violator SQL is optional/moot; the rule applies cleanly from the first article.

### Closeout classification
Ready for UPDATE PROCESS archival (Gate CONDITIONAL, gaps accepted by the owner and registered as backlog: `process/general-plans/backlog/gcv-pressroom-followups_NOTE_05-10-26.md`). SPEC achievement: all locked criteria met by the passing automated/probe gates for Stream A; Stream B display criteria met by manual/code verification with F1-F4 gaps registered. Drift: MEDIUM (constants, tests, probe, docs, context; no harness files). Recommend UPDATE PROCESS -- significant changes detected.
