---
name: report:vowasia-legacy-migration-g22-review-b-alpha
description: "G22 independent review of Phase B stage B-alpha (snapshot/measure/mapping/guard/pins) and EVL fix cycle 1"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: general-plans
  phase: B-alpha
---

# G22 review, Phase B stage B-alpha (VowAsia legacy migration)

**TL;DR:** reviewer verdict APPROVE_WITH_CONCERNS (0 BLOCKER, 0 MAJOR, 9 MINOR, 7 NIT). Fix cycle 1 fixed M1-M9, N1 and N3 in B-alpha files only, red-first; all B-alpha gates are green again. The same M1 flaw in phase-A `out-dir.ts` and in GTP, plus N2/N4/N6/N7 and the high-risk pack files, are recorded as follow-ups.

Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (`### Validate Contract (Chặng B-α)`). Reviewed HEAD: `f569a7a` (branch `claude/vowasia-launch`). Reviewer: `vc-code-reviewer` (sonnet).

## Verdict

| Item | Value |
|---|---|
| Verdict | APPROVE_WITH_CONCERNS |
| BLOCKER | 0 |
| MAJOR | 0 |
| MINOR | 9 (M1-M9) |
| NIT | 7 (N1-N7) |
| EXECUTE deviations 1-6 | all ACCEPTED |

## Findings (as stated by the reviewer)

| Id | Where | Finding | Disposition |
|---|---|---|---|
| M1 | `lib/assert-outside-repo.ts:26-29` | `rel.startsWith("..")` lets `<repo>/..hidden/x` through as "outside". | FIXED (cycle 1) |
| M2 | `lib/assert-outside-repo.ts` | String comparison can be bypassed on a case-insensitive file system (owner works on macOS). | FIXED (cycle 1) |
| M3 | `lib/assert-outside-repo.ts` | The guard only knows this checkout; another git working tree (sibling worktree, another clone) is accepted. | FIXED (cycle 1) |
| M4 | `lib/measure-vowasia-main.ts` | Accumulators are plain objects; legacy values `__proto__` / `constructor` corrupt counts. | FIXED (cycle 1) |
| M5 | `lib/measure-vowasia-main.ts` | Printed categorical values are uncapped (length and count); tags values and unmapped pairs print raw legacy text. | FIXED (cycle 1) |
| M6 | measure + `lib/snapshot-vowasia-main.ts` collector | Relative (`/x`, `src="/x.jpg"`) and protocol-relative (`//host/...`) image references are not counted; URL regex cuts `photo(1).jpg`. | FIXED (cycle 1) |
| M7 | snapshot download step | Leftover temp files of a crashed run and an existing `images/<sha>` are trusted without checks. | FIXED (cycle 1) |
| M8 | snapshot read step | No row count before/after the paged read; a row inserted during paging yields a silently incomplete snapshot. | FIXED (cycle 1) |
| M9 | `lib/gtp-import-pins.ts` | No test that every import from `scripts/migrate/lib/` under `scripts/migrate/vowasia/**` is pinned. | FIXED (cycle 1) |
| N1 | `lib/vowasia-mapping.ts` + test | Mapping accepts new-name slugs (for example `people-planners`) as legacy input; test comment claims the pairs were "seen by discover" (the cross table is NOT measured, KB-2). | FIXED (cycle 1) |
| N2 | (reviewer note) | Follow-up, not fixed in cycle 1. | FOLLOW-UP |
| N3 | measure / snapshot | Inputs are not all validated before directories are created. | FIXED (cycle 1) |
| N4 | (reviewer note) | Follow-up, not fixed in cycle 1. | FOLLOW-UP |
| N5 | (reviewer note) | Not listed for action by the orchestrator. | no action |
| N6 | (reviewer note) | Follow-up, not fixed in cycle 1. | FOLLOW-UP |
| N7 | (reviewer note) | Follow-up, not fixed in cycle 1. | FOLLOW-UP |

## Follow-ups (not fixed: outside the B-alpha file list, or deferred)

- M1-class flaw (`rel.startsWith("..")`) also exists in phase-A `scripts/migrate/vowasia/lib/out-dir.ts` and in the GTP `scripts/migrate/lib/out-dir.ts`. Not touched (phase-A file outside the B-alpha list; GTP files frozen by G8). Phase-A `vowasia-db-banner.ts` and `vowasia-sql.ts` also untouched as instructed.
- N2, N4, N6, N7: deferred.
- High-risk pack: `review-decision.json` and `adversarial-validation.json` (trust-boundary/secret class) are for the orchestrator/owner to produce; not written by EXECUTE.
- `VOWASIA-LEGACY.md` (phase-A doc, not in the B-alpha list) does not yet mention the new git-tree refusal; the message itself explains it (including the dotfiles-repo-at-home case).

## Fix cycle 1

