---
name: plan:gtp-public-tags-route
description: "Additive read route GET /api/public/tags?minCount=<n> returning per-tenant tags used by >= n PUBLISHED articles, so gtp-web can show a tag chip only when a tag has >= 2 articles"
date: 21-10-26
feature: none (general-plans)
---

# GET /api/public/tags?minCount= (additive public read route)

Date: 21-10-26
Status: PLANNED (PLAN mode; SPEC/INNOVATE skipped per owner decision; nothing written outside this file)
Complexity: SIMPLE (one new route + one pure helper + one probe + docs), but it touches a PUBLIC API contract (high-risk class), so it carries a manual-first evidence section.
Base: fresh `origin/main` (`a02a3d6` or later); delivery by PR (owner decision 22-10-26). PVL-supplement cycles 1-2 applied 22-10-26; PVL cycle 3 validated Gate: PASS 22-10-26.

## Overview

Goal: let gtp-web show a tag chip only for tags used by at least 2 PUBLISHED articles, without paging the whole article list.

## TL;DR

Add one new file `src/app/api/public/tags/route.ts` (plus a small SQL helper) that counts, per tenant, how many PUBLISHED articles use each tag in ONE aggregate query and returns tags with `count >= minCount`. No existing route, collection, migration or response is touched. gtp-web must not call it until the CMS deploy is live and the read-only curl checks pass. Rollback = revert the PR (route disappears, 404).

## Decision (owner, 21-10-26)

Owner chose a dedicated count route over having gtp-web page the whole article list. Measured gtp (tenant id 7): 6,506 tags; 4,827 used by exactly 1 article; 1,239 by 2-4; 434 by 5+; 6 unused. So `minCount=2` returns about 1,673 rows (before the cap).

## Verified facts (checked against code at HEAD of `claude/clever-gates-h5xyd8`)

| Fact | Evidence |
|---|---|
| Public list is `workflowStatus == "published"` and must NOT filter `_status` | `src/app/api/public/articles/route.ts:108`; rationale `src/lib/scoped.ts:36-51` |
| `view=refs` is depth 0, select slug/updatedAt/publishedAt, limit cap 1000 (others 50) | `articles/route.ts:92-95,296-298` |
| No tags route exists | `ls src/app/api/public/`: `[module] articles authors cities menus preview site subscribers views` only |
| Tags has only `slug` (indexed) + localized `title` + tenant | `src/collections/Tags.ts:14-22`; tables `tags(id, tenant_id, slug)`, `tags_locales(_parent_id, _locale, title)` in `src/migrations/20260702_231336_initial_schema.ts:335-348` |
| Article tags are a hasMany relationship, stored in `articles_rels` with `path`, `parent_id`, `tags_id` | `Articles.ts:345`; `initial_schema.ts:427-436`; indexes `articles_rels_parent_idx`, `articles_rels_path_idx`, `articles_rels_tags_id_idx` (`:1068-1071`); `articles_tenant_idx`, `articles_workflow_status_idx` (`:1050-1051`) |
| Draft versions live in `_articles_v_rels`, not `articles_rels`, so counting `articles_rels` counts only the main (live) rows | `initial_schema.ts:898` (`_articles_v_rels`) |
| Tenant comes ONLY from the read token (`resolveReadToken`), siblings never take a tenant param | `src/lib/public.ts:1-10,130-154`; used identically in `articles/route.ts:80-83`, `authors/route.ts:26-28` |
| Sibling envelope: articles = Payload list `{docs,totalDocs,page,...}`; authors = `{data:{authors}}`; errors = `{ok:false,status:"unauthorized"}` 401 / `"not_found"` 404 for a disabled feature | `articles/route.ts:82-83`; `authors/route.ts:28,45` |
| CORS/OPTIONS via `preflight`; gzip in `jsonPublic` above 1 KB when `Accept-Encoding: gzip`; NO Cache-Control header on any public route (callers cache via ISR) | `src/lib/public.ts:22-35,71-90`; grep for `Cache-Control` in `src/app/api/public` returns nothing |
| Public GET routes do NOT write activity or integration rows (only `views` and `subscribers` writes have try/catch) | grep `logActivity` in `src/app/api/public`: no hits |
| Invalid query values are ignored, not 400 (typo must not blank a homepage) | `articles/route.ts:115-119` |
| Drizzle through Payload's own pool already used by scripts and probes: `(payload.db as {drizzle}).drizzle.execute(sql\`...\`)`, `sql` from `@payloadcms/db-postgres` | `scripts/hub-probe.ts:28,1048-1050`; `scripts/single-home-probe.ts:99` |
| Console's Drizzle client (`src/console/data/db.ts`) is a SEPARATE pool (`max: 5`) that throws at import without `DATABASE_URL`; it is the Console's lane and must NOT be imported by a public route | `src/console/data/db.ts:14-29` |
| Feature gate helper `featureEnabled(tenant, "articles")` | `src/lib/tenant.ts:54`; used `articles/route.ts:83` |
| Locale clamp helper | `src/lib/locales.ts` `clampLocale`; payload locale fallback is on (`payload.config.ts:103`) |

Base and re-verification (PVL cycle 1, 22-10-26): facts above were first checked at HEAD `3cc1f2a` of `claude/clever-gates-h5xyd8`, which is 24 commits behind `origin/main` `a02a3d6`. They were re-verified on `a02a3d6`: `public.ts`, `scoped.ts`, `tenant.ts`, `locales.ts`, `Tags.ts` and the initial schema are unchanged; `Articles.ts` changed in comments only; the `[module]` route and `package.json` changed; the new migration 20261021 touches podcasts only. EXECUTE branches from fresh `origin/main` and the doc edits are made on that base.

Unverified at plan time (must be confirmed in EXECUTE, listed in the checklist): that the Articles `tags` field is stored with `articles_rels.path = 'tags'` (the field sits inside an unnamed tab, which does not prefix the path; the probe asserts it and production already accepted `.path='tags'` per the owner); the Neon query plan (read-only EXPLAIN by the owner).

## Design

### Contract

`GET /api/public/tags?locale=<code>&minCount=<n>&limit=<n>`

- Auth: `Authorization: Bearer <tenant read token>` via `resolveReadToken` (401 `{ok:false,status:"unauthorized"}` otherwise). Tenant is the token's tenant; there is no tenant parameter.
- Gate: `featureEnabled(tenant, "articles")`, else 404 `{ok:false,status:"not_found"}` (same rule as the article list; tags are article taxonomy).
- `locale`: `clampLocale(param, supportedLanguages(tenant), tenant.defaultLanguage)` exactly like siblings. `defaultLocale = clampLocale(tenant.defaultLanguage, supportedLanguages(tenant), "en")` (always an `_locales` enum member; slug is the last title fallback). EXPLICIT ASSUMPTION, see Owner decisions.
- Param algorithm (ONE explicit algorithm for both params, no other rule anywhere in this plan): `raw = searchParams.get(name)` (first value wins when the param is repeated). If `raw === null` (absent) or `raw.trim() === ""` (blank) use the default. Else `n = Number(raw)`; if `!Number.isFinite(n)` (`abc`, `Infinity`, `NaN`) use the default; else `n = Math.floor(n)`. Then, `minCount`: default 1, clamp to [1,1000]. `limit`: default 500; if the floored `n < 1` use the default 500, otherwise clamp to [1,2000] (hard cap). Lenient: never 400, matching the sibling rule that a bad query value must not blank a page. Documented.
  - Exact expected results (the probe G6 pins every row): `minCount` absent -> 1; empty -> 1; `0` -> floor 0 -> clamp 1; `-3` -> 1; `abc` -> 1 (default); `1.5` -> 1; `2.7` -> 2; `Infinity` -> 1 (non-finite -> default); `1e3` -> 1000; `5000` -> 1000. `limit` absent -> 500; empty -> 500; `0` -> 500 (floored < 1 -> default); `-5` -> 500; `0.5` -> floor 0 -> 500; `abc` -> 500; `2.5` -> 2; `1` -> 1; `99999` -> 2000.
