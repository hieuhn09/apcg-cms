---
name: report:vowasia-legacy-migration-evl-iteration-013
description: "EVL confirmation run (independent vc-tester) for Amendment 2 (pg_net allow-list in 02), HEAD 2ba3d96"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: general
  phase: amendment-2-evl
---

# EVL iteration 013: Amendment 2 confirmation (19-10-26)

**Result: all gates PASS.** Independent re-run on branch `claude/vowasia-launch`, HEAD `2ba3d96` (e424446, 2ba3d96 on top of 8c59f5c). No repo file edited except this report; no commit; no real database touched; mutations ran on a scratch copy outside the repo, deleted afterwards.

## Gate results (real outputs)

| Gate | Command | Result |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | PASS: tests 59, pass 59, fail 0 |
| G2 | `npm run lint:migrate` | PASS: 0 errors, 1 existing warning (`seed-gtp-legacy-fixture.ts:179 't50sec'`) |
| G3 | `npm run typecheck` | PASS: exit 0 |
| G4 | `npm run test:migrate-gtp` | PASS: 69/69 |
| G5 | `npm run test:single-home` | PASS: 267/267 |
| G6 + G14a-d | `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` (alone) | PASS: exit 0, 9 s, `ALL PROBE CHECKS PASSED`, `cleanup done`; G14a (net tables ALL to PUBLIC: 02 applies, NOTICE lists both, `SHOW default_transaction_read_only` = on), G14b/c/c'/d STOP lines present. After: no `/tmp/vowasia-probe-*`, no LISTEN on 54336 (only TIME_WAIT) |
| G7 | `git diff --name-only fe88bc4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | PASS: only `package.json` |
| G7b | `git diff -U0 fe88bc4 -- package.json \| grep -E '^\+[^+]'` | PASS: 3 lines, all contain `vowasia` |
| G7c | untracked outside vowasia/general-plans | PASS: empty |
| G8 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | PASS: exit 0 |
| G10 (01) | write keywords in `01-*.sql` | PASS: empty |
| G10a | write keywords in `01e`; `;` count; lines starting `\` | PASS: empty; 1 `;`; 0 |
| Password whitelist | as in plan | PASS: original GREEN; 6 mutations all RED (`PASSWORD '...'`, `E'...'`, `$$...$$`, line break, literal instead of `pw`, extra ALTER after EXECUTE) |
| G10c | `postgres(ql)?://` outside tests/probe | PASS: empty |
| G13 | backlog stub exists | PASS: exit 0 |

Note: `ss` is not installed; the pre-run port check was done via the probe's own `/dev/tcp` refusal guard and `/proc/net/tcp` (no LISTEN on 0xD440).

## Independent mutations of 02 (scratch copy, probe run per mutation)

| Mutation | Unit tests (G1) | Probe (G6) |
|---|---|---|
| Schema wildcard (`n.nspname = 'net'`) | RED | RED (G14b net.other must stop) |
| Remove `pg_db_role_setting` self-check | RED | RED (G14d) |
| Exemption relkind `IN ('r','v')` | RED | RED (G14c' view) |
| Exemption relkind any | RED | RED (G14c') |
| Self-check accepts any value (`=off` passes) | RED | **GREEN (probe blind)** |
| Delete `ALTER ROLE ... read_only = on` line | RED | RED |
| `ALTER ROLE ... = off` | RED | RED |
| Add third allow-list name `public.other` | RED | **GREEN (probe blind; its third table is `net.other`)** |
| Drop `has_any_column_privilege` from STOP query | **GREEN** | **GREEN (neither catches)** |

- Unit tests are text-based: they catch every change to the asserted strings, but not behavior. The probe alone misses "setting=off accepted" and "extra allow-listed name in another schema".
- The column-privilege branch existed before Amendment 2 (present at 8c59f5c); no gate exercises a column-only PUBLIC grant. Pre-existing coverage gap, not an Amendment 2 regression. Suggested follow-up: probe case with `GRANT SELECT (col) ON public.x TO PUBLIC` must STOP.
- Allow-list matching on `nspname || '.' || relname`: the two names contain exactly one dot, so no other schema/table split can collide (checked by reasoning).

## Diff review 8c59f5c..HEAD

- 8 files, all under `scripts/migrate/vowasia/` and the task folder. GTP files (`scripts/migrate` outside vowasia, `scripts/lib`, `src`, `docs`): unchanged.
- No credential-shaped strings in added lines; no `postgres://` in `.md` diffs.
- `01e`: still one statement (one `;`), no write keywords, no psql meta-commands.
- REVOKE/GRANT on `net.*`: none in `sql/*` (only a comment in 02 saying it does NOT); present only in `fixtures/keyset-probe.ts` against the disposable local PG16, which is expected.

## Status

DONE_WITH_CONCERNS (all gates green; concerns are coverage notes: probe blind to setting=off and to a third out-of-schema name; column-privilege path untested by any gate, pre-existing).
