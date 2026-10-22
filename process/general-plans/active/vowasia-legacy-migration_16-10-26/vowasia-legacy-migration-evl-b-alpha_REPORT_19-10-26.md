---
name: report:vowasia-legacy-migration-evl-b-alpha
description: "Independent EVL confirmation run for VowAsia legacy migration Phase B stage B-alpha (HEAD cb211a0)"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: general
  phase: B-alpha
---

# EVL B-α confirmation (independent re-run) — 19-10-26

TL;DR: every B-α gate re-ran green at HEAD `cb211a0`. No real DB or network touched. Two minor notes, no failing gate.

| Gate | Command | Result | Pass |
|---|---|---|---|
| G1 | `npm run test:migrate-vowasia` | 95/95 pass | PASS |
| G2 | `npm run lint:migrate` | 0 errors, 1 pre-existing warning (`seed-gtp-legacy-fixture.ts:179 t50sec`) | PASS |
| G3 | `npm run typecheck` | exit 0 | PASS |
| G4 | `npm run test:migrate-gtp` | 69/69 | PASS |
| G5 | `npm run test:single-home` | 267/267 | PASS |
| G6 | `npm run probe:migrate-vowasia` (alone, no 543xx listener before) | ALL PROBE CHECKS PASSED, cleanup done | PASS |
| G7 | `git diff --name-only 84928ca -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | only `package.json` | PASS |
| G7b | `+` lines in package.json | exactly 2 (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`); `-` lines empty | PASS |
| G7c | untracked outside allowed dirs | none | PASS |
| G8/G20 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 | PASS |
| SQL unchanged | `git diff --quiet 84928ca -- scripts/migrate/vowasia/sql` | exit 0 | PASS |
| G10 (01 write keywords) | `! grep ... sql/01-*.sql` | clean | PASS |
| G10 password whitelist | as contract | clean; base green, 6 mutants (PASSWORD '..', E'..', $$..$$, multiline, literal on EXECUTE line, extra ALTER ROLE after EXECUTE) all RED (on copies in scratchpad, outside repo) | PASS |
| G10c | `! grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia --exclude=*.test.ts --exclude=keyset-probe.*` | clean | PASS |
| G10a | 01e write keywords / one statement / no psql meta | clean; 1 non-comment `;`; no line starting `\` | PASS |
| G13 | `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | exists | PASS |
| G18 (snapshot part), G21 | inside G1 (snapshot/measure/guard/pins tests) | green | PASS |

Spot checks:
- Files changed vs 84928ca (excl. process): package.json + 19 files under `scripts/migrate/vowasia/`, all within §3.8 B-α list (L786-787). PASS.
- Secrets grep on diff (`supabase.co`, `postgres(ql)://`, old project ref): only two fake localhost URLs in test files (`vowasia_migrator:x@localhost`, `fixture-pass@localhost`), allowed by G10c. No old project ref. PASS.
- measure opens no DB: `measure-vowasia-main.test.ts:40` asserts no connection; its source imports no `pg`/reader/banner. Note: it imports `snapshot-vowasia-main` and `vowasia-cli`, which transitively import `vowasia-reader`/`vowasia-db-banner` modules (no connection at runtime; import-graph only). Minor.
- Red-first: executor report claims 65 tests / 6 failing (module not found) before implementation; tests and implementation landed in the same commits so this is plausible but not provable from git history. Minor.

Not run (out of B-α scope): G11/G19 rehearsals, G22 review (agent), G23 owner run.

**Status:** DONE
