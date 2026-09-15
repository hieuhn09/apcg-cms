---
phase: podcast-youtube-embed
date: 2026-09-15
status: COMPLETE_WITH_GAPS
feature: general
plan: process/general-plans/active/podcast-youtube-embed_15-09-26/podcast-youtube-embed_PLAN_15-09-26.md
---

# EXECUTE report — YouTube-embedded podcasts

**TL;DR:** All 15 checklist steps are code-complete across both repos; all four
Fully-Automated gates are green. Classification is **CODE DONE, not VERIFIED** —
none of the 13 Agent-Probe scenarios or the Hybrid `curl` gate could be run
(no database, no live CMS, no browser in this session). Two documented
deviations, both within blast radius.

## What Was Done

### apcg-cms
| File | Change |
|---|---|
| `src/lib/youtube.ts` (new) | `extractYoutubeId(url): string \| null` — `watch?v=`, `youtu.be/`, `/live/`, `/shorts/`, `/embed/`, scheme-less input tolerated, `?t=`/`list=`/`si=` ignored, host allow-list, 11-char id shape check. |
| `src/collections/Podcasts.ts` | Added `youtubeUrl` (text, `required: true`, `beforeValidate` hook parsing → throws on empty/unparseable, writes derived id) and `youtubeId` (text, `admin.readOnly: true`). Added `admin.hidden: true` to `audioUrl` (field otherwise untouched). No revalidation hook added. |
| `src/console/data/collection-config.ts` | `MANAGED_COLLECTIONS.podcasts.fields`: added `{ name: "youtubeUrl", label: "YouTube URL", type: "text", required: true, placeholder: "https://youtube.com/watch?v=..." }`; removed the `audioUrl` entry. Landed in the same pass as the collection edit (D9 hard-coupling). |
| `src/migrations/20260915_000000_add_podcast_youtube_fields.ts` (new) | Adds `youtube_url` + `youtube_id` as **nullable** `varchar`, idempotent `IF NOT EXISTS`. `.ts` only, no `.json` snapshot. **NOT RUN.** |
| `src/migrations/index.ts` | Registered the new migration in the `migrations` array (see Deviations). |
| `src/payload-types.ts` | Regenerated via `payload generate:types`. Gitignored in this repo (`.gitignore:28`), so it does not appear in `git status`. |

### brief-asia-web
| File | Change |
|---|---|
| `src/payload/payload-types.ts` | Surgical replacement of the `Podcast` and `PodcastsSelect` blocks only. Adds `youtubeUrl`/`youtubeId` and fixes the pre-existing drift (`tenant`, `tag`, `poster`, `audioUrl` were missing; `show`/`description`/`duration`/`host` were wrongly non-optional). No other interface touched. |
| `src/lib/cms-client.central.ts` | New `getPodcasts` — `unstable_cache`, key/tag `podcasts:all`, `revalidate: 300`, mirrors `getNewsletters`. Drops episodes with no `youtubeId`; sorts newest-first. |
| `src/lib/cms-client.ts` | `export const getPodcasts = central.getPodcasts;` |
| `src/components/podcast/youtube-embed.tsx` (new) | Click-to-load facade: `<button aria-label="Play episode: {title}">` + plain `<img>` (`maxresdefault` → `hqdefault` on `onError`, loop-guarded) swapping to `<iframe src="https://www.youtube-nocookie.com/embed/{id}?rel=0">` on click. No `autoplay`. No new dependency (~110 lines incl. comments). |
| `src/app/(reader)/[locale]/podcasts/page.tsx` | Stub replaced with the real index (featured episode + card grid per DESIGN.md "Podcast"). Old comment block deleted and replaced. |
| `src/app/(reader)/[locale]/podcasts/[slug]/page.tsx` (new) | Detail page, same embed contract, `notFound()` on unknown slug, `generateMetadata`. |
| `src/app/(reader)/[locale]/podcasts/podcast-ui.tsx` (new) | Shared styles + `episodeMeta()` helper for the two routes (see Deviations). |
| `src/app/(reader)/[locale]/podcast/page.tsx` | `redirect("/")` → `redirect("/podcasts")`; stale fabricated-content comment block replaced. |
| `src/components/header.tsx` | Restored `["Podcast", "/podcasts"]` between Newsletters and RSS; BA-UI-20 comment removed. |
| `src/components/footer.tsx` | Same restoration + comment removal. |
| `src/app/sitemap.ts` | `podcasts` added to `STATIC_PATHS`; BA-UI-20 suppression comment rewritten; per-episode `podcasts/{slug}` entries enumerated from `getPodcasts`. |

`next.config.ts` untouched in both repos. No new npm dependencies. Nothing committed; both trees left dirty on `claude/tender-ptolemy-njgwwt`.

