---
name: plan:cms-cost-remediation
description: "Vercel/CMS egress+CPU cost remediation across apcg-cms + brief-asia-web — measure-first phase gate then ranked fixes"
date: 09-09-26
feature: general
---

# apcg-cms — Vercel Cost Remediation (August 2026 spike)

**Date**: 09-09-26
**Repos:** `apcg-cms` (Central CMS, `/home/hieunc/Code/apcg-cms`) **and** `brief-asia-web` (reader, `/home/hieunc/Code/brief-asia-web`)
**Complexity**: COMPLEX (measurement gate + multi-repo, multi-phase, one high-risk cutover)
**Status**: 🚧 PLAN — no code touched yet
**Source of truth:** a completed 17-agent adversarial verification workflow. This plan is a durable restatement of that synthesis — it does not add or re-rank findings. Raw synthesis: `/home/hieunc/.claude/projects/-home-hieunc-Code-apcg-cms/02fde8d0-fd22-4ee0-9ce1-9273dcee88dd/tool-results/b7038yo2c.txt`. Raw workflow JSON (per-claim verdicts + extra unknowns): `/tmp/claude-1000/-home-hieunc-Code-apcg-cms/02fde8d0-fd22-4ee0-9ce1-9273dcee88dd/tasks/wy7ij9o7g.output`.

---

## TL;DR

August's 2.96M requests / ~296.9 GB egress spike is a **request-count problem, not a broken cache**. Nobody has measured which of three candidate causes (per-render fan-out, crawler cold-key traffic, invalidation thrash) dominates — and the ranking of every fix below depends on that unmeasured split (`r`). **Phase 0 is a hard blocking gate**: five cheap measurements (P1, P2, P2b, P3, P9) must run before Phase 2 starts, because no source-only analysis can produce `r`. Phase 1 fixes are risk-independent and can run in parallel with Phase 0. One idea from the original (earlier, now superseded) analysis — raising reader cache TTL 60s→1800s — is **INVALIDATED for three independent reasons** and must not be revived. A public-endpoint PII/secret leak (staff emails, session data, ContentEngine token hashes/IPs) is riding along inside "fix #2" and must be treated as a security fix, not a byte-count optimization.

## Overview

This plan turns an already-completed 17-agent adversarial verification workflow into a durable, resumable implementation plan for remediating apcg-cms's August 2026 Vercel egress/CPU cost spike. Scope spans two repos (`apcg-cms`, `brief-asia-web`). Phase 0 is a blocking measurement gate; Phase 1 fixes are risk-independent and run in parallel; Phase 2 is conditioned on Phase 0 results; Phase 3 is a high-risk media-serving cutover; Phase 4 is lower-priority cleanup.

## Acceptance Criteria

