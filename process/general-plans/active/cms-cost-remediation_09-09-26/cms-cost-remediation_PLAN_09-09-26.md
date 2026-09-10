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

## Gzip Passthrough — VIABLE (found 10-09-26, becomes Phase 2 priority #1)

See `Touchpoints` (GZIP row) and Phase 2 table for the shipping item. Full detail:

- Feasibility probe on branch `probe/gzip-public-api` (`7384b1f`, one file: `src/lib/public.ts`): gzip-compress `jsonPublic()` at level 6 when the request accepts gzip and body ≥ 1024 B; set `Content-Encoding: gzip` + `Vary: Origin, Accept-Encoding`.
- `GET /api/public/articles?limit=20`: preview gzip wire 12,627 B vs preview identity 107,183 B; production identity 107,463 B; production edge-gzip wire 13,152 B (**8.49× reduction**).
- **Byte-identical pass-through proven:** `gzipSync(identity_body, {level:6})` → 12,627 B, sha256 prefix `2361d14c64b9f1f3`; preview wire bytes → same size, same sha, `Buffer.equals` true including the gzip header. Not double-encoded. Brotli discriminator (production returns `br` for `Accept-Encoding: br, gzip`, preview returns `gzip`) confirms the edge deferred to the function-set encoding instead of transcoding.
- Reader sites need **no change** — Node `fetch` decompresses transparently (verified in probe).
- CPU cost: 0.61 ms/request at level 6 ≈ $0.20-0.51/month across 2.96M requests. Level 6 recommended over L9 (+0.2% ratio for +20% CPU) or L4 (saves ~$0.13 CPU, gives up ~$5 transfer).
- **Cost estimate (medium-high confidence):** Vercel's pricing doc defines Fast Origin Transfer outgoing as "bytes sent as the HTTP Response (Headers & Body)" — the function's emitted bytes. Emitted bytes drop 8.49×. On the $96.48 August FOT line: expect roughly **$96.48 → $11-13**. sin1 FOT rate is $0.27/GB with no free allowance.
- **Mandatory post-deploy verification gate** (cannot be run earlier): within hours of production deploy, Vercel Observability per-route bytes for `/api/public/articles` must fall from ~100 KB/request toward ~13 KB/request. If it does not, the metering assumption is wrong — revert (one-commit revert, no data impact). See `## Verification Evidence`.
- Ranked **Phase 2 priority #1**, ahead of Fix #1 (fan-out collapse): CMS-only, one file, no reader coordination, no GCV dependency, no API-contract change. Ships regardless of the Phase 2 branch-logic outcome (see Phase 2).
- Full detail and raw measurements: `gzip-passthrough_FEASIBILITY_10-09-26.md` (companion artifact, this task folder).

## Gzip's Effect on Fix 2b's Value (found 10-09-26)

Measured on real production data (50 DTW docs): the fields Fix 2b would drop (`tenant` 978 B/doc, `translationStatus` 307 B/doc, `lastEngine`/`lastEditedBy`/`assignedTo`) are the MOST repetitive content in the response, so gzip already collapses them almost for free (`tenant` × 50 = 48,951 B raw → 826 B gzipped).

| | raw | gzipped |
|---|---|---|
| current | 269,135 B | 28,275 B |
| after dropping the 5 fields | 197,135 B | 24,558 B |
| reduction | 26.8% | **13.1%** |

On the $96.48 baseline: gzip alone → ~$10.14; gzip + field-drop → ~$8.80. **Fix 2b's cost value after gzip is ~$1.34/month.** Its remaining justification is data hygiene (not emitting internal fields on a public API) and the PII/secret leak closure (see `## Security Finding`) — those stand on their own; do not over-prioritise 2b on cost grounds going forward. Fix 2b stays blocked on GCV as before (see `E1`).

**P4 is now ANSWERED:** `translationStatus` DOES populate (307 B/doc, all 50 sampled DTW docs).

**New finding:** `article.tenant` is read by **no reader** — confirmed by grep of all four reader repos at `origin/main`; the only hits anywhere are the unrelated `tenant?: string` claim type declared independently in each repo's `api/revalidate/route.ts`.

## Same-Region FOT Reconciliation (found 10-09-26, INFERRED — medium-high confidence)

Vercel's 2024-07-15 changelog states, verbatim: "all data transfer **between edge regions and the origin location** is now automatically compressed." All five projects — apcg-cms and all four readers — pin `regions: ["sin1"]` in `vercel.json`. Reader→CMS calls are therefore same-region: no cross-region edge→origin hop exists to be compressed, and the function's raw emitted bytes are what is metered — consistent with the bill (2.96M × 107 KB ≈ 299 GB ≈ the observed 296.9 GB per-route figure; the compressed-changelog model would predict ~37 GB and does not reconcile).