## What Was Skipped or Deferred

- **The migration was not run** (per plan hard constraint — no database reachable).
- **D2/D3 DB-emptiness check** (`SELECT tenant_id, count(*) FROM podcasts GROUP BY tenant_id;`) could not be run. Logged as an open risk: columns are nullable and `required` is app-level only, so the failure mode if rows exist is non-destructive (existing rows read fine; blocked only on their own next save).
- **AC4 Hybrid gate** (`curl {CMS_URL}/api/public/podcasts`) — `apcg-cms.vercel.app` is blocked by the egress proxy. Deferred to the user. Not faked.
- **All 13 Agent-Probe scenarios** — deferred, listed below.
- **vc-code-reviewer / vc-code-simplifier sub-step gates** — no Agent/Task tool is available in this session, so these could not be spawned. Self-review was performed instead.

## Test Gate Outcomes

Verbatim output.

`cd /home/user/apcg-cms && npm run typecheck`
```
> central-cms@0.0.0 typecheck
> tsc --noEmit
```

`cd /home/user/apcg-cms && npm run lint` — exit 0, **0 errors**. Only pre-existing warnings, all in migrations written before this plan (`'payload' is defined but never used` / `'req' is defined but never used` in `20260714_014601`, `20260801_082303`, `20260805_023748`, `20260824_000000`). No warning on any file this plan touched.

`cd /home/user/brief-asia-web && npm run typecheck` — run TWICE. First immediately after the D8 types merge, before any component or page code was written (hard ordering gate):
```
> brief-asia@0.0.0 typecheck
> tsc --noEmit
```
Second, after all files landed:
```
> brief-asia@0.0.0 typecheck
> tsc --noEmit
```

`cd /home/user/brief-asia-web && npm run lint` — exit 0, **0 errors**. One NEW warning, expected and intentional:
```
./src/components/podcast/youtube-embed.tsx
84:7  Warning: Using `<img>` could result in slower LCP and higher bandwidth. Consider using `<Image />` from `next/image` ...  @next/next/no-img-element
```
This is D7's deliberate choice (the `maxresdefault` → `hqdefault` fallback is a client-side runtime decision `next/image` cannot make without `unoptimized`). Left un-suppressed rather than adding an inline `eslint-disable`, because this repo already surfaces an "Unused eslint-disable directive" warning elsewhere and warnings do not fail the gate. All other warnings are pre-existing (`cms-client.central.ts` `_locale`, `subscribe-button.tsx`, `db/client.ts`, `market-feed.ts`, `trending.ts`).

Note: `brief-asia-web/next.config.ts` sets `eslint.ignoreDuringBuilds: true`, so lint is not a build gate there — it was run separately, as required.

## Plan Deviations

Two, both within blast radius, both documented rather than silent.

1. **`Podcast.tenant` typed as `number | null`, not `(number | null) | Tenant`** in `brief-asia-web/src/payload/payload-types.ts`. The plan says replace the block verbatim from apcg-cms. Verbatim is impossible: brief-asia-web's hand-maintained copy has **no `Tenant` interface at all** (`grep -c "^export interface Tenant "` → 0; the string `tenant` appeared nowhere in the file). Copying verbatim would have referenced an undeclared type and failed the D8 hard gate; pulling in the whole `Tenant` interface would have violated the plan's "do not touch any other interface" rule. Narrowed to the id-only shape with an explanatory comment — the reader fetches podcasts through the public API at depth 0. The drift-fix intent (add the missing `tenant` field) is preserved. `poster?: (number | null) | Media` WAS copied verbatim — `Media` does exist there.
2. **Two files created that the plan does not name:**
   - `apcg-cms/src/migrations/index.ts` edited to register the new migration. The plan's Touchpoints list the migration file only, but `index.ts` is the array Payload's runner actually imports — an unregistered migration file is dead code and the columns would never be added. Treated as part of "write the migration".
   - `brief-asia-web/src/app/(reader)/[locale]/podcasts/podcast-ui.tsx` — shared styles + the `episodeMeta()` formatter used by both the index and detail pages. The plan names two page files; this avoids duplicating identical presentation code across them. Alternative would have been extending `components/marketing/prototype-pages.tsx`, whose helpers (`ProtoPage`, `heroTitle`) are not exported — a larger, riskier edit to a shared file.

Everything else matches the plan exactly. In particular: migration not run; columns nullable with no `NOT NULL`; steps 2 and 2a landed together; no revalidation hook added to `Podcasts.ts`; `next.config.ts` untouched; no new dependencies; no `autoplay=1`; stale comment blocks replaced (not just retargeted); `/podcast` → `/podcasts`.