- Phase 0's five measurements (P1, P2, P2b, P3, P9) are run and recorded in `## Phase 0 Results` before any Phase 2 code change lands.
- The TTL-raise idea is never re-shipped (see INVALIDATED banner).
- Fix #2 ships with the security `defaultPopulate` fix, not `depth: 0` (no inline-image regression).
- Fix #4 (R2 cutover) does not go live before the redirect shim is deployed and P8a-d all pass.
- No `media.url`/`sizes_*_url` backfill task is created (see "What NOT To Do" #7).
- Every fix row in this plan names its repo, file:line, expected saving with arithmetic, risk level, and blocking precondition (P-number).

## Phase Completion Rules

- **Phase 0** is CODE COMPLETE only when all 5 gate measurements have recorded values (or an explicit "inconclusive — reason") in `## Phase 0 Results`. Phase 2 may not start before this.
- **Phase 1** items are individually CODE COMPLETE when their file change lands and the matching Verification Evidence row's gate is green; they do not block on Phase 0.
- **Phase 2** priority ordering is decided by the Phase 0 Results branch logic — do not hardcode a fix order before Phase 0 completes.
- **Phase 3** is CODE COMPLETE only after P8a-d pass AND the redirect shim is verified live before the env flip.
- A phase is VERIFIED only after user confirmation of runtime behavior (dashboards/logs/curl output), not merely after code lands — mirrors this repo's `CODE DONE` vs `VERIFIED` distinction.


---

## ⚠️ INVALIDATED — DO NOT RE-PROPOSE THIS FIX

**Raising reader cache TTL from 60s to 1800s on the `articles:all` keys (`brief-asia-web/src/lib/cms-client.central.ts`) was the original headline recommendation. It is INVALIDATED. Do not ship it, do not re-derive it, do not let a future agent "rediscover" it as a good idea.** It fails three independent ways:

1. **(a) Bounded by invalidation, not TTL.** Effective key lifetime is `min(TTL, inter-flush interval)`. Translation writebacks fire 2 un-suppressed `articles:all` busts per locale per article; at ~12 publishes/day that's already a flush every few minutes. 1800s behaves like ~300s.
2. **(b) Saves ~zero on the dominant term.** Per-article `related` and `by-slug` keys are requested far less than once per 60s on the long tail, so their TTL never binds regardless of value. Using `(1-r)/k + r`: at `r=0.12` → 6.7x saving, at `r=0.40` → 2.4x, at `r=0.60` → 1.6x. `r` is exactly the unmeasured parameter (see Phase 0).
3. **(c) Converts a silent failure into an outage.** `brief-asia-web/src/lib/central-api.ts:58-65` is fail-soft: any non-2xx / timeout / bad JSON returns the caller's `empty` shape **from inside the `unstable_cache` callback**, so Next.js caches the failure like a success. At 60s a CMS blip caches an empty feed for a minute; at 1800s it caches an **empty homepage, or a live article's `notFound()` 404** (`article/[slug]/page.tsx:86`), for half an hour — with **no early-clear mechanism** (the only clear path is a content-write webhook, which never fires on recovery).

Replacement for the TTL raise is **Fix #1** (Phase 2, collapse fan-out) — a different mechanism entirely. If TTLs are ever revisited, **300s is the saturation point; 900s buys nothing beyond it.**

---

## Corrected Diagnosis (carry forward, do not re-litigate)

- 2.96M calls × ~90 ms CPU ≈ 73.8 CPU-hours; 2.96M × ~100 KB ≈ 296.9 GB. The cost is a **request-count** problem.
- Five earlier claims were WRONG and are retracted (see synthesis §Corrected diagnosis items 1–5 for the full refutation text — summarized): cache is not "broken" by `no-store`; BYPASS is because every reader call carries an `Authorization` header (Vercel CDN never caches those) — not a missing `Cache-Control`; the 04/09 fix's 30-50 GB estimate was wrong by ~3x (real band 108-151 GB, or 183-220 GB if `translationStatus` populates); the TTL raise is invalidated (above); the R2 flip's "49.3 GB removed" claim is overstated (that's the *whole* `/api/[...slug]` catch-all, not just media — the media share is unknown).
- Ranked by strength of evidence, what actually drives the 2.96M:
  1. **Per-render fan-out on the article page** (strong evidence, magnitude unmeasured) — `brief-asia-web/src/lib/cms-client.central.ts:496-500` + `:544-552`: 4-10 Central list calls per cold article render. TTL-invariant (long-tail keys never repeat inside 60s).
  2. **Cold-key/long-tail crawler traffic** (right shape, untested) — new `robots.ts` / `sitemap.ts` opened up to 5,000+ URLs to crawl; nobody has run user-agent attribution.
  3. **Wholesale tag invalidation** (strong code evidence, rate unmeasured) — `articles:all` is the only tag on every article-derived key; write firehose (translation, cron) mostly lacks `disableRevalidate`.
  4. **Hot-key TTL churn** (real, but NOT 89% of volume as previously modeled) — the 60s-TTL homepage keys create a floor, but the "89% fit" staircase model is refuted by the observed gradual, no-deploy-correlated ramp.
- Two claims explicitly killed by reviewers — do not carry forward: (a) removing `draftMode()` from the article route is a no-op at pinned Next 15.4.11 (breaks preview for nothing); (b) the "12 calls per homepage / 8 pillars" fan-out arithmetic used a repo constant (`src/lib/data.ts` PILLARS) the homepage doesn't actually use — real pillar count comes from Central's `/api/public/site` and was never measured.
- **Still genuinely unknown after everything above:** what fraction of the 2.96M is TTL-invariant cold-key traffic (`r` in `(1-r)/k + r`). This controls every savings estimate in this plan. No source-only analysis can produce it — only P1 + P2 can.

---

## What Is Already Fixed (with CORRECTED impact — do not trust the original commit messages' framing)

| Commit | Date | Change | Corrected impact |
|---|---|---|---|
| `7125ab0` | 10/08 | `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` on `/api/media/file/*` (`apcg-cms/src/app/(payload)/api/[...slug]/route.ts:36-39`) | **Possibly ZERO as observed.** Production logs on 31/08 (3 weeks post-commit) still show `x-vercel-cache: MISS`. Cause unconfirmed — a `Set-Cookie` from Payload REST auth refresh, unexpected `Vary`, or a per-deployment `CMS_URL` cold-starting the edge cache are all live candidates. **P9 must run before assuming this commit works.** |
| `5639e41` | 04/09 | `LIST_SELECT = { body: false }` on `/api/public/articles` (`apcg-cms`) | Egress: **108-151 GB/month at current volume** (not the originally claimed 30-50 GB), or 183-220 GB if `translationStatus` populates. Confidence LOW (synthetic model — P3+P4 pin it). Request count: **unchanged** (2.96M untouched). CPU: **probably unchanged** — unverified whether Payload's Postgres adapter omits the column at the query level or fetches+strips it in JS (P14). Timing: landed **after** the August window — do not double-count its saving against the August baseline. |

---

## What NOT To Do (reproduced in full — every item here was proposed and refuted; losing this list means someone re-does dead work)

| # | Do NOT | Why |
|---|---|---|
| 1 | Add `Cache-Control` / `s-maxage` to `apcg-cms/src/lib/public.ts:36-41` | Vercel CDN refuses to cache any request carrying an `Authorization` header (every reader call sends one); `s-maxage` without `CDN-Cache-Control` is stripped anyway. Ships clean, changes nothing. |
| 2 | Move the read token into the URL path/query to make the JSON API CDN-cacheable | Leaks the read secret into logs/cache keys/Referer headers; needs a 5-repo coordinated contract change + token rotation; `jsonPublic` sets `Vary: Origin` while cached `Access-Control-Allow-Origin` is pinned to whichever origin warmed the entry → intermittent CORS failures on 4 of 5 sites; risks serving one tenant's payload to another until every tenant key is distinct. This was a deliberate, already-documented decision. |
| 3 | Remove `cache: "no-store"` from `central-api.ts:57` to "repair" the cache | Documented no-op for the outer `unstable_cache` layer — doesn't touch the layer that's actually storing the result. |
| 4 | Raise `export const revalidate` on any reader page | `revalidateTag` purges the Data Cache; `unstable_cache` tags don't reliably propagate to the Full Route Cache the way `fetch` tags do. Produces genuinely 30-minute-stale articles/corrections/takedowns on a news site. |
| 5 | Raise TTLs on `authors:all`, `corrections:all`, `newsletters:all`, or `market-snapshots` | Only 5 of 27 CMS collections wire `revalidateHooks` (Articles, Cities, Pillars, SubSections, WireDrops). These four collections emit none of those tags — their 300s TTL is their **only** freshness mechanism. Corrections is an editorial-integrity surface. (Separate cheap follow-up, NOT part of this remediation: wire `revalidateHooks` into these 4 — see Phase 4.) |
| 6 | Remove `await draftMode()` from `brief-asia-web/.../article/[slug]/page.tsx:78` | Refuted at pinned Next 15.4.11: reading `isEnabled` doesn't track dynamic; only `enable()`/`disable()` do. Buys nothing, breaks the auth-gated preview flow. |
| 7 | **Write a backfill for `media.url` / `sizes_*_url`** | **DEAD WORK.** Payload 3.85.1's `plugin-cloud-storage/src/hooks/afterRead.ts` regenerates the value from `generateFileURL({filename, prefix, size})` on every read from `filename` + `prefix`, discarding any stored varchar. `getFields.ts` attaches this to top-level `url` and every `sizes.<name>.url`. Proven empirically: `scripts/migrate/import-central.ts:348` writes media rows with **no `url` at all** and those images already render correctly in production. If anyone proposes a `media.url` backfill task, kill it — do not schedule it. |
| 8 | Fix the `tokenHash` / staff-email disclosure with `select` or `depth: 0` | `select` doesn't constrain how an *already-populated* relationship serializes (needs `populate`/`defaultPopulate` instead). `depth: 0` on the `[slug]` route stops lexical `upload` node population inside `body` — `brief-asia-web/src/components/article/article-body.tsx:42` returns `null` for a non-object node, so **every inline image in every article silently disappears on all five sites**, with no error and no failing test. See Fix #2 for the correct fix. |
| 9 | Prioritize narrowing tag granularity (`articles:all` → per-pillar) as the primary lever | At current publish rates this buys little for hot keys and doesn't touch the fan-out or cold-key terms that dominate the volume. |
| 10 | Investigate these — they are clean | `sitemap.ts` `view=refs` path (155 B/row, <1 GB/mo across all 5 sites); `opengraph-image.tsx` (no server-side image fetch, text-on-navy via `ImageResponse`); `/api/markets` (properly edge-cached at 300s matching a 300s client poll); `middleware.ts` (sets no cookie/header, not defeating any cache); `tenantTag()` in `apcg-cms/src/hooks/revalidate.ts:31` (dead code, and that's *why* the chain works — both sides use unprefixed tags that match exactly, per-tenant isolation comes from webhook routing, not the tag string). |

---

## Security Finding (plan-level severity — NOT a byte optimization)

`GET /api/public/articles` at `depth:1` currently returns, per row: `lastEngine`, `lastEditedBy` (staff identity/session-adjacent fields), and — **if `translationStatus` populates** — up to 20 nested `ContentEngine` docs per row, each carrying `tokenHash`, `tokenPrefix`, and `lastSeenIp`. **This is a live PII/secret exposure on a public, unauthenticated-adjacent endpoint** (readers hit it with a shared read token, not per-user auth). It happens to be resolved by the same code change as Fix #2, but it must be tracked and signed off as a **security fix**, not filed under "reduce payload size."

**The trap:** do NOT fix this with `depth: 0` (see "What NOT To Do" #8) — that silently deletes every inline image in every article on all five sites with no error and no failing test. The correct fix is `defaultPopulate` scoping on `content-engines` / `users` / `tenants`, applied alongside the `LIST_SELECT` extension in Fix #2. The `[slug]` route (single-article fetch) needs this `defaultPopulate` treatment; the list route's exposure is closed by the `LIST_SELECT` field-drop in Fix #2.

---

## Repos Touched (every touchpoint below names its repo explicitly)

| Repo | Path | Role |
|---|---|---|
| `apcg-cms` | `/home/hieunc/Code/apcg-cms` | Central CMS — this repo |
| `brief-asia-web` | `/home/hieunc/Code/brief-asia-web` | One of five reader sites — **the only one inspected** |

**Production hosts (confirmed by measurement, record for reuse):** CMS production host is `apcg-cms.vercel.app`; brief-asia tenant prefix is `brief-asia` (with hyphen); reader canonical host is `www.briefasia.com` (bare `briefasia.com` 308-redirects to it).

**Unverified generalization warning:** every "×5" multiplier in every estimate in this plan (and in the source synthesis) is **unverified**. Only `brief-asia-web` was read in the underlying research. The other four reader sites — **WTB, DTW, GCV, WAD** — have not been inspected for matching patterns (cache wrapping, fan-out call counts, unpin-expired handling, `next/image` remote-pattern config). Precondition **P10** exists specifically to close this gap before any fix that assumes "all five sites behave like brief-asia-web."

---

## Touchpoints

| Repo | File | Fix # | Change |
|---|---|---|---|
| `brief-asia-web` | `src/lib/cms-client.central.ts:496-500`, `:544-552` | 1 | Collapse related-articles fan-out (4-10 calls → 2-3, then → 1 via new endpoint) |
| `apcg-cms` | `src/app/api/public/articles/route.ts:39` | 2 | Extend `LIST_SELECT` to drop `translationStatus`, `lastEngine`, `lastEditedBy`, `assignedTo` |
| `apcg-cms` | `src/app/api/public/articles/[slug]/route.ts:36` | 2 (security) | `defaultPopulate` scoping on `content-engines`/`users`/`tenants` — NOT `depth: 0` |
| `brief-asia-web` | `src/app/(reader)/[locale]/search/search-action.ts:17-25` | 3 | Gate `searchArticles` on `query.length >= 3` (currently only gates the analytics insert) |
| `brief-asia-web` | `src/components/search-overlay.tsx:40-44` | 3 | Debounce 200ms → 400ms |
| `brief-asia-web` | `src/app/(reader)/[locale]/search/page.tsx:61-66` | 3 | Debounce 220ms → 400ms |
| `brief-asia-web` | `src/lib/cms-client.central.ts:438-443` | 3 | Wrap search in `unstable_cache` keyed on normalized query, 60s; `limit` 40 → 12 |
| `apcg-cms` | `src/app/api/public/articles/route.ts:107-137` | 3 | (context only — 4 unindexed `LIKE` scans triggered per uncached search call) |
| `apcg-cms` | `payload.config.ts:80`, `:208-217` | 4 | Flip `R2_PUBLIC_BASE_URL` env-gated switch (already coded) |
| `apcg-cms` | `src/app/(payload)/api/[...slug]/route.ts` | 4 | Add ~10-line 302 redirect shim `/api/media/file/<name>?prefix=<t>` → `${R2_PUBLIC_BASE_URL}/<t>/<name>`, placed so it doesn't shadow clientUpload handler |
| `apcg-cms` | `src/app/api/cron/publish-scheduled/route.ts:82-97` | 5 | Pass `disableRevalidate` in the per-row loop; post ONE webhook at the end instead of up to 200 |
| `apcg-cms` | `src/app/api/cron/unpin-expired/route.ts:89` | 5 | Post NO revalidation webhook (route's own docstring: `pinnedUntil` enforced at read time) |
| `apcg-cms` | `src/hooks/translation.ts:119-127` | 5 | Add `disableRevalidate` |
| `apcg-cms` | `src/app/api/engine/translation/route.ts:120-137` | 5 | Add `disableRevalidate` to both `payload.update` calls |
| `apcg-cms` | `src/app/api/engine/intake/route.ts:204` | 5 | Suppress reader-cache bust on `pending_review` draft create |
| `brief-asia-web` | `src/lib/article-view.ts:283` | 6 | `heroImageUrl: hero?.url` → `hero?.sizes?.card?.url ?? hero?.url` (null-safe, NEVER `hero.sizes.card.url` direct access) |
| `brief-asia-web` | `src/components/cover-art.tsx:145-152` | 6 | Add `srcSet` for derivatives |
| `apcg-cms` | `src/hooks/revalidate.ts:52-58`, `:40` | 7 | Check `res.ok`, add timeout, log the empty-`frontendUrl` case |
| `apcg-cms` | `src/lib/public.ts:51-57` | 8 | Memoize `resolveReadToken` (module-level Map, 30-60s TTL) |
| `brief-asia-web` | `src/app/(reader)/[locale]/[pillar]/page.tsx:6,56-61` | 9 | Split `?section=` variant into its own route to restore inert ISR |
| `apcg-cms` | `src/collections/Authors.ts`, `Corrections.ts`, `Newsletters.ts`, `MarketSnapshots.ts` | 4 (cleanup) | Wire `revalidateHooks` (currently only 5 of 27 collections have this — mirror `Pillars.ts:6`) |
| `apcg-cms` | `src/app/(payload)/api/[...slug]/route.ts` | 4 (cleanup, new finding) | Add a `HEAD` export (mirroring `GET`) and extend the cache-header wrapper to apply on more than just `res.status === 200` — see "HEAD returns 404 on media" finding below |

## Public Contracts

- `GET /api/public/articles` (apcg-cms) — response shape narrows (fields dropped by Fix #2); behavior for `content_type`/other params unaffected.
- `GET /api/public/articles/[slug]` (apcg-cms) — population scope narrows via `defaultPopulate` (security fix); must NOT change `depth` semantics for `body` lexical nodes.
- Media serving contract (`/api/media/file/*`) — Fix #4 is a **hard cutover**: every already-cached absolute media URL (5 sites' ISR entries, sent newsletters, RSS/social scrapes, Google's image index) will 404 without the redirect shim. This is the single highest-risk public-contract change in this plan.
- Webhook contract `/api/revalidate` (each reader) — Fix #7 changes only observability (logs, timeout), not the wire contract.

## Blast Radius

- **Files:** ~20 across two repos (table above).
- **DB:** none required for Phases 1/2/3/5 as coded. Fix #4 preconditions include read-only `SELECT` checks (P8c). No migration in this plan.
- **Risk classes present:** public API contract change (Fix #2, security-relevant), auth/session-adjacent data exposure (security finding), deploy/runtime/gateway change (Fix #4 — media serving cutover), cron/webhook behavior change (Fix #5, #7).
- **Highest risk item:** Fix #4 (R2 cutover) — genuinely irreversible-feeling if the redirect shim is wrong; rollback is "unset env + redeploy" (~2 min) but requires the shim to already exist and be correct BEFORE flipping the env var.

## Verification Evidence (Post-Phase Testing)

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| P1 query-string facet on `/api/public/articles` (Vercel Logs, 24h) | Agent-Probe (dashboard read) | Decision rule for Phase 0→2 routing: which fix is #1 |
| P2 User-Agent facet + `[slug]`:`list` ratio | Agent-Probe (dashboard read) | Arbitrates crawler-cold-key vs hot-key-churn causal story |
| P2b (same log window, extended) | Agent-Probe | Confirms P2 stability across the window, not a single-day artifact |
| P3 curl real bytes, gzip vs identity, Fast Origin vs Fast Data Transfer | Hybrid (requires live CMS_READ_TOKEN + prod/staging CMS) | Pins the 108-220 GB range to a point estimate |
| P9 `curl -sI` media route twice, check `Set-Cookie`/`Vary`/`x-vercel-cache` | Hybrid (requires live CMS) | Confirms whether `7125ab0` media caching commit is actually working |
| P4 `jq '.docs[0].translationStatus'` + DB count | Hybrid (requires DB access) | Confirms whether Fix #2's larger estimate (183-220 GB) applies |
| P7 avg relationship branch count on `articles_rels` | Hybrid (requires DB access) | Confirms Fix #1's fan-out multiplier arithmetic |
| P8a-d R2 domain/derivative/prefix/reader-config checks | Hybrid (requires live R2 + 4 other repos) | Gates Fix #4 go/no-go — ALL FOUR mandatory before env flip |
| Fix #2 unit/integration: response no longer contains `lastEngine`/`lastEditedBy`/`translationStatus` fields | Fully-Automated (once written) | Security finding closed; `LIST_SELECT` extension correct |
| Fix #2 regression: inline images still render in article body after `[slug]` route change | Agent-Probe (visual check on ≥1 article with inline image) | The `depth:0` trap did NOT get reintroduced |
| Fix #4 redirect shim: hitting an old cached `/api/media/file/<name>?prefix=<t>` URL 302s to R2 correctly | Hybrid (requires R2 configured) | Cutover does not 404 existing cached URLs |
| Fix #6 null-safety: article with only original hero (no `sizes.card`) still renders a real image, not a generative SVG placeholder | Agent-Probe | The naive-`hero.sizes.card.url` crash trap avoided |
| Fix #5 unpin-expired: verify `route.ts:139-142` still enforces expiry at read time after webhook suppression | Fully-Automated (existing guard, add coverage if missing) | Suppressing the webhook doesn't reintroduce stale pins for brief-asia-web |
| Fix #5 unpin-expired generalization: P10 confirms other 4 readers don't render `pinnedToLatest` off a plain list doc | Hybrid (requires reading 4 other repos) | Fix #5's unpin suppression doesn't break WTB/DTW/GCV/WAD |
| Fix #7 webhook: force a 401 (bad secret) and confirm it now logs as a failure, not silently succeeds | Hybrid (requires reader env with `REVALIDATE_SECRET`) | `res.ok` check actually catches the failure mode it targets |

## Test Infra Improvement Notes

(none identified yet — this plan is measurement + targeted-fix heavy; test infra gaps will surface during Phase 1/2 EXECUTE and should be recorded here at that time)

---

## Implementation Checklist (phase-ordered, see full detail in each Phase section below)

1. Run Phase 0 measurements P1, P2, P2b, P3, P9; record results.
2. In parallel: ship Phase 1 fixes (#2 LIST_SELECT + security, #7 res.ok/timeout, #5 partial unpin-expired, #8 resolveReadToken memoization).
3. Apply Phase 2 branch logic from Phase 0 Results; ship the selected priority fix(es) (#1 fan-out collapse and/or #3 search gating and/or crawler control).
4. If pursuing Phase 3: confirm P8a-d, deploy redirect shim, verify shim, then flip `R2_PUBLIC_BASE_URL`.
5. Ship Phase 4 cleanup (#6 card derivatives with null-safety, #9 `?section=` route split, `revalidateHooks` wiring).

## Phase 0 — MEASURE (BLOCKING GATE — zero code change, ~1 hour)

**This phase is a structural gate, not a suggestion.** No agent may start Phase 2 work until this phase's exit condition is met. Phase 1 is explicitly cleared to run **concurrently** with Phase 0 (see Phase 1 below) because it is risk-independent of the measurement outcome. Phase 2 is NOT — its fix priority ordering is a direct function of `r` (see Corrected Diagnosis, last bullet), and no source-only analysis can produce `r`.

**Exit condition for this gate:** P1, P2, P2b, P3, and P9 have all been run and their results recorded in this plan's `## Phase 0 Results` section (to be filled in by whoever executes this phase — do not skip filling it in even if a result is "inconclusive").

| ID | What to run | Exact command / query | Decision rule it feeds |
|---|---|---|---|
| P1 | Vercel Logs, `apcg-cms`, `path = /api/public/articles`, 24h, facet on query string | Count: `q=`, `view=refs`, `ids=`, `limit=24` (related fan-out signature), `limit=40&sort=-publishedAt` (homepage `getRecentArticles(40)`), bare `limit=20`, and ~98-byte empty-envelope responses | If `limit=24` without `page` dominates → **Fix #1 is confirmed #1, everything else can wait.** If `q=` is a large share → **Fix #3 jumps to the top.** |
| P2 | Same log window, facet by User-Agent (Googlebot, bingbot, GPTBot, ClaudeBot, PerplexityBot, Bytespider) + by day across August. Separately: compare `/api/public/articles/[slug]` route counter vs `/api/public/articles` counter (both already in the Vercel dashboard) | — | Ratio near **1:6-9** → cold article renders + related fan-out dominate (Fix #1 wins). Ratio near **1:60** → hot-key timer churn dominates (different priority — revisit invalidation-thrash fixes first). |
| P2b | Same as P2, run across the FULL August window (not a single day) | — | Confirms P2's ratio is stable across the ramp, not a one-day artifact — needed because the observed spike was gradual with no deploy correlation |
| P3 | `curl -sD- -o /dev/null -H "Authorization: Bearer $CMS_READ_TOKEN" -H 'Accept-Encoding: gzip, br' '<cms>/api/public/articles?limit=20'` then repeat with `Accept-Encoding: identity`; compare `content-encoding`/`content-length`, `\| wc -c` the body. Then check Vercel Usage tab: **Fast Origin Transfer** vs **Fast Data Transfer** — confirm which metric produced the 296.9 GB figure | — | Replaces the entire synthetic byte model; pins the September projection (currently 108-220 GB, LOW confidence) to a point estimate |
| P9 | `curl -sI '<cms>/api/media/file/<name>?prefix=briefasia' \| grep -i 'cache-control\|x-vercel-cache\|set-cookie\|vary'` — run twice in a row | — | Confirms/refutes whether `7125ab0`'s media caching is actually working (currently: possibly zero as observed). If broken due to `Set-Cookie` or `Vary`, this is a trivial, independent free win — do it regardless of everything else. |

**Supporting preconditions to run in the same sitting (cheap, not gating, but feed later phases):** P4 (`translationStatus` population — feeds Fix #2 sizing and Phase 0 exit isn't blocked by it, but Phase 2's Fix #2 estimate is), P5 (write rate — feeds Fix #5 priority), P6 (body size distribution), P7 (fan-out branch count — feeds Fix #1 arithmetic), P11 (real nav-pillar count), P14 (did `5639e41` cut CPU or only bytes).

### Phase 0 Results

_(to be filled in by the executing agent/session — do not proceed to Phase 2 until this section has real values, even if some read "inconclusive — see [why]")_

**P2 — RUN, DECISIVE. Gate question answered.**
- `/api/public/articles` = 2,960,000 requests (August 2026)
- `/api/public/articles/[slug]` = 650,000 requests (August 2026 — same window, user-confirmed)
- Ratio = **1 : 4.55**
- Decision rule from Phase 0 table: near 1:6-9 → fan-out dominates; near 1:60 → hot-key timer churn dominates. **4.55 sits inside the fan-out regime and far from the churn regime.**
- **VERDICT: cold article renders + related fan-out DOMINATE. Fix #1 (collapse the related-articles fan-out) is CONFIRMED as priority #1.**
- Bounding arithmetic: article renders = 650k/month. They generate `650k × F` list calls where F is the mean fan-out. Since non-article surfaces (homepage, pillar, tag, country, author, search) must contribute > 0 calls, **F < 4.55**. At a plausible F≈3: article pages account for 650k slug + ~1.95M list ≈ **2.60M of the 3.61M combined request volume (~72%)**. Record F as bounded, not measured — P7 (avg `articles_rels` per parent) still pins it.

**P9 — RUN. Media edge caching WORKS. Earlier "possibly zero as observed" is REFUTED.**
- Probed `https://apcg-cms.vercel.app/api/media/file/southeast-asian-firms-overlook-digital-pact-worth-usd-2-trillion.jpeg?prefix=brief-asia` with GET, three consecutive times.
- Result every time: `HTTP/2 200`, `x-vercel-cache: HIT`, `age: 166`+ (rising), `content-type: image/jpeg`, `content-length: 134882`.
- Commit `7125ab0` is functioning in production. **No action needed. Remove media-cache repair from consideration.**
- `## What Is Already Fixed` row for `7125ab0` corrected accordingly: status is now **VERIFIED WORKING**, not "possibly zero as observed." The 31/08 MISS logs are now explained by the HEAD-vs-GET finding below (see Methodology note).

**P1 — NOT RUN.** Query-string facet still pending (Vercel Logs). Priority DOWNGRADED: P2 already arbitrated the gate question, so P1 is now refinement (sizing the search `q=` share for Fix #3), not arbitration.

**P2b — NOT RUN.** User-Agent facet across the full August window still pending. **Still worth running:** it decides whether the 650k article renders are humans or crawlers, and therefore whether crawler control must ship alongside Fix #1.

**P3 — NOT RUN.** Requires `CMS_READ_TOKEN`. Still needed to pin the September GB projection (currently 108-220 GB, LOW confidence).

**Gate status: PARTIALLY MET — the arbitrating measurement (P2) is complete and Fix #1 ordering is locked. P1/P2b/P3 remain open and must be recorded before Phase 2 work is considered fully unblocked.**

- `r` (fraction of 2.96M that is TTL-invariant cold-key traffic): still TBD — P2's ratio arbitrates the *dominant cause*, not the precise `r` fraction; P1/P2b refine it further.

### Methodology note (read before re-running P9)

`/api/media/file/*` returns **404 to HEAD but 200 to GET** for the same URL. Verified on multiple files. Any P9 re-run must use `curl -s -D- -o /dev/null` (GET), never `curl -sI` (HEAD), or it reads a 404 error response and reports a false failure. This error was made once during the first measurement pass.

---

## Phase 1 — Risk-Independent Fixes (may run CONCURRENTLY with Phase 0)

These do not depend on the P1/P2/P3/P9 measurement outcome — their correctness and value hold regardless of what `r` turns out to be.

| Item | Fix # | Repo | Risk | Precondition |
|---|---|---|---|---|
| Extend `LIST_SELECT` (+ security fix for `[slug]` route via `defaultPopulate`) | 2 | `apcg-cms` | **Very low** — grep of both reader files (`cms-client.central.ts`, `central-api.ts`) confirms zero references to the four dropped fields | P4 sizes it; P10 confirms other 4 readers also don't consume those fields |
| `res.ok` + timeout in revalidate webhook | 7 | `apcg-cms` | Low — observability-only change, not a cost fix on its own | none — do alongside anything else |
| `unpin-expired` webhook suppression | 5 (partial — this line only) | `apcg-cms` | Low-medium — verified safe for brief-asia-web (`route.ts:139-142` enforces at read time); **NOT yet verified for other 4 readers** | P10 clears the generalization |
| Memoize `resolveReadToken` | 8 | `apcg-cms` | Low — deliberate security trade-off: revocation/deactivation delayed by TTL (use 30-60s, document it) | none |

**Arithmetic for Fix #2:** `lastEngine` + `lastEditedBy` alone model at ~874 B/row (~13% of post-fix row). `translationStatus`, if populated (19 rows in the sample), models at ~11.6 KB/row — potentially a **larger cut than `5639e41` itself**. Applied to a 108-220 GB September baseline: somewhere between 14 GB and 120 GB saved.

---

## Phase 2 — Conditioned on Phase 0 Results (DO NOT START before Phase 0 exit condition is met)

Branch logic — select based on Phase 0 Results:

```
IF P1 shows limit=24-without-page dominates
   OR P2/P2b ratio is near 1:6-9 (cold-render/fan-out dominant)
THEN → Fix #1 (collapse related-articles fan-out) is the priority. Do it first.

IF P1 shows q= is a large share of traffic
THEN → Fix #3 (gate + cache search) jumps to top priority alongside/before Fix #1.

IF P2/P2b ratio is near 1:60 (hot-key churn dominant)
   AND/OR P2 crawler share is large
THEN → prioritize crawler control (robots/sitemap tuning, not built yet — see Open Questions)
   and revisit Fix #5 (invalidation suppression) before Fix #1, since a smaller `r`
   from measurement means TTL-bound hot keys matter more relative to fan-out.

DEFAULT (if Phase 0 is inconclusive after best effort):
   → Run Fix #1 anyway (it's confirmed by source review as the single largest amplifier
     regardless of share — "survives every reviewer under every causal story" per the
     synthesis) but treat its expected-savings percentage as unproven until Phase 0 data lands.
```

| Item | Fix # | Repo | Change | Arithmetic | Risk | Precondition |
|---|---|---|---|---|---|---|
| Collapse related-articles fan-out | 1 | `brief-asia-web` | Cheap interim: cap tag branches 4→1, drop 2 filler calls (4-10 calls → 2-3 per cold render). Proper fix: Central-side `?related_to=<id>` endpoint or single multi-taxonomy OR query | If article renders are ~50% of 2.96M and average ~7 list calls, removing 5 cuts ~1.06M requests (~36%) / ~26 CPU-hours. If 80% of renders, cuts ~1.7M. Multiplier verified from source; share is not (this is exactly what P1/P2 settle) | Low-medium — related rail editorial quality changes; fillers exist to avoid under-filled rail | **P1** (confirms via `limit=24` share) |
| Gate + cache search | 3 | `brief-asia-web` | Min length 3, debounce 400ms, `limit` 40→12, wrap in `unstable_cache` keyed on normalized query at 60s | Unknown request volume; `apcg-cms/src/app/api/public/articles/route.ts:107-137` runs 4 unindexed `LIKE` scans per uncached `?q=` call — a 10-char typing session currently costs 6-10 uncached 40-doc queries | Very low — half a day of work | **P1** (tells you if `q=` is 1% or 20% of 2.96M) |
| Crawler control (robots/sitemap tuning) | — | `brief-asia-web` | Not designed yet — depends on P2 attribution results | — | TBD | **P2/P2b** |

---

## Phase 3 — R2_PUBLIC_BASE_URL Cutover (HARD CUTOVER — highest risk in this plan)

**`disablePayloadAccessControl: true` de-registers the `/api/media/file/*` static handler for all non-clientUpload requests. Every already-cached absolute media URL — five sites' ISR entries, sent newsletters, RSS/social scrapes, Google's image index — will 404 the moment this flips**, unless the redirect shim (below) is already in place and correct.

**Preconditions — ALL FOUR mandatory, run IN ORDER, do not skip any:**

| ID | Check | Must confirm |
|---|---|---|
| P8a | `curl -I https://<r2-domain>/briefasia/<known-filename>` | 200 with real `Content-Type`. **Domain must be a custom domain, not `r2.dev`** — r2.dev is explicitly not for production and rate-limits to 429s at hundreds of req/s |
| P8b | Same curl for a derivative filename (e.g. `card-` variant) | 200 — derivatives carry most of the request count |
| P8c | `SELECT count(*) FROM media WHERE prefix IS NULL OR prefix = '';` then HEAD one such filename at the bucket root | These rows predate the `prefix` column (from `20260801_082303_migration_hardening.ts:49`) and live at the bucket root, not under a prefix path |
| P8d | In each of the other 4 reader repos: `grep -rn "remotePatterns\|next/image\|/api/media/" src/ next.config.*` | Confirms whether the other 4 readers' `next/image` config will accept the new R2 domain |

**Steps:**
1. Confirm P8a-d all pass.
2. Write the ~10-line 302 redirect shim in `apcg-cms/src/app/(payload)/api/[...slug]/route.ts`: `/api/media/file/<name>?prefix=<t>` → `${R2_PUBLIC_BASE_URL}/<t>/<name>`. Place it so it does **not** shadow the surviving clientUpload handler.
3. Deploy the shim FIRST, verify it 302s correctly against a real cached URL, THEN flip `R2_PUBLIC_BASE_URL`.
4. Note: `disablePayloadAccessControl` silently flips `skipSafeFetch` to `true` — URL-fetch paths lose Payload's `safeFetch` hardening. Confirm this is acceptable or add compensating validation.
5. Note: the server-side fetch-back that generates `imageSizes` fires on updates as well as creates — the public R2 domain becomes a hard dependency of the admin write path once flipped.

**Rollback:** unset env var + redeploy (~2 min) — but only safe if the shim itself hasn't been removed.

**No database backfill required for this phase or any phase — see "What NOT To Do" #7. If a backfill task appears in any tracker, close it as dead work.**

**Arithmetic:** the media share of the 49.3 GB `/api/[...slug]` catch-all moves to free R2 egress. The share is unknown — needs a log facet (not yet in this plan's Phase 0 list; add as a follow-up precondition if pursuing this phase).

---

## Phase 4 — Lower-Priority Cleanup

| Item | Fix # | Repo | Change | Trap to avoid |
|---|---|---|---|---|
| Serve card derivatives instead of full-res originals | 6 | `brief-asia-web` | `src/lib/article-view.ts:283`: `heroImageUrl: hero?.url` → `hero?.sizes?.card?.url ?? hero?.url`. Add `srcSet` in `cover-art.tsx:145-152` | **Write it exactly as `hero?.sizes?.card?.url ?? hero?.url`, NEVER `hero.sizes.card.url` direct access.** `scripts/migrate/import-central.ts:332-345` only carries across derivatives the source site had and drops any with a null filename — many of the ~3,300 imported articles have partial `sizes`. `cover-art.tsx:139` falls through a null `src` to a generative SVG placeholder with **no error and no log** — a naive direct-access change silently replaces real photographs with abstract art on legacy articles. Precondition: `SELECT count(*) FROM media WHERE sizes_card_filename IS NULL;` and assess whether a derivative backfill (of card sizes, NOT of `url` columns — see What NOT To Do #7) is needed if that count is non-trivial. |
| **New sub-item: homepage image weight** | 6 | `brief-asia-web` | Measured live on `https://www.briefasia.com/`: **19 CMS image URLs, 2,591,292 bytes total (2.47 MB)**. Notable offenders: `fbCover-1600x900.png` = 955,268 B (a PNG on a homepage), `fbCover-800x450.png` = 385,987 B, `0 Architect Prof...-1600x900.jpg` = 174,507 B. Several images are fetched at **both** 1600px and 800px on the same page. All returned `x-vercel-cache: HIT`. | **Framing — do not misread this as an August cost driver.** These are edge-cache HITs, so they bill as Fast Data Transfer, not Fast Origin Transfer — **not** part of the 296.9 GB / 49.3 GB origin figures. Their cost is page-weight/Core Web Vitals plus a smaller data-transfer line. Two concrete follow-ups: (a) **convert PNG hero art to WebP/JPEG** — a 955 KB PNG is ~90% reducible; (b) **stop requesting two sizes of the same image on one page**. |
| Split `?section=` pillar variant into its own route | 9 | `brief-asia-web` | `[pillar]/page.tsx:6,56-61` awaits `searchParams` (a Next 15 Dynamic API) so all 8 hubs render per-request and page-level ISR (`revalidate = 60`) is inert | Verify with **P15** (`next build`, check `○ (Static)` vs `ƒ (Dynamic)` route table) rather than assuming |
| Wire `revalidateHooks` into 4 unhooked collections | — | `apcg-cms` | Add to `Authors.ts`, `Corrections.ts`, `Newsletters.ts`, `MarketSnapshots.ts`, mirroring `Pillars.ts:6` | None — this closes a real freshness gap (currently these 4 collections rely solely on their 300s TTL as freshness mechanism); low-risk, four one-line changes |
| **New finding: HEAD returns 404 on media** | — | `apcg-cms` | `src/app/(payload)/api/[...slug]/route.ts` exports GET/POST/PATCH/PUT/DELETE/OPTIONS but **no HEAD**, and the cache-header wrapper only applies when `res.status === 200`. Add a `HEAD` handler and widen the wrapper. | Consequence: link checkers, social/preview scrapers, and crawlers that issue HEAD receive a 404 with `cache-control: public, max-age=0, must-revalidate` — permanently uncacheable. This is the most likely explanation for the persistent `x-vercel-cache: MISS` in the 31/08 production logs that motivated the original (now refuted) concern about `7125ab0`. Severity: low cost impact, real correctness impact. |

---

## Preconditions Reference Table (full P-numbering, cross-referenced to synthesis)

| ID | What | Feeds |
|---|---|---|
| P1 | Query-string facet on `/api/public/articles` | Phase 0 gate — decisive |
| P2 | User-Agent facet + `[slug]`:`list` ratio | Phase 0 gate — decisive |
| P2b | Same as P2, full August window | Phase 0 gate |
| P3 | Real response bytes, gzip vs identity, correct Vercel metric | Phase 0 gate |
| P4 | Does `translationStatus` populate? | Fix #2 sizing |
| P5 | August article write rate | Fix #5 priority (TTL vs invalidation) |
| P6 | Body size distribution | Collapses 108-151 GB range to a point |
| P7 | Related fan-out branch count (avg `articles_rels` per parent) | Fix #1 arithmetic multiplier |
| P8a-d | R2 domain/derivative/prefix/reader-config | Fix #4 go/no-go, ALL mandatory |
| P9 | Is `7125ab0`'s media caching actually working? | Phase 0 gate |
| P10 | Do the other 4 readers match brief-asia-web? | Generalizes every "×5" estimate; clears Fix #5's unpin change and Fix #2's field-usage assumption |
| P11 | Real nav-pillar count per tenant | Corrects homepage fan-out arithmetic (repo constant was wrong) |
| P12 | Webhook chain health (200/401/503 across readers) | Confirms Fix #7 targets a real, currently-invisible failure mode |
| P13 | Is `/api/public/views` in use? | Separate, unmeasured route — `postView` has no caller in brief-asia-web |
| P14 | Did `5639e41` cut CPU or only bytes? | Confirms whether CPU-hours are actually reduced by the already-shipped fix |
| P15 | Which reader routes are actually static? | Settles the ISR/`draftMode` dispute empirically (`next build` route table) |

---

## Open Questions / Harness Gaps

- **Newly surfaced, previously unanalysed reader-side cost surface: reader HTML is never CDN-cached.** `https://www.briefasia.com/` responds with `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` — the homepage HTML is not CDN-cached at all, so every homepage visit runs a reader-side function render. (Note: bare `https://briefasia.com` 308-redirects to `https://www.briefasia.com`.) **Not** part of the Central cost figures (that's CMS-side origin transfer), but may be a material Vercel cost on the reader projects. Open question: does this contradict `export const revalidate = 60` on the homepage, and is it caused by `middleware.ts` matching, a Dynamic API, or auth/session usage? **P15** (`next build` route table — already in this plan for Fix #9) would settle it.
- **`process/context/all-context.md` does not exist.** This repo's agent harness was never bootstrapped (`process/context/` holds only `generated-skills-catalog.json`). Context discovery could not follow the documented routing tables. This is a known gap, not a blocker for this plan — noted here per instruction, not resolved (do not run `vc-setup` as part of this plan).
- **Crawler-control fix (Phase 2, conditional branch) has no concrete design yet** — it depends entirely on P2/P2b attribution results, which have not been run as of this plan's writing.
- **Fix #4's media-share-of-49.3GB is unknown** — needs a log facet not currently listed among P1-P15; add one before starting Phase 3 in earnest if the team decides Phase 3 is worth pursuing before Phase 2 fully lands.
- **Whether Fix #2's `defaultPopulate` change requires a Payload version-specific syntax check** — not verified against the pinned Payload 3.85.1 API surface in this planning pass; flag for `vc-docs-seeker` at EXECUTE time.
- **No workflow JSON per-claim breakdown was separately re-extracted for this plan** beyond the synthesis text; if a future agent needs the raw per-agent verdicts/corrections/unknowns, they live at `/tmp/claude-1000/-home-hieunc-Code-apcg-cms/02fde8d0-fd22-4ee0-9ce1-9273dcee88dd/tasks/wy7ij9o7g.output` under `result.perClaim[]` (query with `jq`, do not `cat` the whole file — it is large).

---

## Validate Contract

Status: CONDITIONAL
Date: 09-09-26
date: 2026-09-09
generated-by: outer-pvl

### Net Gate

**Gate: CONDITIONAL**

0 FAILs at the whole-plan level. 5 CONCERNs, resolved as: 3 mandatory execute-agent instructions (hard preconditions that gate specific sub-items), 1 plan-scoping split (Fix #2 → 2a/2b), 1 known-gap (P10 cannot be run in this environment). No item was softened to hide a cross-site breaking change — the one genuinely blocking sub-item (Fix #2's field-drop) is carved out and hard-blocked below, not waved through.

### Per-Phase Gate (this plan is phased; gate applies per phase, not as one blanket verdict)

| Phase | Gate | Why |
|---|---|---|
| Phase 0 (measure) | CONDITIONAL — proceed | P2 + P9 are RUN and decisive/confirming. P1/P2b/P3 are NOT RUN but are read-only dashboard/curl work with no code risk; they do not block Phase 1. |
| Phase 1 (risk-independent fixes) | CONDITIONAL — proceed, with Fix #2 split (see below) | 3 of 4 items (Fix #7, Fix #5-partial, Fix #8) are clear to ship now. Fix #2 splits into 2a (ship now) and 2b (BLOCKED pending P10). |
| Phase 2 (conditioned fixes) | **BLOCKED — do not start** | Plan's own Phase Completion Rule: Phase 2 may not start before Phase 0's exit condition (P1, P2b, P3 all recorded) is met. This is a temporal gate, not a plan defect — it lifts automatically once those 3 measurements are recorded, no re-validation needed for that reason alone. |
| Phase 3 (R2 cutover) | **BLOCKED — do not start** | P8a-d have not been run. Plan's own precondition chain already requires this; validate adds a rollback-safety instruction (below) before this phase may be attempted. |
| Phase 4 (cleanup) | CONDITIONAL — proceed | Low risk, preconditions (P15, `sizes_card_filename` count) are self-contained and already documented in the plan. |

### Parallel strategy

**No single strategy fits this plan — the phases have genuinely different risk/parallelism shapes. Recommend per-phase:**

| Phase | Strategy | Agent count | Rationale |
|---|---|---|---|
| Phase 0 remaining (P1, P2b, P3) | Sequential (1 agent, agent-probe/hybrid) | 1 | Dashboard reads + one curl command; no benefit from parallelizing 3 read-only measurements, and P2b/P3 feed the same decision. |
| Phase 1 (Fix #2a, #5-partial, #7, #8) | **Parallel subagents** | 4 | The 4 items touch **disjoint files** (`[slug]/route.ts` + 3 collection configs · `cron/unpin-expired/route.ts` · `hooks/revalidate.ts` · `lib/public.ts`) with zero shared state — textbook fire-and-forget fan-out, no coordination needed. |
| Phase 2 (once unblocked) | Sequential (1 agent) | 1 | Branch logic selects exactly one priority path; nothing to parallelize until Phase 0 fully resolves which branch. |
| Phase 3 (R2 cutover) | Sequential, single agent, manual-first | 1 | P8a-d are an explicitly ordered chain (`run IN ORDER, do not skip any`) followed by shim-deploy-verify-then-flip. Parallelizing this would violate the plan's own sequencing requirement and is explicitly disallowed. |
| Phase 4 (cleanup) | Parallel subagents | 3-4 | Fix #6, Fix #9, and the `revalidateHooks`/`HEAD` cleanup touch disjoint files with no shared state. |

Signals present: S2 (API/security surface) · S3 (Phase 2's 3-way branch) · S5 (user requested deep scrutiny) · S6 (public API + PII/secret + deploy/gateway high-risk classes) · S7 (~20 files across 2 repos) = **5/7**. Dominant signal: **S6** (three distinct high-risk classes stacked in one plan: public API contract, auth/session-adjacent PII, deploy/gateway cutover) — this is why the plan is validated and executed per-phase rather than as one fan-out.

---

### I. Validation Findings

**Layer 1 — Dimension Findings**

**Infra / Setup Fit**

| Finding | Severity | Proposed fix |
|---|---|---|
| All 20 touchpoint files exist at their stated repo/path in both `apcg-cms` and `brief-asia-web`; line-number targets are within ±10 lines of plan text (normal drift since planning) | ✅ PASS | Re-grep exact line before editing (see E8) |
| `[slug]/route.ts` currently calls `scopedFind({..., depth: 2})` with no `select` — confirms the security finding's premise (nothing currently narrows this route's population) | ✅ PASS | — |
| `content-engines`, `users`, `tenants` collection files all exist (`ContentEngines.ts`, `Users.ts`, `Tenants.ts`) | ✅ PASS | — |
| `defaultPopulate` is not used anywhere else in this codebase (`grep -rl defaultPopulate src` returns nothing) — this is a genuinely new pattern for this repo, not a copy of an existing usage | CONCERN | Execute-agent instruction: verify exact Payload 3.85.1 `defaultPopulate` API shape via `vc-docs-seeker` or `node_modules/payload` type defs before writing; do not guess from training data (see E2) |
| Fix #4's redirect shim: the plan's rollback claim ("unset env var + redeploy, ~2 min") is correct at the `payload.config.ts` level (`disablePayloadAccessControl`/`generateFileURL` are already conditioned on `r2PublicBaseUrl` truthiness, confirmed by reading lines 80/199-218) — but the shim itself, as scoped, has no stated conditional, so an unconditional shim would keep 302-redirecting even after rollback | CONCERN | Execute-agent instruction: gate the shim's redirect branch on the same `r2PublicBaseUrl` check so unset+redeploy fully reverts both halves (see E5) |
| Fix #4 precondition ordering (P8a→P8d→shim-deploy→verify→env-flip) has no mechanical/automated enforcement — it is procedure, not code | CONCERN | Execute-agent instruction: paste real command output for each P8 step into the phase report, in order, before touching the env var (see E5) |

**Test Coverage**

| Finding | Severity | Proposed fix |
|---|---|---|
| Neither repo has a test runner configured. `apcg-cms/package.json` and `brief-asia-web/package.json` both expose only `typecheck` (`tsc --noEmit`) and `lint` (`next lint`) — no `jest`, `vitest`, `playwright`, or `test` script; no `*.test.*`/`*.spec.*` files found in either repo; no `jest.config`/`vitest.config`/`playwright.config` in either repo. This was independently confirmed, not assumed. | CONCERN | Do not invent an `npm test`. All behavioral verification for both repos is Hybrid or Agent-Probe tier (see Section III); typecheck+lint prove type/lint cleanliness only, never behavior. |
| The plan already tier-labels most gates correctly as Hybrid/Agent-Probe | ✅ PASS | — |
| The `depth: 0` regression trap (What NOT To Do #8) had no concrete gate specified in the plan beyond a manual visual check | CONCERN | Added a Fully-Automated grep guard (see Section III, Fix #2 area) that fails the build if the literal string reappears — cheap, deterministic, catches the exact known trigger even without a test runner |
| The `.claude/skills/*/scripts/*.mjs` validator suite mentioned in the task is harness/process tooling (plan structure, skill registry, agent parity) — it does not exercise application code and provides zero coverage for any Fix in this plan | ✅ PASS (noted for clarity) | Only `validate-plan-artifact.mjs` is relevant here (already run against this plan file, 0 failures, 0 warnings) |

**Breaking Changes**

| Finding | Severity | Proposed fix |
|---|---|---|
| Fix #2's `LIST_SELECT` extension drops `lastEngine`, `lastEditedBy`, `assignedTo`, `translationStatus` as field **keys** from `GET /api/public/articles` — a shared public contract consumed by 5 reader sites. Only `brief-asia-web` was grepped and cleared; WTB, DTW, GCV, WAD are not on this machine and P10 (the precondition that exists specifically to close this gap) has NOT run and **cannot** run in this environment. | **CONCERN → hard-gated, not FAILed** | Split Fix #2 into 2a/2b (below). 2b (the field-drop) is BLOCKED by execute-agent instruction until P10 runs somewhere those 4 repos are reachable. |
| Fix #2's `defaultPopulate` scoping on `[slug]` route does **not** remove any field key — it only sanitizes what appears *inside* an already-populated relationship (strips `tokenHash`/`tokenPrefix`/`lastSeenIp`/staff-identity fields, keeps `lastEngine`/`translationStatus` present as keys) | ✅ PASS — genuinely separable from the P10 risk | Ship this half now (Fix 2a) — no reader can be broken by a field that still exists, only sanitized |
| Fix #4's media contract change is a hard cutover with a real 404 risk for every already-cached absolute media URL across all 5 sites, sent newsletters, RSS/social scrapes, and Google's image index | CONCERN (already correctly identified as highest-risk item by the plan) | Confirmed the plan's own P8a-d + shim-first sequencing is the right mitigation; strengthened with the env-gated-shim instruction above so rollback is provably complete |
| Fix #5's `unpin-expired` webhook suppression is verified safe for `brief-asia-web` (`route.ts:139-142` enforces expiry at read time) but explicitly NOT yet verified for the other 4 readers (plan's own risk column says so) | CONCERN (plan already flags this correctly) | Keep scoped to brief-asia-web only until P10-equivalent check runs for the other 4 (see E7) |
| Webhook contract (`/api/revalidate`) — Fix #7 changes only observability, not the wire shape | ✅ PASS | — |

**Security Surface**

| Finding | Severity | Proposed fix |
|---|---|---|
| The `tokenHash`/`tokenPrefix`/`lastSeenIp`/staff-identity PII leak on `GET /api/public/articles[/[slug]]` is real, live, and correctly diagnosed by the plan as a security fix, not a byte optimization | ✅ PASS (diagnosis correct) | Prioritize Fix 2a (defaultPopulate) — it is separable from the P10-gated byte-saving half and should ship first/independently, precisely because it is urgent and the other half is not |
| The `depth: 0` trap (What NOT To Do #8) is correctly identified and correctly avoided in the plan's prescribed fix | ✅ PASS | Enforced with a concrete grep-guard gate (Section III) so a future agent reaching for `depth: 0` anyway gets caught mechanically, not just by a note in a plan file |
| `resolveReadToken` memoization (Fix #8) is a deliberate, documented security trade-off (revocation delay bounded by TTL) | ✅ PASS | Confirm the 30-60s TTL is actually implemented as stated — no code currently implements this memoization (grep confirms `resolveReadToken` in `src/lib/public.ts` has no cache today), so this is greenfield, not a modification of existing caching logic |
| Fix #4's `disablePayloadAccessControl: true` flips `skipSafeFetch` to `true` (plan's own note) — URL-fetch paths lose Payload's `safeFetch` hardening | CONCERN (plan already flags this) | Carried forward as an explicit go/no-go item under Phase 3 — execute-agent must confirm this is acceptable or add compensating validation before flipping the env var, not discover it after |

---

**Layer 2 — Per-Phase Feasibility**

**Phase 0 — Measure**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | Zero code change; commands are curl/dashboard reads. P9's already-recorded HEAD-vs-GET finding was independently re-verified by reading `src/app/(payload)/api/[...slug]/route.ts` — it genuinely exports no `HEAD` handler, confirming the plan's methodology note is code-accurate, not asserted. |
| Plan gaps | none found beyond what the plan already flags (P1/P2b/P3 pending) | — |
| Conflicts | none | — |
| Highest-risk edit | None — this phase makes no code change | N/A |

**Phase 1 — Risk-Independent Fixes**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | All 4 items' edit targets are present and uniquely matchable: `LIST_SELECT` at `route.ts:39`, `[slug]/route.ts` depth:2/no-select confirmed, `resolveReadToken` in `public.ts` (no existing cache — greenfield), `postRevalidate` in `hooks/revalidate.ts` (no `res.ok` check today — confirmed by reading the fetch call), `cron/unpin-expired/route.ts:89` currently posts an unconditional webhook via the `logActivity`/revalidate hook path (no `disableRevalidate` context flag set today — confirmed). |
| Plan gaps | Fix #2 bundles a P10-gated contract change with a P10-independent security fix under one risk rating ("Very low") — this understates 2b's real risk | Split into 2a/2b, see Execute-Agent Instructions E1-E3 |
| Conflicts | none | — |
| Highest-risk edit | Fix #2b (the field-drop), if shipped without the split | Mitigation: E1 hard-blocks 2b until P10 |

**Phase 2 — Conditioned Fixes**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS (branch logic reads cleanly; `cms-client.central.ts`'s `getRelatedArticlesCached` fan-out confirmed: `countrySlugs.map` + `tagSlugs.slice(0,4).map` + optional pillar branch + up to 2 filler branches — matches the "4-10 calls" claim exactly) | Cannot start — see per-phase gate above |
| Plan gaps | none new | — |
| Conflicts | none | — |
| Highest-risk edit | N/A until unblocked | — |

**Phase 3 — R2 Cutover**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | The `GET` export in `src/app/(payload)/api/[...slug]/route.ts` already wraps `payloadGet(...)` with a `pathname.startsWith("/api/media/file/")` check — the shim slots into the same conditional shape described by the plan, "does not shadow clientUpload" is achievable since clientUpload posts, not GETs, to a different path. |
| Plan gaps | Shim needs explicit env-gating for a complete rollback (see Infra finding above) | E5 |
| Conflicts | none | — |
| Highest-risk edit | The env-var flip itself | Mitigation: E5 (shim-first, verified, then flip; never reverse) |

**Phase 4 — Cleanup**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | `article-view.ts:283` and `cover-art.tsx:145-152` both exist and match the described shapes; `[pillar]/page.tsx` awaits `searchParams` as described |
| Plan gaps | none new | — |
| Conflicts | none | — |
| Highest-risk edit | Fix #6's null-safety change if written as direct access instead of optional-chained | Plan's own trap warning is sufficient; carried into Section III as an explicit Agent-Probe scenario |

---

### II. Net Gate Derivation

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (3 findings, all mitigated by execute-agent instructions) |
| Test coverage | CONCERN (no test runner in either repo — structural, not fixable within this plan's scope) |
| Breaking changes | CONCERN (Fix #2 field-drop is real; contained via 2a/2b split, not shipped) |
| Security surface | PASS (diagnosis and fix design are correct; one greenfield-verification note) |

| Layer 2 phases | Status |
|---|---|
| Phase 0 — Measure | PASS |
| Phase 1 — Risk-independent fixes | CONCERN (Fix #2 split required) |
| Phase 2 — Conditioned fixes | BLOCKED (temporal — Phase 0 exit condition not yet met; not a plan defect) |
| Phase 3 — R2 cutover | BLOCKED (temporal — P8a-d not yet run; not a plan defect) |
| Phase 4 — Cleanup | PASS |

**Totals: 0 FAILs / 5 CONCERNs / 2 phase-level temporal BLOCKs (both self-resolving once their own stated precondition is met, per the plan's own Phase Completion Rules) / 4 PASSes**

**→ Net Gate: CONDITIONAL** — Phase 0 and Phase 4 pass clean. Phase 1 proceeds with the Fix #2 split enforced by hard execute-agent instructions (not softened). Phase 2 and Phase 3 are correctly not-yet-startable per the plan's own written gate — this validate pass does not waive either gate and does not let Phase 2 or Phase 3 code land under this contract.

---

### III. Test Coverage Plan

**Area: `apcg-cms/src/app/api/public/articles/route.ts` + `[slug]/route.ts` (Fix #2a/#2b, security)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | `depth: 0` regression guard | `! grep -qE 'depth:\s*0' "src/app/api/public/articles/[slug]/route.ts"` exits 0 | The specific known trap (What NOT To Do #8) was not reintroduced literally | Does not catch an equivalent regression achieved a different way (e.g. a new `select` that drops `body`) |
| Fully-Automated | Typecheck/lint clean after edit | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression from the `defaultPopulate` config change | Proves nothing about runtime response shape or behavior |
| Hybrid | Security fields no longer expose secrets | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles/<known-slug>?locale=en'` then `jq '.doc.translationStatus[]?.contentEngine // .doc.lastEngine'` — result must contain no `tokenHash`/`tokenPrefix`/`lastSeenIp` keys — precondition: live CMS + `CMS_READ_TOKEN` | Fix 2a (defaultPopulate) actually closes the PII/secret leak at runtime, not just in code review | Does not prove the list route (2b, deferred) is also clean — that is out of scope until 2b ships |
| Hybrid | Inline images still populate after 2a | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles/<slug-with-inline-image>?locale=en' \| jq -e '.doc.body.root.children[] \| select(.type=="upload") \| .value.url'` returns a non-null URL — precondition: live CMS + a known article containing an inline image | The `defaultPopulate` change did not collapse into the `depth: 0` failure mode | Does not prove every article's every image is fine — sample of 1+ known cases only |
| Agent-Probe | Visual: inline image renders in a real article page | Load `brief-asia-web` locally or staging against an article with a body inline image; confirm the image renders, not a blank gap | Human/agent visual judgment that the fix is correct end-to-end | Not automatable — no visual regression tooling exists in either repo |
| Known-gap | Fix 2b (LIST_SELECT field-drop) is NOT covered by any gate in this contract | — | This sub-item is explicitly out of scope for this EXECUTE pass — see E1 | Resolution: backlog artifact (below), re-run VALIDATE for Fix 2b once P10 is recorded |

**Area: `apcg-cms/src/app/api/cron/unpin-expired/route.ts` + `src/hooks/revalidate.ts` (Fix #5-partial, Fix #7)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No runtime behavior |
| Fully-Automated | `unpin-expired` still enforces expiry at read time | Existing guard at `route.ts:139-142` (public articles route reads `pinnedUntil` at read time) — add a coverage assertion if a test harness is ever added; today, confirm by code inspection that the read-time filter is untouched by this change | Suppressing the webhook doesn't reintroduce stale pins for brief-asia-web | No automated test executes this — code-inspection only until a runner exists |
| Hybrid | `res.ok` check actually catches a webhook failure | Force a 401 (bad `REVALIDATE_SECRET`) against a reader's `/api/revalidate` and confirm `postRevalidate` now logs a failure instead of silently succeeding — precondition: reader env with `REVALIDATE_SECRET` reachable | The observability fix (Fix #7) targets a real, previously-invisible failure mode | Does not prove timeout handling (separate scenario, same precondition) |
| Agent-Probe | `unpin-expired` generalization to the other 4 readers | Read WTB/DTW/GCV/WAD's article-rendering code for `pinnedToLatest` usage patterns | Whether Fix #5's suppression is safe beyond brief-asia-web | Cannot be probed at all from this machine — those repos are not present |
| Known-gap | Other-4-reader generalization for Fix #5 (P10-equivalent) | — | — | Resolution: keep Fix #5 scoped to brief-asia-web only (see E7); backlog artifact for the other 4 |

**Area: `apcg-cms/src/lib/public.ts` (Fix #8, `resolveReadToken` memoization)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No behavior |
| Hybrid | Memoized token resolves to the same tenant within TTL window, and a revoked token is honored after TTL expiry | Manual: rotate/deactivate a test tenant's read token, hit `/api/public/articles` before and after the TTL window, confirm 401 only appears after expiry — precondition: live CMS + a disposable test tenant token | The deliberate revocation-delay trade-off behaves as documented (30-60s), not indefinitely | Does not prove behavior under concurrent requests (race on the memoization map) |
| Known-gap | Concurrent-request race on the module-level Map | — | — | Resolution: accept as known-gap — low real-world risk (read-mostly, short TTL); document in phase report |

**Area: `apcg-cms/payload.config.ts` + `src/app/(payload)/api/[...slug]/route.ts` (Fix #4, R2 cutover — HIGH-RISK CLASS: deploy/gateway)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No runtime behavior |
| Hybrid | P8a — R2 domain serves real bytes | `curl -I https://<r2-domain>/briefasia/<known-filename>` → 200, real `Content-Type`, custom domain (not `r2.dev`) | R2 origin is reachable and correctly configured | Nothing about derivative filenames or prefix-less rows |
| Hybrid | P8b — derivative filenames also resolve | Same curl against a `card-` variant filename → 200 | Derivatives (majority of request volume) are served correctly | Nothing about the bucket-root prefix-less rows |
| Hybrid | P8c — prefix-less legacy rows | `SELECT count(*) FROM media WHERE prefix IS NULL OR prefix = '';` then `HEAD` one such filename at the bucket root | Whether pre-migration rows will 404 under the new scheme | Does not fix them — only surfaces the count for a go/no-go call |
| Hybrid | P8d — other-4-reader `next/image` config | `grep -rn "remotePatterns\|next/image\|/api/media/" src/ next.config.*` in each of WTB/DTW/GCV/WAD | Whether those readers' image config accepts the new R2 domain | **Cannot be run from this machine — those repos are absent.** |
| Hybrid | Redirect shim 302s correctly | Deploy shim only (env var still unset), then `curl -I '<cms>/api/media/file/<name>?prefix=<t>'` → confirm normal 200 passthrough (pre-flip); after flipping in a staging-only env, confirm 302 → correct R2 URL | The shim activates only when `R2_PUBLIC_BASE_URL` is set, and redirects to the exact R2 URL | Does not prove production traffic patterns (newsletters, RSS, Google image index) will follow the redirect correctly — those are external consumers outside this repo's control |
| Agent-Probe | Rollback drill | In a disposable/staging environment: flip env var, confirm cutover works, unset it, redeploy, confirm `/api/media/file/*` serves bytes directly again with no lingering redirect | Rollback is a complete, working code path, not just a claim | Cannot be probed against production — staging-only by design |
| Known-gap | P8d (other 4 readers) | — | — | **Cannot run from this environment.** Resolution: backlog artifact — Phase 3 must not proceed to the env-flip step until P8d is run by someone with access to WTB/DTW/GCV/WAD |

**High-risk class table (mandatory hybrid minimum per protocol):**

| Area | High-risk class | Minimum tier | Gap rationale if known-gap accepted |
|---|---|---|---|
| Fix #2 (public API field/population changes) | public API contract change + PII/secret exposure | Hybrid | 2a is Hybrid-covered above (curl+jq). 2b has no known-gap acceptance — it is hard-blocked (E1), not accepted as a gap. |
| Fix #4 (R2 cutover) | deploy/runtime/gateway | Hybrid | P8a-c are Hybrid-covered. P8d cannot run here — accepted as a documented known-gap ONLY for the purpose of not stalling Phase 3 prep work; the env-flip itself remains blocked until P8d is actually run by someone with the other 4 repos. |
| `resolveReadToken` memoization | secret/trust-boundary logic (token revocation timing) | Hybrid | Covered above. |

**Area: `brief-asia-web/src/lib/cms-client.central.ts` (Fix #1, related-articles fan-out collapse)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (brief-asia-web) exits 0 | No type/lint regression | **No behavior whatsoever** — brief-asia-web has no test runner (confirmed: no jest/vitest/playwright config or spec/test files exist) |
| Hybrid | Live call-count reduction | Instrument `getRelatedArticlesCached`'s branches (temporary `console.count` or CMS-side request log correlation) on a real cold article render, before vs. after the collapse — precondition: live CMS + brief-asia-web dev/staging | The "4-10 calls → 2-3" claim is real, not just source-reviewed | Exact percentage of the 2.96M this saves — that's P1/P7's job, not this gate's |
| Agent-Probe | Related-articles rail still renders sensible content | Load an article page, confirm the related rail shows non-empty, on-topic articles (not just "doesn't crash") | Editorial quality of the collapsed fan-out logic | Not automatable — no visual/content-quality tooling exists |
| Known-gap | No regression test locks in the call count going forward | — | — | Resolution: backlog artifact — brief-asia-web needs a minimal test harness (e.g. mock `fetch` + assert call count) before this kind of regression can be caught automatically; out of scope for this plan |

**Area: `brief-asia-web` search (Fix #3) + `apcg-cms` search route (context only)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean (both repos as applicable) | `npm run typecheck && npm run lint` in each repo | No type/lint regression | No behavior |
| Hybrid | Query gating + cache actually reduces uncached `LIKE` scans | Type a query <3 chars → confirm no `searchArticles` call fires (network tab / log); type ≥3 chars twice with the same normalized query within 60s → confirm the second hits `unstable_cache`, not a fresh CMS round-trip — precondition: live CMS + brief-asia-web dev | The gate + cache actually change request volume, not just intent | Real share of the 2.96M this saves — that's P1's job |
| Agent-Probe | Debounce feels correct, no dropped keystrokes | Manual UI check typing at normal speed | Debounce timing (400ms) doesn't harm UX | Not automatable |
| Known-gap | No automated test for search behavior | — | — | Same brief-asia-web test-infra gap as Fix #1 |

**Area: `brief-asia-web/src/lib/article-view.ts` + `cover-art.tsx` (Fix #6, null-safety)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (brief-asia-web) exits 0 | No type/lint regression; TS should flag if the optional-chained form is written wrong | Does not catch a runtime-only mistake TS can't see |
| Agent-Probe | Article with only original hero (no `sizes.card`) still renders a real image | `SELECT count(*) FROM media WHERE sizes_card_filename IS NULL;` first (precondition check from the plan), then load one such legacy article and confirm a real photo renders, not the generative SVG placeholder | The naive `hero.sizes.card.url` direct-access crash trap was avoided | Does not prove every legacy article — sample-based |
| Known-gap | No automated visual regression test | — | — | Same brief-asia-web test-infra gap |

**Area: `brief-asia-web/[pillar]/page.tsx` (Fix #9) + `apcg-cms` `revalidateHooks`/`HEAD` cleanup (Phase 4)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean (both repos) | `npm run typecheck && npm run lint` | No type/lint regression | No behavior |
| Hybrid | P15 — static vs dynamic route confirmation | `next build` in brief-asia-web, check the route table for `○ (Static)` vs `ƒ (Dynamic)` on the split route | Whether the `?section=` split actually restores ISR | Nothing about page content correctness |
| Hybrid | `HEAD` handler returns 200 on media | `curl -sI '<cms>/api/media/file/<name>?prefix=<t>'` → expect 200 after the fix (currently 404, confirmed by the plan's own methodology note and independently re-confirmed by reading the route file's exports) | The new `HEAD` export fixes the crawler/link-checker 404 | Does not prove Vercel's edge cache actually starts HIT-ing as a result — separate, unmeasured effect |
| Fully-Automated | `revalidateHooks` wiring present | `grep -l "revalidateHooks" src/collections/Authors.ts src/collections/Corrections.ts src/collections/Newsletters.ts src/collections/MarketSnapshots.ts` — all 4 must match | The 4 previously-unhooked collections now wire the hook, mirroring `Pillars.ts:6` | Does not prove the hook payload/tag shape is correct — that's covered by Fix #7's webhook gates |

**Missing test areas (no coverage possible at any tier within this plan's scope):**

| Area | Why untestable in this plan | Resolution chosen |
|---|---|---|
| P10 for Fix #2b (LIST_SELECT field-drop) across WTB/DTW/GCV/WAD | Those 4 repos are not present on this machine | Backlog: `p10-other-reader-verification_NOTE_09-09-26.md` — hard-blocks Fix 2b via E1 until resolved |
| P8d for Fix #4 across WTB/DTW/GCV/WAD | Same — repos absent | Backlog: same note covers both P10 and P8d (same underlying access gap) — hard-blocks the Phase 3 env-flip step |
| Fix #1 / Fix #3 automated regression coverage in `brief-asia-web` | No test runner exists in that repo at all | Backlog: `brief-asia-web-test-harness-bootstrap_NOTE_09-09-26.md` — out of scope for this cost-remediation plan |
| Crawler-control design (Phase 2 conditional branch) | Depends entirely on unrun P2/P2b attribution | Deferred — plan's own Open Questions already tracks this; no new note needed |

---

### IV. Plan Updates Applied

**None.** This VALIDATE pass's write scope was restricted to the `## Validate Contract` section only (per session instruction) — no edits were made to the plan body (Touchpoints, Phase tables, Blast Radius, etc.). Every fixable concern below is captured as a mandatory Execute-Agent Instruction instead of an inline plan-text edit. If the plan is revised later to formally split Fix #2 into 2a/2b in its own Touchpoints/Phase 1 table, that is a PLAN-mode edit, not something this VALIDATE pass performed.

### Execute-agent instructions

| # | Instruction | Trigger condition |
|---|---|---|
| E1 | **Hard block.** Do NOT modify `LIST_SELECT` to drop `lastEngine`/`lastEditedBy`/`assignedTo`/`translationStatus` (Fix 2b, the field-drop/byte-saving half) until P10 has been run and recorded for WTB, DTW, GCV, and WAD (or an equivalent grep-based clearance of those 4 repos). If P10 cannot be run in this session, Fix 2b is OUT OF SCOPE — do not implement it. File a backlog note instead (see Section III missing-areas). | Before touching `apcg-cms/src/app/api/public/articles/route.ts:39` |
| E2 | Implement Fix #2's security half (2a) as `defaultPopulate` scoping on `ContentEngines.ts`, `Users.ts`, `Tenants.ts` collection configs — NOT `depth: 0`, NOT a route-level `select`. `defaultPopulate` is not used anywhere else in this codebase; verify the exact Payload 3.85.1 API shape (via `vc-docs-seeker` or `node_modules/payload` type defs) before writing it — do not guess from training data. | Before editing `[slug]/route.ts` or any of the 3 collection files |
| E3 | After implementing 2a: run the `depth: 0` grep guard (Section III) AND the inline-image Hybrid/Agent-Probe checks on a real article with an inline image, before marking the security fix complete. | Immediately after E2's edit lands |
| E4 | Do not begin ANY Phase 2 code change until `## Phase 0 Results` in this plan records real values (or explicit "inconclusive — reason") for P1, P2b, and P3. P2 and P9 being done does NOT satisfy this — the plan's own Phase Completion Rules require all five. | Before any Phase 2 touchpoint edit |
| E5 | Do not begin Phase 3 work until P8a-d are all run, in order, with real command output pasted into the phase report. Write the redirect shim so its 302 branch is conditional on `process.env.R2_PUBLIC_BASE_URL` being set (mirroring `payload.config.ts:80`'s own conditional) — this makes "unset env var + redeploy" a complete rollback of both the URL-generation change AND the shim's redirect behavior in one step. Deploy the shim, verify it 302s correctly against a real cached URL, THEN flip the env var. Never reverse this order. | Before any Phase 3 touchpoint edit |
| E6 | Fix #1 (and Fix #3) have zero automated test coverage in `brief-asia-web` (confirmed: no test runner exists in that repo). "Verified" for these fixes means: (a) `npm run typecheck && npm run lint` pass, (b) a live before/after call-count measurement against a real cold render, and (c) an Agent-Probe visual check of the affected UI. Do not report either fix as "tested" on the basis of typecheck/lint alone. | Before marking Fix #1 or Fix #3 CODE COMPLETE |
| E7 | Fix #5's `unpin-expired` webhook suppression is verified safe for `brief-asia-web` only. Do not generalize this conclusion to WTB/DTW/GCV/WAD without running the equivalent check (does that reader render `pinnedToLatest` off a plain list doc). If that check cannot run this session, keep the change scoped to what's provably safe and record the other 4 as an explicit known-gap in the phase report — do not silently assume they're fine. | Before deploying the `unpin-expired` change |
| E8 | Line numbers in this plan's Touchpoints table were verified within ±10 lines during VALIDATE (files have drifted slightly since planning). Re-grep each exact target string immediately before editing; do not trust the plan's line numbers as exact. | Every touchpoint edit |
| E9 | Do not, under any circumstances, revive the TTL-raise idea (see `## ⚠️ INVALIDATED` banner) or schedule a `media.url`/`sizes_*_url` backfill (see "What NOT To Do" #7). This validate pass re-confirms both bans stand — nothing in this contract licenses either. | Standing instruction, all phases |

### Backlog artifacts to create during durable capture

| Artifact | Location | What it tracks |
|---|---|---|
| `p10-other-reader-verification_NOTE_09-09-26.md` | `process/general-plans/backlog/` | Tracks the still-unresolved P10/P8d gap: someone with access to WTB/DTW/GCV/WAD must (a) grep for `lastEngine`/`lastEditedBy`/`assignedTo`/`translationStatus` usage before Fix 2b can ship, and (b) check `next/image`/`remotePatterns` config before Fix #4's env-flip. Blocks: Fix 2b, Phase 3 env-flip step. |
| `brief-asia-web-test-harness-bootstrap_NOTE_09-09-26.md` | `process/general-plans/backlog/` | Neither `apcg-cms` nor `brief-asia-web` has a test runner. Recommends bootstrapping a minimal `vitest` setup in `brief-asia-web` starting with a `fetch`-mock-based call-count assertion for `getRelatedArticlesCached`, so Fix #1's savings claim gets a real regression lock going forward. Out of scope for this cost-remediation plan itself. |

### Known gaps on record

- **P10 (other 4 readers don't consume the 4 dropped fields)** — cannot be run in this environment (repos not present). Fix 2b is hard-blocked (E1), not shipped as a known-gap-accepted risk. Resolution: backlog note above; re-run VALIDATE on Fix 2b once P10 is recorded.
- **P8d (other 4 readers' `next/image` config)** — same access gap. The Phase 3 env-flip step remains blocked until this runs; Phase 3 prep work (shim writing/testing against P8a-c) may proceed since it's independent of P8d.
- **No automated regression test for Fix #1/#3's request-volume claims** — `brief-asia-web` has no test runner. Accepted as known-gap for this plan; backlog note above tracks the follow-up.
- **Payload 3.85.1's exact `defaultPopulate` syntax is unverified against the pinned version** (plan's own Open Question, carried forward) — resolved procedurally via E2 (verify via docs before writing), not accepted as a silent gap.
- **Crawler-control design (Phase 2 conditional branch)** has no concrete design yet — depends on unrun P2/P2b attribution. Already tracked in the plan's own Open Questions; no new artifact needed, just confirming it's still open.

### What this coverage does NOT prove

- The grep-based `depth: 0` guard proves the literal string is absent — it does NOT prove some other code path (a different `select`, a future refactor) can't reintroduce the same silent inline-image deletion by a different mechanism.
- Typecheck/lint gates across both repos prove type-safety and lint-cleanliness only — they prove **zero** runtime behavior, request-count reduction, or byte-saving. Every actual behavioral/performance claim in this plan rests on Hybrid or Agent-Probe tiers, most of which require live CMS access this validate pass did not have.
- The Hybrid curl/jq checks for Fix 2a prove the *sampled* article/slug tested is clean — they do not prove every article, every locale, every tenant is clean. Same caveat applies to every "one known article" Agent-Probe scenario in this contract.
- Nothing in this contract proves the September GB/CPU savings projections (108-220 GB range, the ~1.06M-1.7M request cut from Fix #1) will materialize at the stated magnitude — those numbers remain LOW-confidence estimates per the plan itself; P1/P3/P6/P7 (not gating, but sizing) are still unrun.
- Nothing in this contract verifies Fix #4's rollback in a real production incident — the rollback drill above is staging-only by design; a live production rollback has never been executed or timed.

### Accepted by

Accepted by: session (single-shot VALIDATE delegation — no separate interactive V5 round-trip occurred within this invocation). The CONDITIONAL items above (Fix #2 split, test-infra gap, Fix #4 shim env-gating) are recommended for human confirmation before EXECUTE begins on Phase 1; the two phase-level BLOCKs (Phase 2, Phase 3) are not waived by this acceptance and remain hard-gated by the plan's own Phase Completion Rules plus execute-agent instructions E4/E5 above.

---

## Autonomous Goal Block

SESSION GOAL: Remediate apcg-cms's August 2026 Vercel egress/CPU cost spike (2.96M req / ~297GB) via measure-first, ranked fixes across apcg-cms + brief-asia-web, without shipping the invalidated TTL-raise or any unverified cross-site breaking change.
Charter + umbrella plan: N/A — single general plan, no umbrella/phase-program.
Autonomy: Per this repo's orchestration.md Autonomy Mode rules. Phase 1 items 2a/#5(partial)/#7/#8 may proceed under standing EXECUTE consent once granted. Phase 2 and Phase 3 remain hard-gated (see Hard stop conditions) — autonomy does not waive plan-encoded temporal gates.
Hard stop conditions / safety constraints:
- Do not ship Fix #2b (drop lastEngine/lastEditedBy/assignedTo/translationStatus from GET /api/public/articles) until P10 is run and recorded for WTB, DTW, GCV, WAD — this repo cannot verify it alone.
- Do not start Phase 2 code until `## Phase 0 Results` records P1, P2b, and P3 (P2 and P9 alone are not sufficient per the plan's own Phase Completion Rules).
- Do not flip `R2_PUBLIC_BASE_URL` (Phase 3) until P8a-d all pass AND the redirect shim is deployed, env-gated, and verified live.
- Never implement Fix #2's `[slug]` route fix as `depth: 0` — use `defaultPopulate` on ContentEngines/Users/Tenants (see "What NOT To Do" #8 and the Security Finding).
- Never revive the TTL-raise (60s→1800s) idea — see `## ⚠️ INVALIDATED` banner.
- Never schedule a `media.url`/`sizes_*_url` backfill — see "What NOT To Do" #7.
Next phase: EXECUTE — Phase 1 items Fix #2a (defaultPopulate security fix), Fix #7 (res.ok/timeout), Fix #5-partial (unpin-expired suppression, brief-asia-web only), Fix #8 (resolveReadToken memoization). Run Phase 0's remaining measurements (P1, P2b, P3) in parallel.
Validate contract: inline in this plan file, `## Validate Contract` section (Gate: CONDITIONAL, generated-by: outer-pvl, dated 09-09-26).
Execute start: fully-auto commands: `npm run typecheck && npm run lint` in both `apcg-cms` and `brief-asia-web` after each Phase 1 edit | e2e spec: none exists (no test runner in either repo — see Test Coverage dimension finding) | probe scenario: curl+jq checks against live CMS for Fix 2a (see Section III Test Coverage Plan) | high-risk pack: yes — Fix #2 (public API + PII) and Fix #4 (deploy/gateway) both qualify per `vc-risk-evidence-pack`'s 6 high-risk classes; required before either is treated as finalize-ready.

---

## Resume and Execution Handoff

1. **Selected plan file path:** `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md` (this file).
2. **Last completed phase or step:** PLAN written 09-09-26, supplemented same day with Phase 0 partial results. P2 and P9 have been RUN (decisive/confirming); P1, P2b, P3 are NOT RUN. Phase 0 gate status: PARTIALLY MET (see `## Phase 0 Results`). No code change yet.
3. **Validate-contract status:** pending — VALIDATE has not run.
4. **Supporting context files loaded during planning:** the 141-line corrected synthesis (path in header); this repo's `brief-content-type_PLAN_20-08-26.md` (read only for house plan-format conventions, unrelated subject); `process/development-protocols/plan-lifecycle.md` and `implementation-standards.md` (referenced per task instructions — not independently re-quoted here, see those files directly for house style rules on plan lifecycle and commit hygiene).
5. **Next step for a fresh agent picking up mid-execution:**
   - If `## Phase 0 Results` is still all TBD → run Phase 0 (P1, P2, P2b, P3, P9) FIRST. Do not touch Phase 2 code. Phase 1 items may be started in parallel with Phase 0.
   - If Phase 0 Results are filled in → apply the Phase 2 branch logic to pick the priority fix, then proceed to VALIDATE for whichever phase's code changes are queued next.
   - Before touching Fix #2 or the security finding, re-read the "Security Finding" and "What NOT To Do" #8 sections above — the `depth: 0` trap is easy to reintroduce.
   - Before touching Fix #4, confirm P8a-d have all passed and the redirect shim is deployed and verified BEFORE flipping the env var — do not reverse this order.
   - Do not, under any circumstances, revive the TTL-raise idea (see banner at top) or schedule a `media.url` backfill (see "What NOT To Do" #7).

---

**Status:** DONE
**Summary:** Wrote the COMPLEX plan artifact consolidating the completed 17-agent verification synthesis into a durable, resumable plan with a Phase 0 blocking measurement gate, the INVALIDATED-TTL banner, the full "What NOT To Do" list, explicit two-repo touchpoints, the security finding flagged at plan severity, honest LOW-confidence labeling, and a resume handoff. No source files were modified in either repo.
**Concerns/Blockers:** None blocking. Two open items worth tracking: (1) the crawler-control Phase 2 branch has no concrete design yet — depends on unrun P2/P2b data; (2) `process/context/all-context.md` is missing from this repo's harness (noted in Open Questions, not resolved).
