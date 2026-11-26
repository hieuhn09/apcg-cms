---
name: plan:public-api-cdn-cache
description: "Phase A of the Vercel cost program: make successful GETs of the Central CMS public API CDN-cacheable per tenant behind a default-OFF kill switch, with a mandatory Preview gate and a documented fallback."
date: 26-11-26
metadata:
  node_type: memory
  type: plan
---

# Public API CDN cache (Phase A, Vercel cost program)

**Date**: 26-11-26
**Repo**: `apcg-cms` only (no site-repo change in the primary design)
**Complexity**: COMPLEX (one small code change, but a go/no-go empirical gate, a fallback branch that touches 12 repos, and a production rollout)
**Status**: ⏳ PLANNED (no code touched)
**Related plan (reuse, do not contradict)**: `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md` (+ `cms-cost-remediation_CLOSEOUT_10-09-26.md`). It covers the August 2026 spike and already shipped gzip and Fix 2b. It does NOT ship CDN caching of `/api/public/*`; this plan is the follow-through on its Fix #1 row (line ~144, "Add Cache-Control / s-maxage to public.ts") and Fix #2 row (line ~145, rejected "token in URL"). See "Conflict with the prior plan" below, which is the most important section.

## Goal

Make successful GET responses of an explicit allowlist of `src/app/api/public/*` routes cacheable at the Vercel CDN, partitioned per tenant, behind a kill switch, so the ~12 site frontends stop invoking the CMS function on every read. Owner-approved direction; INNOVATE decided: CDN caching in the CMS only.

## Evidence (Vercel observability, 18 to 25 Nov 2026, project apcg-cms)

- ~4.0M requests/week, 99.6% `cache_result=BYPASS`. `/api/public/articles` 2.17M invocations / 30.8 GB (~14 KB avg); `/articles/[slug]` 1.44M / 7.6 GB; `/site` 200k; `/[module]` 125k. apcg-cms is ~45% of team Fast Origin Transfer and ~41% of function CPU. Team bill ~$375/month, rising.
- Callers per week: wtb-web 2.94M, wad-web 1.15M, brief-asia-web 0.92M, gtp-web 0.68M, asianomist-web 0.53M, gcv-web 0.32M, otw-web 0.23M, amb/vowasia ~0.16M, abb/agr/aer ~0.1M.

## Conflict with the prior plan (read first)

The prior plan's Fix #1 row records, "Confirmed 10-09-26 by docs + empirical test": Vercel's CDN refuses to cache any request carrying an `Authorization` header (docs `/docs/caching/cdn-cache`, unconditional precondition), and a production media-route probe returned `x-vercel-cache: BYPASS` three times with `Authorization` and `MISS` then `HIT` without. It also records that `Vary: Authorization` is moot because the Authorization exclusion fires before the cache-key stage.

This plan's owner-approved primary design (`Vary: Authorization`) therefore has a HIGH prior probability of failing. It is NOT being rerun on faith: step 0 of the Preview gate is a cheap, code-free-as-possible probe that either re-confirms the 10-09-26 finding (then jump to the fallback branch) or shows the platform behaviour has changed (Vercel changes things; the prior probe was on the media route, not a JSON route with `Vary`). The code in Phase 1 is small and default-OFF, so building it to run the gate costs little. The prior plan's rejection of "token in URL/query" stands: this plan never puts the read token in a URL. The fallback uses a NON-secret tenant slug in the path, which the prior plan flagged as a "cache-served auth bypass" risk; that risk is analysed under Fallback B (the content is already public on the sites, so the bypass exposes only published content, but the owner must accept it explicitly).

Also reuse, do not re-litigate: the TTL-raise idea (60s to 1800s on readers) is INVALIDATED in the prior plan; this plan only sets CDN TTL on the CMS side and does not touch reader TTLs.

## Decision summary (INNOVATE outcome)

