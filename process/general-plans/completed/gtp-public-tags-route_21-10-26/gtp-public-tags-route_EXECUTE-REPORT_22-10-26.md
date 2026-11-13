---
phase: gtp-public-tags-route-execute
date: 2026-10-22
status: COMPLETE
feature: none (general-plans)
plan: process/general-plans/active/gtp-public-tags-route_21-10-26/gtp-public-tags-route_PLAN_21-10-26.md
---

# EXECUTE report: GET /api/public/tags?minCount=

TL;DR: route, helper, probe and docs are built and committed on `claude/clever-gates-h5xyd8`. Every gate that can run locally is green (G1, G2, G3, G4-G8, G9a, G9b, G10) and all 12 mutations went red then green. G11 (EXPLAIN) and G12 (live curl) are owner-run after merge. Status: CODE DONE, not VERIFIED.

## What Was Done

| File | What |
|---|---|
| `src/lib/public-tags.ts:26-46` | `parseMinCount` / `parseLimit` (null or blank -> default; `Number`; non-finite -> default; `Math.floor`; minCount clamp [1,1000]; limit `<1` -> 500 else cap 2000) |
| `src/lib/public-tags.ts:55-75` | `buildTagCountQuery`: one aggregate, `workflow_status = 'published'` literal, tenant on article AND tag side, `count(DISTINCT parent_id)`, locale casts `::"_locales"`, order `cnt DESC, slug ASC, id ASC`, `count(*) OVER ()` for `totalDocs` |
| `src/lib/public-tags.ts:84-93` | `mapTagRows`: numeric coercion, `title` falls back to slug, missing `rows` = empty, `totalDocs` 0 when empty |
| `src/app/api/public/tags/route.ts:36-62` | `OPTIONS` -> `preflight`; `GET`: `resolveReadToken` (401), `featureEnabled(tenant,"articles")` (404), `clampLocale` for locale and default locale, query through `payload.db.drizzle.execute`, `jsonPublic(...,200)`; failure -> fixed-label `console.error` + 500 `internal_error` |
| `scripts/public-tags-probe.ts` | `--preflight` (guard only, before any Payload import), probe groups G4-G8 + G10 (`--only=` subset), `--compare <A> <B>` for G9b; loopback-only base; fixture-token 200 before assertions; run-tagged fixtures deleted in `finally`; tokens printed by 6-char prefix only |
| `package.json:56` | `"probe:public-tags": "tsx scripts/public-tags-probe.ts"` (only change) |
| `docs/09-website-integration.md` | endpoint row + subsection (params, caps, truncation via `totalDocs`, growth margin, duplicate slug, caching advice) |
| `process/context/integrations/all-integrations.md` | `/tags` in the public route row + raw-SQL / double tenant guard note |
| `process/context/tests/all-tests.md` | `probe:public-tags` row |

Environment: disposable native PG16 (`/usr/lib/postgresql/16/bin`, `/tmp/ptags-pg.*`, `127.0.0.1:54391/ptags`, `log_statement=all`), env passed from a scratch shell file (no `.env.local` exists in this checkout), `next dev` with webpack in its own process group on 3511 (branch) and 3512 (`git worktree` of `origin/main` `65110dd`). `src/payload-types.ts` (gitignored) was stale vs `main`'s podcastSeries change and was regenerated locally before G1; not committed.

## Test Gate Outcomes

| Gate | Command | Exit | Key output |
|---|---|---|---|
| Preflight | `npx tsx scripts/public-tags-probe.ts --preflight` | 0 | `[preflight] local database 127.0.0.1:54391/ptags — OK`; with a remote URL: exit 2, `local-db guard: DATABASE_URL is not a local database; refusing.` |
| Seed | `npm run db:seed` (output piped through a hex redaction filter) | 0 | `[seed] done` |
| G1 | `npm run typecheck` | 0 | no errors |
| G1 loose | move `src/payload-types.ts` out, `npx tsc --noEmit`, move back, `ls` | 0 | file restored |
| G2 | `npm run lint` | 0 | 0 errors; no warnings in the new files (pre-existing warnings only) |
| G4-G8, G10 | `npm run probe:public-tags` (`PUBLIC_TAGS_PROBE_PGLOG` = PG log) | 0 | `[probe] 70/70 checks passed`; G10: `50 tags: 50 rows, 1 statements (1 on articles_rels); 5000 tags: 2000 rows, 1 statements (1 on articles_rels)`; `G4 stored relationship path is 'tags'` and a tag attached through the Payload Local API is counted |
| G9a (after commit `00b7913`) | `git diff --name-status origin/main...HEAD` | 0 | `M package.json`, `A` route/helper/probe, plus the plan-folder files from commit `bbb8754`; nothing else under `src/` |
| G9b | `npx tsx scripts/public-tags-probe.ts --compare http://127.0.0.1:3511 http://127.0.0.1:3512` | 0 | `17/17`: `articles`, `articles?view=refs`, `articles/<slug>`, `authors`, `cities` (404 both, feature off), `menus?type=header`, `site`, identity and gzip, body + 7 headers identical |
| G9b red proof | `Access-Control-Max-Age` 86400 -> 86401 in server A's `src/lib/public.ts` | 1 | every G9b row FAIL; reverted with `git checkout --`; `git diff --quiet origin/main HEAD -- src/lib/public.ts` true; G9a re-run unchanged; compare re-run 17/17 |
| G3 | clean copy via `git ls-files`, no `payload-types.ts`/`.env.local`, `VERCEL_ENV=preview npm run vercel-build` | 0 | migrations skipped (preview), `✓ Compiled successfully`, route table `ƒ /api/public/tags` |
| G11 | owner | not run | post-merge |
| G12 | owner | not run | post-deploy |