## Test Infra Gaps Found

- Neither repo has an automated test runner — confirmed, not assumed (`brief-asia-web/process/context/tests/all-tests.md`: "There is **no automated test runner in this repo**"). Every behavioural claim here rests on Agent-Probe scenarios that could not be executed in this session.
- `apcg-cms` has **no `process/context/` harness at all** (`CONTEXT_PARTIAL: apcg-cms context router absent — only CLAUDE.md + process/development-protocols/ available`). Known gap, flagged in the task brief; not a blocker.
- `payload generate:types` requires `DATABASE_URL` + `PAYLOAD_SECRET` to be set even though it never connects. Worked around with throwaway values. Worth noting for anyone regenerating types without a DB.

## Remaining Manual Verification (all 13 Agent-Probe scenarios + 1 Hybrid — for the user)

Needs a running CMS with a seeded BriefAsia tenant, the migration applied, and a browser:

1. AC1 — save a Podcasts doc in Payload admin with `youtubeUrl` empty → must be blocked.
2. AC2 — save with `https://vimeo.com/123` → `beforeValidate` must reject it.
3. AC2a(i) — console "Add podcast" (`/console/sites/[tenant]/podcasts`) with `youtubeUrl` filled → creates successfully.
4. AC2a(ii) — same form left blank → friendly server-side "YouTube URL is required." before Payload validation.
5. AC3 — save each of `watch?v=`, `youtu.be/`, `/live/`, `/shorts/`, plus one `?t=42` and one playlist-param URL → correct `youtubeId` derived each time.
6. AC4 (**Hybrid, deferred — egress-blocked here**) — `curl {CMS_URL}/api/public/podcasts` → `youtubeUrl`/`youtubeId` present, no route change.
7. AC5 — load `/podcasts` with 3+ episodes, Network tab → **zero** requests to `youtube.com`/`youtube-nocookie.com` before any click.
8. AC6 — click play → iframe `src` starts `https://www.youtube-nocookie.com/embed/`, no `autoplay=1`.
9. AC7 — play control is a `<button>` with non-empty `aria-label`, Tab-reachable, Enter/Space-activatable.
10. AC8 — use a video with no `maxresdefault.jpg` → `<img>` swaps to `hqdefault.jpg`, no broken-image icon.
11. AC9 — visit `/podcasts/{slug}` → same click-to-load contract.
12. AC10 — `audioUrl` absent from both the Payload admin form and the console create form; existing rows' `audioUrl` values untouched.
13. AC13(i) — footer + mobile-menu Podcasts link present and routes to `/podcasts`.
14. AC13(ii) — `/podcasts` and `/podcasts/{slug}` appear in sitemap output.

Plus the plan's own open item: run `SELECT tenant_id, count(*) FROM podcasts GROUP BY tenant_id;` before applying the migration.

## Closeout Packet

- **Selected plan:** `process/general-plans/active/podcast-youtube-embed_15-09-26/podcast-youtube-embed_PLAN_15-09-26.md`
- **Finished:** all 15 Implementation Checklist steps; 4/4 Fully-Automated gates green (typecheck + lint, both repos); D8 ordering gate honoured.
- **Verified vs unverified:** types and lint are verified. Runtime behaviour — URL parsing, save-blocking, console create flow, click-to-load, nocookie/no-autoplay, thumbnail fallback, nav/sitemap rendering — is **unverified**. The migration is unapplied.
- **Remaining:** the 14 manual scenarios above; the DB row-count check; commit (orchestrator-owned, after EVL).
- **Follow-up stubs created:** `process/general-plans/active/podcast-youtube-embed_15-09-26/youtube-parser-regression-test_NOTE_15-09-26.md`
- **CONTEXT_PARTIAL:** `apcg-cms context router absent (no process/context/all-context.md)`
- **Closeout classification:** **Keep in active/testing** — code-complete and gate-green, but `CODE DONE`, not `VERIFIED`, per the plan's own Phase Completion Rules. Not ready for UPDATE PROCESS archival until the Agent-Probe pass has real recorded outcomes.

## Forward Preview

- **Test Infra Found:** no runner in either repo; `tsc --noEmit` + `next lint` are the only automated gates. A future harness should pick up `extractYoutubeId` as its first regression case.
- **Blast Radius Changes:** 5 files in apcg-cms (2 new, 3 modified, +1 gitignored regenerated), 11 in brief-asia-web (3 new, 8 modified). One more file per repo than the plan predicted — both justified in Deviations.
- **Commands to Stay Green:** `cd /home/user/apcg-cms && npm run typecheck && npm run lint` ; `cd /home/user/brief-asia-web && npm run typecheck && npm run lint`.
- **Dependency Changes:** none.