- `limit` also governs the response: rows are ordered `count DESC, slug ASC, id ASC` (stable, deterministic, total). No paging in v1 (DECIDED): gtp at `minCount=2` is about 1,673 rows (about 84% of the cap); the response carries `totalDocs` (rows matching before the cap) so a consumer can detect truncation.
- Response `200`: `{ "docs": [ { "slug": "...", "title": "...", "count": 3 } ], "totalDocs": 1673 }`. Same top-level key `docs` and `totalDocs` as the article list envelope (so frontends reuse one parser shape) without pretending to be a Payload page object (no `page`/`hasNextPage`). `count` is a JSON number.
- Headers: whatever `jsonPublic` already gives (CORS, gzip above 1 KB). No `Cache-Control` (matches every sibling; the consumer caches with ISR `revalidate`). `OPTIONS` -> `preflight`.
- Errors: unexpected DB failure -> `console.error` with a fixed label (no token, no SQL params) and `jsonPublic(request,{ok:false,status:"internal_error"},500)`. Same status string the hub routes use for internal errors.

### Query (single aggregate, tenant on BOTH sides)

One statement through `payload.db.drizzle.execute(sql...)`; `workflow_status` compared to a literal (never a bound text param against an enum); locale cast to the `_locales` enum:

```
SELECT t.slug, COALESCE(l.title, d.title) AS title, c.cnt, count(*) OVER () AS total
FROM (
  SELECT r.tags_id, count(DISTINCT r.parent_id) AS cnt
  FROM articles_rels r
  JOIN articles a ON a.id = r.parent_id
  WHERE r.path = 'tags' AND r.tags_id IS NOT NULL
    AND a.tenant_id = $tenant AND a.workflow_status = 'published'
  GROUP BY r.tags_id
  HAVING count(DISTINCT r.parent_id) >= $minCount
) c
JOIN tags t ON t.id = c.tags_id AND t.tenant_id = $tenant
LEFT JOIN tags_locales l ON l._parent_id = t.id AND l._locale = $locale::"_locales"
LEFT JOIN tags_locales d ON d._parent_id = t.id AND d._locale = $defaultLocale::"_locales"
ORDER BY c.cnt DESC, t.slug ASC, t.id ASC
LIMIT $limit
```

