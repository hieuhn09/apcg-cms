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

**Verified 10-09-26 from source — the leak is confirmed still live:**
- `apcg-cms:src/collections/Articles.ts:398` — `lastEngine` is a `relationship` to `content-engines`
- list route `depth: 1` (`articles/route.ts:261`); `[slug]` route `depth: 2` (`[slug]/route.ts:36`)
- `src/lib/scoped.ts:68` passes `overrideAccess: true`, which **bypasses** `ContentEngines.access.read = isSystemAdmin` (`ContentEngines.ts:27`)
- `ContentEngines.ts:76,77,96` — `tokenHash`, `tokenPrefix`, `lastSeenIp` are plain text fields; `admin: { readOnly: true }` is a UI hint, not access control
- Current state (10-09-26): `LIST_SELECT` is still `{ body: false }` only; `defaultPopulate` appears nowhere in `src/collections/`

---

## Reader Fallback Removed — Risk Baseline Raised (found 10-09-26)

**All four audited readers have deleted their embedded Payload instance** — brief-asia `97d970e`, wad `413cada`, wtb `61bc3e0`, dtw `8f8de17`. In every repo `src/lib/cms-client.ts` collapsed from a `CMS_SOURCE` switch into a bare re-export barrel over `cms-client.central`; `CMS_SOURCE` survives only as prose comments and stale `.env.example` entries.

**Consequence — state it plainly: the risk of every Central contract change is HIGHER than this plan currently assumes, not lower.** There is no local-Payload escape hatch left in any of the four readers. Every change to Central's public API hits four production sites immediately, with no fallback path to fall back to.

**Paired detection gap:** there is no test suite in any of the four readers, and no runtime response validation anywhere (no zod / valibot / yup / ajv / superstruct). `cmsFetch` swallows every failure into an empty envelope, and the health probes assert only `id` / `slug` / `publishedAt` / `mediaHost`. Anything that breaks, breaks silently in production at HTTP 200 with nothing in the logs.

This does not change any fix's design in this plan — it raises the bar for how carefully Fix #2b, Fix #4, and any future Central contract change must be verified before shipping, and it is why A3/A4 below are recorded as explicit contract locks even though neither is touched by this plan today.

## Repos Touched (every touchpoint below names its repo explicitly)

| Repo | Path | Role |
|---|---|---|
| `apcg-cms` | `/home/hieunc/Code/apcg-cms` | Central CMS — this repo |
| `brief-asia-web` | `/home/hieunc/Code/brief-asia-web` | One of five reader sites — **the only one inspected** |

**Production hosts (confirmed by measurement, record for reuse):** CMS production host is `apcg-cms.vercel.app`; brief-asia tenant prefix is `brief-asia` (with hyphen); reader canonical host is `www.briefasia.com` (bare `briefasia.com` 308-redirects to it).

**Unverified generalization warning:** every "×5" multiplier in every estimate in this plan (and in the source synthesis) is **unverified**. Only `brief-asia-web` was read in the underlying research. **UPDATE 10-09-26:** three of the four other reader sites — **WAD, WTB, DTW** — have since been audited against `origin/main` (see `### P10 + P8d — RUN 10-09-26` under Phase 0 Results) and are CLEAR on every field this plan touches. **GCV remains uninspected — it is not on this machine** and is now the only outstanding generalization gap. Precondition **P10** is RUN for 3 of 4 repos; GCV is the sole remaining blocker for any fix that assumes "all five sites behave like brief-asia-web."

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

## Additional Contract Locks (A3, A4 — found 10-09-26, not touched by this plan, must never break silently)

Neither field below is in Fix 2b's drop set today, so Fix 2b as specified is safe. They are recorded here anyway because nothing downstream would ever surface a violation — the readers have no fallback (see above) and no runtime validation, so a silent break would ship straight to production.

| ID | Must remain true | Evidence | Silent failure if violated |
|---|---|---|---|
| A3 | The `view=refs` branch keeps returning `title` | `brief-asia-web@origin/main:src/lib/central-api.ts:179` probes `"title" in docs[0]` | `fetchAllArticleRefs` bails with a `console.warn`; sitemap silently truncates to one page. Reader-invisible; surfaces weeks later as an SEO indexation drop |
| A4 | `pinnedToLatest` **and** `pinnedUntil` stay as keys on list docs | `wtb-web@origin/main:src/lib/pin.ts:17-18` reads both off list docs from `cms-client.central.ts:143` | `activePin` returns null; homepage hero and top-of-Latest fall back to the newest Destinations article. An editor pins a story and it simply does not appear, with no error to report |

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

### P10 + P8d — RUN 10-09-26 (13-agent audit against origin/main)

**Method note (important):** the local checkouts of the other reader repos were stale by 29 / 10 / 27 / 5 commits respectively (three had uncommitted work), so this audit read `origin/main` only — via `git grep origin/main` and `git show origin/main:<file>` — and mutated no working tree. An earlier shallow pass over the stale local trees produced a partly wrong answer (see the wtb-web correction below); that is why the method matters and why this audit re-ran against `origin/main` specifically.

Repos audited: `brief-asia-web`, `wad-web`, `wtb-web`, `dtw-web` (all present at `/home/hieunc/Code/`). **GCV was NOT audited — it is not on this machine.** Every repo's clearance was attacked by two independent reviewers; **0 of 8 refutation attempts succeeded.**

**Result — all four audited readers are CLEAR on all four Change-A fields** (`lastEngine`, `lastEditedBy`, `assignedTo`, `translationStatus`). Zero hits tree-wide at `origin/main`, case-insensitive, snake_case, generated `payload-types.ts` and harness dirs included. Every indirect vector was independently closed: no object spread of an article doc into a typed consumer, no `for...in`, no variable-key access on article docs, and **no runtime schema validation anywhere** (no zod / valibot / yup / ajv / superstruct in any of the four).

Per-change verdicts:

| Change | Verdict | Blocker |
|---|---|---|
| A — drop `lastEngine`/`lastEditedBy`/`assignedTo`/`translationStatus` keys from list | GO for the 4 audited | **GCV only** |
| B — `defaultPopulate` sanitization (security) | **GO — no blocker** | none |
| C — `unpin-expired` stops firing the webhook | GO | standing condition on wtb-web (see below) |
| D — R2 media URLs | GO | confirm the R2 rewrite covers `sizes.*.url` |

**Correction to an earlier (wrong) belief — wtb-web DOES read Central.** An earlier pass concluded wtb-web does not read Central at all. That conclusion came from a working tree 27 commits behind. At `origin/main`, wtb-web **does** read Central (via `cms-client.central.ts`, same barrel pattern as the other three). Record this correction explicitly so nobody re-derives the old, wrong belief.

**Standing condition on Fix #5 (wtb-web only) — Change-C safety is contingent, not structural.** brief-asia, wad and dtw obtain pins via `flag: "pinnedToLatest"`, so Central's query-time `pinnedUntil` enforcement governs — structurally safe regardless of caching. **wtb-web never sends the flag**; it pulls a raw list and picks the pin in memory. It survives only because `src/lib/pin.ts` re-checks `pinnedUntil` at render time **and** every Central fetch is `cache:"no-store"`, keeping those pages dynamic. That margin is one line of config: adding `export const revalidate = N` to wtb-web's home page (three existing precedents in that repo) would freeze `Date.now()` at generation time and hold an expired pin for the whole window with nothing left to bust it. Do not treat wtb-web's Change-C clearance as permanent — re-check if wtb-web ever adds `revalidate` to its home page.

