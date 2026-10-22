---
name: report:vowasia-legacy-migration-evl-b-alpha-cycle2
description: "Independent EVL re-run of all B-alpha gates after G22 fix cycle 1 (HEAD 31d79b7)"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  phase: B-alpha
---

# EVL B-alpha, cycle 2 (after G22 fix cycle 1)

**Verdict: PASS. Every B-alpha gate is green; every fix claim M1-M9, N1, N3 is confirmed. No failing items.**

HEAD `31d79b7` (fix `4448f64` + docs). BASE_BA `84928ca`. Tree clean before and after. No real DB, no network, no source edits, no commit.

## Gates

| Gate | Result |
|---|---|
| G1 `test:migrate-vowasia` | 113/113 pass |
| G2 `lint:migrate` | 0 errors, 1 pre-existing warning |
| G3 `typecheck` | exit 0 |
| G4 `test:migrate-gtp` | 69/69 |
| G5 `test:single-home` | 267/267 |
| G6 `probe:migrate-vowasia` (alone, nothing concurrent, no npm ci) | exit 0, ALL PROBE CHECKS PASSED, cleanup done |
| G7 vs 84928ca | only `package.json` |
| G7b | +2 lines (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`), 0 removed |
| G7c | empty |
| G8/G20 vs fe88bc4 | exit 0 |
| SQL vs 84928ca | exit 0 (unchanged) |
| G10 (01 write keywords) | clean |
| G10 password allow-list | base green; 6 mutants (PASSWORD '..', E'..', $$..$$, multiline, literal on EXECUTE line, extra ALTER ROLE after EXECUTE) all RED, run on copies in the scratchpad outside the repo |
| G10c | clean |
| G10a (01e) | no write keyword, 1 `;`, 0 lines starting `\` |
| G13 | backlog stub present |

## Fix claims

| Id | Check | Result |
|---|---|---|
| M1 | `isInside` uses `rel === ".."` / `startsWith(".." + sep)` / absolute (assert-outside-repo.ts:57); test 9 | confirmed |
| M2 | `realpathSync.native` + (dev, ino) ancestor compare (:89, :104); test 10 | confirmed |
| M3 | `git -C <ancestor> rev-parse --show-toplevel`, success -> insideGit, other error -> gitError (fail closed), GIT_* vars cleared (:82-108); tests 11-12 | confirmed |
| M4 | `Object.create(null)` accumulators (measure :45); test 25 | confirmed |
| M5 | `MEASURE_LIMITS {valueChars:60, topN:50}`; pairs hashed; test 26 | confirmed |
| M6 | `lib/image-refs.ts` counts relative + protocol-relative, keeps `photo(1).jpg`; tests 27, 49, 50 | confirmed |
| M7 | only `^[0-9a-f]{64}\.tmp-\d+-\d+$` deleted; storeForeign / storeCorrupt; tests 51-53 | confirmed |
| M8 | countRows before/after, mismatch -> countChanged, nothing written; tests 46-47 | confirmed |
| M9 | unpinned-import scan; test 19 | confirmed |
| N1 | `C8_LEGACY_PAIRS` checked before rename, new-name slugs rejected | confirmed |
| N3 | `{create:false}` check first; tests 13, 28, 48 | confirmed |

## Diff scope and secrets

- `git diff --name-only f569a7a HEAD`: only `scripts/migrate/vowasia/**` B-alpha files (incl. new `lib/image-refs.ts`, fixture `fake-legacy.ts`) + `process/`. `package.json` unchanged in the fix.
- Grep on `84928ca..HEAD` (excluding process/): no `supabase.co`; `postgresql://` only in two fake localhost test URLs; old project ref absent from `scripts`, `src`, `package.json`.

## Notes (not failures)

- M3 recognises "not a git repository" by English git text; a localised git falls closed (refuses), which is the safe direction.
- M2/M9 proofs rely on the executor's mutation runs; not re-mutated here.

## Unresolved questions

None.