- **Chosen (Design A)**: CDN caching in the CMS only. On successful (200) GETs of an allowlist of read routes, add `Vercel-CDN-Cache-Control: s-maxage=<N>, stale-while-revalidate=<M>` (CDN-only header, stripped before the client, takes precedence over `Cache-Control` for Vercel's CDN) plus a conservative downstream `Cache-Control` so browsers and the sites' own fetch layer are not told to cache. Partition per tenant via `Vary: Authorization` (retain existing `Origin` and `Accept-Encoding`). Defaults s-maxage=60, stale-while-revalidate=300, both env-tunable. Kill switch `PUBLIC_API_CDN_CACHE`, default OFF.
- **Rejected for now**: (1) tenant slug in URL, cached with no Vary: needs changes in all 12 site repos; kept as documented FALLBACK B. (2) Per-site data-cache fixes (wtb-web etc.): separate later phases (B: brief-asia-web dynamic routes; C: wtb-web ~10 CMS calls per page view). (3) In-function/runtime cache: saves DB/CPU but not data transfer.
- **Accepted trade-offs**: new/edited/hidden articles, view counts and `flag=pinnedToLatest` (uses `new Date()`) may lag up to TTL+SWR (default up to 360 s) at the CDN, on top of the sites' own ISR windows; token revocation lag extends by TTL (existing 30 s memo in `resolveReadToken` plus up to 60 s CDN, +SWR serve-stale); a revoked token's cached 200 can still be served to anyone presenting that exact token. Per-tenant tag purge from the revalidate hook is OUT of scope (follow-up F1).

## Touchpoints

| File | Change |
|---|---|
| `src/lib/public-cache.ts` (NEW) | Pure helper `publicCacheHeaders({ method, pathname, status, env })` returning `Record<string,string> \| null`. Holds the allowlist, the switch parse, TTL parse/clamp. No I/O, no Payload import, so it is trivially unit-testable. |
| `src/lib/public.ts` `jsonPublic` (~:71-90) | Single integration point. After building `headers`, call the helper with `request.method`, `new URL(request.url).pathname`, `status`, `process.env`; if non-null merge its headers. Extend the `Vary` assembly so it is always built from a set: `Origin`, plus `Accept-Encoding` when gzipped (existing), plus `Authorization` when cache headers are applied. Must not disturb the gzip branch (it currently overwrites `headers.Vary`). |
| `src/lib/public-cache.test.ts` (NEW) | `tsx --test` unit tests (see Tests). |
| `package.json` | Add script `test:public-cache`: `tsx --test src/lib/public-cache.test.ts` (matches the per-file runner convention). |
| `docs/09-website-integration.md` (~:77, ~:102) | Replace "No `Cache-Control`" with the new behaviour (when the switch is on, CDN caches 60 s; sites should still ISR) and the revalidate-lag note. Docs-only; do in the same PR. |
| `process/context/integrations/all-integrations.md` | Add a short entry for the switch + gate result after EXECUTE (UPDATE PROCESS step, not part of the code PR). |
| `src/app/(payload)/api/[...slug]/route.ts:19-31` | Comment only: update the sentence "JSON API deliberately NOT cached" to point at `public-cache.ts` (optional, comment-only; skip if the gate fails). |

No route file under `src/app/api/public/` changes: caching is decided centrally from method + pathname + status, so every route (including ones added later) is uncached by default unless on the allowlist.

## Public Contracts

- Response bodies unchanged. Added response headers only when the switch is on: `Vercel-CDN-Cache-Control`, `Cache-Control` (downstream, conservative), `Vary` gains `Authorization`. With the switch off the response is byte- and header-identical to today (this is an acceptance test).
- Env vars (set on Vercel project apcg-cms, Production and Preview, by the OWNER; the agent never sets or reads secrets):
  - `PUBLIC_API_CDN_CACHE`: only the exact value `on` enables; anything else/unset = OFF. Default unset (OFF). Read per request (no module-level cache) so a redeploy-less flip is not assumed; flipping still needs a redeploy because Vercel env changes apply to new deployments.
  - `PUBLIC_API_CDN_S_MAXAGE`: integer seconds, default 60, clamped to [10, 600]; invalid = default.
  - `PUBLIC_API_CDN_SWR`: integer seconds, default 300, clamped to [0, 1800]; invalid = default.
- Downstream header decision (justify against Vercel docs at EXECUTE; docs: "Cache-Control headers" and "CDN-Cache-Control" pages): `Vercel-CDN-Cache-Control` is read only by Vercel's CDN and removed from the client response, and it overrides `Cache-Control` for the CDN. So the downstream `Cache-Control` can stay `public, max-age=0, must-revalidate`, which tells browsers and the Next.js fetch layer nothing new to cache. Preview gate step 5 verifies Vercel does not instead cache using the downstream value or refuse due to it. If the docs/behaviour show `Vercel-CDN-Cache-Control` is not honoured on Route Handler responses, fall back to `CDN-Cache-Control`, then to `Cache-Control: s-maxage` (which Vercel strips from the client side per the prior plan's finding).
- Allowlist (GET, status 200 only), exact paths:
  `/api/public/articles`, `/api/public/articles/<slug>`, `/api/public/site`, `/api/public/authors`, `/api/public/cities`, `/api/public/menus`, `/api/public/tags`, `/api/public/booths`, `/api/public/booths/<slug>`, and `/api/public/<module>` ONLY for module names that are keys of `MODULES` in `src/app/api/public/[module]/route.ts` (the helper imports no route code; EXECUTE copies the key list into a constant with a comment pointing at `MODULES`, and a unit test asserts the constant equals the real keys if `MODULES` is exported, otherwise a code comment plus manual check).