**dtw-web audit validity caveat.** The dtw-web clearance above is valid **only for `origin/main` at tip `383f83d`**. The local checkout sits on `feat/rebrand-phase-4-rendered-copy`, 15 commits ahead, containing commits that MODIFY `payload.config.ts` — a file `origin/main` DELETED. Merging produces a delete/modify conflict that, resolved carelessly, would **resurrect the local Payload** and void this audit. See Open Questions below.

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
| ~~Serve card derivatives instead of full-res originals~~ | 6 | ~~`brief-asia-web`~~ | **REMOVED 10-09-26 — already done upstream.** Three of the four audited readers already shipped derivative selection: brief-asia `6033b1f`+`2a4a3e6`, wad `c3e7be8`+`58aff80`, wtb `edfe2ea`+`6452497`. All choose among `sizes.*.url` by `filesize` and are host-agnostic, so they survive the R2 move (Phase 3) unmodified. Do not redo this — nothing left to ship here. | N/A |
| Homepage image weight — PNG conversion only | 6 (PNG-cleanup only) | `brief-asia-web` | Measured live on `https://www.briefasia.com/`: **19 CMS image URLs, 2,591,292 bytes total (2.47 MB)**. Notable offenders: `fbCover-1600x900.png` = 955,268 B (a PNG on a homepage), `fbCover-800x450.png` = 385,987 B, `0 Architect Prof...-1600x900.jpg` = 174,507 B. Several images are fetched at **both** 1600px and 800px on the same page. All returned `x-vercel-cache: HIT`. **This is a separate problem from derivative selection above (which is done) — do not conflate the two.** | **Framing — do not misread this as an August cost driver.** These are edge-cache HITs, so they bill as Fast Data Transfer, not Fast Origin Transfer — **not** part of the 296.9 GB / 49.3 GB origin figures. Their cost is page-weight/Core Web Vitals plus a smaller data-transfer line. Two concrete follow-ups: (a) **convert PNG hero art to WebP/JPEG** — a 955 KB PNG is ~90% reducible; (b) **stop requesting two sizes of the same image on one page**. |
| Split `?section=` pillar variant into its own route | 9 | `brief-asia-web` | `[pillar]/page.tsx:6,56-61` awaits `searchParams` (a Next 15 Dynamic API) so all 8 hubs render per-request and page-level ISR (`revalidate = 60`) is inert | Verify with **P15** (`next build`, check `○ (Static)` vs `ƒ (Dynamic)` route table) rather than assuming |
| Wire `revalidateHooks` into 4 unhooked collections | — | `apcg-cms` | Add to `Authors.ts`, `Corrections.ts`, `Newsletters.ts`, `MarketSnapshots.ts`, mirroring `Pillars.ts:6` | None — this closes a real freshness gap (currently these 4 collections rely solely on their 300s TTL as freshness mechanism); low-risk, four one-line changes |
| **New finding: HEAD returns 404 on media** | — | `apcg-cms` | `src/app/(payload)/api/[...slug]/route.ts` exports GET/POST/PATCH/PUT/DELETE/OPTIONS but **no HEAD**, and the cache-header wrapper only applies when `res.status === 200`. Add a `HEAD` handler and widen the wrapper. | Consequence: link checkers, social/preview scrapers, and crawlers that issue HEAD receive a 404 with `cache-control: public, max-age=0, must-revalidate` — permanently uncacheable. This is the most likely explanation for the persistent `x-vercel-cache: MISS` in the 31/08 production logs that motivated the original (now refuted) concern about `7125ab0`. Severity: low cost impact, real correctness impact. |

---

## New Defect Found (unrelated to this plan, found 10-09-26) — WAD stale read-times

`wad-web@origin/main:src/lib/article-view.ts:344` reads `.body` off **list** docs to compute card read-time. Central shipped `body: false` on list responses on 04/09 (`5639e41`). **WAD article-card read-times have therefore been silently falling back to the "5 MIN READ" default since 04/09.**

This is a separate defect with its own fix, **pre-existing and NOT attributable to Change A** (this plan's Fix #2 field-drop hasn't shipped yet). Fix belongs in `wad-web`, not `apcg-cms` — track it there, not as a Phase item in this plan.

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
| P10 | Do the other 4 readers match brief-asia-web? | **RUN 10-09-26 for brief-asia-web, wad-web, wtb-web, dtw-web (CLEAR, 13-agent audit against origin/main).** GCV not on this machine — still open, now the sole blocker for Fix 2b and the Phase 3 env-flip. |
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
- **dtw-web audit validity caveat (found 10-09-26).** The dtw-web P10/P8d clearance (see `### P10 + P8d` under Phase 0 Results) is valid **only for `origin/main` at tip `383f83d`**. The local checkout sits on `feat/rebrand-phase-4-rendered-copy`, 15 commits ahead, containing commits that MODIFY `payload.config.ts` — a file `origin/main` DELETED. Merging produces a delete/modify conflict that, resolved carelessly, would **resurrect the local Payload** and void the audit. Anyone merging that branch must re-run the dtw-web portion of the P10/P8d audit afterward.
- **No workflow JSON per-claim breakdown was separately re-extracted for this plan** beyond the synthesis text; if a future agent needs the raw per-agent verdicts/corrections/unknowns, they live at `/tmp/claude-1000/-home-hieunc-Code-apcg-cms/02fde8d0-fd22-4ee0-9ce1-9273dcee88dd/tasks/wy7ij9o7g.output` under `result.perClaim[]` (query with `jq`, do not `cat` the whole file — it is large).

---

## Validate Contract

Status: CONDITIONAL
Date: 10-09-26
date: 2026-09-10
generated-by: outer-pvl
supersedes: 2026-09-09 (outer-pvl) — PVL cycle 1 closed P10/P8d for 4 of 5 readers, raised the risk baseline, and added two new contract locks (A3/A4); this contract replaces the prior CONDITIONAL wholesale

### Net Gate

**Gate: CONDITIONAL**

0 FAILs at the whole-plan level. Cycle 1 genuinely closed the previous contract's largest CONCERN (P10/P8d, narrowed from "4 unknown repos" to "GCV only" — verified live against `origin/main` for all four audited repos, not just accepted from the report). It also surfaced 2 new items that were not open questions before this cycle: an inverted A3 test-gate direction (corrected below, not shipped as a silent trap) and a now-stale dtw-web merge-conflict caveat (verified closed — reported honestly as good news, not manufactured as a new block). Net effect: 4 CONCERNs remain (down from 5), 0 are new blocking risk, 1 is a corrected specification bug in this contract's own test-gate wording. Fix 2a is cleared to ship now. Phase 2 and Phase 3 remain correctly not-yet-startable — this cycle does not soften either gate.

### Per-Phase Gate (unchanged in shape from cycle 0 — only the evidence underneath changed)

| Phase | Gate | Why |
|---|---|---|
| Phase 0 (measure) | CONDITIONAL — proceed | Re-verified 10-09-26: P2 (ratio 1:4.55, fan-out confirmed dominant) and P9 (media caching confirmed working) remain RUN/decisive. P1/P2b/P3 still NOT RUN. Cycle 1 did not touch Phase 0 measurements — no change to this row's gate, only its supporting evidence is one day fresher. |
| Phase 1 (risk-independent fixes) | CONDITIONAL — proceed, Fix #2a unblocked, Fix #2b narrowed | Fix #2a (security, `defaultPopulate`) is GO — verified live 10-09-26 that the leak is still present and `defaultPopulate` is still greenfield (see Layer 1 Infra findings). Fix #2b (field-drop) stays BLOCKED but the block narrowed from "4 unknown repos" to "GCV only" — this is confirmed, not merely asserted (see Breaking Changes findings). |
| Phase 2 (conditioned fixes) | **BLOCKED — do not start** | Unchanged. Re-verified 10-09-26: `## Phase 0 Results` still shows P1/P2b/P3 as NOT RUN. P10 moving to RUN does not touch this gate — Phase 2's block is about P1/P2b/P3, a disjoint precondition set. Plan's own Phase Completion Rule still applies. |
| Phase 3 (R2 cutover) | **BLOCKED — do not start** | Unchanged. Re-verified: no R2 domain has been attached (P8a-c still NOT RUN). P8d (the reader-config check) is now cleared for 3 of 4 readers, but P8d alone unblocking does not unblock Phase 3 — P8a-c gate the env-flip and none of them have run. |
| Phase 4 (cleanup) | CONDITIONAL — proceed | Unchanged. Fix #6 (derivative selection) is now confirmed DONE upstream for 3 of 4 readers per cycle 1's audit — no new risk, one less thing to build. |