Base for the gates: `BASE_BA = 84928ca`; work started at `f569a7a`. Files changed (all under `scripts/migrate/vowasia/`, B-alpha files only): `lib/assert-outside-repo.ts` (+test), `lib/measure-vowasia-main.ts` (+test), `lib/snapshot-vowasia-main.ts` (+test), `lib/vowasia-mapping.ts` (+test), `lib/gtp-import-pins.test.ts`, `fixtures/vowasia-legacy/fake-legacy.ts`, new `lib/image-refs.ts`.

### What was fixed

| Id | Fix | Proving test (red first) |
|---|---|---|
| M1 | `isInside`: outside only when `rel === ".."`, `rel.startsWith(".." + sep)` or absolute. | `M1: a sibling dir ... starts with '..'` (red before fix) |
| M2 | `realpathSync.native` on both sides, plus (dev, ino) of every ancestor of the nearest existing ancestor (spelled and real chain) compared with the repo root. | `M2: refuses by (dev, ino) ...`: the injection seam did not exist before, so it passed vacuously pre-fix; proven by mutation (disabling the inode check turns it red, 0/1). |
| M3 | `git -C <nearest existing ancestor> rev-parse --show-toplevel`: success refuses (`insideGit`, message names the dotfiles-at-home case); any other failure than "not a git repository" (git missing, dubious ownership) fails closed (`gitError`). GIT_DIR / GIT_WORK_TREE / ceiling vars cleared for the probe. | `M3: refuses any git working tree`, `M3: fails closed ...` (red before fix) |
| M4 | Prototype-free accumulators (`Object.create(null)`) and own-property increments for status/title/excerpt/urlPaths/pairs/tags. | `M4: __proto__ / constructor ...` (red by mutation back to `{}`: 0/1) |
| M5 | `publishableReport`: values cut to 60 chars, top 50 per block, truncation noted in the block header; unmapped pairs as `unmapped:<10-hex sha256>`; tags values printed only when every row is an array of short strings (else withheld). Both `measure-report.json` and `.md` use it. | `M5: printed categorical values are capped ...` (red before fix) |
| M6 | New `lib/image-refs.ts`: URL regex allows balanced parentheses; relative and protocol-relative references counted in measure (body + cover image) and in the snapshot collector (distinct); recorded in `manifest.json` (`relativeImageRefs`, `protocolRelativeImageRefs`) and the log line; never fetched. | `M6: ...` in measure and snapshot tests (red before fix) |
| M7 | Before downloading: delete only `^[0-9a-f]{64}\.tmp-\d+-\d+$`; any other non-sha file -> `storeForeign` (before any fetch); an existing `images/<sha>` is re-hashed before reuse, mismatch -> `storeCorrupt`. Workers stop on the first fatal error. | three `M7: ...` tests incl. crash simulation (red before fix) |
| M8 | `countRows` before and after the paged read; mismatch with each other or with rows read -> `countChanged`, nothing written; `snapshot-meta.json` records `rowCounts {before, after}`. Fake client gained count support and an insert-after-first-page option. | two `M8: ...` tests (red before fix) |
| M9 | Test scans every `.ts` under `scripts/migrate/vowasia/**` for relative imports resolving into `scripts/migrate/lib/` and asserts each is pinned. | passes on the current tree; proven by mutation (a temp file importing unpinned `legacy-reader` turns it red, 0/1). |
| N1 | `C8_LEGACY_PAIRS` (approved table, 17 legacy sub-sections + empty) checked before the rename; new-name slugs are rejected as legacy input; test comment now says the cross table is NOT measured (KB-2). | mapping test (red before fix: missing export) |
| N3 | `assertOutsideRepo(..., { create: false })` check first; measure verifies the snapshot before creating `--out`; snapshot read creates `--out` only after a successful read; download never creates a missing `--snapshot`. | `N3: ...` tests (red before fix) |

Behaviour change to note: the measure report no longer shows raw unmapped (section|subsection) pairs; the owner sees their counts and short hashes (the C8 verdict text stays).

### Gate evidence (19-10-26, after the fix)

| Gate | Result |
|---|---|
| G1 `npm run test:migrate-vowasia` | 113/113 pass (was 59 phase-A + B-alpha tests; +cycle-1 tests) |
| G2 `npm run lint:migrate` | 0 errors, 1 pre-existing warning (`seed-gtp-legacy-fixture.ts:179 't50sec'`) |
| G3 `npm run typecheck` | exit 0 |
| G4 `npm run test:migrate-gtp` | 69/69 |
| G5 `npm run test:single-home` | 267/267 |
| G6 `npm run probe:migrate-vowasia` (alone) | exit 0, ALL PROBE CHECKS PASSED, cleanup done |
| G7 vs `84928ca` | only `package.json` |
| G7b | exactly 2 added lines (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`), 0 removed |
| G7c | empty |
| G8/G20 vs `fe88bc4` | exit 0 (no GTP change) |
| SQL vs `84928ca` | exit 0 (unchanged) |
| G10 (01 write keywords, password allow-list, no `postgres://` outside tests/probe) | all pass |
| G10a (01e) | no write keyword, one statement terminator outside comments, no psql meta-command |
| G13 | backlog stub present |