Note on G8: `next dev` prepends its own `Vary` tokens (`Sec-CH-Prefers-Color-Scheme, RSC, ...`), so the probe asserts the route's part (`Origin` / `Origin, Accept-Encoding`) and that the full `Vary` equals the sibling `/authors` value.

## Mutation proofs (M1-M12)

Each mutation applied, probe group run (red), file restored and sha256 checked, group re-run (green).

| # | Mutation | Red (exit 1) | Green after revert |
|---|---|---|---|
| M1 | `a._status` instead of `workflow_status` | G4 exact list: T1=4, T4 lost | 7/7 |
| M2 | drop `workflow_status` predicate | G4: T1=5 | 7/7 |
| M3 | `count(*)` | G4: T4=3 (duplicate rel) | 7/7 |
| M4 | `HAVING >` | G4: minCount=1 returns 3 rows | 7/7 |
| M5 | drop `t.tenant_id` | G5: B tag leaks into A (`shared:1`) and A tag into B | 5/5 |
| M6 | drop `a.tenant_id` | G5: A shared count 3, B shared 6 | 5/5 |
| M7 | remove clamps | G6: `parseMinCount("5000")`=5000, `parseLimit("99999")`=99999 | 43/43 |
| M8 | `ORDER BY c.cnt ASC` | G6 order assertions | 43/43 |
| M9 | no COALESCE / no slug fallback | G7: `l2=null`, `l0=null` | 9/9 |
| M10 | remove `featureEnabled` gate | G8: gated tenant 200 | 9/9 |
| M11 | `Response.json` | G8: Vary/CORS/gzip | 9/9 |
| M12 | per-row lookup loop | G10: 51 vs 2001 statements | 7/7 |

## Plan Deviations

None in code or scope. Notes:
- Plan says "branch from fresh origin/main, not claude/clever-gates-h5xyd8"; per the orchestrator the branch IS `origin/main` `65110dd` + the plan commit, so the work was committed there (origin/main had not moved at fetch time).
- The plan-listed `process/context/` edits (step 8) were made in EXECUTE because the plan names them; `all-context.md` was left for UPDATE PROCESS as the plan says.
- Evidence for the high-risk pack (`harness/*.json`) is not written by this report; the transcripts above are the source for the PR description.

## What Was Skipped or Deferred

G11, G12 (owner, after merge/deploy). PR stays draft; not merged.

## Test Infra Gaps Found