- Never cached (not on allowlist): `/api/public/views` (POST), `/api/public/subscribers` (POST, and its GET at `subscribers/route.ts:106` is per-user/newsletter state), `/api/public/preview` (signed token in query, returns drafts), anything else under `/api/public/`. Any non-200 (401, 404, 400, 500, 503) and any non-GET (including OPTIONS preflight, which uses `preflight()` and not `jsonPublic`) is never given cache headers.

## Blast Radius

- All 12 site frontends read this API; with the switch ON every read can be up to TTL+SWR stale at the CDN. With the switch OFF there is zero change.
- Highest-risk failure: cross-tenant leak (one tenant's JSON served to another) if the CDN keys only on URL while the tenant derives from the token. This is why the Preview gate is mandatory and why Design A is not enabled on Production until it passes.
- Second risk: an unauthenticated/invalid-token request served a cached 200 (auth bypass at the cache layer). Gate steps 3 and 4 test this directly.
- CORS: cached `Access-Control-Allow-Origin` is pinned to the origin that warmed the entry; `Vary: Origin` is already present so entries partition by Origin. Server-side callers (Next.js sites fetching with no `Origin`) are the dominant traffic; browser callers add key multiplicity, not wrong ACAO. Gate step 6 checks one browser-origin case.
- Writes, hooks, crons, hub/engine routes, Payload admin and the media route are untouched.

## Data Flow

Site fetch (`Authorization: Bearer <tenant read token>`) -> Vercel CDN (key = URL + Vary dims: Authorization, Origin, Accept-Encoding) -> HIT: served from CDN, function not invoked. MISS/BYPASS: `resolveReadToken` derives tenant from the token (30 s memo) -> route queries Payload scoped to that tenant -> `jsonPublic` adds cache headers only if switch on, method GET, status 200, path on allowlist -> CDN stores. Publish/hide/edit -> `src/hooks/revalidate.ts` webhook invalidates the SITE's tags, not the CDN entry; the CDN entry expires by TTL (SWR may serve one stale response while it refreshes).

## Failure Modes

| Failure | Behaviour / mitigation |
|---|---|
| Vercel refuses to cache requests with Authorization (the 10-09-26 finding) | Gate step 0/2 shows BYPASS every time. Switch to Fallback B; keep the code OFF; no production impact. |
| Vary: Authorization not used as a key dimension | Gate step 3 shows tenant B receiving tenant A's content or identical bodies. STOP, never enable, go to Fallback B. |
| Cached 200 served to missing/invalid token | Gate step 4. STOP. |
| 5xx or empty body cached | Allowlist is 200 only. A 200 with an empty `docs: []` is cacheable by design (unknown pillar etc.); acceptable at 60 s. |
| Stale content complaint | Lower `PUBLIC_API_CDN_S_MAXAGE` or flip the switch off. |
| Switch parse error | Anything not exactly `on` is OFF (fail-safe). |

## Implementation Checklist

1. Re-read `src/lib/public.ts` `jsonPublic` and `src/app/api/public/[module]/route.ts` `MODULES`; record the current `MODULES` keys in the PR description.
2. Create `src/lib/public-cache.ts` with the pure helper, allowlist constant, env parsing (switch exact `on`, TTL clamps).
3. Wire the helper into `jsonPublic` in `src/lib/public.ts`; build `Vary` from a set so gzip and cache branches compose; keep the no-switch output identical.
4. Create `src/lib/public-cache.test.ts` and the `test:public-cache` script in `package.json`.
5. Run `npm run test:public-cache` and `npm run typecheck`; run an existing neighbouring suite that imports `public.ts` (e.g. `npm run test:booths`) to confirm no regression.
6. Update `docs/09-website-integration.md` Caching section (~:77 and ~:102) and the comment at `(payload)/api/[...slug]/route.ts:19-31`.
7. Open a PR; ask the OWNER to set `PUBLIC_API_CDN_CACHE=on` on the PREVIEW environment only; run the Preview gate below; write results to `public-api-cdn-cache_REPORT_<date>.md` in this folder (verdict per step, no tokens).
8. Decision point: PASS -> step 9. FAIL -> record the failing step, leave the code merged-but-OFF only if the owner agrees, otherwise close the PR, and open the Fallback B plan (see below).
9. Merge to `main` (switch still OFF on Production); owner sets the env on Production; redeploy; run the abbreviated Production smoke (gate steps 1, 3, 4 on production URLs).
10. Measure after >= 24 h (acceptance below); record in the REPORT; then UPDATE PROCESS (context + the prior plan's Current Execution State gets one line pointing here).

## Preview Verification Gate (mandatory before enabling on Production)

Run against the Preview deployment URL (`$PREVIEW` = the PR's Vercel preview URL; if Preview has Deployment Protection, use the owner-provided bypass mechanism, never pasted into chat/plan). Tokens are referenced ONLY by env names in the shell: `$TOKEN_A` and `$TOKEN_B` = read tokens of two DIFFERENT tenants that both have `features.articles` on (owner exports them locally; do not echo them; use `curl -s -o /dev/null -D -` style header dumps and `head -c` on bodies). Pick a URL on the allowlist, e.g. `$PREVIEW/api/public/articles?limit=3`. Always request with `Accept-Encoding: gzip` as the sites do. Add a cache-busting query param (e.g. `&_g=<unique>`) per test run so earlier entries do not mask results.

0. Probe (fast fail): with the switch ON on Preview, request the URL twice with `$TOKEN_A`. Record `x-vercel-cache`, `age`, `cache-control`, `vary`. If both are BYPASS, re-confirm with the Vercel docs page and note the date; this is the prior-plan finding recurring: go to the Fallback B branch now, skip steps 1-7.
1. Headers: first request MISS (or STALE), second HIT with `age` present; `vary` includes `Authorization`; the client-facing response does not expose `s-maxage` beyond what Vercel passes (record exactly what it shows).
2. HIT sustained: 5 consecutive requests with `$TOKEN_A` within 30 s: at least 4 HIT; function invocation count for that path in Vercel observability does not rise by 5.
3. Tenant partition (the leak test): same URL with `$TOKEN_B` immediately after A's cached HIT. It must return tenant B's content (compare a tenant-specific field such as the first article `slug`/`tenant`-identifying data against a direct response from a switch-OFF deployment, e.g. production, for B), not A's; first B request is MISS, later B requests HIT. Then alternate A, B, A, B: each stays its own tenant. Any cross-tenant body = STOP and Fallback B.
4. Auth never from cache: right after a cached 200 for A: (a) request with NO `Authorization` -> must be 401 with no `x-vercel-cache: HIT`; (b) request with an INVALID token -> 401, not HIT; repeat each twice (a cached 401 must not be stored either: confirm the 401s carry no `Vercel-CDN-Cache-Control` and are not HIT on repeat). Any 200 here = STOP.
5. Not cached: `/api/public/preview?token=...` (use an expired or garbage token to get 401/400), `POST /api/public/views` and `POST /api/public/subscribers` with an empty body (expect 4xx), `GET /api/public/subscribers`: none shows `Vercel-CDN-Cache-Control`, none HIT. Also a 404 (e.g. `/api/public/articles/this-slug-does-not-exist`) and a feature-gated 404 for a module the tenant lacks: no HIT on repeat.
6. CORS/gzip: request with `Origin: <an allowed origin>` and again with a different origin or none: bodies identical, `access-control-allow-origin` correct per request (not pinned to the other origin), `content-encoding: gzip` only when requested; identity request (no `Accept-Encoding`) returns plain JSON and is not served gzipped bytes from a gzip-keyed entry.
7. Switch OFF check: redeploy Preview with switch unset: responses show no `Vercel-CDN-Cache-Control`, `vary` without `Authorization`, and `x-vercel-cache: BYPASS`/`MISS` as today (byte-identical to pre-change).

PASS = steps 0-7 all as stated. Any cross-tenant body, any cached 401, or no HIT at step 0/1/2 = FAIL, record in the REPORT, and take the Fallback B branch. Do not proceed to Production on a partial pass.

## Fallback B (branch if the gate fails; separate plan, requires owner approval)

Tenant in the URL path, no Authorization on cacheable requests. Sketch only: a new read path `/api/public/t/<tenantSlug>/...` (or a `vercel.json` rewrite) whose cache key is naturally per tenant; sites switch to it (12 repos: wtb-web, wad-web, brief-asia-web, gtp-web, asianomist-web, gcv-web, otw-web, amb/vowasia/abb/agr/aer-web). Because a cache HIT never re-runs a token check, the tenant slug becomes the only access control for published content. That is acceptable ONLY because these responses contain exactly the content already public on each site; it requires the owner's explicit decision, must stay on the same allowlist/200-only/GET-only rules, must never include drafts, `preview`, or tenant-private data, and the old Authorization path stays supported for non-cached callers. This reverses nothing in the prior plan's secret-hygiene rule (the read token never goes in a URL). Write it as its own plan with its own 12-repo blast radius; do not start it from this plan.

## Production Rollout and Rollback

- Rollout: gate PASS -> merge (switch OFF) -> owner sets `PUBLIC_API_CDN_CACHE=on` (and optionally TTLs) on Production -> redeploy -> smoke (gate steps 1, 3, 4 with production URLs) -> observe 24 h. Roll out all tenants at once (the header is per-response, no per-tenant switch in scope; if the owner wants staged rollout, add `PUBLIC_API_CDN_CACHE_TENANTS` as a follow-up, not now).
- Rollback: set `PUBLIC_API_CDN_CACHE` to anything other than `on` (or delete it) and redeploy. New responses carry no cache headers. Existing CDN entries: Vercel's CDN cache is scoped per deployment (a new deployment starts with a cold cache for its own URLs) and entries expire at s-maxage+SWR regardless, so worst case residual staleness is <= 360 s at default TTLs. If a faster purge is ever needed, use the Vercel dashboard "Purge CDN cache" (Project > Settings > Caching) or the Vercel MCP/CLI invalidate-by-tag/path tools; this plan sets no cache tags, so purge = whole-project or by redeploy. Emergency token revocation: same as today (30 s memo) plus up to TTL+SWR for any cached entry; for an immediate cut, purge CDN cache + redeploy.

## Measurement and Acceptance (>= 24 h after Production enable)

Query Vercel observability, project apcg-cms, 24 h window vs the 18 to 25 Nov baseline, grouped by route and `cache_result`:

- AC1: `cache_result=HIT` share on allowlisted `/api/public/*` >= 60% (baseline 0.4%).
- AC2: function invocations on `/api/public/*` down >= 50% vs the same-length baseline (target ~70-90% for `articles` and `articles/[slug]`).
- AC3: Fast Origin Transfer and function data transfer for apcg-cms down >= 40%; record Fast Origin Transfer share of team total (baseline ~45%).
- AC4: zero tenant-leak reports; one spot-check per tenant (all ~12 read tokens, from the sites' own env) that `/api/public/site` returns that tenant's `site.name`/`brand`.
- AC5: no rise in site-side error rates or 401s (compare 4xx on apcg-cms before/after); new-article-visible lag on one test publish is <= TTL+SWR plus the site ISR window.
- If AC1 <60% but no leak: investigate key fragmentation (Origin/Accept-Encoding variants, per-request query params such as cache-busters in site code) before tuning TTL.

## Tests

- Unit (`npm run test:public-cache`): switch `on`/`off`/unset/`ON`/`1` (only exact `on`); GET vs POST/OPTIONS/HEAD; status 200 vs 401/404/500; each allowlisted path (including a `<slug>` and a `<module>` path) vs each denied path (`/views`, `/subscribers`, `/preview`, unknown); TTL defaults, clamps and garbage input; `Vary` composition with gzip on and off (extract the `Vary` builder into the helper or test through `jsonPublic` with a fake `Request`); switch OFF returns exactly the pre-change header set.
- `npm run typecheck`.
- Manual Preview gate above (the real proof; unit tests cannot prove Vercel behaviour).

## Verification Evidence

| Gate | Evidence artifact |
|---|---|
| Unit + typecheck green | command output pasted in the REPORT |
| Gate steps 0-7 | `public-api-cdn-cache_REPORT_<date>.md`: per-step headers (no tokens), verdict, Preview URL, deployment id |
| Production AC1-AC5 | same REPORT, with observability query description and numbers |
| Prior plan reconciled | one line added to the prior plan's Current Execution State linking this plan and its verdict |

## Dependencies and Sequencing

Owner must provide: two tenant read tokens exported locally (names above), Preview protection bypass if enabled, env settings on Vercel Preview/Production. Phase B/C (site-side fixes) are independent and can proceed in parallel; their measured gains are additive. Fallback B depends on this gate's verdict.

## Out of Scope / Follow-ups

- F1: `Vercel-Cache-Tag` per tenant and purge-by-tag from `src/hooks/revalidate.ts` (kills most staleness; do after Phase A proves out). F2: per-tenant switch. F3: raising the 30 s token memo is NOT proposed. F4: Phases B and C.

## Resume and Execution Handoff

- Status: ⏳ PLANNED. Execute anchor: this file only (no legacy phase files).
- First action in EXECUTE: checklist 1-6 (code + tests, switch default OFF). Do NOT set any Vercel env or merge to `main` without the owner. Step 7 onward needs owner-provided tokens/env; if they are not available, stop at step 6 with a PR and report DONE_WITH_CONCERNS.
- If the Preview gate fails, do not iterate on header variants indefinitely: one retry with `CDN-Cache-Control` then `Cache-Control: s-maxage` is allowed; after that go to Fallback B.
- Validators after edits: `node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs process/general-plans/active/public-api-cdn-cache_26-11-26/public-api-cdn-cache_PLAN_26-11-26.md`.

## Rollback Notes (plan-level)

The code change is additive and inert while the switch is unset; reverting the PR is a clean rollback. Docs edits revert with the same PR.