### Parallel strategy

Unchanged from cycle 0 — the per-phase strategy table below is re-confirmed, not re-derived, since nothing in cycle 1 changed the file-disjointness or risk-class shape of any phase.

| Phase | Strategy | Agent count | Rationale |
|---|---|---|---|
| Phase 0 remaining (P1, P2b, P3) | Sequential (1 agent, agent-probe/hybrid) | 1 | Dashboard reads + one curl command; still no benefit from parallelizing 3 read-only measurements. |
| Phase 1 (Fix #2a, #5-partial, #7, #8) | **Parallel subagents** | 4 | Still-disjoint files (`[slug]/route.ts` + 3 collection configs · `cron/unpin-expired/route.ts` · `hooks/revalidate.ts` · `lib/public.ts`) — fire-and-forget fan-out, no coordination needed. Fix #2b is excluded from this fan-out (it does not ship this cycle). |
| Phase 2 (once unblocked) | Sequential (1 agent) | 1 | Unchanged — branch logic selects exactly one priority path. |
| Phase 3 (R2 cutover) | Sequential, single agent, manual-first | 1 | Unchanged — explicitly ordered P8a-d chain, no parallelization allowed. |
| Phase 4 (cleanup) | Parallel subagents | 2-3 | Narrowed from cycle 0's 3-4: Fix #6 (derivative selection) is done upstream and drops out of this fan-out; PNG-conversion sub-item, `?section=` split, and `revalidateHooks`/`HEAD` cleanup remain disjoint. |

Signals present: S2 (API/security surface) · S3 (Phase 2's 3-way branch) · S5 (user requested deep scrutiny) · S6 (public API + PII/secret + deploy/gateway high-risk classes, now compounded by the raised reader-risk baseline — see Infra findings) · S7 (~20 files across 2 repos) = **5/7**. Dominant signal unchanged: **S6**, now sharper — the readers' own fallback removal (found this cycle) means every one of these high-risk classes now fails closed into production with zero test coverage catching it, not just theoretically.

---

### I. Validation Findings

**Layer 1 — Dimension Findings**

**Infra / Setup Fit**

| Finding | Severity | Proposed fix |
|---|---|---|
| Live-verified 10-09-26 (not re-quoted from the prior contract): `Articles.ts:398` `lastEngine` is a `relationship` to `content-engines`; list route `depth: 1` (`articles/route.ts:261`); `[slug]` route `depth: 2` (`[slug]/route.ts:36`); `scoped.ts:68` passes `overrideAccess: true`; `ContentEngines.ts:27` gates read access to `isSystemAdmin`, bypassed by the above; `ContentEngines.ts:76,77,96` `tokenHash`/`tokenPrefix`/`lastSeenIp` are plain fields | ✅ PASS (leak confirmed still live, diagnosis unchanged) | Ship Fix 2a now (E1 below) |
| `defaultPopulate` re-confirmed absent anywhere in `apcg-cms/src` (`grep -rl defaultPopulate src` → no matches) — still genuinely greenfield | CONCERN (unchanged from cycle 0) | Execute-agent instruction: verify exact Payload 3.85.1 API shape before writing (E2, carried forward) |
| **New this cycle — risk baseline raised, not lowered.** All four audited readers (brief-asia-web, wad-web, wtb-web, dtw-web) have deleted their embedded Payload instance (verified live: brief-asia-web's local checkout is 29 commits behind `origin/main`; `origin/main:src/lib/cms-client.ts` is now a bare re-export barrel over `cms-client.central`, confirmed by reading the file directly — the local stale checkout still shows the old `CMS_SOURCE` switch, which is exactly why the audit read `origin/main` and not local trees). No reader has a local-Payload fallback left. Combined with zero test suites and zero runtime response validation in any of the four (independently confirmed: no jest/vitest/playwright config or test files in brief-asia-web; the audit's own claim of "no zod/valibot/yup/ajv/superstruct in any of the four" was not independently re-run this session but is consistent with cycle 1's report) | **CONCERN — real, correctly stated by the plan, must not be read as lower risk** | This does not block anything new — it raises the evidentiary bar for every Hybrid/Agent-Probe gate in Section III below (see the strengthened Fix 2a gate) and is the reason A3/A4 are recorded as hard locks even though this plan doesn't touch either field this cycle |
| Fix #4's env-gated-shim instruction (E5, carried forward) still applies unchanged — not re-verified this cycle since no Phase 3 code exists yet | ✅ PASS (no new finding) | — |
| **Correction found this cycle — the dtw-web merge-conflict caveat in this plan's Open Questions is now STALE, not live.** Verified directly: `origin/main` tip is still `383f83d` as the plan states, and `git merge-base HEAD origin/main` on the local `feat/rebrand-phase-4-rendered-copy` checkout returns that exact same hash — meaning origin/main is already fully merged into local HEAD (commit `0607840 Merge origin/main into rebrand phase 4` is one of the 17 commits ahead). `payload.config.ts` does not exist in either branch (`find . -iname payload.config.ts` returns nothing tracked); its only history is a single deletion commit (`8f8de17`) that is common ancestor to both branches, and none of the 17 local-only commits touch that path (`git log origin/main..HEAD --stat -- payload.config.ts` is empty). **There is no pending delete/modify conflict — it was either already resolved cleanly by the merge, or the original caveat mis-stated a risk that never had commits behind it.** | ✅ PASS (corrects an over-cautious plan claim — good news, not a new block) | Downgrade the "dtw-web audit validity caveat" in the plan's Open Questions from an active risk to a closed note next time the plan body is edited (PLAN-mode edit, not performed here — see Section IV). The commit-pinning statement itself ("valid only for `origin/main` at tip `383f83d`") remains correct and should stay as a standing precondition — only the specific merge-conflict mechanism was stale. |

**Test Coverage**

| Finding | Severity | Proposed fix |
|---|---|---|
| Re-confirmed 10-09-26, unchanged: neither repo has a test runner. `apcg-cms/package.json` scripts list confirms only `lint` (`next lint`) and `typecheck` (`tsc --noEmit`) — no `jest`/`vitest`/`playwright`/`test` script; no `*.test.*`/`*.spec.*` files; no test config files in either repo | CONCERN (structural, unfixable within this plan's scope) | Unchanged from cycle 0: do not invent `npm test`. All behavioral gates are Hybrid/Agent-Probe. See Section III for the full tier table with exact commands. |
| The `depth: 0` regression guard proposed in cycle 0 is still correctly specified and still catches the exact known trigger — re-verified `[slug]/route.ts:36` is currently `depth: 2`, not `0`, so the guard would currently pass | ✅ PASS (survived the supplement unchanged) | Carried forward verbatim into Section III below |
| **New this cycle — A3's test-gate direction as stated in the plan body is inverted and would fail to catch the actual regression it names.** Verified: `brief-asia-web@origin/main:src/lib/central-api.ts:179` (`fetchAllArticleRefs`) treats `"title" in docs[0]` as TRUE meaning "Central ignored `view=refs` (full docs returned)" and bails early with a `console.warn`, truncating the sitemap to one page. The plan's Additional Contract Locks table states the invariant as "the `view=refs` branch **keeps returning** `title`" — this is backwards. The actual required invariant, confirmed by reading `apcg-cms/src/app/api/public/articles/route.ts:261-264` (`select: refsView ? { slug: true, updatedAt: true, publishedAt: true } : LIST_SELECT`), is: **`view=refs` must keep NOT returning `title`.** If a future change adds `title: true` to the refsView select branch, that is exactly the regression that trips the reader's own defensive check and truncates the sitemap — the opposite of what the plan's current wording would lead an execute-agent to protect. | **CONCERN — corrected below, not shipped as a silent spec bug** | See Execute-Agent Instruction E10 and the corrected Fully-Automated gate in Section III. This is a wording defect in the plan's Additional Contract Locks table (A3 row), not a code defect — no source file is wrong today (current `select` already correctly omits `title` from the refsView branch). |
| A4 test-gate direction re-verified correct as stated: `wtb-web@origin/main:src/lib/pin.ts` (`activePin`) reads `a.pinnedToLatest` and `a.pinnedUntil` directly off list docs, confirmed by reading the function body live — the invariant "both keys must stay on list docs" is stated in the correct direction and matches Fix #2's current `LIST_SELECT = { body: false }` (neither key is dropped today) | ✅ PASS | Carry forward unchanged into Section III |

**Breaking Changes**

| Finding | Severity | Proposed fix |
|---|---|---|
| Fix #2b (field-drop) generalization: **narrowed and independently re-confirmed this cycle, not merely accepted from the report.** Cycle 1's 13-agent audit against `origin/main` for brief-asia-web/wad-web/wtb-web/dtw-web found zero hits for the four dropped fields, with every indirect vector (spread, `for...in`, variable-key access, runtime schema validation) closed and 0/8 refutation attempts succeeding. This validate pass did not independently re-run the full 13-agent audit (out of scope for a VALIDATE session; would duplicate cycle 1's own empirical work), but did independently confirm the underlying facts that make the audit trustworthy: `LIST_SELECT` is still `{ body: false }` only (field-drop not yet shipped, so no live risk exists yet either way), and the audit's own stated method (reading `origin/main` via `git show`, not stale local trees) is sound given brief-asia-web's local tree really is 29 commits behind `origin/main` (independently verified this session) | ✅ PASS for 4 of 5 readers, CONCERN remains for GCV only | Fix 2b stays hard-blocked (E1, unchanged) until GCV is checked; the block is real and correctly narrow, not a residual risk on the 4 cleared repos |
| Fix #2a's `defaultPopulate` scoping on the `[slug]` route does **not** remove any field key — only sanitizes populated sub-fields (strips `tokenHash`/`tokenPrefix`/`lastSeenIp`/staff-identity, keeps `lastEngine`/`translationStatus` present as keys). Re-confirmed this cycle: `[slug]/route.ts:36` is still `depth: 2` with no `select`/`defaultPopulate` today, so no reader-visible shape changes when 2a ships — the leak is closed, the wire shape stays the same except inside the populated relationship | ✅ PASS — genuinely separable from P10/GCV, no dependency on Fix 2b | Ship Fix 2a now (E1) — independent of the GCV block |
| A3/A4 (new contract locks from cycle 1) are correctly scoped as "not touched by this plan today" — re-confirmed: neither `LIST_SELECT` nor the refsView `select` branch currently include or exclude `title`/`pinnedToLatest`/`pinnedUntil` in a way that violates either lock | ✅ PASS (A4) / CONCERN (A3 — see wording defect above) | A4: no action needed. A3: correct the test-gate wording (E10). |
| Fix #4 and Fix #5's breaking-change risk profile is unchanged from cycle 0's assessment — re-confirmed no code exists yet for either | ✅ PASS (no new finding, not re-litigated) | Carried forward: E5 (Fix #4), E7 (Fix #5) |

**Security Surface**

| Finding | Severity | Proposed fix |
|---|---|---|
| The PII/secret leak is re-verified live and unambiguous as of 10-09-26 (see Infra findings above for the exact file:line chain) — the leak has not been touched by any code change since cycle 0 | ✅ PASS (diagnosis correct, still live, still urgent) | **Clear GO for Fix 2a.** No blocking dependency remains — see Net Gate above. |
| `resolveReadToken` memoization (Fix #8) remains greenfield (re-confirmed: no cache exists in `src/lib/public.ts` today) | ✅ PASS (unchanged) | Carried forward: implement the 30-60s TTL as documented |
| **Raised-stakes note (from the risk-baseline finding above):** with no reader-side fallback and no runtime response validation anywhere, a mistake in Fix 2a's `defaultPopulate` scoping that accidentally strips a field readers DO consume (e.g. `lastEngine`'s own id, or breaks byline resolution) would fail silently at HTTP 200 across all 4 live sites with nothing in the logs. The plan's own finding that "no reader reads any inner subfield of those relationships, and bylines resolve from the separate `authors` collection" is the mitigating fact — but it has not been independently re-verified against `origin/main` for all 4 readers this session (only asserted by cycle 1's audit) | CONCERN | Strengthened Hybrid test gate below (Section III) explicitly asserts byline/author rendering is unaffected post-Fix-2a, not just that secret fields are gone |

---

**Layer 2 — Per-Phase Feasibility**

**Phase 0 — Measure**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | Unchanged — zero code change, P1/P2b/P3 remain read-only dashboard/curl work |
| Plan gaps | none new | P2/P9 results from cycle 0 re-confirmed stable this session (not re-run — no new dashboard access this VALIDATE pass) |
| Conflicts | none | — |
| Highest-risk edit | N/A | This phase makes no code change |

**Phase 1 — Risk-Independent Fixes**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | All 4 items' edit targets re-verified present and uniquely matchable this session: `LIST_SELECT = { body: false }` at `route.ts:39` (confirmed live), `[slug]/route.ts:36` `depth: 2` with no select (confirmed live), `resolveReadToken` in `public.ts` (still no cache — greenfield, confirmed), `cron/unpin-expired/route.ts` and `hooks/revalidate.ts` unchanged since cycle 0 (not re-read line-by-line this session; no evidence anything moved) |
| Plan gaps | Fix #2's split (2a/2b) is now cleanly documented as a two-item split with independent GO/BLOCKED status — the split itself was already applied by cycle 0's contract and is not new work this cycle, only its evidentiary basis (P10) improved | See E1 (unchanged in substance, narrower scope) |
| Conflicts | none | — |
| Highest-risk edit | Fix #2b if shipped without GCV confirmation | Unchanged mitigation: E1 hard-blocks 2b |

**Phase 2 — Conditioned Fixes**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS (unchanged, not re-verified this session — branch logic and fan-out call sites were confirmed in cycle 0 and no code has changed since) | Cannot start — see per-phase gate above |
| Plan gaps | none new | — |
| Conflicts | none | — |
| Highest-risk edit | N/A until unblocked | — |

**Phase 3 — R2 Cutover**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS (unchanged, not re-verified this session — no code exists yet for this phase) | — |
| Plan gaps | none new | — |
| Conflicts | none | — |
| Highest-risk edit | The env-var flip itself | Mitigation unchanged: E5 |

**Phase 4 — Cleanup**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | Fix #6 (derivative selection) confirmed DONE upstream this cycle for 3 of 4 readers — removed from this phase's remaining scope, narrowing the fan-out (see Parallel strategy above) |
| Plan gaps | none new | — |
| Conflicts | none | — |
| Highest-risk edit | Fix #6's PNG-conversion sub-item and the null-safety change, if written as direct access instead of optional-chained | Unchanged — plan's own trap warning is sufficient, carried into Section III |

---

### II. Net Gate Derivation

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (2 findings: `defaultPopulate` greenfield-verification note, raised risk baseline — both mitigated by execute-agent instructions; 1 finding corrected from CONCERN to PASS this cycle: dtw-web merge-conflict caveat is stale) |
| Test coverage | CONCERN (no test runner in either repo — structural, unchanged; 1 new CONCERN this cycle: A3 test-gate wording inverted, corrected below) |
| Breaking changes | CONCERN (Fix #2b field-drop, narrowed to GCV only; contained via 2a/2b split, not shipped) |
| Security surface | CONCERN (diagnosis correct and Fix 2a is clear to ship, but the raised risk baseline means the Hybrid gate must now explicitly prove bylines/authors are unaffected, not just that secrets are gone — this is a strengthened gate requirement, not a block) |

| Layer 2 phases | Status |
|---|---|
| Phase 0 — Measure | PASS |
| Phase 1 — Risk-independent fixes | CONDITIONAL (Fix #2a GO, Fix #2b narrowed-BLOCKED) |
| Phase 2 — Conditioned fixes | BLOCKED (temporal — Phase 0 exit condition not yet met; unchanged, not a plan defect) |
| Phase 3 — R2 cutover | BLOCKED (temporal — P8a-c not yet run; unchanged, not a plan defect) |
| Phase 4 — Cleanup | PASS |

**Totals: 0 FAILs / 4 CONCERNs (down from 5) / 2 phase-level temporal BLOCKs (both self-resolving once their own stated precondition is met) / 4 PASSes (up from 4 — one item moved from CONCERN to PASS: the dtw-web merge-conflict caveat).**

**→ Net Gate: CONDITIONAL.** Phase 0 and Phase 4 pass clean. Phase 1 proceeds — Fix #2a is now an unambiguous GO with no remaining blocker; Fix #2b stays hard-blocked, narrowed to GCV only, not softened. Phase 2 and Phase 3 remain correctly not-yet-startable; this cycle does not waive either gate. Per the net-gate vacuous-green ban: this plan's fully-automated gates (typecheck/lint/grep-guards) alone do not prove any behavioral claim — every behavioral assertion in this plan rests on Hybrid or Agent-Probe tiers, which is why the net gate is CONDITIONAL and not PASS even with 0 FAILs.

---

### III. Test Coverage Plan

**Area: `apcg-cms/src/app/api/public/articles/route.ts` + `[slug]/route.ts` (Fix #2a/#2b, security)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | `depth: 0` regression guard | `! grep -qE 'depth:\s*0' "src/app/api/public/articles/[slug]/route.ts"` exits 0 | The known trap (What NOT To Do #8) was not reintroduced literally | Does not catch an equivalent regression via a different mechanism (e.g. a new `select` that drops `body`) |
| | | `Failing stub:` `test("should reject depth:0 on [slug] route", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: depth:0 regression guard") })` | | |
| Fully-Automated | Typecheck/lint clean after edit | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression from the `defaultPopulate` config change | Proves nothing about runtime response shape or behavior |
| | | `Failing stub:` `test("should typecheck and lint clean after defaultPopulate change", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: typecheck/lint clean") })` | | |
| Hybrid | Security fields no longer expose secrets | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles/<known-slug>?locale=en'` then `jq '.doc.translationStatus[]?.contentEngine // .doc.lastEngine'` — result must contain no `tokenHash`/`tokenPrefix`/`lastSeenIp` keys — precondition: live CMS + `CMS_READ_TOKEN` | Fix 2a actually closes the PII/secret leak at runtime | Does not prove the list route (2b, deferred) is also clean |
| Hybrid | **Strengthened this cycle — byline/author resolution unaffected** | Same request as above; additionally assert `.doc.author` (or the article's byline-resolving field, per the plan's own note that "bylines resolve from the separate `authors` collection") is present and non-null, and that `.doc.lastEngine` (the key, not its populated subfields) is still present if it was before — precondition: live CMS + a known article with a byline | The raised risk baseline (no reader fallback, no runtime validation) is compensated for by proving `defaultPopulate` scoping did not collaterally strip a field readers actually consume | Does not prove every article/locale/tenant — sample of 1+ known cases only |
| Hybrid | Inline images still populate after 2a | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles/<slug-with-inline-image>?locale=en' \| jq -e '.doc.body.root.children[] \| select(.type=="upload") \| .value.url'` returns a non-null URL | The `defaultPopulate` change did not collapse into the `depth: 0` failure mode | Sample of 1+ known cases only |
| Agent-Probe | Visual: inline image renders in a real article page | Load `brief-asia-web` locally or staging against an article with a body inline image; confirm the image renders | Human/agent visual judgment that the fix is correct end-to-end | Not automatable — no visual regression tooling exists in either repo |
| Known-gap | Fix 2b (field-drop) not covered by any gate in this contract | — | Explicitly out of scope for this EXECUTE pass — see E1 | Resolution: backlog artifact (below); re-run VALIDATE for Fix 2b once GCV clearance is recorded |

**Area: `apcg-cms/src/app/api/public/articles/route.ts` (A3 contract lock — corrected this cycle)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | **Corrected direction:** `view=refs` continues to NOT return `title` | `! grep -A3 'select: refsView' "src/app/api/public/articles/route.ts" \| grep -q 'title: true'` exits 0 | The refsView select branch has not been changed to include `title` — the exact regression that trips `brief-asia-web`'s own `fetchAllArticleRefs` defensive check | Does not prove runtime behavior directly — this is a static-source guard; add the Hybrid check below for a live confirmation |
| | | `Failing stub:` `test("should keep view=refs select omitting title", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: A3 contract lock — title absent from refsView select") })` | | |
| Hybrid | Live confirmation that `view=refs` omits `title` | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles?view=refs&limit=1'` then `jq -e '.docs[0] | has("title") | not'` — precondition: live CMS | Confirms at runtime, not just in source, that the reader's `"title" in docs[0]` heuristic will correctly stay false | Does not prove pagination beyond page 1 — separate concern from the field-presence check |
| Known-gap | No test exists in `brief-asia-web` to independently assert its own `fetchAllArticleRefs` bail-out logic | — | `brief-asia-web` has no test runner (same structural gap as the rest of this plan) | Accepted — this lock is enforced from the `apcg-cms` side only; if `brief-asia-web`'s detection logic itself changes, re-audit this row |

**Area: `apcg-cms/src/app/api/public/articles/route.ts` (A4 contract lock)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | `LIST_SELECT` never drops `pinnedToLatest`/`pinnedUntil` | `! grep -A5 'LIST_SELECT = ' "src/app/api/public/articles/route.ts" \| grep -qE '(pinnedToLatest|pinnedUntil)\s*:\s*false'` exits 0 | Neither key is explicitly excluded from the list select object | Does not prove the fields are populated with correct values — only that they are not deliberately dropped |
| | | `Failing stub:` `test("should never drop pinnedToLatest/pinnedUntil from LIST_SELECT", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: A4 contract lock") })` | | |
| Hybrid | Live confirmation both keys are present on list docs | `curl -s -H "Authorization: Bearer $CMS_READ_TOKEN" '<cms>/api/public/articles?limit=1'` then `jq -e '.docs[0] | has("pinnedToLatest") and has("pinnedUntil")'` — precondition: live CMS | Confirms at runtime that `wtb-web`'s `activePin` (which reads both keys directly off list docs) will not silently break | Does not prove `wtb-web`'s own read-time re-check logic — that lives in a different repo with no test coverage |

**Area: `apcg-cms/src/app/api/cron/unpin-expired/route.ts` + `src/hooks/revalidate.ts` (Fix #5-partial, Fix #7)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No runtime behavior |
| Fully-Automated | `unpin-expired` still enforces expiry at read time | Code-inspection confirmation that `route.ts:139-142`'s read-time filter is untouched by this change (no automated test exists) | Suppressing the webhook doesn't reintroduce stale pins for brief-asia-web | No automated test executes this |
| Hybrid | `res.ok` check actually catches a webhook failure | Force a 401 (bad `REVALIDATE_SECRET`) against a reader's `/api/revalidate`, confirm `postRevalidate` logs a failure — precondition: reader env with `REVALIDATE_SECRET` reachable | Fix #7 targets a real, previously-invisible failure mode | Does not prove timeout handling (separate scenario, same precondition) |
| Agent-Probe | `unpin-expired` generalization to the other readers | Re-confirmed this cycle for wad-web/wtb-web/dtw-web (structural GO for wad/dtw via `pinnedToLatest` query-time enforcement; contingent-but-currently-safe for wtb-web via the standing condition on its `no-store` fetch pattern — re-check if wtb-web ever adds `revalidate` to its home page, verified this session that no such change exists yet: `wtb-web@origin/main` shows no new `revalidate` export in `pin.ts` or its callers) | Whether Fix #5's suppression is safe beyond brief-asia-web | GCV still cannot be probed — not present on this machine |
| Known-gap | GCV generalization for Fix #5 | — | — | Resolution: Fix #5 may generalize to brief-asia-web/wad-web/wtb-web/dtw-web; keep scoped away from GCV only |

**Area: `apcg-cms/src/lib/public.ts` (Fix #8, `resolveReadToken` memoization)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No behavior |
| Hybrid | Memoized token honors TTL-bounded revocation delay | Rotate/deactivate a test tenant's read token, hit `/api/public/articles` before and after the TTL window, confirm 401 only appears after expiry — precondition: live CMS + a disposable test tenant token | The documented 30-60s revocation-delay trade-off behaves as designed | Does not prove behavior under concurrent requests (race on the module-level Map) |
| Known-gap | Concurrent-request race on the memoization Map | — | — | Accepted as known-gap — low real-world risk (read-mostly, short TTL); document in phase report |

**Area: `apcg-cms/payload.config.ts` + `src/app/(payload)/api/[...slug]/route.ts` (Fix #4, R2 cutover — HIGH-RISK CLASS: deploy/gateway)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 | No type/lint regression | No runtime behavior |
| Hybrid | P8a — R2 domain serves real bytes | `curl -I https://<r2-domain>/briefasia/<known-filename>` → 200, real `Content-Type`, custom domain (not `r2.dev`) | R2 origin reachable and correctly configured | Nothing about derivative filenames or prefix-less rows |
| Hybrid | P8b — derivative filenames resolve | Same curl against a `card-` variant filename → 200 | Derivatives (majority of request volume) served correctly | Nothing about bucket-root prefix-less rows |
| Hybrid | P8c — prefix-less legacy rows | `SELECT count(*) FROM media WHERE prefix IS NULL OR prefix = '';` then `HEAD` one such filename at the bucket root | Whether pre-migration rows 404 under the new scheme | Does not fix them — only surfaces the count for a go/no-go call |
| Hybrid | P8d — other-reader `next/image` config | `grep -rn "remotePatterns\|next/image\|/api/media/" src/ next.config.*` in each of WAD/WTB/DTW/GCV | Whether those readers' image config accepts the new R2 domain | Confirmed compatible for WAD/WTB/DTW as of the 10-09-26 audit; GCV still cannot be run from this machine |
| Hybrid | Redirect shim 302s correctly, and rolls back completely | Deploy shim only (env var unset), curl → confirm normal 200 passthrough (pre-flip); flip in staging only, curl → confirm 302 to correct R2 URL; unset + redeploy, curl → confirm passthrough resumes with no lingering redirect | The shim's redirect branch is conditional on `R2_PUBLIC_BASE_URL`, so rollback is provably complete on both halves (E5) | Does not prove production traffic patterns (newsletters, RSS, Google image index) follow the redirect |
| Agent-Probe | Rollback drill | In a disposable/staging environment, run the full flip → confirm → unset → redeploy → confirm cycle | Rollback is a complete, working code path | Cannot be probed against production |
| Known-gap | P8d (GCV only) | — | — | Cannot run from this environment; backlog artifact hard-blocks the Phase 3 env-flip step |

**High-risk class table (mandatory hybrid minimum per protocol):**

| Area | High-risk class | Minimum tier | Gap rationale if known-gap accepted |
|---|---|---|---|
| Fix #2 (public API field/population changes) | public API contract change + PII/secret exposure | Hybrid | 2a is Hybrid-covered above, strengthened this cycle with a byline-preservation assertion. 2b has no known-gap acceptance — hard-blocked (E1), not accepted as a gap. |
| Fix #4 (R2 cutover) | deploy/runtime/gateway | Hybrid | P8a-c Hybrid-covered. P8d ran for WAD/WTB/DTW (GO). GCV alone accepted as a documented known-gap ONLY for Phase 3 prep work; the env-flip itself remains blocked until P8d runs for GCV. |
| `resolveReadToken` memoization | secret/trust-boundary logic (token revocation timing) | Hybrid | Covered above. |
| A3/A4 contract locks | public API contract change (silent-failure class — SEO indexation, editorial pin visibility) | Fully-Automated + Hybrid | Both covered above; A3's gate direction was corrected this cycle. |

**Area: `brief-asia-web/src/lib/cms-client.central.ts` (Fix #1, related-articles fan-out collapse)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (brief-asia-web) exits 0 | No type/lint regression | No behavior — brief-asia-web has no test runner (re-confirmed this session: `origin/main` shows no jest/vitest/playwright config) |
| Hybrid | Live call-count reduction | Instrument `getRelatedArticlesCached`'s branches on a real cold article render, before vs. after the collapse — precondition: live CMS + brief-asia-web dev/staging | The "4-10 calls → 2-3" claim is real | Exact percentage of the 2.96M this saves — that's P1/P7's job |
| Agent-Probe | Related-articles rail still renders sensible content | Load an article page, confirm the related rail shows non-empty, on-topic articles | Editorial quality of the collapsed fan-out logic | Not automatable |
| Known-gap | No regression test locks in the call count going forward | — | — | Resolution: backlog artifact — out of scope for this plan |

**Area: `brief-asia-web` search (Fix #3) + `apcg-cms` search route (context only)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean (both repos) | `npm run typecheck && npm run lint` in each repo | No type/lint regression | No behavior |
| Hybrid | Query gating + cache reduces uncached `LIKE` scans | Type <3 chars → confirm no `searchArticles` call; type ≥3 chars twice within 60s → confirm second hits `unstable_cache` — precondition: live CMS + brief-asia-web dev | Gate + cache actually change request volume | Real share of the 2.96M this saves — that's P1's job |
| Agent-Probe | Debounce feels correct | Manual UI check typing at normal speed | Debounce timing (400ms) doesn't harm UX | Not automatable |
| Known-gap | No automated test for search behavior | — | — | Same brief-asia-web test-infra gap |

**Area: `brief-asia-web/src/lib/article-view.ts` + `cover-art.tsx` (Fix #6, null-safety)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (brief-asia-web) exits 0 | No type/lint regression; TS flags the optional-chained form if written wrong | Does not catch a runtime-only mistake TS can't see |
| Agent-Probe | Article with only original hero still renders a real image | `SELECT count(*) FROM media WHERE sizes_card_filename IS NULL;` then load one such legacy article | The naive `hero.sizes.card.url` direct-access crash trap was avoided | Sample-based only |
| Known-gap | No automated visual regression test | — | — | Same brief-asia-web test-infra gap |

**Area: `brief-asia-web/[pillar]/page.tsx` (Fix #9) + `apcg-cms` `revalidateHooks`/`HEAD` cleanup (Phase 4)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean (both repos) | `npm run typecheck && npm run lint` | No type/lint regression | No behavior |
| Hybrid | P15 — static vs dynamic route confirmation | `next build` in brief-asia-web, check route table for `○ (Static)` vs `ƒ (Dynamic)` on the split route | Whether the `?section=` split restores ISR | Nothing about page content correctness |
| Hybrid | `HEAD` handler returns 200 on media | `curl -sI '<cms>/api/media/file/<name>?prefix=<t>'` → expect 200 after the fix (currently 404 — confirmed live this session: `GET` is exported, `HEAD` is not, in `src/app/(payload)/api/[...slug]/route.ts`) | The new `HEAD` export fixes the crawler/link-checker 404 | Does not prove Vercel's edge cache actually starts HIT-ing as a result |
| Fully-Automated | `revalidateHooks` wiring present | `grep -l "revalidateHooks" src/collections/Authors.ts src/collections/Corrections.ts src/collections/Newsletters.ts src/collections/MarketSnapshots.ts` — all 4 must match | The 4 previously-unhooked collections now wire the hook | Does not prove the hook payload/tag shape is correct |

**Missing test areas (no coverage possible at any tier within this plan's scope):**

| Area | Why untestable in this plan | Resolution chosen |
|---|---|---|
| P10/P8d for Fix #2b/#4 — GCV only | GCV is not present on this machine; the other 4 readers are cleared | Backlog: `p10-other-reader-verification_NOTE_09-09-26.md` (narrowed to GCV) — hard-blocks Fix 2b via E1 and the Phase 3 env-flip |
| Fix #1/#3 automated regression coverage in `brief-asia-web` | No test runner exists in that repo | Backlog: `brief-asia-web-test-harness-bootstrap_NOTE_09-09-26.md` — out of scope for this plan |
| Crawler-control design (Phase 2 conditional branch) | Depends entirely on unrun P2/P2b attribution | Deferred — plan's own Open Questions already tracks this |
| A3's reader-side detection logic (`fetchAllArticleRefs` bail-out) | No test runner in `brief-asia-web` | Enforced from the `apcg-cms` side only (Fully-Automated + Hybrid gates above); if the reader's detection logic itself changes, re-audit |

---

### IV. Plan Updates Applied

**None.** Per session instruction, this VALIDATE pass's write scope was restricted to the `## Validate Contract` section only — no edits were made to the plan body (the `## Additional Contract Locks (A3, A4)` table, `## Reader Fallback Removed`, Touchpoints, Phase tables, or Open Questions). Two corrections found this session are recorded here as findings for a future PLAN-mode edit, not applied inline:
1. The A3 row's invariant wording ("the `view=refs` branch keeps returning `title`") should be corrected to "the `view=refs` branch keeps NOT returning `title`" — the current wording is inverted relative to the actual required behavior and the reader's own detection logic.
2. The "dtw-web audit validity caveat" in Open Questions should be updated to note that the specific delete/modify merge-conflict risk it describes is now closed (origin/main is already merged into the local branch, and `payload.config.ts` does not exist in either branch's current history) — the general commit-pinning statement (valid only at `origin/main` tip `383f83d`) should remain as a standing precondition.

### Execute-agent instructions

| # | Instruction | Trigger condition |
|---|---|---|
| E1 | **Hard block, unchanged in substance, narrower in scope than cycle 0.** P10 has RUN and CLEARED brief-asia-web, wad-web, wtb-web, and dtw-web on all four dropped fields — 0 of 8 refutation attempts succeeded. Do NOT modify `LIST_SELECT` to drop those fields (Fix 2b) until **GCV alone** is also cleared. If GCV cannot be checked this session, Fix 2b remains OUT OF SCOPE. | Before touching `apcg-cms/src/app/api/public/articles/route.ts:39` |
| E2 | Implement Fix #2a as `defaultPopulate` scoping on `ContentEngines.ts`, `Users.ts`, `Tenants.ts` — NOT `depth: 0`, NOT a route-level `select`. Verify the exact Payload 3.85.1 API shape (via `vc-docs-seeker` or `node_modules/payload` type defs) before writing — do not guess from training data. | Before editing `[slug]/route.ts` or any of the 3 collection files |
| E3 | After implementing 2a: run the `depth: 0` grep guard AND the byline/author-preservation Hybrid check (Section III, strengthened this cycle) AND the inline-image checks on a real article, before marking the security fix complete. | Immediately after E2's edit lands |
| E4 | Do not begin ANY Phase 2 code change until `## Phase 0 Results` records real values for P1, P2b, and P3. P2 and P9 alone do NOT satisfy this. | Before any Phase 2 touchpoint edit |
| E5 | Do not begin Phase 3 work until P8a-d are all run, in order, with real command output pasted into the phase report. Write the redirect shim's 302 branch conditional on `process.env.R2_PUBLIC_BASE_URL` being set, so "unset env var + redeploy" is a complete rollback of both halves. Deploy the shim, verify it 302s correctly, THEN flip the env var. Never reverse this order. | Before any Phase 3 touchpoint edit |
| E6 | Fix #1 (and Fix #3) have zero automated test coverage in `brief-asia-web`. "Verified" means: (a) typecheck+lint pass, (b) a live before/after call-count measurement, (c) an Agent-Probe visual check. Do not report either fix as "tested" on typecheck/lint alone. | Before marking Fix #1 or Fix #3 CODE COMPLETE |
| E7 | Fix #5's `unpin-expired` suppression is verified safe for brief-asia-web/wad-web/wtb-web/dtw-web (wtb-web via a standing condition on its `no-store` fetch pattern — re-check if wtb-web ever adds `revalidate` to its home page; re-verified this session that it has not). Do not generalize to **GCV** without running the equivalent check. | Before deploying the `unpin-expired` change |
| E8 | Line numbers in this plan's Touchpoints table were verified within ±10 lines during the prior VALIDATE pass and re-spot-checked this cycle (`Articles.ts:398`, `route.ts:261`, `[slug]/route.ts:36`, `scoped.ts:68`, `ContentEngines.ts:27/76/77/96` all confirmed exact or within tolerance). Re-grep each exact target string immediately before editing regardless. | Every touchpoint edit |
| E9 | Do not, under any circumstances, revive the TTL-raise idea or schedule a `media.url`/`sizes_*_url` backfill. This validate pass re-confirms both bans stand. | Standing instruction, all phases |
| E10 | **New this cycle.** When implementing or reviewing anything touching the `view=refs` branch of `apcg-cms/src/app/api/public/articles/route.ts`, the correct invariant is: the refsView `select` object must NEVER include `title: true`. Do not be misled by the plan body's A3 row wording ("keeps returning title") — that wording is inverted; the Fully-Automated/Hybrid gates in Section III of this contract state the correct direction and are the authoritative check. Flag the plan body wording for correction at the next PLAN-mode touch (see Section IV). | Any edit touching the refsView branch |
| E11 | **New this cycle.** The risk baseline for every reader-facing contract change (Fix #2b, #4, #5, #1) is HIGHER than earlier passes assumed — all 4 audited readers have no local-Payload fallback and no runtime response validation, so a bad change fails silently at HTTP 200. Treat every Hybrid gate in Section III as mandatory, not optional-if-short-on-time, for any of these fixes. | Before marking any reader-facing fix (2b, 4, 5, 1) CODE COMPLETE |

### Backlog artifacts to create during durable capture

| Artifact | Location | What it tracks |
|---|---|---|
| `p10-other-reader-verification_NOTE_09-09-26.md` | `process/general-plans/backlog/` | Narrowed to GCV. brief-asia-web/wad-web/wtb-web/dtw-web audited and CLEARED against origin/main (10-09-26, re-confirmed this cycle). Someone with access to **GCV** must (a) grep for the 4 dropped fields, (b) check `next/image`/`remotePatterns` config. Blocks: Fix 2b, Phase 3 env-flip step. |
| `brief-asia-web-test-harness-bootstrap_NOTE_09-09-26.md` | `process/general-plans/backlog/` | Neither `apcg-cms` nor `brief-asia-web` has a test runner. Recommends bootstrapping a minimal `vitest` setup starting with a `fetch`-mock-based call-count assertion for `getRelatedArticlesCached`. Out of scope for this plan. |
| `wad-web-stale-read-time_NOTE_10-09-26.md` (new) | `process/features/` or general backlog, filed in **wad-web's own tracker, not this repo's** | `wad-web@origin/main:src/lib/article-view.ts:344` reads `.body` off list docs for read-time computation; Central dropped `body` from list responses 04/09 (`5639e41`). Confirmed live this session (`computeReadMin((a as {body?: unknown}).body, a.readMin)`). Pre-existing, not attributable to this plan's Fix #2 (which hasn't shipped). This plan does not fix it — the artifact exists only to ensure it isn't lost, and should be created/tracked in `wad-web`'s own process folder, not `apcg-cms`'s. |

### Known gaps on record

- **P10 (GCV)** — RUN 10-09-26 for the other 4 readers (CLEAR). GCV alone remains un-run. Fix 2b is hard-blocked (E1), not shipped as a known-gap-accepted risk.
- **P8d (GCV)** — RUN for WAD/WTB/DTW (compatible). GCV alone remains the access gap for the Phase 3 env-flip step.
- **No automated regression test for Fix #1/#3's request-volume claims** — `brief-asia-web` has no test runner. Accepted as known-gap; backlog note tracks the follow-up.
- **Payload 3.85.1's exact `defaultPopulate` syntax is unverified against the pinned version** (carried forward, resolved procedurally via E2 — not accepted as a silent gap).
- **Crawler-control design (Phase 2 conditional branch)** has no concrete design yet — depends on unrun P2/P2b attribution.
- **Concurrent-request race on `resolveReadToken`'s memoization Map** — accepted as known-gap (low real-world risk, read-mostly, short TTL).
- **A3's reader-side (`brief-asia-web`) detection logic itself has no test coverage** — enforced from the `apcg-cms` side only; accepted, `brief-asia-web` has no test runner.
- **Retired this cycle (was a CONCERN, now closed, not a residual gap):** the dtw-web merge-conflict caveat is verified stale — `origin/main` is already fully merged into the local branch and `payload.config.ts` exists in neither branch's current tree. The commit-pinning statement itself remains a standing precondition (re-verify if `origin/main` tip moves past `383f83d`).

### What this coverage does NOT prove

- The grep-based `depth: 0`, A3, and A4 guards prove the literal patterns are absent/present in source — they do NOT prove an equivalent regression achieved a different way (a new `select`, a refactor) can't reintroduce the same silent failure.
- Typecheck/lint gates across both repos prove type-safety and lint-cleanliness only — zero runtime behavior, request-count reduction, or byte-saving.
- The Hybrid curl/jq checks for Fix 2a (including this cycle's strengthened byline-preservation assertion) prove the *sampled* article/slug tested is clean — not every article, every locale, every tenant.
- Nothing in this contract proves the September GB/CPU savings projections will materialize at the stated magnitude — P1/P3/P6/P7 remain unrun.
- Nothing in this contract verifies Fix #4's rollback in a real production incident — the rollback drill is staging-only by design.
- **New this cycle:** nothing in this contract independently re-runs the full 13-agent audit's own methodology (this VALIDATE pass spot-checked the audit's underlying facts — branch divergence, file contents at `origin/main` — but did not re-derive the audit's per-repo verdicts from scratch). If the audit's own reasoning contained an error not caught by the spot-checks performed here, this contract would not catch it.
- This contract's A3 correction (E10) fixes the plan's *wording*; it does not add a live regression test in `brief-asia-web` itself (that repo still has no test runner) — the guard is one-sided, enforced only from the `apcg-cms` source.

### Accepted by

Accepted by: session (autonomous PVL cycle 2 re-validate; no separate interactive V5 round-trip occurred within this invocation). The CONDITIONAL items above (Fix #2b/GCV block, test-infra structural gap, raised risk baseline requiring strengthened Hybrid gates on all reader-facing fixes) are recommended for human confirmation before EXECUTE begins on the newly-unblocked Fix 2a; the two phase-level BLOCKs (Phase 2, Phase 3) are not waived by this acceptance and remain hard-gated by the plan's own Phase Completion Rules plus E4/E5.

---

## Autonomous Goal Block

SESSION GOAL: Remediate apcg-cms's August 2026 Vercel egress/CPU cost spike (2.96M req / ~297GB) via measure-first, ranked fixes across apcg-cms + brief-asia-web, without shipping the invalidated TTL-raise or any unverified cross-site breaking change.
Charter + umbrella plan: N/A — single general plan, no umbrella/phase-program.
Autonomy: Per this repo's orchestration.md Autonomy Mode rules. Phase 1 items 2a/#5(partial)/#7/#8 may proceed under standing EXECUTE consent once granted. Phase 2 and Phase 3 remain hard-gated (see Hard stop conditions) — autonomy does not waive plan-encoded temporal gates.
Hard stop conditions / safety constraints:
- Do not ship Fix #2b (drop lastEngine/lastEditedBy/assignedTo/translationStatus from GET /api/public/articles) until P10 is run and recorded for **GCV** (narrowed 10-09-26 — brief-asia-web/wad-web/wtb-web/dtw-web already cleared via a 13-agent audit against origin/main).
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
   - **P10 + P8d update (10-09-26):** brief-asia-web, wad-web, wtb-web, dtw-web are audited and CLEAR against `origin/main` (see `### P10 + P8d` under Phase 0 Results). GCV is the sole remaining gap for Fix 2b (E1) and the Phase 3 env-flip step (P8d) — do not re-run the audit for the other 4 repos, only GCV needs checking now.
   - Before touching Fix #2 or the security finding, re-read the "Security Finding" and "What NOT To Do" #8 sections above — the `depth: 0` trap is easy to reintroduce. Note: the security leak is confirmed still live as of 10-09-26 (see the verification chain at the end of the Security Finding section) — `defaultPopulate` has not shipped yet.
   - Before touching Fix #4, confirm P8a-d have all passed (WAD/WTB/DTW already confirmed; GCV outstanding) and the redirect shim is deployed and verified BEFORE flipping the env var — do not reverse this order.
   - Fix #6 (derivative selection) is DONE upstream in 3 of 4 readers — do not redo it (see Phase 4 table). The separate PNG-conversion sub-item is still open.
   - wtb-web's Fix #5 safety is a standing condition, not structural — re-check if wtb-web ever adds `revalidate` to its home page (see `### P10 + P8d`).
   - A new unrelated defect was found in wad-web (stale card read-times since 04/09) — track it in that repo, not here.
   - dtw-web's audit is only valid at `origin/main` tip `383f83d` — re-run if that repo's `feat/rebrand-phase-4-rendered-copy` branch merges (see Open Questions).
   - Do not, under any circumstances, revive the TTL-raise idea (see banner at top) or schedule a `media.url` backfill (see "What NOT To Do" #7).

---

**Status:** DONE
**Summary:** Wrote the COMPLEX plan artifact consolidating the completed 17-agent verification synthesis into a durable, resumable plan with a Phase 0 blocking measurement gate, the INVALIDATED-TTL banner, the full "What NOT To Do" list, explicit two-repo touchpoints, the security finding flagged at plan severity, honest LOW-confidence labeling, and a resume handoff. No source files were modified in either repo.
**Concerns/Blockers:** None blocking. Two open items worth tracking: (1) the crawler-control Phase 2 branch has no concrete design yet — depends on unrun P2/P2b data; (2) `process/context/all-context.md` is missing from this repo's harness (noted in Open Questions, not resolved).
