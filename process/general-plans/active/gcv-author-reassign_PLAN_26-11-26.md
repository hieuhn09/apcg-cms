# GCV author reassign and prune — PLAN (26-11-26)

Status: 🔨 CODE DONE 26-11-26 on branch `claude/gcv-author-reassign` (step 1; unit tests, typecheck, lint green; no DB run). Steps 2-3 (owner runs) pending.
Approved: owner chose option 2a + merge of trailing-space names, 26-11-26
Scope: tenant `gcv` only. Owner-run script against production Central (Neon `neondb`). No schema change, no CMS/hub code change.

## Why

The APCGHub composer lists every `authors` row of a tenant. GCV has 68. The 10-11-26 prune
(`npm run audit:prune-authors`, PR #64) only removes authors with no article, no latest-draft
version, no profile. Dry run 26-11-26 (`prune-authors.report-2026-11-26T09-49-22-064Z.csv`) found:

| Group | Rows | Usage |
|---|---|---|
| Engine pool (`ENGINE_POOLS.gcv`, 7 names, masthead) | 7 | engine + import articles |
| Real writers: Alexandre Rodrigues, Amelia Tan, Simon Ng, `Tu C. Nguyen ` (trailing space), `Valerie Nguyen`, `Valerie Nguyen ` (trailing space) | 6 | manual articles |
| Legacy-archive authors (incl. house name `Global Chic Voyage`) | 43 | 1–4 `origin='import'` articles each, ≈66 in total |
| Old names with 0 live article, only latest-draft version refs (Sofia I. Anders 246, Charlotte G. Harper 47, Madison L. Clarke 45, Victor J. Armand 16, Yumi Nishimura 11, Adrian M. Keller 9, Martin A. Leone 9, Huy Q. Vo 4, Clara J. Ellington 4, An M. Nguyen 3, Chau B. Hoang 2, Rizky A. Putra 2) | 12 | 398 `_articles_v` latest+draft rows |

Finding: 398 = the sum of `import_articles` of the 7 engine names. When GCV switched pen names
(04-09-26) `articles.author_id` of imported articles was moved to the 7 pool names, but their latest
`_articles_v` row (status `draft`) still names the old author. Those rows are not unpublished
articles; they are stale latest-version snapshots of live articles. Risk today: publishing such an
article from Payload admin reverts its author to the old name.

## Owner decisions

- D1: legacy-archive articles (43 authors, ≈66 articles) are reassigned to the 7 engine pool
  names (option a), spread evenly and deterministically. `Global Chic Voyage` is reassigned and deleted too.
- D2: `Valerie Nguyen ` (trailing space) merges into `Valerie Nguyen`.
  `Tu C. Nguyen ` has no twin: rename it to `Tu C. Nguyen` (trim).
- D3: stale latest-draft version rows are re-pointed to the author of their article's main row, not deleted.
- D4: afterwards, prune the now-unused GCV authors including ones with a profile (`--include-profiles`).
  Expected result: GCV keeps 12 authors (7 pool + 5 real writers).

## Steps

1. New owner script `scripts/audit/reassign-gcv-authors.ts` (`npm run audit:reassign-authors`),
   pure logic in `scripts/lib/reassign-authors.ts` with unit tests. Same guards as
   `prune-unused-authors.ts`: DB name banner, `--confirm-host`, `/neondb` name guard, dry run by
   default, `--apply --plan=<file>` needs a TTY + typed count, plan records the DB, re-check at apply,
   JSON backup of every row it changes before writing, one transaction.
   Operations (tenant gcv only):
   a. Sync: `_articles_v` rows with `latest = true` whose `version_author_id` is a REMOVE-set author
      and whose parent article's `author_id` differs ⇒ set to the parent's `author_id`.
   b. Reassign: `articles.author_id` of the 43 legacy-archive authors ⇒ pool name (deterministic
      round-robin by article id, balanced against the pool); same change on those articles' latest `_articles_v` row.
   c. Merge `Valerie Nguyen ` ⇒ `Valerie Nguyen` (main rows + latest version rows + co-author rels);
      rename `Tu C. Nguyen ` ⇒ `Tu C. Nguyen`.
   d. Refuse (abort) if any co-author rel (`articles_rels` / `_articles_v_rels` latest) points to a
      REMOVE-set author, or if any author outside the expected sets would be touched.
2. Owner runs dry run, reviews, runs `--apply`.
3. Owner runs `audit:prune-authors --tenant=gcv --include-profiles` dry run, then `--apply`.

## Execution notes (26-11-26)

- Files: `scripts/lib/reassign-authors.ts` (pure), `scripts/lib/reassign-authors.test.ts`
  (`npm run test:reassign-authors`), `scripts/audit/reassign-gcv-authors.ts`, `package.json`
  (`audit:reassign-authors`, `test:reassign-authors`).
- 1d decision: co-author rels on a REMOVE author are NOT moved; the script refuses and lists them
  (a co-author slot is an editorial choice). Also refuses: a REMOVE author with rank / user / engine or
  manual article, a missing or duplicated POOL name, a sync whose article main row has no author or an
  author outside gcv, a merge that would list `Valerie Nguyen` twice on one row, a rename twin.
- No denormalised author-name column exists on `articles` / `_articles_v` (checked collections +
  migrations); `updated_at` and `version` are not touched.
- Prune `--include-profiles` IS honoured on `--apply`: it is recorded in the plan file
  (`includeProfiles`) and read back; the flag itself is refused on the apply command line.

## Out of scope / known side effects

- Old articles show the new pen name on gcv web once its cache refreshes (direct SQL, no Payload hooks).
- Author pages of removed names disappear.
- Other tenants: later, same approach.

## Verification

- Unit tests for the pure planner. `npm test` (or repo test command) and typecheck pass.
- After apply: dry run of prune shows 0 draft refs for the 12 old names and 0 articles for the 43.
- Hub composer shows ≈12 GCV authors.