(Illustrative of the shape to be written in EXECUTE with `sql` template parameters; this is a spec, not source.) Properties: published-only counting (`workflow_status = 'published'`, never `_status`, same predicate as the list route); tenant isolation by construction twice (article `tenant_id` and tag `tenant_id`), so a stray cross-tenant relationship row can neither be counted nor leak a foreign tag; `count(DISTINCT parent_id)` guards against a duplicate rel row inflating a count; title falls back requested locale -> tenant default locale (`defaultLocale` as defined in Contract, always a valid enum member; approximates Payload's `fallback: true`, which uses the global `en`); a tag with no title row in either locale is still returned with `title` = slug (guard in the mapper so a null never reaches the JSON). Ordering is made total with a final `t.id ASC` tiebreaker as a defensive tiebreaker (correction 22-10-26, review M1: slug uniqueness is enforced by the `src/collections/Tags.ts:19` hook AND by the unique index `tags_tenant_slug_idx` on `(tenant_id, slug)` from `src/migrations/20260801_082303_migration_hardening.ts:84`; the separate `tags_slug_idx` is non-unique).

### Cost on Neon

- Tenant gtp: about 6.5k tags; article-tag rels are on the order of 10-20k rows (4,827 single-use + 1,239 tags used 2-4 times + 434 tags used 5+ times, plus 6 unused). Other tenants are larger (brief-asia, dtw about 3k+ articles each) but the tenant predicate on `articles` (`articles_tenant_idx`) bounds the join to one tenant.
- Expected plan: filter `articles` by `tenant_id` (+ `workflow_status`), nested loop into `articles_rels_parent_idx`, hash aggregate by `tags_id`, join `tags` by PK. One round trip, no N+1, no per-tag queries. Estimated tens of milliseconds warm; the cold first call after idle includes Neon wake-up like every other route.
- `articles_rels_path_idx` is low-selectivity (all relation paths, all tenants) so the planner should not rely on it; no new index is proposed. If the owner's EXPLAIN shows a sequential scan of `articles_rels` that matters, the follow-up option (NOT in this plan) is a composite index migration; it is deliberately excluded to keep the change migration-free and instantly revertible.
- Response size at the cap: 2000 rows x about 60 bytes = about 120 KB raw, gzips to about 20-30 KB (compressed in-function by `jsonPublic`, consistent with the cost-remediation work in `process/general-plans/active/cms-cost-remediation_09-09-26/`). A frontend should fetch it once with ISR (for example 300 s), not per page view.
- Public-route abuse: same exposure as the other read routes (a valid tenant token is required; token lookup is memoized 30 s in `public.ts`). No rate limit exists on any public route; not added here (accepted, noted).

### Why not alternatives

- Payload `find` on `tags` then per-tag article `count`: N+1, thousands of queries. Rejected.
- Payload `find` on `articles` with `depth:1` and counting in the route: pulls the whole archive (the brief-asia sitemap lesson, `articles/route.ts:88-91`). Rejected.
- Console Drizzle client: separate pool, boot-time env throw, wrong lane. Rejected.
- A denormalized `articleCount` column on Tags: needs hooks on every article write plus a backfill migration; far larger blast radius. Rejected for v1.

## Touchpoints

| File | Change |
|---|---|
| `src/app/api/public/tags/route.ts` | NEW. `OPTIONS` + `GET` as specified. |
| `src/lib/public-tags.ts` | NEW. Pure helpers: `parseMinCount`, `parseLimit`, `mapTagRows` (title fallback, numeric coercion, `totalDocs`), and the SQL builder taking `{tenantId, minCount, limit, locale, defaultLocale}`. Pure functions keep the route thin and unit-checkable. |
| `scripts/public-tags-probe.ts` | NEW. Local-disposable-Postgres probe (see Verification). |
| `package.json` | add the single script `"probe:public-tags": "tsx scripts/public-tags-probe.ts"` (DECIDED: probe-only, no `node:test` script or test file). |
| `docs/09-website-integration.md` | add the endpoint row to the public API table (near line 25-30 / 51-54) and a short subsection on `minCount`, cap, truncation, caching advice. |
| `process/context/integrations/all-integrations.md` | add `/tags` to the public route list at line 122 and a note under Security/Cost patterns that the route counts via raw SQL and is tenant-guarded twice. |
| `process/context/tests/all-tests.md` | list `probe:public-tags` next to the other probes; one line in Known Gaps removed/kept as appropriate. |
| `process/context/all-context.md` | one dated "Last updated" line (UPDATE PROCESS, not EXECUTE). |

Read (not changed): `src/lib/public.ts`, `src/lib/scoped.ts`, `src/lib/tenant.ts`, `src/lib/locales.ts`, `src/collections/Tags.ts`, `src/collections/Articles.ts`, `articles/route.ts`, `authors/route.ts`.
NOT touched: every existing route file, every collection, every migration (`src/migrations/**`), `payload.config.ts`, `src/lib/public.ts`, `src/lib/scoped.ts`, the Console.

## Public Contracts

- NEW external contract: `GET /api/public/tags` (shape above). Once gtp-web ships against it, its shape is frozen like the siblings.
- UNCHANGED, and must stay byte-identical: every existing `/api/public/*` response, status code and header; `OPTIONS` behavior; `workflowStatus`-only visibility predicate. The probe asserts byte equality of a fixed set of sibling responses before vs after (see Verification).
- The route returns only `slug`, `title`, `count` of tags that are used by published articles of the token's tenant. No ids, no tenant data, no unpublished-only tags (a tag used only by drafts/hidden/archived articles has count 0 and is never returned for `minCount >= 1`).
- Information-exposure note: tag slug and title are already public via `/articles` (`depth:1` populates tags). The new fact exposed is the count, which is derivable from the article list. No new sensitive data.
- Security (STRIDE quick scan): Spoofing = bearer token only, same as siblings. Tampering = read-only SQL, all values parameterized, `minCount`/`limit` parsed to integers with clamps, locale from the allowlisted `clampLocale`. Information disclosure = double tenant predicate; response contains public data only. Denial of service = result cap 2000, `minCount` clamp, one query; unauthenticated callers cost only the memoized token check. Elevation = none (no writes). No secret, auth or billing flow changes, so `vc-security` full pass is not required.

## Blast Radius

Risk class: PUBLIC API contract (additive) + raw SQL against Payload-managed tables.

- Files: 3 new source files, 1 `package.json` line, 4 docs/context files. 0 existing source files modified, 0 migrations, 0 env vars, 0 collection or schema changes, 0 hooks.
- Runtime: one new serverless function. Existing functions untouched; a bug in the new route can only affect `/api/public/tags`. A build-level error (typecheck, import) would fail the whole deploy, which is why the loose-Payload-types build gate is mandatory below.
- Failure mode of the raw SQL after a future Payload upgrade: table or column rename would surface as a 500 on this route only; covered by the probe and noted in `all-integrations.md`.
- Rollback: revert the PR (the route returns the framework 404 and the consumer degrades to "no chips" if it already handles a failed fetch). No data to undo. Since no consumer depends on it before the hard rule below is satisfied, rollback has zero user impact.

## Acceptance Criteria

AC-ADDITIVE (no existing route changes), AC-BUILD (typecheck, lint, loose-types clean build), AC-PUBLISHED (counts use workflowStatus=published only), AC-TENANT (cannot return another tenant's tags), AC-PARAMS (minCount/limit validation, cap, determinism), AC-LOCALE (localized title with fallback), AC-CONTRACT (401/404/CORS/gzip like siblings), AC-COST (single aggregate, acceptable Neon plan), AC-LIVE (owner-run production read-only checks). Each is proven by the matching gate row in Verification Evidence.

## Phase Completion Rules

Single phase. CODE DONE = checklist steps 1-8 complete with G1-G10 green locally. VERIFIED only after merge, deploy, and the owner-run G11 and G12 pass. Until then status stays CODE DONE and the plan stays in active/.

## Hard rules

1. gtp-web MUST NOT call or depend on `/api/public/tags` until the CMS deploy containing it is live in production and the owner-run read-only curl checks below pass.
2. The route MUST NOT change any existing route's response (status, body, headers). The probe's byte-equality check is a merge gate.
3. Never run the probe against production; it writes fixtures and hard-refuses non-local `DATABASE_URL` through `scripts/lib/local-db-guard.ts`.
4. Never print the gtp read token in logs, chat, commits or docs; reference only its prefix (`9f3af5e9`) if a label is needed.
5. Branch from fresh `origin/main` (not the stale `claude/clever-gates-h5xyd8`) and deliver by PR; the owner merges.
6. Probe safety: the probe refuses a non-loopback `PUBLIC_TAGS_PROBE_BASE`, and requires a fixture-token 200 (proving the dev server uses the same disposable DB) before any assertion.
7. Owner curl procedure: `read -rs` into a shell variable and `curl -K <(printf ...)` so the token never appears in argv or history.

## Verification Evidence

Per `process/context/tests/all-tests.md` there is no general test framework and no CI; gates are typecheck, lint, clean build, a local disposable-Postgres probe, and read-only live checks. Tier names: Fully-Automated (deterministic command), Hybrid (needs local Postgres / dev server), Agent-Probe (judgment). Known-Gap is a residual, never a proving strategy.

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G1 `npm run typecheck` exits 0, plus the cheap loose-types gate: move `src/payload-types.ts` out, `npx tsc --noEmit` exits 0, move it back and `ls` it | Fully-Automated | AC-BUILD: new files type-check under strict AND loose Payload types |
| G2 `npm run lint` exits 0 (no new errors vs baseline) | Fully-Automated | AC-BUILD: lint clean |
| G3 clean-copy build with LOOSE Payload types (built from the working tree via `git ls-files`, not a fresh clone; run after the local commit of checklist step 7): copy the working tree via `git ls-files -z --cached --others --exclude-standard`, delete `src/payload-types.ts` and `.env.local` in the copy, symlink `node_modules`, set throwaway `DATABASE_URL`/`DATABASE_DIRECT_URL`/`PAYLOAD_SECRET`/`CENTRAL_SIGNING_SECRET` pointing at the disposable local DB, run `VERCEL_ENV=preview npm run vercel-build` (exit 0, route table shows `ƒ /api/public/tags`), then restore `importMap.js` in the real tree with `git checkout --` (`next build` rewrites it). Probe/script code must stay loose-type safe | Hybrid (disposable local DB + clean copy; dev machines type-check strictly, Vercel does not) | AC-BUILD: deployable on Vercel's real type conditions |
| G4 `npm run probe:public-tags` (local disposable Postgres; MANDATORY pre-flight first: `npx tsx scripts/public-tags-probe.ts --preflight` (imports only `scripts/lib/local-db-guard.ts`, prints `host:port/db`, exits non-zero on refusal) must pass BEFORE `npm run db:seed` and before any dev server starts, because plain `db:seed` has no local-DB guard (`scripts/seed.ts:422,431` guard only the opt-in GTP/Pressroom fixtures); then `npm run db:seed`; dev server running, `--http` default): published-only counting. Fixture tenant A: tag T1 used by 2 published + 1 draft(`workflowStatus` draft) + 1 hidden + 1 archived, tag T2 by 1 published, tag T3 by 0, tag T4 by 2 published where one is `_status:"draft"` + `workflowStatus:"published"` (must count), plus a raw duplicate `articles_rels` row on one published article (must not inflate: `count(DISTINCT)`). Expect `minCount=1` -> T1 count 2, T2 1, T4 2, no T3; `minCount=2` -> T1,T4. Also a local `SELECT DISTINCT path FROM articles_rels` confirms `path='tags'`. Mutations M1-M4 must each turn it red | Hybrid | AC-PUBLISHED: counts use `workflowStatus=published` only, not `_status`; duplicates not double counted |
| G5 probe: tenant isolation. Tenant B has tag `shared-slug` used by 5 published articles; tenant A has a tag with the same slug used by 2; plus TWO deliberately corrupted rel rows: an A article linked to a B tag (tag-side predicate) AND a B article linked to an A tag (article-side predicate). A's response never contains B's counts, B's tag, or inflated A counts; B's token returns only B's. Mutations M5 and M6 must each turn it red | Hybrid | AC-TENANT: cannot return another tenant's tags |
| G6 probe: parameter algorithm (`raw` null/blank -> default; else `n=Number(raw)`, non-finite -> default, `Math.floor`; `minCount` clamp [1,1000] default 1; `limit` floored `<1` -> 500 else clamp [1,2000]). Pinned expectations: `minCount` absent -> 1, empty -> 1, `0` -> 1, `-3` -> 1, `abc` -> 1, `1.5` -> 1, `2.7` -> 2, `Infinity` -> 1, `1e3` -> 1000, `5000` -> 1000; `limit` absent -> 500, empty -> 500, `0` -> 500, `-5` -> 500, `0.5` -> 500, `abc` -> 500, `2.5` -> 2, `1` -> 1 (1 row, correct `totalDocs`), `99999` -> 2000. `minCount=2` excludes count-1 tags; repeated params use the first value; ordering `count DESC, slug ASC, id ASC` and stable across two calls | Hybrid | AC-PARAMS: validation, cap and determinism |
| G7 probe: locale: tag with `en` and `vi` titles; `locale=vi` returns vi title, a tag with only `en` falls back to the tenant default-locale title, unsupported `locale=zz` clamps to default; a case where the tenant default locale differs from the requested locale (fallback goes to the tenant default, not the global `en`); a tag with no locale rows returns slug as title (never null) | Hybrid | AC-LOCALE: localized title handling |
| G8 probe: auth/gate: no token and bad token -> 401 `{ok:false,status:"unauthorized"}` and the 401 body byte-equals the `articles` 401 body; tenant with `features.articles=false` -> 404; `OPTIONS` -> 204 with CORS headers; response gzip when `Accept-Encoding: gzip` and body >= 1 KB (assert `Vary: Origin, Accept-Encoding`), identity otherwise (assert `Vary: Origin`) | Hybrid | AC-CONTRACT: auth, gate, CORS, gzip, Vary identical to siblings |
| G9a run AFTER the local commit of checklist step 7 (three-dot diff compares commits only): `git diff --name-status origin/main...HEAD` must be non-empty and list the three expected `A` files `src/app/api/public/tags/route.ts`, `src/lib/public-tags.ts`, `scripts/public-tags-probe.ts`, with the diff otherwise limited to this allow-list: `M` only for `package.json` plus the named docs/context files; no modified file under `src/app/api/public/` other than the new `tags/` (merge gate). G9b pairwise compare: a `git worktree` of `origin/main` as server B and the branch as server A, both on the SAME disposable DB and the SAME fixture token; request `GET /api/public/articles`, `/articles?view=refs`, `/articles/<slug>`, `/authors`, `/cities`, `/menus?type=header`, `/site` from both and compare normalized body (sorted keys) and the headers `content-type`, `access-control-*`, `vary`, `content-encoding`; must be identical. Mutation: alter a header in server A's `src/lib/public.ts` and confirm G9b turns red, revert it, commit state unchanged, and RE-RUN G9a to prove `src/lib/public.ts` is unmodified | G9a Fully-Automated; G9b Hybrid | AC-ADDITIVE: no existing route changes |
| G10 probe: query shape: run the disposable PG with `log_statement='all'` (or pg_stat_statements); assert as the PRIMARY assertion exactly 1 statement touching `articles_rels` per request; and, only on WARM requests, an equal TOTAL statement count for 50 vs 5,000 synthetic tags: send a warm-up request (same token, same route) before each measurement, use the SAME token for both scenarios within the 30 s token-memo window (`public.ts` memo), and never compare a cold first request (route compile, token lookup) with a warm one (bulk-insert the 5,000 via raw `generate_series` SQL, run-tagged and deleted in `finally`); mutation M12 (per-row lookup loop) must turn it red | Hybrid | AC-COST: single aggregate, no N+1 |
| G11 Owner-run read-only EXPLAIN on production (SELECT only, `EXPLAIN (ANALYZE, BUFFERS)` is read-only for SELECT) for tenant 7 and one big tenant; record actual rows, time and plan node types in the PR; abort criteria: sequential scan on `articles_rels` taking more than 500 ms | Agent-Probe (owner judgment of plan) | AC-COST: Neon cost acceptable |
| G12 Owner-run post-deploy curl checks (token via `read -rs` + `curl -K <(printf ...)`, never in argv, never printed): see Manual-first evidence, including the cross-tenant step with a token the owner picks at run time | Agent-Probe | AC-LIVE: production behavior, isolation, minCount |

SPEC criteria (derived from the owner decision, since no SPEC file exists): AC-ADDITIVE, AC-BUILD, AC-PUBLISHED, AC-TENANT, AC-PARAMS, AC-LOCALE, AC-CONTRACT, AC-COST, AC-LIVE. Each `proven by` the gate in the row above with the strategy tag shown. No criterion rests on Known-Gap alone.

Mutation proofs (checklist step 6): the probe must demonstrate red-then-green for M1-M12 in the Validate Contract's mutation table; a mutation that cannot turn its named assertion red does not count as proof for that row.

### Manual-first evidence pack (high-risk class: public API contract)

Collect in the PR description before merge, and again after deploy:

1. Probe transcript (G4-G10) from a local run, with the local DB banner (`host:port/db`) visible.
2. The post-commit diff `git diff origin/main...HEAD --name-status` and `--stat` (same three-dot form as G9a, run after the local commit and again after the G9b mutation is reverted) showing the three expected added files and only the intended others; an uncommitted or untracked-blind diff is not accepted.
3. Clean-build output tail (G3) including the route table.
4. Owner EXPLAIN output (G11).
5. Post-deploy read-only checks (owner runs). Token handling: `set +x`, history off, `read -rs GTP_READ_TOKEN` into a shell variable, and pass the header through a process-substitution config so the token never appears in argv: `curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$GTP_READ_TOKEN") "$URL"` (or a 0600 header file). Never echo it; label by prefix only (`9f3af5e9`).
   - `GET .../api/public/tags?minCount=2` returns 200, docs sorted by count desc, every `count >= 2`, `totalDocs` close to the measured 1,673 (about 434 + 1,239 = 1,673 at measurement time; drift expected).
   - `minCount=5` returns about 434 rows; `minCount=1` capped at `limit` with `totalDocs` about 6,500.
   - Spot-check three returned tags: `GET /api/public/articles?tag=<slug>&limit=1` `totalDocs` equals the returned `count` for that tag (this cross-checks published-only counting against the existing route, which uses the same predicate).
   - Same call without a token -> 401. Cross-tenant step: the owner picks any other tenant's read token at run time (same `read -rs` + `-K` procedure); expect 200 with that tenant's tags only and zero gtp-only slugs.
   - Existing routes spot check: `articles?limit=1`, `authors`, `site` return 200 as before.
   - `Accept-Encoding: gzip` response is smaller than identity for the 2000-row case.

## Implementation checklist (for EXECUTE, exact order)

1. Base and branch (DECIDED): `git fetch origin`, then branch from fresh `origin/main` (`a02a3d6` at validate time or later); never build on the stale `claude/clever-gates-h5xyd8`. Delivery is a PR. Re-run the additivity diff after any rebase.
2. Create `src/lib/public-tags.ts`: `parseMinCount(raw)` and `parseLimit(raw)` (raw is `string | null`) implementing the Design algorithm word for word: `null` or blank -> default; else `n = Number(raw)`; non-finite -> default; `Math.floor`; `minCount` default 1 clamp [1,1000]; `limit` default 500, floored `< 1` -> 500, else clamp [1,2000]; the helper returns exactly the Design expected-results table, `buildTagCountQuery({tenantId, minCount, limit, locale, defaultLocale})` returning the `sql` template per the Query section (all values bound; `'tags'` path and `'published'` as literals; final `t.id ASC` tiebreaker), `mapTagRows(rows)` (numeric coercion of `cnt`/`total`, `title ?? slug`, `totalDocs` from the window count, 0 when no rows).
3. Create `src/app/api/public/tags/route.ts`: `OPTIONS` -> `preflight`; `GET`: `getPayload`, `resolveReadToken` (401), `featureEnabled(tenant,"articles")` (404), parse params with the rule table, clamp locale, derive `defaultLocale` as defined in Design, run query via `(payload.db as unknown as {drizzle:{execute:(q:unknown)=>Promise<{rows:Record<string,unknown>[]}>}}).drizzle.execute(...)` (same cast the probes use; `sql` from `@payloadcms/db-postgres`), map, `jsonPublic(request,{docs,totalDocs},200)`; try/catch -> `console.error` with a fixed label only (no token, no SQL params, no tenant id) + 500 `internal_error`. Header comment documents tenant isolation, published-only rule and why raw SQL (no group-by in Payload).
4. Add the single `"probe:public-tags"` script to `package.json` (probe-only; no `node:test` script).
5. Write `scripts/public-tags-probe.ts` (including a `--preflight` mode that imports only `scripts/lib/local-db-guard.ts`, prints `host:port/db` and exits non-zero on refusal) in the style of `scripts/single-home-probe.ts`: `import "./lib/env"`; `assertLocalDb(process.env.DATABASE_URL)` BEFORE importing `payload.config` (exit 2 on refusal); refuse a non-loopback `PUBLIC_TAGS_PROBE_BASE` (as `hub-probe` does for `HUB_PROBE_BASE`; default `http://127.0.0.1:3511`); prove server-DB equality by requiring a 200 for the fixture token before any assertion (a server on another DB cannot know the fixture token); tag all fixtures with a run tag and delete in `finally`; create two fixture tenants with read tokens (hash via `hashToken` from `src/lib/crypto`), articles, tags, rel rows (including a raw duplicate rel and BOTH corrupt rels) per G4-G7; call the running dev server over HTTP for G4-G9; keep Payload results loose-type safe (cast through `unknown` or use `scripts/lib/payload-loose.ts`; `next build` type-checks `scripts/`); start dev servers with webpack in their own process group (`setsid sh -c "echo $$ > <pgid-file>; exec npx next dev -p <port>"`, stop with `kill -- -<PGID>`); exit code 0 only if every check passed, non-zero on any failure; print PASS/FAIL lines, never tokens.
6. Run G1 (including the cheap loose-types `tsc`), G2 (fix anything the new files introduce); run the local-DB pre-flight (`npx tsx scripts/public-tags-probe.ts --preflight`) and abort on any refusal; only then `npm run db:seed`, start the dev server(s), and run the probe G4-G10 locally, then the mutation proofs M1-M12 (apply each mutation, record the red assertion, revert, record green; a row that cannot go red is not proof); record all transcripts for the PR.
7. Make a LOCAL COMMIT of the EXECUTE changes on the PR branch (no push yet), then run G9a (`git diff --name-status origin/main...HEAD`: non-empty, three expected `A` files, allow-list otherwise) and G9b; after the temporary G9b `public.ts` mutation is reverted, re-run G9a. Then run G3 with the clean-copy method (the clean copy is built from the working tree via `git ls-files`, not a fresh clone), then restore `importMap.js` in the real tree with `git checkout --`.
8. Update docs on the `origin/main`-based branch: `docs/09-website-integration.md` (endpoint row + subsection: params, defaults, caps, truncation via `totalDocs`, the growth-margin/monitoring note, note that a duplicate tag slug (imports) would appear as two rows, caching advice: fetch once with ISR, not per request), `process/context/integrations/all-integrations.md` line 122 route list, `process/context/tests/all-tests.md` probe entry.
9. Open the PR (delivery decided: PR, owner merges), include the evidence pack; owner merges; deploy; owner runs G11 and G12.
10. UPDATE PROCESS: dated line in `process/context/all-context.md`; move this plan to `completed/` only after G12 passes.

## Risks and edge cases (vc-scenario highlights)

| Risk / edge case | Mitigation |
|---|---|
| `articles_rels.path` not literally `'tags'` (tab/group prefix) | G4 asserts non-zero counts; if prefixed, the probe fails loudly before merge. Confirm with `SELECT DISTINCT path FROM articles_rels` locally in EXECUTE. |
| Enum bound-parameter rejection (`workflow_status`, `_locale`) | literal `'published'`; locale cast `::"_locales"`; G4/G7 exercise both. |
| Tag deleted while rels remain | rels cascade on tag delete (`articles_rels_tags_fk ... ON DELETE cascade`), and the inner join to `tags` drops orphans anyway. |
| Same tag attached twice to one article | `count(DISTINCT parent_id)`. |
| Article in two tenants' view via corrupted rel | double tenant predicate (G5). |
| Hidden/archived/draft articles | excluded by `workflow_status = 'published'`; a published article later hidden drops out on the next call (no caching in the route). |
| Translated tag titles missing | COALESCE chain then slug (G7). |
| Large tenant slow cold start | G11 evidence; no index added in this plan. |
| Consumer caches a truncated list | `totalDocs` vs `docs.length` documented; v1 cap 2000 > gtp's 1,673 (84% of the cap, so growth can truncate again); the consumer must pass `limit=2000` and hide all chips when `docs.length < totalDocs` (see Follow-up). |
| 30 s token memo means a revoked token still works briefly | same accepted trade-off as every public route (`public.ts:92-106`). |

## Test Infra Improvement Notes

(none identified yet) Candidate, for UPDATE PROCESS to judge: this probe is the second place needing "byte-equality of existing public routes before/after a change"; a reusable golden-response snapshot helper in `scripts/lib/` would close the Known Gap "no automated regression check for the public API's response shape" in `tests/all-tests.md`.

## Follow-up (NOT part of this plan): gtp-web consumer change

Separate plan in the `gtp-web` repo, started only after Hard rule 1 is satisfied. Scope for that plan to cover: add a server-side `getTagsWithMinCount(2)` in the CMS client that calls `GET ${CMS_URL}/api/public/tags?minCount=2&limit=2000&locale=<l>` with the existing `CMS_READ_TOKEN` (it MUST pass `limit=2000`; the default 500 would silently truncate gtp's about 1,673 rows); consumer truncation rule: treat `docs.length < totalDocs` as degraded (log it) and then hide ALL tag chips rather than show a partial list, never an error page; growth margin: 1,673 is already about 84% of the 2,000 cap, so the owner re-checks `totalDocs` periodically (Agent-Probe monitoring note, also stated in `docs/09-website-integration.md`) and any cap raise is a separate decision; cache with ISR (for example `revalidate: 300`, tag-based revalidation consistent with the existing `/api/revalidate` webhook); render a chip only for tags present in the response; handle failure (fetch error or non-200) as "no chips", never as a page error; stop paging the full article list for tag counts; do not hard-code `minCount` in more than one place; verify with a Preview deployment against production CMS before merge. The next plan should reference this plan path and the live check results from G12.

## Owner decisions (22-10-26, "mac dinh" = planner defaults) - all DECIDED, no open questions

| # | Topic | Decision |
|---|---|---|
| 1 | Delivery | DECIDED: pull request from a branch off fresh `origin/main`; the owner reviews and merges. No direct commit on `main`. |
| 2 | Response cap / paging | DECIDED: default `limit` 500, hard cap 2000, no paging in v1; `totalDocs` lets a consumer detect truncation. |
| 3 | Invalid `minCount` | DECIDED: lenient (treated as the default 1, then clamped to [1,1000]); never a 400. |
| 4 | Feature gate | DECIDED: gated on `features.articles`; 404 `not_found` when off. |
| 5 | Pure-helper test file | DECIDED: probe-only. No `node:test` file, no new test script. |
| 6 | Non-gtp token for the G12 cross-tenant curl check | DECIDED: the owner picks any other tenant's read token at run time (not chosen at plan time). |

Explicit assumption (default-locale rule, to be confirmed by the owner at review if desired): `defaultLocale = clampLocale(tenant.defaultLanguage, supportedLanguages(tenant), "en")`, i.e. always a valid `_locales` enum member, falling back to `"en"` and then to the tag slug as the last title fallback. This mirrors Payload's `fallback: true` closely enough for tenants whose default language is their configured one, and cannot make the `::"_locales"` cast throw.

## Resume and Execution Handoff

1. Selected plan file path: `/home/user/apcg-cms/process/general-plans/active/gtp-public-tags-route_21-10-26/gtp-public-tags-route_PLAN_21-10-26.md`
2. Last completed phase/step: PLAN written (21-10-26); PVL-supplement cycle 1 applied (22-10-26, Gap 1-11); PVL-supplement cycle 2 applied (22-10-26, Gap A-D); PVL cycle 3 validated from V1 (22-10-26, Gate: PASS, 0 FAIL, 0 CONCERN); nothing implemented, no branch created, nothing committed.
3. Validate-contract status: written 22-10-26 by PVL cycle 3 (re-validate from V1), Gate: PASS, generated-by: outer-pvl, 0 FAIL, 0 CONCERN; Execute-agent instructions E1-E13 in the contract (E10-E13 are execution-time wording clarifications).
4. Supporting context files loaded: `process/context/all-context.md`, `integrations/all-integrations.md` (route table, public contract rules), `tests/all-tests.md` (Known Gaps, no test framework, Default Verification Order, 2026-10-15 webpack/process-group entry), `src/lib/public.ts`, `src/lib/scoped.ts`, `src/app/api/public/articles/route.ts`, `authors/route.ts`, `src/collections/Tags.ts`, initial schema migration, `src/console/data/db.ts`, `scripts/hub-probe.ts` and `single-home-probe.ts` headers, `scripts/lib/local-db-guard.ts`.
5. Next step for a fresh agent: after the orchestrator's /goal block and an explicit `ENTER EXECUTE MODE`, spawn `vc-execute-agent` (opus) with this exact path, branch from fresh `origin/main`, and follow the checklist in order including the local-DB `--preflight` before `db:seed` and the M1-M12 mutation proofs. Do not start gtp-web work.
Validators to run before handoff: `node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs <plan path>`.

## Validate Contract

Status: PASS
Date: 22-10-26
date: 2026-10-22
generated-by: outer-pvl
supersedes: 2026-10-22 (outer-pvl) — cycle 3 re-validation of the plan body after PVL-supplement cycle 2 (Gap A-D applied); this contract replaces the cycle-2 contract entirely

Parallel strategy: sequential (one opus vc-execute-agent for the three tightly-coupled source files; vc-tester and any reviewers on sonnet)
Rationale: 3/7 signals (S2 public-API surface, S6 high-risk class, S7 8 files); dominant signal S6. Score is MEDIUM, but the helper, route and probe form one coupled unit, so fan-out buys nothing. Cost guard not triggered (VALIDATE re-run = 4 Layer 1 + 5 Layer 2 = 9 agents).

Validation method note: V2 was executed in-session by this single validate agent applying the vc-validate-findings Layer 1 and Layer 2 role specs against the real code and against `origin/main` `65110dd` (fetched 22-10-26; the working checkout `claude/clever-gates-h5xyd8` is behind it). Between `a02a3d6` (the cycle-1/2 base) and `65110dd` the ONLY changed file is `process/context/integrations/all-integrations.md` (an `Articles.exclusive` copy note; the line-122 public-route row anchor still holds); `src/lib/public.ts`, `scoped.ts`, `tenant.ts`, `locales.ts`, `crypto.ts`, `src/collections/Tags.ts`, every `src/app/api/public/**` route, `src/migrations/**`, `scripts/lib/local-db-guard.ts`, `scripts/seed.ts` and `package.json` are unchanged. `validate-plan-artifact.mjs` on the plan: 0 failures, 0 warnings.

### Cycle-2 gaps A-D: re-verified closed (checked against the revised plan body and the real code)

| Gap | Check performed | Verdict |
|---|---|---|
| A parameter algorithm | The single algorithm (Design > Param algorithm; checklist step 2; G6 row; Test-gates AC-PARAMS row) is word-for-word the same in all four places, and each pinned value was recomputed by hand with it: minCount `absent,empty -> default 1`; `0 -> floor 0 -> clamp 1`; `-3 -> 1`; `abc -> NaN -> default 1`; `1.5 -> 1`; `2.7 -> 2`; `Infinity -> non-finite -> default 1`; `1e3 -> 1000`; `5000 -> clamp 1000`. limit `absent,empty -> default 500`; `0 -> floor 0 <1 -> 500`; `-5 -> 500`; `0.5 -> floor 0 -> 500`; `abc -> 500`; `2.5 -> 2`; `1 -> 1`; `99999 -> clamp 2000`. All 10 minCount and 9 limit expectations are correct and mutually consistent; `Number("")`/`Number(null)` = 0 is no longer relied on because null/blank are tested before `Number()`. | CLOSED |
| B commit before G9a | Checklist order is 4 (package.json script) -> 5 (probe) -> 6 (G1/G2, pre-flight, seed, probe, M1-M12) -> 7 (LOCAL COMMIT, then G9a, G9b, revert, re-run G9a, then G3) -> 8 (docs) -> 9 (PR). G9a is stated to run after that commit, to be non-empty and to list the three `A` files; evidence-pack item 2 uses the same post-commit three-dot form; G3 is scheduled after the commit as well. | CLOSED (two wording notes, see E10 and E11) |
| C local-DB pre-flight | `--preflight` is a mandatory step in G4 and checklist step 6 BEFORE `db:seed` and before any dev server; it uses `assertLocalDb`, which has no override of any kind (`scripts/lib/local-db-guard.ts`: hard refusal when the effective host is not one of `localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`; fixed messages; no confirm flag, unlike `assertLocalOrConfirmed`), so no environment variable can turn it off; the only env input is `DATABASE_URL` itself, and a shell-exported value wins over `.env.local` identically for `db:seed`, the probe and `next dev`. The probe also refuses a non-loopback `PUBLIC_TAGS_PROBE_BASE` and requires a fixture-token 200 before any assertion. Confirmed that plain `db:seed` guards only the opt-in GTP/Pressroom fixtures (`scripts/seed.ts:420-432`). | CLOSED (one wording note, see E13) |
| D stable G10 | G10 now states: primary assertion = exactly 1 statement touching `articles_rels` per request; equal TOTAL statement count for 50 vs 5,000 synthetic tags only on WARM requests; warm-up request before each measurement; same token for both scenarios inside the 30 s token memo (`src/lib/public.ts` memo); never compare a cold first request with a warm one; bulk insert via `generate_series`, run-tagged, deleted in `finally`; M12 must turn it red. The disposable PG is started with `pg_ctl -o '...' -l $P/pg.log` (`process/context/tests/all-tests.md`, Disposable one-shot Postgres entry), so `-c log_statement=all` is feasible. | CLOSED (one fixture note, see E12) |

Everything verified in cycles 1-2 was re-checked on `65110dd` and still holds: the SQL (aliases, `::"_locales"` cast, `HAVING` with a bound parameter, `count(*) OVER ()` evaluated before `LIMIT` so `totalDocs` is the pre-cap total, UNIQUE `("_locale","_parent_id")` on `tags_locales` so the two LEFT JOINs cannot multiply rows, `tags(id,tenant_id,slug)` and `tags_locales(title,_locale,_parent_id)`, `articles_rels(parent_id,path,tags_id)`, `articles.workflow_status` enum column, rel FK cascades, `tags_slug_idx` non-unique; correction 22-10-26: `tags_tenant_slug_idx` is UNIQUE on `(tenant_id, slug)`, so the `t.id ASC` tiebreaker is defensive only); `clampLocale(requested, supported, tenantDefault)` always returns a `LOCALE_CODES` member equal to the `_locales` enum, so `defaultLocale = clampLocale(tenant.defaultLanguage, supportedLanguages(tenant), "en")` cannot make the cast throw; `featureEnabled` and `supportedLanguages` are exported from `src/lib/tenant.ts`; `hashToken` from `src/lib/crypto.ts`; `sql` from `@payloadcms/db-postgres` and the `drizzle.execute` cast idiom are used by `scripts/hub-probe.ts` and `scripts/single-home-probe.ts`; 401 body `{ok:false,status:"unauthorized"}`, 404 `not_found`, `preflight` 204 with CORS, gzip threshold and `Vary: Origin, Accept-Encoding` vs `Vary: Origin` (`src/lib/public.ts`); the static `tags/` segment beats `[module]`, whose unknown-module answer is the 404 `not_found` body, so no collision; `articles?tag=` exists for the G12 cross-check; all files named in Touchpoints and "Read (not changed)" exist on `origin/main` and none of `src/app/api/public/tags/route.ts`, `src/lib/public-tags.ts`, `scripts/public-tags-probe.ts` exists yet. Note: no production request route in `src` uses `payload.db.drizzle` today (only scripts and probes do); this route is the first, which is why G4-G10 exercise it through the real dev-server route handler and G12 confirms it live.

### Layer 1 dimensions

| Dimension | Status | Findings |
|---|---|---|
| Infra fit | PASS | Runtime pool is Payload's own (`payload.config.ts` pool), no migration/env/collection change; route table and loose-types build gates follow the documented method; the unguarded `db:seed` is now preceded by the non-bypassable `--preflight`. |
| Test coverage | PASS | No test framework exists (`tests/all-tests.md`), so probe + typecheck/lint/clean build + owner-run live checks is the right shape; every developed behavior has a Hybrid or Agent-Probe gate (no vacuous green by Known-Gap); G6 expectations are pinned and correct; G9a is non-vacuous; G10 is stable on warm requests. |
| Breaking changes | PASS | Purely additive: zero diff on `public.ts`, `scoped.ts`, `tenant.ts`, `locales.ts`, `Tags.ts` and every existing public route against `origin/main`; the only observable change is `/api/public/tags` going from 404 to 200 for a valid token. |
| Security surface | PASS | Bearer-only, tenant from `resolveReadToken` (no tenant param); all values bound, locale allowlisted by `clampLocale` plus enum cast; response is `slug,title,count` (already public via `/articles`); double tenant predicate; cap 2000; read-only SQL; fixed-label `console.error`; probe cannot touch production (non-bypassable local-DB guard, loopback base, fixture-token 200). No auth/billing/secret change, so `vc-security` full pass is not required. |

### Layer 2 sections

| Section | Status | Notes |
|---|---|---|
| Design: contract + query | PASS | SQL and schema facts verified; parameter algorithm and expected values consistent and correct. |
| Touchpoints | PASS | Files exist or are new as stated; `package.json` row is probe-only; docs and route-list anchors hold on `origin/main`. |
| Verification Evidence (G1-G12) | PASS | G1-G12 sound and each can go red (M1-M12 table); G4/G6 pinned; G9a commit-ordered; G10 warm. |
| Implementation Checklist | PASS | Order is executable: script -> probe -> pre-flight -> seed -> probe/mutations -> commit -> additivity gates -> clean build -> docs -> PR. |
| Follow-up (gtp-web consumer) | PASS | `limit=2000`, degraded-on-truncation rule, ISR, failure = no chips, growth margin all present. |

**Totals: 0 FAILs / 0 CONCERNs / 4 Layer 1 PASSes + 5 Layer 2 PASSes**

Dimension findings:
- Infra fit: PASS — Payload's own pool, no migration/env change, non-bypassable local-DB pre-flight before `db:seed`.
- Test coverage: PASS — probe + build gates; every behavior Hybrid/Agent-Probe; G6/G9a/G10 fixed.
- Breaking changes: PASS — additive only; existing routes unchanged by construction and by G9b.
- Security surface: PASS — bearer tenant scope, bound params, double tenant predicate, cap 2000.
- Design feasibility: PASS — parameter algorithm recomputed by hand, SQL/schema facts verified.
- Verification feasibility: PASS — G1-G12 executable and red-able.
- Checklist feasibility: PASS — ordered, commit precedes G9a, pre-flight precedes seed.

Open gaps: none. Four non-blocking wording notes are carried as Execute-agent instructions E10-E13 below.

### Test gates (C3 table; strategy column carries only the 3 proving strategies)

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC-BUILD | route, helper and probe type-check and lint under strict AND loose Payload types | Fully-Automated | `npm run typecheck`; `npm run lint`; cheap loose gate: move `src/payload-types.ts` out, `npx tsc --noEmit` exit 0, move back and `ls` it | B |
| AC-BUILD | deployable on Vercel's real type conditions; route table lists `ƒ /api/public/tags` | Hybrid | G3: clean copy of the working tree via `git ls-files -z --cached --others --exclude-standard`, delete `src/payload-types.ts` and `.env.local` in the copy, symlink `node_modules`, throwaway `DATABASE_URL`/`DATABASE_DIRECT_URL`/`PAYLOAD_SECRET`/`CENTRAL_SIGNING_SECRET` pointing at the disposable local DB, `VERCEL_ENV=preview npm run vercel-build` | B |
| AC-ADDITIVE | no existing source file or route changed | Fully-Automated | G9a: `git diff --name-status origin/main...HEAD` run AFTER the work is committed on the branch (checklist step 7), lists only `A` for `src/app/api/public/tags/route.ts`, `src/lib/public-tags.ts`, `scripts/public-tags-probe.ts` plus `M` only for `package.json` and the named docs/context files, and the three `A` lines are present (non-empty diff) | B |
| AC-ADDITIVE | existing public routes answer identically (same DB, same token) | Hybrid | G9b: two servers (branch vs `git worktree` of `origin/main`), one disposable DB, pairwise normalized body + headers; mutation on server A's `public.ts` turns it red | B |
| AC-PUBLISHED | counts use `workflow_status='published'`, never `_status`; duplicates not double counted | Hybrid | G4 + duplicate-rel fixture; mutations M1-M4 each turn it red | B |
| AC-TENANT | other tenant's tags/counts never returned, from either side of the join | Hybrid | G5 with BOTH corrupt rels; mutations M5, M6 | B |
| AC-PARAMS | minCount/limit parse, clamp, order, `totalDocs`, determinism | Hybrid | G6 with a single pinned expectation per input: minCount `0,-3,abc,1.5,2.7,Infinity,1e3,empty,absent,5000` -> `1,1,1,1,2,1,1000,1,1,1000`; limit `0,-5,0.5,abc,2.5,empty,absent,1,99999` -> `500,500,500,500,2,500,500,1,2000` (algorithm: null/blank -> default; Number; non-finite -> default; floor; minCount clamp [1,1000]; limit `<1` -> 500 else clamp [1,2000]) | B |
| AC-LOCALE | localized title, fallback, enum-safe | Hybrid | G7 incl. tenant default differing from requested locale, `locale=zz`, and a tag with no title rows (slug fallback) | B |
| AC-CONTRACT | 401/404/204 CORS/gzip + `Vary` identical to siblings | Hybrid | G8 incl. `Vary` on gzip and identity and 401 body byte-equal to the `articles` 401 body | B |
| AC-COST | single aggregate, no N+1 | Hybrid | G10: exactly 1 statement touching `articles_rels` per request, and equal total statement count at 50 vs 5,000 tags measured on WARM requests; M12 turns it red | B |
| AC-COST | Neon plan acceptable | Agent-Probe | G11 owner-run read-only `EXPLAIN (ANALYZE, BUFFERS)` on tenant 7 and one large tenant | C (post-merge, owner) |
| AC-LIVE | production behavior, isolation, minCount, cross-check vs `/articles?tag=` | Agent-Probe | G12 owner-run curl pack (token via `read -rs` + `curl -K <(printf ...)`) | C (post-deploy, owner) |

Legacy line form (retained for existing consumers):
- build: [Fully-automated: `npm run typecheck`; `npm run lint`; loose-types `npx tsc --noEmit`] | [hybrid: clean-copy `VERCEL_ENV=preview npm run vercel-build` + local DB]
- additive: [Fully-automated: `git diff --name-status origin/main...HEAD` after commit] | [hybrid: two-server pairwise compare, same DB]
- route behavior: [hybrid: `npm run probe:public-tags` against disposable local Postgres + dev server on 127.0.0.1] | [agent-probe: G11 EXPLAIN, G12 live curl]
- residual: [known-gap: no automated regression of public API response shape in CI (`all-tests.md` Known Gaps); carried as gap-resolution D, not a proving strategy]

Failing stubs (Fully-Automated rows only):

```
test("should type-check and lint the route, helper and probe under strict and loose Payload types", () => {
  throw new Error("NOT IMPLEMENTED — TDD stub: should type-check and lint the route, helper and probe under strict and loose Payload types")
})
test("should change no existing source file under src/app/api/public or src/lib/public.ts", () => {
  throw new Error("NOT IMPLEMENTED — TDD stub: should change no existing source file under src/app/api/public or src/lib/public.ts")
})
```


### Mutation proofs the probe must demonstrate (red first; Execute-agent instruction E1)

Apply each mutation to the route/helper, run the probe, record the failing assertion, revert, record green. The SQL-text mutations are edits to the SQL builder in `src/lib/public-tags.ts`. The plan body (Verification Evidence mutation-proofs paragraph and checklist step 6) refers to this table by name; keep it in this contract on every re-write.

| # | Mutation | Assertion that must go red |
|---|---|---|
| M1 | predicate uses `_status='published'` instead of `workflow_status` | G4: T4 (`_status` draft + workflowStatus published) disappears |
| M2 | drop the `workflow_status = 'published'` predicate | G4: T1 count 5 instead of 2 |
| M3 | `count(DISTINCT r.parent_id)` to `count(*)` | G4: the duplicate-rel fixture inflates the count |
| M4 | `HAVING ... >=` to `>` | G4/G6: `minCount=2` omits count-2 tags |
| M5 | drop `t.tenant_id = $tenant` | G5: corrupt rel (A article to B tag) leaks B's tag into A |
| M6 | drop `a.tenant_id = $tenant` | G5: corrupt rel (B article to A tag) inflates A's count |
| M7 | remove the 1000/2000 clamps | G6: `minCount=5000` / `limit=99999` not clamped |
| M8 | flip `ORDER BY c.cnt DESC` | G6: order assertion |
| M9 | remove the title COALESCE fallback / slug fallback | G7: null or empty title for fallback tags |
| M10 | remove the `featureEnabled` gate | G8: `features.articles=false` tenant gets 200 not 404 |
| M11 | return `Response.json` instead of `jsonPublic` | G8: CORS/gzip/Vary assertions |
| M12 | add a per-row lookup loop | G10: statement count scales with tag count |


### Execute-agent instructions

- E1: run the mutation table above; a probe that cannot go red for a row does not count as proof for that row.
- E2: branch from fresh `origin/main` (`git fetch origin`; base was `65110dd` at validate time, `a02a3d6` earlier; re-run the additivity diff after any rebase). Do not build on `claude/clever-gates-h5xyd8`.
- E3: probe and any scripts must cast loose Payload results through `unknown` or use `scripts/lib/payload-loose.ts` (`next build` type-checks `scripts/`, per `tsconfig.json` include); never `as {id:number}` straight off `find().docs[n]`.
- E4: start probe dev servers with webpack (not Turbopack), in their own process group (`setsid sh -c "echo $$ > <pgid-file>; exec npx next dev -p <port>"`, stop with `kill -- -<PGID>`; never `pkill -f "next dev"`); restore `importMap.js` with `git checkout --` after any `next build`.
- E5: the route must `console.error` only a fixed label on failure (no token, no SQL params, no tenant id).
- E6: never print, log or write a read token anywhere (probe output, PR, report); label by prefix only.
- E7: do not edit `src/lib/public.ts`, `scoped.ts`, `tenant.ts`, `locales.ts`, any existing route, any collection, `src/migrations/**` or `payload.config.ts`. The only exception is the TEMPORARY G9b red-proof header mutation in server A's `public.ts`, which must be reverted and then G9a re-run on the committed branch to prove the file is unmodified.
- E8: run `git diff --name-status origin/main...HEAD` only after committing on the branch and confirm it is non-empty; for a pre-commit look use `git status --porcelain` or `git add -N`.
- E9: never run `npm run db:seed` or the probe before the local-DB banner check (`--preflight`) passes.
- E10: the docs edits (checklist step 8) land after the step-7 gates; before opening the PR, commit them and run `git diff --name-status origin/main...HEAD` once more on the final branch: it must still show only the three `A` files plus `M` for `package.json` and the named docs/context files, and attach that final output to the PR evidence.
- E11: G9a and G9b run in checklist step 7 (after the local commit), not in step 6; read the "G4-G10" ranges in step 6 and in evidence-pack item 1 as G4-G8 and G10, with G9 transcripts attached from step 7.
- E12: G10 synthetic tags (50 and 5,000) must each be linked to at least one PUBLISHED article of the fixture tenant so they are RETURNED rows (use `minCount=1&limit=2000` for the measurement); tags that never appear in the result would let M12 stay green, and per E1 that row would then not count as proof. Treat a missing `rows` field from `drizzle.execute` as an empty result in `mapTagRows` (probes cast `rows` as optional).
- E13: `--preflight` must load env exactly like `scripts/seed.ts` (`import "./lib/env"` first, static, same as the probe) so it inspects the same `DATABASE_URL` that `db:seed` and the dev server will use; do not read a different variable, do not add any override flag, and do not import `payload.config` or `@payloadcms/db-postgres` before the guard has passed (use dynamic `await import(...)` after `assertLocalDb`, as `single-home-probe.ts` does).

What this coverage does NOT prove:
- G1-G3 (typecheck/lint/build) do not prove the SQL returns correct rows or runs acceptably on Neon.
- Probe G4-G10 prove behavior on a disposable local Postgres with synthetic fixtures; they do not prove production plan quality, production data shape drift (tag/rel counts), pgbouncer pooled-endpoint behavior, Neon cold-start latency, or the real 6,506-tag cardinality.
- G9a/G9b prove existing routes are unchanged for the fixture token and the listed requests, not for every query-string combination or every tenant.
- The default-locale rule mirrors Payload's `fallback:true` only for tenants whose configured default language is where their tag titles live; a tenant with default `vi` and `en`-only titles gets the slug as title where Payload's own read would return the `en` title (accepted assumption, recorded in the plan's Owner decisions section).
- Nothing here proves `path='tags'` holds on production beyond the owner's earlier observation; the G4 non-zero count and a local `SELECT DISTINCT path FROM articles_rels` are the local proof.
- G11/G12 are owner-run after merge; until they pass, AC-COST (plan quality) and AC-LIVE are unproven. The consumer (gtp-web) behavior, caching and truncation handling are out of scope of this plan.
- No automated regression of public API response shape exists in CI (existing Known Gap, gap-resolution D).
- `payload.db.drizzle.execute` has no prior use in a production request route in this repo; only the dev-server probe (G4-G10) and the owner's G12 exercise it under serverless conditions.

Gate: PASS (no FAILs, no unresolved CONCERNs; plan body updated by PVL-supplement cycles 1-2; two cycles of supplements recorded in `results.tsv`)
Accepted by: n/a — Gate is PASS; no concern is outstanding or accepted (E10-E13 are execution-time wording clarifications, not accepted gaps)

## Autonomous Goal Block

SESSION GOAL: Add GET /api/public/tags?minCount= (additive public read route) to apcg-cms, merged by PR, so gtp-web can show a tag chip only for tags used by >= 2 published articles.
Charter + umbrella plan: N/A — single plan: process/general-plans/active/gtp-public-tags-route_21-10-26/gtp-public-tags-route_PLAN_21-10-26.md
Autonomy: proceed through reversible steps without asking; stop only on hard stops; delegate all edits to vc-execute-agent (opus) and gate runs to vc-tester (sonnet); never run production writes.
Hard stops / safety constraints:
- Never change any existing /api/public/* route, src/lib/public.ts, scoped.ts, tenant.ts, locales.ts, any collection or migration (only the temporary G9b red-proof mutation, reverted).
- Run the local-DB pre-flight (--preflight) before db:seed, the dev server and the probe; the probe runs only against a disposable local Postgres (scripts/lib/local-db-guard.ts, loopback base URL); never against production.
- Never print or store a read token; label by prefix only.
- gtp-web must not call the route until the CMS deploy is live and the owner-run G11/G12 pass.
- Branch from fresh origin/main; commit before G9a; open a PR; the owner merges; no push to main.
Next phase: EXECUTE (explicit "ENTER EXECUTE MODE" required): process/general-plans/active/gtp-public-tags-route_21-10-26/gtp-public-tags-route_PLAN_21-10-26.md
Validate contract: inline in plan (Gate: PASS, generated-by: outer-pvl, 2026-10-22, cycle 3)
Execute start: npm run typecheck && npm run lint | loose-types tsc + clean-copy VERCEL_ENV=preview npm run vercel-build | local-DB --preflight, then npm run probe:public-tags (disposable PG + dev server on 127.0.0.1:3511) incl. mutation table M1-M12 | owner-run G11 EXPLAIN + G12 curl | high-risk pack: yes (public API contract; risk-gate/verification/review-decision JSON in the task folder harness/ before merge)