**Marked INFERRED, medium-high confidence:** three independent lines converge (the changelog's explicit cross-region scoping, the same-region `regions` pin on all five projects, and the bill reconciling only against uncompressed bytes) but no single doc sentence states the same-region exception explicitly. The post-deploy Observability check above (gzip section) is what would empirically confirm or refute this inference.

## What Is Already Fixed (with CORRECTED impact — do not trust the original commit messages' framing)

| Commit | Date | Change | Corrected impact |
|---|---|---|---|
| `7125ab0` | 10/08 | `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` on `/api/media/file/*` (`apcg-cms/src/app/(payload)/api/[...slug]/route.ts:36-39`) | **Possibly ZERO as observed.** Production logs on 31/08 (3 weeks post-commit) still show `x-vercel-cache: MISS`. Cause unconfirmed — a `Set-Cookie` from Payload REST auth refresh, unexpected `Vary`, or a per-deployment `CMS_URL` cold-starting the edge cache are all live candidates. **P9 must run before assuming this commit works.** |
| `5639e41` | 04/09 | `LIST_SELECT = { body: false }` on `/api/public/articles` (`apcg-cms`) | Egress: **108-151 GB/month at current volume** (not the originally claimed 30-50 GB), or 183-220 GB if `translationStatus` populates. Confidence LOW (synthetic model — P3+P4 pin it). Request count: **unchanged** (2.96M untouched). CPU: **probably unchanged** — unverified whether Payload's Postgres adapter omits the column at the query level or fetches+strips it in JS (P14). Timing: landed **after** the August window — do not double-count its saving against the August baseline. |

---

## What NOT To Do (reproduced in full — every item here was proposed and refuted; losing this list means someone re-does dead work)

| # | Do NOT | Why |
|---|---|---|
| 1 | Add `Cache-Control` / `s-maxage` to `apcg-cms/src/lib/public.ts:36-41` (or move the tenant into the URL path and drop `Authorization`, to make the route edge-cacheable) | **Confirmed 10-09-26 by docs + empirical test.** Clause (a): Vercel CDN refuses to cache any request carrying an `Authorization` header — confirmed both by Vercel's own docs (`/docs/caching/cdn-cache`, listed as an unconditional cacheability precondition, stricter than RFC 9111 §3.5) and empirically (production media route probe: with `Authorization` → `x-vercel-cache: BYPASS` three consecutive times; without → `MISS` then `HIT`). Clause (b), reworded: `s-maxage` **is** honoured by Vercel's edge cache (confirmed on a separate route, `s-maxage=300` → `HIT`, `age: 183`) but is **stripped from the client-facing header** — irrelevant here because the Authorization exclusion fires first, so `Vary: Authorization` is moot (the request never reaches the cache-key stage). **New:** moving the tenant into the URL and dropping `Authorization` to unlock caching would open a cache-served auth bypass — a cache hit never re-runs the function's token check. |
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
| `apcg-cms` | `src/lib/public.ts` (`jsonPublic()`) | GZIP | **Phase 2 priority #1.** Gzip-compress `jsonPublic()` responses (Node `zlib.gzipSync`, level 6, when `Accept-Encoding` includes gzip and body ≥1024 B); set `Content-Encoding: gzip` + `Vary: Origin, Accept-Encoding`. Proven VIABLE on branch `probe/gzip-public-api` (commit `7384b1f`) — byte-identical pass-through confirmed (sha256 match, `Buffer.equals` true). |
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
| GZIP post-deploy Observability check: `/api/public/articles` per-route bytes drop from ~100 KB/req toward ~13 KB/req within hours of prod deploy | Hybrid (requires live Vercel Observability access post-deploy) | Confirms the FOT-metering assumption behind the gzip Fast Origin Transfer saving estimate; if it does not fall, revert (one-commit revert, no data impact) |
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

**P3 — RUN 10-09-26 (via gzip feasibility probe, see `gzip-passthrough_FEASIBILITY_10-09-26.md`).** `GET /api/public/articles?limit=20`: **107,463 B identity / 12,578 B gzip.** Metric confirmed as Fast Origin Transfer on **uncompressed (identity) bytes** — this pins the pre-gzip September projection close to the identity figure, not the 108-220 GB synthetic-model range. See Finding 4 (below) for the same-region reconciliation of why FOT meters raw emitted bytes rather than the compressed changelog figure.

**Gate status: PARTIALLY MET — the arbitrating measurement (P2) is complete and Fix #1 ordering is locked; P3 is now also RUN (10-09-26, via the gzip feasibility probe). P1 and P2b remain open and must be recorded before Phase 2 work is considered fully unblocked.**

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

**Arithmetic for Fix #2:** `lastEngine` + `lastEditedBy` alone model at ~874 B/row (~13% of post-fix row). `translationStatus`, if populated (19 rows in the sample), models at ~11.6 KB/row — potentially a **larger cut than `5639e41` itself**. Applied to a 108-220 GB September baseline: somewhere between 14 GB and 120 GB saved. **Superseded 10-09-26 by the gzip finding above:** `translationStatus` is now confirmed to populate (P4 answered — 307 B/doc across all 50 sampled DTW docs), but once gzip ships, Fix 2b's raw/gzipped delta measured on real production data is only 26.8% raw / **13.1% gzipped**, worth roughly **$1.34/month** on the $96.48 baseline — not the 14-120 GB range estimated pre-gzip. Fix 2b's remaining justification is data hygiene + the PII/secret leak (Fix 2a), not this cost arithmetic.

---

## Phase 2 — Conditioned on Phase 0 Results (DO NOT START before Phase 0 exit condition is met)

Branch logic — select based on Phase 0 Results:

**Gzip ships regardless of Phase 0 branch outcome** — it is CMS-only, VIABLE (see Touchpoints, GZIP row), and does not depend on `r` or any fan-out/crawler/churn causal story. It ranks #1 in the Phase 2 table above independent of the branch chosen below.

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
| **Gzip-compress `jsonPublic()` responses (PRIORITY #1 — VIABLE, code exists)** | GZIP | `apcg-cms` | `src/lib/public.ts` — gzip at level 6 when `Accept-Encoding` includes gzip and body ≥1024 B; `Content-Encoding: gzip` + `Vary: Origin, Accept-Encoding`. Proven on `probe/gzip-public-api` (`7384b1f`): 12,627 B gzip wire vs 107,183 B identity (8.49× reduction) on `GET /api/public/articles?limit=20`, byte-identical decompressed body (sha256 match). CPU cost 0.61 ms/req ≈ $0.20-0.51/month at 2.96M req. | Estimated $96.48 → ~$11-13/month on the August Fast Origin Transfer line (medium-high confidence — Vercel's FOT metric is defined as emitted response bytes; see Finding 4 for the same-region reconciliation). Mandatory post-deploy Observability verification gate (see Verification Evidence) — revert (one commit) if bytes don't fall as predicted. | **Low** — one file, no reader coordination, no GCV dependency, no API-contract change; readers need no change (Node `fetch` decompresses transparently, verified in probe) | None — CMS-only, ships independently of Phase 0 branch logic |
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

- **This plan's `## Validate Contract` (cycle 2, dated 10-09-26) predates the gzip touchpoint** (Finding added same day, after the contract was written). VALIDATE must be re-run for the gzip touchpoint (`src/lib/public.ts` / `probe/gzip-public-api`) before it is treated as CODE COMPLETE / ready for merge — it has not gone through a PVL pass yet.
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
supersedes: 2026-09-10 (outer-pvl) — cycle 2 contract (same calendar day) predated the gzip touchpoint finding (added after cycle 2's contract was written) and the PR #11 merge; this contract replaces it wholesale. Scope this cycle: the gzip touchpoint (`src/lib/public.ts`) plus re-verification of E1/A3/A4/depth:0 against the current tree (post PR #11).

### Net Gate

**Gate: CONDITIONAL**

**SHIP / NO-SHIP (gzip merge to `main`): SHIP — after stripping the PROBE-ONLY `X-Origin-Encoded` debug header (1-line diff, see new Infra finding below). No FAIL found anywhere in the gzip touchpoint. All four static contract guards (E1 exclusion-mode `LIST_SELECT`, A3 refsView-no-title, A4 pin-keys-present, depth:0-not-reintroduced) independently re-verified PASS on the current tree, post-PR-#11-merge — the video route addition does not touch any of them.**

0 FAILs at the whole-plan level. This cycle is scope-expansion, not gap-closure: cycle 2's 4 standing CONCERNs (GCV block on Fix 2b, no-test-runner, raised risk baseline, A3 body wording — E10) are unchanged and carried forward untouched (see Section I). One genuinely new item was found this cycle: the gzip branch still ships a PROBE-ONLY telemetry header (`X-Origin-Encoded`) that the code's own comment says to remove before shipping — nobody did. This is not a functional defect (it doesn't break decoding, CORS, or caching) and is a trivial pre-merge fix, so it is recorded as a CONCERN with an execute-agent instruction (E12), not a FAIL. Net effect: gzip itself is otherwise clean — byte-identical pass-through re-confirmed against the exact code being merged (public.ts is unchanged since the measured commit `7384b1f`; only two later commits touched the plan doc and merged `main`), and PR #11's video-route changes do not disturb any existing contract lock.

### Per-Phase Gate (gzip carve-out added; everything else unchanged in shape from cycle 2)

| Phase | Gate | Why |
|---|---|---|
| Phase 0 (measure) | CONDITIONAL — proceed, **P3 now RUN** | Plan body's own `## Phase 0 Results` (re-read this session) shows P3 moved from NOT-RUN to RUN via the gzip feasibility probe (107,463 B identity / 12,578 B gzip on `limit=20`). P1 and P2b remain the only two still-open Phase 0 items. This corrects cycle 2's per-phase-gate text, which still said "P1/P2b/P3 still NOT RUN" — that line was stale the moment the gzip supplement landed the same day. |
| Phase 1 (risk-independent fixes) | CONDITIONAL — unchanged | Not in scope for this cycle's re-validation; Fix #2a GO / Fix #2b GCV-blocked status carried forward verbatim from cycle 2, not re-derived here. |
| Phase 2 (conditioned fixes) | **BLOCKED for Fix #1/#3/crawler-control — GZIP CARVE-OUT: startable/mergeable now** | Gzip needs no Phase 0 arbitration (plan's own text: "ships regardless of the Phase 2 branch-logic outcome") and no reader coordination, no GCV dependency, no API-contract change — it is the one Phase 2 item cleared to ship independent of the P1/P2b gate. Fix #1 (fan-out collapse) and Fix #3 (search) remain hard-blocked on P1/P2b per the plan's own Phase Completion Rule — unchanged, not softened by this cycle. |
| Phase 3 (R2 cutover) | **BLOCKED — do not start** | Unchanged. P8a-c still NOT RUN; no R2 domain attached. Not touched by this cycle's scope. |
| Phase 4 (cleanup) | CONDITIONAL — unchanged | Not in scope for this cycle's re-validation; carried forward from cycle 2. |

### Parallel strategy

Unchanged from cycle 2 for Phases 0/1/3/4 — re-confirmed, not re-derived, since nothing in this cycle changed those phases' file-disjointness or risk shape. New row added for the gzip item.

| Phase / Item | Strategy | Agent count | Rationale |
|---|---|---|---|
| Gzip touchpoint (this cycle's scope) | Sequential (1 agent) | 1 | Single file, single mechanism, already empirically proven — no fan-out benefit; the only remaining work is a 1-line debug-header strip plus a post-deploy Observability read. |
| Phase 0 remaining (P1, P2b) | Sequential (1 agent, agent-probe/hybrid) | 1 | Unchanged — dashboard reads, no parallelization benefit. |
| Phase 1 (Fix #2a, #5-partial, #7, #8) | Parallel subagents | 4 | Unchanged from cycle 2 — disjoint files, fire-and-forget fan-out. |
| Phase 2 (Fix #1/#3, once P1/P2b land) | Sequential (1 agent) | 1 | Unchanged — branch logic selects exactly one priority path. |
| Phase 3 (R2 cutover) | Sequential, single agent, manual-first | 1 | Unchanged. |
| Phase 4 (cleanup) | Parallel subagents | 2-3 | Unchanged from cycle 2. |

Signals present: S2 (public API surface, transport-layer this time, not schema) · S6 (public API high-risk class — transport change to every `/api/public/*` response; deploy/gateway-adjacent since it changes wire bytes) · S7 (~20 files across 2 repos, whole-plan blast radius; gzip itself is 1 file) = **3/7 for the gzip item specifically** (whole-plan score remains 5/7 per cycle 2, unchanged, since this cycle does not touch the whole-plan blast radius). Dominant signal for the gzip item: S6 — a public API response transport change, low-risk in isolation (one file, no reader coordination) but touching every `/api/public/*` route.

---

### I. Validation Findings

**Layer 1 — Dimension Findings**

**Infra / Setup Fit**

| Finding | Severity | Proposed fix |
|---|---|---|
| **PR #11 re-verification (live, this session).** `origin/main` (now this branch's base, `d12befd`) landed article video support: `LIST_SELECT` in `src/app/api/public/articles/route.ts:46-52` extended with four `video*: false` keys (`video`, `videoCaption`, `videoCredit`, `videoDescription`) using the exact same exclusion mechanism Fix 2b will eventually use — confirmed by direct read, not re-quoted from the report. `[slug]/route.ts:46` now builds `responseDoc = { ...doc, video: resolveArticleVideo(doc) }` and passes it through `jsonPublic` at line 47 — confirmed this flows through the gzip branch unchanged (no video-specific casing in `jsonPublic`). New migration `20260910_000000_add_video_support.ts` exists in `src/migrations/` (commit `a165ce6`) — additive/nullable schema only, and per session instruction this is **not** a new DDL risk for merging *this* branch: it already shipped and ran via PR #11's own `vercel-build` → `migrate-prod.mjs` deploy path on `main`, independent of and prior to this gzip merge. | ✅ PASS (re-verified live, not assumed) | No action — informational re-confirmation |
| **E1 re-verified: `LIST_SELECT` still exclusion-mode, still omits none of `lastEngine`/`lastEditedBy`/`assignedTo`/`translationStatus`** — Fix 2b has NOT shipped. Confirmed by direct read of the current `LIST_SELECT` object (5 keys: `body`, `video`, `videoCaption`, `videoCredit`, `videoDescription` — all `false`; none of the four PII/hygiene fields present). | ✅ PASS | No action — E1 hard-block remains correctly unbreached |
| **A3 re-verified: refsView `select` still has no `title`** — `select: refsView ? { slug: true, updatedAt: true, publishedAt: true } : LIST_SELECT` at `route.ts:275-277`, confirmed unchanged since cycle 2. | ✅ PASS | No action |
| **A4 re-verified: `pinnedToLatest`/`pinnedUntil` still list keys** — `LIST_SELECT` does not name either field in its exclusion set, so both remain implicitly included on list docs. Confirmed unchanged. | ✅ PASS | No action |
| **`depth: 0` guard re-verified: `[slug]/route.ts:37` is still `depth: 2`**, not reintroduced as `0`. Confirmed unchanged, and confirmed the video spread (`{ ...doc, video: ... }`) happens *after* the `depth: 2` fetch, so it does not interact with the guard. | ✅ PASS | No action |
| **New this cycle — gzip branch ships a PROBE-ONLY debug header that its own comment says to remove.** `src/lib/public.ts` sets `headers["X-Origin-Encoded"] = \`gzip;l=${GZIP_LEVEL};in=${raw.byteLength};out=${gz.byteLength}\`` on every gzip-compressed response, directly under a comment reading "PROBE-ONLY telemetry: proves this code path ran... Remove before shipping." It was not removed before this merge review. Not a functional defect (does not affect decoding, CORS, or the `Vary` merge) and not a secret leak (byte counts are already derivable from `Content-Length`), but it is dead debug surface area shipping to a public API forever unless removed, and it directly contradicts its own inline instruction. | **CONCERN (new)** | Strip the `X-Origin-Encoded` header assignment (and, optionally, the `PROBE (branch probe/gzip-public-api)` doc-comment header, which is now stale prose since this is merging to `main`) before or immediately at merge — see E12. One-line diff, no behavioral change. |
| **`Vary` merge re-verified — does not clobber `corsHeaders()`'s `Vary: Origin`.** The gzip branch explicitly reassigns `headers.Vary = "Origin, Accept-Encoding"` (not appended, not dropped) — confirmed by direct read; the non-gzip branch (identity, or sub-threshold) returns the object built from `corsHeaders()` unmodified, i.e. `Vary: Origin` only, matching pre-diff behavior exactly. | ✅ PASS | No action |
| **Transport-only re-verified — JSON payload contract unchanged.** `jsonPublic` still receives the same `body: unknown` and calls `JSON.stringify(body)` first; the gzip/identity branch only changes how those bytes leave the function, never their content. A caller sending `Accept-Encoding: identity` (or no header) gets `raw` (the same `Buffer.from(json, "utf8")`) with the same headers shape as before this diff — confirmed byte-for-byte equivalent to pre-diff `jsonPublic` for that path. | ✅ PASS | No action |
| Local environment note (not a code defect, not part of this diff): this working tree's git-ignored `src/payload-types.ts` was stale from before PR #11's video collection landed, causing a false-positive `tsc --noEmit` failure (`videoMedia` not assignable) on first run this session. Regenerated via `npm run payload:generate-types` (a local, gitignored artifact — not a git-tracked change); `tsc --noEmit` is clean after regeneration. Confirmed via a disposable worktree of `main` (no `payload-types.ts` present at all there) that `payload.config.ts` and `Articles.ts` are byte-identical between `main` and this branch — the stale-types issue was purely local-checkout staleness, not a code regression introduced by either PR #11 or this branch. | ✅ PASS (informational — flagging so a fresh EXECUTE/EVL session doesn't re-derive this from scratch) | Execute-agent should run `npm run payload:generate-types` once after any Payload collection/schema change lands locally, before trusting `typecheck` — see E13 |

**Test Coverage**

| Finding | Severity | Proposed fix |
|---|---|---|
| Re-confirmed, unchanged: neither `apcg-cms` nor `brief-asia-web` has a test runner. `apcg-cms/package.json` scripts list confirmed this session: only `lint` (`next lint`) and `typecheck` (`tsc --noEmit`); no jest/vitest/playwright script or config. | CONCERN (structural, unfixable within this plan's scope, unchanged from cycles 0-2) | Unchanged: all gzip behavioral gates are Hybrid/Agent-Probe. See Section III. |
| **`npm run typecheck && npm run lint` re-run live this session on the current tree (post PR #11 merge, post gzip diff): both PASS.** Lint: 0 warnings in any touched file (`src/lib/public.ts` clean); all warnings are in `src/migrations/*` (pre-existing, unrelated). | ✅ PASS (freshly re-run, not assumed from the prior EVL cycle) | Carry into Section III as the Fully-Automated gate for this cycle |
| E10 (A3 body wording inverted) — **still open, not fixed by this cycle's supplement.** Per session instruction, this is not this cycle's job; flagging again per instruction so it is not lost, and it does not block the gzip ship decision (it concerns the plan body's prose, not the refsView `select` object, which is independently confirmed correct above). | CONCERN (carried forward, unchanged in substance from cycle 2) | Standing instruction E10 (unchanged) — fix at next PLAN-mode touch of the plan body |

**Breaking Changes**

| Finding | Severity | Proposed fix |
|---|---|---|
| **Gzip is transport-only — re-confirmed no JSON contract change.** See Infra findings above (Vary merge, payload equivalence). No `Public Contracts` section entry needs updating for the gzip item's response *shape*; only the wire encoding changes, and only for callers that opt in via `Accept-Encoding`. | ✅ PASS | No action; note for a future PLAN-mode touch that the `## Public Contracts` section could optionally mention the new `Content-Encoding`/`Vary` behavior for completeness, but it is not a contract-breaking change |
| **PR #11's `LIST_SELECT` extension and `[slug]` video spread re-verified as non-breaking for this plan's existing locks.** Neither addition touches `lastEngine`/`lastEditedBy`/`assignedTo`/`translationStatus` (Fix 2b's set), `title` (A3), or `pinnedToLatest`/`pinnedUntil` (A4). The new `video` key on the `[slug]` response is additive — no reader currently expects its absence, and readers ignore unknown keys (standard `{ ...doc, video }` spread, no destructuring elsewhere in this codepath that would break on an extra field). | ✅ PASS (new finding this cycle, not previously assessed since PR #11 landed after cycle 1) | No action |
| Fix #2b/GCV block (E1), A3 wording defect (E10), and the raised reader-risk baseline are unchanged from cycle 2 — not re-litigated here, out of this cycle's scope. | CONCERN (carried forward, unchanged) | See cycle 2's findings verbatim; no new evidence gathered this cycle |

**Security Surface**

| Finding | Severity | Proposed fix |
|---|---|---|
| **Gzip introduces no new PII/secret exposure.** The security finding (staff-identity/session-adjacent fields, `ContentEngines` secrets) concerns which *fields* are returned, not how the response bytes are transported — gzip changes only the latter. Re-confirmed the leak's diagnosis is unchanged and still live (Fix 2a still not shipped) — this is carried forward, not re-derived, since it is out of this cycle's scope. | ✅ PASS for the gzip item specifically; CONCERN carried forward for the still-open leak itself (unchanged from cycle 2, Fix 2a not yet EXECUTEd) | No new action from gzip; existing E1/E2/E3 stand |
| **`X-Origin-Encoded` header is not a secret leak** — reviewed explicitly given the security-surface lens: it exposes only `level` (a constant, `6`), `in`/`out` byte counts (already derivable from `Content-Length` on the gzip response and from the identity response's own `Content-Length`), and confirms compression occurred (already visible via the `Content-Encoding: gzip` header it sits next to). No token, tenant, or user-identifying data. Classified as dead debug surface (see Infra finding above), not a security defect. | ✅ PASS (explicitly ruled out, not assumed) | Still recommend removal per E12, for hygiene — not required for security clearance |
| Client-decompression / failure-mode review (per task instruction, scrutinized explicitly this cycle): (a) a client that cannot decompress — mitigated because gzip only activates when the caller's own `Accept-Encoding` header opts in (honors `gzip;q=0`, defaults to identity when absent) — a client is never forced into an encoding it didn't request; the four audited readers are confirmed Node-`fetch`-based (transparent auto-decompression, verified in the FEASIBILITY probe); GCV is unverified but carries the same structural safety (opt-in only) — this is the same standing GCV gap as E1/P10/P8d, not a new risk. (b) a proxy/monitor that reads the body as text without decompressing — this is a pre-existing HTTP-contract risk already present today, since Vercel's edge *already* returns `content-encoding: gzip` for any caller sending `Accept-Encoding: gzip` against production (confirmed in the FEASIBILITY probe's control measurements) — this diff moves *where* the compression happens, it does not introduce a new class of client incompatibility. (c) sub-1024B path — verified by direct code read (`raw.byteLength < GZIP_MIN_BYTES` returns the uncompressed branch) and by the FEASIBILITY probe's own local test (36 B 401 envelope: `content-encoding` absent, valid uncompressed JSON). | ✅ PASS on (a) and (c) (mechanically verified); (b) is an accepted pre-existing class of risk, not new | Known-gap: GCV live pass-through unverified (same standing gap as E1) — see Known Gaps |

---

**Layer 2 — Per-Section Feasibility**

**Section: Gzip touchpoint — `apcg-cms/src/lib/public.ts` (`jsonPublic`)**

| Question | Verdict | Detail |
|---|---|---|
| Mechanical feasibility | PASS | Diff already merged into this branch (commit `7384b1f`, unchanged since); `git diff main..HEAD --stat` confirms only `src/lib/public.ts` (56 insertions / 4 deletions) plus two documentation-only files. Nothing left to "write" — this is a re-validate of code that already exists and was already feasibility-probed on a live preview. |
| Plan gaps | One found: the PROBE-ONLY debug header was never stripped (see Infra/Security findings above). No other gap found — the touchpoint's own plan section (`## Gzip Passthrough — VIABLE`) already documents the mandatory post-deploy Observability gate, the CPU cost, and the "reader sites need no change" claim; all three were independently re-checked this cycle (see Section III and the CPU-estimate row) and hold. | See E12 |
| Conflicts | None found. PR #11's video-route changes and the gzip diff are non-overlapping in `public.ts` (PR #11 touched only the two route files, not `public.ts`'s `jsonPublic`/`corsHeaders`) — confirmed via `git diff main..HEAD --stat -- payload.config.ts src/collections/Articles.ts` returning empty against the pre-merge probe point, and via direct read of the current `public.ts` showing no video-specific logic. |
| Highest-risk edit + mitigation | The `X-Origin-Encoded` header left in place is the single most likely "someone forgot to clean this up" ship regret. Mitigation: E12 (strip before/at merge — trivial, no behavior change, no redeploy risk beyond a normal one-line commit). |

**Phase 0 / 1 / 3 / 4 (not in this cycle's scope — carried forward from cycle 2 verbatim, not re-run)**

| Phase | Verdict | Detail |
|---|---|---|
| Phase 0 — Measure | PASS (unchanged) | Zero code change; P3 additionally confirmed RUN this session by re-reading the plan's own `## Phase 0 Results` (not independently re-measured — that measurement is the gzip FEASIBILITY probe's own P3 row, already on record). |
| Phase 1 — Risk-independent fixes | Not re-verified this cycle — carried forward from cycle 2 (Fix #2a GO, Fix #2b GCV-blocked) | Out of this cycle's scope |
| Phase 2 — Conditioned fixes | Gzip item: PASS (see above). Fix #1/#3/crawler-control: BLOCKED, unchanged (P1/P2b still open) | — |
| Phase 3 — R2 cutover | BLOCKED (unchanged) | Not touched this cycle |
| Phase 4 — Cleanup | Not re-verified this cycle — carried forward from cycle 2 | Out of this cycle's scope |

---

### II. Net Gate Derivation

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (1 new this cycle: `X-Origin-Encoded` debug header left in — trivial, mitigated by E12; all other findings this cycle are PASS re-confirmations; standing cycle-2 CONCERNs on `defaultPopulate`/raised-risk-baseline unchanged, out of this cycle's scope but still open) |
| Test coverage | CONCERN (no test runner — structural, unchanged; E10 A3-wording defect still open, unchanged; gzip's own typecheck+lint gates freshly re-run and PASS) |
| Breaking changes | ✅ PASS for the gzip item and for PR #11's re-verified non-interference with E1/A3/A4; CONCERN carried forward, unchanged, for Fix 2b/GCV (out of this cycle's scope) |
| Security surface | ✅ PASS for the gzip item (no new PII/secret exposure; debug header explicitly ruled out as a leak); CONCERN carried forward, unchanged, for the still-open Fix 2a leak itself (out of this cycle's scope) |

| Layer 2 sections | Status |
|---|---|
| Gzip touchpoint (`src/lib/public.ts`) | CONCERN (1 trivial, non-blocking: debug header — E12) |
| Phase 0 — Measure | PASS (P3 now additionally confirmed RUN) |
| Phase 1 — Risk-independent fixes | CONDITIONAL (carried forward, unchanged, not this cycle's scope) |
| Phase 2 — Conditioned fixes | Split: gzip item PASS/startable; Fix #1/#3/crawler-control BLOCKED (temporal, unchanged) |
| Phase 3 — R2 cutover | BLOCKED (temporal, unchanged) |
| Phase 4 — Cleanup | Not re-verified this cycle (carried forward CONDITIONAL from cycle 2) |

**Totals this cycle's scope: 0 FAILs / 1 new CONCERN (debug header, trivial) / 4 standing CONCERNs carried forward unchanged (GCV block, no-test-runner, raised-risk-baseline, E10 wording) / multiple PASS re-confirmations (E1, A3, A4, depth:0, Vary-merge, payload-equivalence, PR#11-non-interference, debug-header-not-a-secret-leak).**

**→ Net Gate: CONDITIONAL.** The gzip touchpoint itself has **0 FAILs and exactly 1 trivial CONCERN** (the debug header), which is why the SHIP recommendation above is unambiguous and not softened. The whole-plan Net Gate stays CONDITIONAL rather than moving to PASS because (a) this cycle's scope is deliberately narrow (gzip + PR #11 re-verification) and does not re-touch or resolve the 4 standing whole-plan CONCERNs from cycle 2, and (b) per the net-gate vacuous-green ban, the gzip item's own single most consequential claim — that the FOT dollar saving actually materializes — rests entirely on a Hybrid, post-deploy-only Observability gate that cannot be run before merge; a plan cannot claim a terminal PASS on a behavior whose only proof is Known-Gap-until-deploy. This is a scheduling fact, not a defect: the gate is written, named, and mandatory (Section III), and its failure mode is a cheap one-commit revert.

---

### III. Test Coverage Plan

**Area: `apcg-cms/src/lib/public.ts` (GZIP touchpoint, Phase 2 priority #1)**

| Tier | Scenario | Command / Steps | What it proves | What it does NOT prove |
|---|---|---|---|---|
| Fully-Automated | Typecheck/lint clean | `npm run typecheck && npm run lint` (apcg-cms) exits 0 — **re-run live this session, both PASS; 0 warnings in `src/lib/public.ts`, all lint warnings confined to `src/migrations/*`** | No type/lint regression from the gzip diff or PR #11's video changes | No runtime encoding/decoding behavior |
| | | `Failing stub:` `test("should typecheck and lint clean with gzip jsonPublic", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: gzip typecheck/lint clean") })` | | |
| Fully-Automated | Min-size threshold constant present | `grep -n "GZIP_MIN_BYTES = 1024" src/lib/public.ts` exits 0 — **confirmed present this session** | The sub-1024B exemption path exists in source, unchanged | Does not prove the branch is taken correctly at runtime — see Hybrid row below |
| | | `Failing stub:` `test("should exempt bodies under 1024 bytes from gzip", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: GZIP_MIN_BYTES threshold") })` | | |
| Fully-Automated | `Vary` merge lists both dimensions on the gzip branch | `grep -n 'headers.Vary = "Origin, Accept-Encoding"' src/lib/public.ts` exits 0 — **confirmed present this session** | The gzip branch's `Vary` reassignment still names `Origin` (does not silently regress to `Accept-Encoding`-only, which would break the CORS cache-key contract) | Does not prove the identity branch's `Vary: Origin` (from `corsHeaders()`, untouched) is also correct at runtime — covered by the identity-path Hybrid row below |
| | | `Failing stub:` `test("should merge Vary: Origin, Accept-Encoding on the gzip branch without dropping Origin", () => { throw new Error("NOT IMPLEMENTED — TDD stub for: Vary header merge") })` | | |
| Hybrid (preview, runnable now) | Live gzip pass-through on the exact merging code | `curl -sD- -o /dev/null -H "Authorization: Bearer $CMS_READ_TOKEN" -H "x-vercel-protection-bypass: $BYPASS_SECRET" -H "Accept-Encoding: gzip" "https://apcg-cx8nj2p1a-apcg.vercel.app/api/public/articles?limit=20"` → expect single-valued `content-encoding: gzip`, `vary` containing both `Origin` and `Accept-Encoding` — precondition: preview reachable, bypass secret held by orchestrator (not required for this agent to run) | Confirms the FEASIBILITY probe's pass-through result still holds on the current preview build (unchanged since commit `7384b1f`) | Production edge software may differ from preview at the margin — see the mandatory post-deploy row below |
| Hybrid (preview, runnable now) | Identity path unchanged | Same curl with `-H "Accept-Encoding: identity"` → expect valid JSON, no `content-encoding` header | Old (pre-diff) behavior preserved for identity callers | Only samples one endpoint (`/api/public/articles`) — all `/api/public/*` routes share `jsonPublic`, not independently curled here |
| Hybrid | Byte-identical round-trip (already measured; re-cite, not re-derive) | `zlib.gzipSync(identity_body, {level:6})` → sha256 `2361d14c64b9f1f3…`, 12,627 B; preview wire bytes → same size, same sha, `Buffer.equals` true — **measured against commit `7384b1f`, which `git log` confirms is still the tip of `src/lib/public.ts`'s history (no further edits to this file since)** | The exact code being merged, not a stale or superseded version, produces byte-identical pass-through | Does not re-run the measurement against the `[slug]` route's new video-spread response specifically — same `jsonPublic` function, no video-specific branch, so mechanically identical, but not independently curled this session |
| Hybrid | Sub-1024B path stays uncompressed | `curl` a known short-circuit response (e.g. an unauthorized/empty envelope, ~36-98 B per the plan's own measurements) with `Accept-Encoding: gzip` → expect no `content-encoding` header | The threshold logic holds for real short responses, not just the constant's presence in source | Sample of 1-2 known short responses, not exhaustive |
| Hybrid — **MANDATORY, cannot run before merge** | Post-deploy Observability confirmation | Within hours of production deploy, read Vercel Observability's per-route bytes for `/api/public/articles`: must fall from ~100 KB/request toward ~13 KB/request. **If it does not fall as predicted: revert (one-commit revert, no data impact).** | Confirms the FOT-metering assumption (same-region reconciliation, medium-high confidence per the FEASIBILITY doc) that the entire dollar-saving case rests on | Cannot be obtained pre-merge — this is the single gate this contract cannot close before shipping, which is why the net gate is CONDITIONAL, not PASS (see II) |
| Agent-Probe | CPU/memory at maximum response size (limit=50, largest allowed non-refsView response) | Extrapolate from two independently measured real data points: the CPU benchmark (0.61 ms @ 107,463 B body, level 6) and the Fix-2b table's real 50-doc production body (269,135 B raw / 28,275 B gzipped) — ratio 269,135/107,463 ≈ 2.5×, so estimated ≈1.5 ms/request at the largest allowed size | The worst-case per-request CPU cost stays sub-2ms — not a real constraint at any response size this API serves | This is an extrapolation from two real measurements, not a third live measurement at limit=50 with `Accept-Encoding: gzip` — would need one more curl+time sample to convert to a Hybrid-tier proof |
| Known-Gap | GCV live pass-through | — | Node-`fetch`-based clients decompress transparently by construction (verified for the 4 audited readers); GCV is not on this machine — same standing gap as E1/P10/P8d, not a new gzip-specific risk | Accepted — GCV's opt-in-only gzip activation means worst case is "GCV never sends `Accept-Encoding: gzip`," which is safe by construction, not a silent failure mode |
| Known-Gap | Proxy/monitor client that requests gzip but reads the body as text | — | This is a pre-existing HTTP-contract risk already live today (production's edge already gzips on request) — this diff relocates where compression happens, it does not create this risk class | Accepted — no new mitigation needed beyond what already exists |

**High-risk class table (mandatory hybrid minimum per protocol):**

| Area | High-risk class | Minimum tier | Gap rationale if known-gap accepted |
|---|---|---|---|
| Gzip touchpoint (`src/lib/public.ts`) | public API contract change (transport-layer) + deploy/gateway-adjacent (changes wire bytes on every `/api/public/*` response) | Hybrid | Covered above (preview curls, byte-identity re-cite, mandatory post-deploy Observability gate). GCV known-gap accepted per rationale above — opt-in-only design makes the worst case safe-by-construction, not silent. |

**Missing test areas (no coverage possible at any tier within this plan's scope):**

| Area | Why untestable in this plan | Resolution chosen |
|---|---|---|
| Post-deploy Observability FOT-drop confirmation | Cannot be measured before a real production deploy exists | Resolution: mandatory post-deploy Hybrid gate (above), one-commit revert if it fails — not a known-gap, a scheduled gate |
| GCV gzip pass-through | GCV is not present on this machine | Known-gap, accepted per rationale above (opt-in-only design is safe-by-construction) |

---

### IV. Plan Updates Applied

**None.** Per session instruction, this VALIDATE pass's write scope is restricted to the `## Validate Contract` section only — no edits were made to the plan body. Two items are flagged here for a future PLAN-mode touch, in addition to the two carried forward from cycle 2 (Section IV of the superseded contract, both still unresolved — the A3 wording inversion, E10; and the now-stale dtw-web merge-conflict caveat, already downgraded to closed in cycle 2's own text):

1. **New this cycle:** the plan body's `## Phase 0 Results` section already correctly shows P3 as RUN, but this cycle's superseded contract (cycle 2) still said "P1/P2b/P3 still NOT RUN" in its per-phase gate table — that line was already stale the day it was written (the gzip supplement landed the same session). This new contract corrects it (see Per-Phase Gate table above); no plan-body edit is needed since the plan body itself was already correct.
2. **New this cycle:** the plan's `## Autonomous Goal Block` and `## Resume and Execution Handoff` sections still reference "Validate contract: inline in this plan file... (Gate: CONDITIONAL, generated-by: outer-pvl, dated 09-09-26)" — the cycle-0 date. This is now two contracts stale (cycles 1, 2, and this one all postdate it). Per this session's write-scope restriction (`## Validate Contract` section only), these are not updated here — flag for the next PLAN-mode touch to refresh both sections' contract references and the gzip-specific "Next step" language (the gzip item is now validated, not merely "found VIABLE").

### Execute-agent instructions

Carried forward unchanged from cycle 2 (not reproduced verbatim here to avoid drift — see the superseded cycle-2 contract in this plan's git history / the immediately-preceding version of this section for the full text): **E1–E11 all still apply exactly as written.** E1 (Fix 2b GCV hard-block) and E9 (never revive TTL-raise / media.url backfill) are the two most load-bearing for anyone resuming this plan. New this cycle:

| # | Instruction | Trigger condition |
|---|---|---|
| E12 | **New.** Strip the `X-Origin-Encoded` header assignment in `src/lib/public.ts`'s `jsonPublic` (the line reading `headers["X-Origin-Encoded"] = \`gzip;l=...\`;`) before or immediately at merging this branch to `main`. Its own comment says "Remove before shipping" — do it. One-line diff, no behavior change, no re-test needed beyond typecheck/lint. Optionally also trim the stale "PROBE (branch probe/gzip-public-api)" doc-comment header above `GZIP_LEVEL`, since this is no longer a probe branch once merged. | Before or at merge to `main` |
| E13 | **New.** After merging, run the mandatory post-deploy Observability gate (Section III) within hours of the production deploy. If `/api/public/articles` per-route bytes do NOT fall from ~100 KB/request toward ~13 KB/request: revert with a single commit (no data impact) — do not attempt to "fix forward" the metering assumption before reverting. | Within hours of production deploy of this touchpoint |
| E14 | **New.** If a future Payload collection/schema/field change lands (as PR #11's video support did), regenerate `src/payload-types.ts` (`npm run payload:generate-types`) before trusting a `tsc --noEmit` result — this is a git-ignored local artifact that goes stale silently and produces false-positive typecheck failures unrelated to any real code defect (see the Infra finding this cycle). | Before trusting `typecheck` after any Payload schema/collection change |
| E15 | **New, clarifying, not a new block.** Phase 0's P3 is now RUN (see Per-Phase Gate table). The only two remaining Phase 0 blockers for Fix #1/#3 (Phase 2, non-gzip items) are P1 and P2b — E4 (unchanged) still correctly names all three, but P3 specifically is now satisfied. Do not re-run P3; only P1 and P2b remain open. | Before starting Fix #1 or Fix #3 |

### Backlog artifacts to create during durable capture

Unchanged from cycle 2 — no new backlog artifact needed for the gzip item (its durable evidence already lives in the companion `gzip-passthrough_FEASIBILITY_10-09-26.md` artifact in this task folder, which is sufficient; no additional NOTE file needed).

### Known gaps on record

Carried forward from cycle 2 unchanged: P10(GCV)/P8d(GCV) block on Fix 2b and the Phase 3 env-flip; no automated regression test for Fix #1/#3; Payload 3.85.1's exact `defaultPopulate` syntax unverified (procedurally resolved via E2); crawler-control design undecided; `resolveReadToken` concurrent-request race (accepted, low risk); A3's reader-side detection logic has no test coverage (accepted). New this cycle:

- **Post-deploy Observability FOT-drop confirmation** — cannot be measured before a real production deploy; scheduled as a mandatory Hybrid gate (E13), not accepted as a silent gap.
- **GCV gzip pass-through** — GCV is not present on this machine; accepted as known-gap because the design is opt-in-only (a client that never sends `Accept-Encoding: gzip` is safe by construction, not silently broken) — same risk shape as the existing GCV gaps, not a new class of exposure.
- **CPU/memory at limit=50 is an extrapolation, not a fourth live measurement** — accepted; the extrapolation is bounded by two independently real measurements (0.61ms/107KB and the real 269KB/28KB 50-doc body), and the worst case (≈1.5ms/request) is far below any plausible CPU budget concern.

### What this coverage does NOT prove

- The three Fully-Automated static-source guards for this cycle (min-size constant present, `Vary` merge string present, plus the carried-forward `depth:0`/A3/A4 grep guards) prove the literal patterns are present/absent in source — they do NOT prove an equivalent regression achieved a different way (e.g. a refactor that inlines the constant, or restructures the `Vary` assignment) can't reintroduce the same silent failure.
- Typecheck/lint gates prove type-safety and lint-cleanliness only — zero runtime encoding behavior, request-count reduction, or byte-saving.
- The Hybrid preview curls (gzip + identity) prove the *sampled* preview build (commit `7384b1f`, confirmed unchanged) behaves correctly — they do not re-prove production's edge behaves identically; that is exactly what the mandatory post-deploy Observability gate is for, and it is the one gate this contract cannot close before merge.
- Nothing in this contract independently re-measures the FEASIBILITY artifact's own byte-identity claim (sha256 `2361d14c64b9f1f3…`) — this cycle re-confirmed the *code producing that result is unchanged* (via `git log`), not the measurement itself.
- The CPU/memory estimate at limit=50 is an extrapolation from two real data points, not a fourth live measurement — see Known Gaps.
- Nothing in this contract proves GCV's behavior under gzip — accepted as a known-gap, safe-by-construction per the opt-in design, not independently verified.
- This contract does not re-verify or re-derive any of cycle 2's 4 standing whole-plan CONCERNs (GCV/Fix-2b block, no-test-runner, raised-risk-baseline, E10 wording) — those are carried forward by reference, not re-investigated this cycle, since this cycle's scope is the gzip touchpoint plus PR #11 re-verification only.

### Accepted by

Accepted by: session (autonomous PVL cycle 3 re-validate; no separate interactive V5 round-trip occurred within this invocation). The 1 new CONCERN (debug header, E12) is trivial and does not require human confirmation before merge — it is a one-line pre-merge cleanup, not a design or risk decision. The 4 standing whole-plan CONCERNs carried forward from cycle 2 (GCV block, no-test-runner, raised-risk-baseline, E10 wording) remain recommended for human confirmation before EXECUTE begins on Fix 2a specifically (unchanged from cycle 2 — this cycle did not touch that recommendation). Phase 2 (non-gzip items) and Phase 3 remain hard-gated and are not waived by this acceptance.
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
   - **Gzip passthrough (found 10-09-26) is VIABLE and is Phase 2 priority #1.** Code already exists on branch `probe/gzip-public-api` (commit `7384b1f`, one file: `src/lib/public.ts`). It is CMS-only, no reader coordination, no GCV dependency. Next step for this touchpoint specifically: run VALIDATE (it has not gone through PVL yet — the existing `## Validate Contract` predates this finding), then merge. Do not skip the mandatory post-deploy Observability verification gate (see `## Verification Evidence`).
   - Do not, under any circumstances, revive the TTL-raise idea (see banner at top) or schedule a `media.url` backfill (see "What NOT To Do" #7).

---

**Status:** DONE
**Summary:** Wrote the COMPLEX plan artifact consolidating the completed 17-agent verification synthesis into a durable, resumable plan with a Phase 0 blocking measurement gate, the INVALIDATED-TTL banner, the full "What NOT To Do" list, explicit two-repo touchpoints, the security finding flagged at plan severity, honest LOW-confidence labeling, and a resume handoff. No source files were modified in either repo.
**Concerns/Blockers:** None blocking. Two open items worth tracking: (1) the crawler-control Phase 2 branch has no concrete design yet — depends on unrun P2/P2b data; (2) `process/context/all-context.md` is missing from this repo's harness (noted in Open Questions, not resolved).