None new. The `--compare` mode is a candidate seed for a reusable golden-response helper (plan's Test Infra note).

## Owner must run (after merge and deploy)

G11, read-only, on production (SELECT only), tenant 7 and one large tenant, e.g. via the Neon SQL editor:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT t.slug, COALESCE(l.title, d.title) AS title, c.cnt, count(*) OVER () AS total
FROM (
  SELECT r.tags_id, count(DISTINCT r.parent_id) AS cnt
  FROM articles_rels r JOIN articles a ON a.id = r.parent_id
  WHERE r.path = 'tags' AND r.tags_id IS NOT NULL AND a.tenant_id = 7 AND a.workflow_status = 'published'
  GROUP BY r.tags_id HAVING count(DISTINCT r.parent_id) >= 2
) c
JOIN tags t ON t.id = c.tags_id AND t.tenant_id = 7
LEFT JOIN tags_locales l ON l._parent_id = t.id AND l._locale = 'en'
LEFT JOIN tags_locales d ON d._parent_id = t.id AND d._locale = 'en'
ORDER BY c.cnt DESC, t.slug ASC, t.id ASC LIMIT 2000;
```

Abort criterion: a sequential scan on `articles_rels` taking more than 500 ms.

G12, token never in argv or output (label: prefix `9f3af5e9`):

```bash
set +x; set +o history
read -rs GTP_READ_TOKEN
U=https://<cms-host>/api/public
c() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$GTP_READ_TOKEN") "$@"; }
c "$U/tags?minCount=2&limit=2000" | jq '{n:(.docs|length), totalDocs, min:([.docs[].count]|min)}'   # ~1,673, all >= 2
c "$U/tags?minCount=5&limit=2000" | jq '.docs|length'                                                # ~434
c "$U/tags?minCount=1&limit=2000" | jq '{n:(.docs|length), totalDocs}'                                # 2000, ~6,500
c "$U/articles?tag=<slug>&limit=1" | jq .totalDocs    # equals that tag's count, 3 spot checks
curl -sS -o /dev/null -w '%{http_code}\n' "$U/tags"   # 401
c -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}\n' "$U/tags?minCount=1&limit=2000"   # smaller than identity
c -o /dev/null -w '%{size_download}\n' "$U/tags?minCount=1&limit=2000"
for p in 'articles?limit=1' authors site; do c -o /dev/null -w "$p %{http_code}\n" "$U/$p"; done
unset GTP_READ_TOKEN
```

Cross-tenant: repeat the first call with another tenant's token read the same way; expect only that tenant's tags.

## Closeout Packet

- Plan: `process/general-plans/active/gtp-public-tags-route_21-10-26/gtp-public-tags-route_PLAN_21-10-26.md`
- Verified locally: G1-G10, M1-M12. Unverified: production plan (G11), live behavior (G12).
- Classification: Keep in active/testing (until merge + G11/G12).
- Next: owner review of draft PR #49, merge, deploy, G11, G12; then UPDATE PROCESS.

## Forward Preview

- Test Infra Found: native PG16 at `/usr/lib/postgresql/16/bin` (run as `postgres`); `next dev` adds framework `Vary` tokens.
- Blast Radius Changes: none beyond the plan.
- Commands to Stay Green: `npm run typecheck`, `npm run lint`, `npx tsx scripts/public-tags-probe.ts --preflight`, `npm run probe:public-tags`.
- Dependency Changes: none.

## Review fixes (22-10-26, review APPROVE_WITH_CONCERNS)

- M1: verified `src/migrations/20260801_082303_migration_hardening.ts:84` creates `CREATE UNIQUE INDEX "tags_tenant_slug_idx" ON "tags" ("tenant_id","slug")`. Docs bullet reworded (unique per tenant by hook + index; the id tiebreaker is defensive only). Plan body corrected in two places. Correction of this report: the earlier "duplicate slug appears as two rows" note in the docs row above is superseded.
- M2: `docs/09-website-integration.md` — blank line + `| Endpoint | Returns |` header restored before the `/site`, `/menus`, `/podcasts`, `/preview` rows so they render as a table again; `/tags` row unchanged.
- M3: route `catch` now logs `{ name, code }` only (error name + Postgres `code`/`cause.code` via `pgErrorCode`, mirrored into `src/lib/public-tags.ts` from `hub-article-lock.ts`). Body still 500 `internal_error`.
- N1: new `rowsOrThrow(res)` in `src/lib/public-tags.ts`; the route throws (500 path) when the `drizzle.execute` result has no `rows` array. `mapTagRows` unchanged (still tolerant per E12). Probe G6 gained one check.

Gates (disposable PG16 `127.0.0.1:54411/ptags`, `log_statement=all`, data dir `/tmp/rfpg.*` because `/tmp/claude-0` is root-only and postgres cannot run there):

| Gate | Exit | Key output |
|---|---|---|
| `npm run typecheck` | 0 | no errors |
| loose tsc (payload-types moved out/back) | 0 | file restored |
| `npm run lint` | 0 | 0 errors |
| preflight / db:seed | 0 / 0 | `local database 127.0.0.1:54411/ptags — OK`, `[seed] done` |
| `npm run probe:public-tags` | 0 | `[probe] 71/71 checks passed` (was 70) |
| N1 mutation (guard line removed) | 1 | `FAIL G6 N1 result without a rows array throws`, 43/44; restored, sha256 match, 44/44 |

## Correction note (23-10-26, added by UPDATE PROCESS; history above not rewritten)

G12 was run live on production on 23-10-26 (owner, temporary gtp read token `g12-check`, revoked afterwards, 401 confirmed). The "~1,673" and "~434" figures in the G12 script above were estimates and are wrong. Measured: `minCount=2&limit=2000` -> n=1206, totalDocs=1206; `minCount=5` -> 299; `minCount=1&limit=2000` -> n=2000, totalDocs=5037 (truncation signal works); `articles?tag=<slug>&limit=1` totalDocs equals the tag count for 3 spot checks (aviation-safety 65, tourism-investment 3, yunnan-province 2); no token -> 401; gzip 15,187 B vs 75,448 B identity at `minCount=2`; `articles?limit=1`, `authors`, `site` still 200. Cross-tenant was not checked live (covered by the local probe, 71 checks). Merged as apcg-cms#49 (`4f3a8f1`), deployed to production.
