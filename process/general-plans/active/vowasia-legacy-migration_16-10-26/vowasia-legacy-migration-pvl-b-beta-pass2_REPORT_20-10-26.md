---
name: report:vowasia-legacy-migration-pvl-b-beta-pass2
description: "Inner PVL pass 2 for Amendment 4 / stage B-beta of the VowAsia legacy migration: F1 and C1-C13 all closed; Gate CONDITIONAL on 3 new CONCERNs (stale §3 text with no precedence rule, B-beta phase-A gate set and G10c, rewrite-links rule for old-site links); no contract written"
date: 20-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-legacy-migration
  phase: B-beta
---

# PVL B-beta (Amendment 4), pass 2: Gate CONDITIONAL

## TL;DR

- **Gate: CONDITIONAL.** 0 FAIL, 3 CONCERNs. No `### Validate Contract (Chặng B-β)` written; the placeholder stays.
- **All 14 pass-1 gaps are closed.** F1 is fixed everywhere it appeared (4.1, 4.2.7, 4.4 item 8, AC-B11, 3.4 step 8, 3.5 item 9, 3.7 AC list, the L835 note). The owner rule is back: old drafts get no map entry, map = 349. Q12 "Dừng ngay" is recorded word for word. O-B5 and O-B12 are open owner items with hard STOPs and no default, which is acceptable.
- **No hard rule is broken.**
- **The 3 new CONCERNs:**
  1. Old §3 text still says the opposite of §4 in five places, and nothing says which one wins. This includes the `--min-coverage` sentence in 3.4 step 8, which is not marked superseded.
  2. The B-beta gate list does not say which phase-A gates still run (3.7 and 4.5 disagree). G10c, the check that keeps `postgres://` out of the owner guide, will go red as soon as the rehearsal script copies the GTP pattern.
  3. A new gap from the supplement: the `rewrite-links` flag takes one answer for all links, but OB5 asks the owner about each link. The rewrite target is also not stated.
- **Fix size:** one small plan-supplement. Then pass 3 can write the contract. A draft contract skeleton (gates, E-instructions, coverage table) is below so pass 3 is quick.

## Scope and base

- Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`, Amendment 4 (L948-1158), read with Amendment 3 §3.3-3.10.
- Branch `claude/vowasia-launch`, HEAD `f447a21`. `git diff --name-only 9d9e5a4 HEAD` lists only 4 files under `process/general-plans/`, so `9d9e5a4` is still a valid G7/G7b base.
- Inputs: pass-1 report `vowasia-legacy-migration-pvl-b-beta_REPORT_20-10-26.md` and iteration report `vowasia-legacy-migration-pvl-iteration-004_REPORT_20-10-26.md`.
- generated-by (for when a contract is written): `inner-pvl: B-beta`.
- How it ran: this subagent has no Agent tool. The 4 Layer 1 dimensions and the per-section Layer 2 checks ran in-session, one after another, against code (not summaries). Strategy score 3/7 (S2, S6, S7), as in pass 1.

## V1 pre-check

| Check | Result |
|---|---|
| `validate-plan-artifact.mjs` | 0 failures, 0 warnings |
| Paths used by Amendment 4 | all present: `scripts/migrate/vowasia/**` (B-alpha), the 11 pinned GTP files, `scripts/lib/{local-db-guard,central-db-name-guard,vowasia-taxonomy}.ts`, `scripts/audit/add-vowasia-taxonomy.ts`, GTP `rewrite-links-main.ts`, `rollback-main.ts`, `rehearse-gtp.sh` |
| Pinned-import closure | the 11 pinned files import only each other (`gtp-transform`→`gtp-mapping`→`legacy-sql`; `run-dir`→`out-dir`; `rollback-rules`→`run-dir`) plus npm packages. So "import only the pinned 11" is achievable without pulling in an unpinned GTP file. |
| Existing contracts | B-alpha PASS + B-beta placeholder. No `supersedes:` needed when B-beta's contract is written (the placeholder is not a contract). |

Cheap gates re-run at `f447a21` (read-only): G1 `npm run test:migrate-vowasia` 113/113; G7 empty; G7c ok; G8 `git diff --quiet fe88bc4 HEAD -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` exit 0; G10c (current form) exit 0. Pass 1 measured G2-G5 green at `9d9e5a4`. No code changed since, so they were not re-run.

## Closure check: F1 and C1-C13

| Gap | Closed? | Evidence |
|---|---|---|
| F1 old drafts in the map | yes | 4.1 last bullet, 4.2.7 (7 rules), 4.4 item 8, AC-B11 (4.5 and 3.7 L782), 3.4 step 8, 3.5 item 9, L835 note "ĐÃ RÚT". Arithmetic: 230 + 107 = 337; 337 + 12 = 349. Correct. |
| C1 date-fallback base | yes | 4.1, 4.2.6, 4.4 item 1 and item 6, AC-B15 (all-rows = 140 compared; imported number recorded) |
| C2 4 links / OB5 | yes, with a new gap | 4.2.3 classes, OB5 STOP before OB6, AC-B14, 3.9 O-B5, `--old-site-links` required with no default. New gap: see CONCERN 3. |
| C3 body as text | yes in §4, **not in §3** | 4.2.2 + 4.4 item 2 tests. 3.4 step 4 and 3.5 item 2 still describe the old HTML path; see CONCERN 1. |
| C4 lock scope + stale lock | yes | 4.4 item 6 (apply-only, `O_EXCL`, holder, no override, 5-step recovery + red-first test), item 9, item 13 crash case, OB7. The `ps` pattern matches the CLI names. |
| C5 rehearsal bootstrap | yes | 4.4 item 13 (seed.ts unchanged + `PAYLOAD_DB_PUSH=true`, `rehearse-bootstrap.ts` behind `assertLocalDb`, local taxonomy `--apply`, then fixture seed); one path `fixtures/`; 3.8 and 4.4 touchpoints agree. Local `--apply` needs no TTY (`assertLocalOrConfirmed` returns early for a local host, `local-db-guard.ts:96-103`). |
| C6 fixture entry file | yes | 4.4 item 11, touchpoints, `:fixture` mapping in item 14 |
| C7 upload error | yes | Q12 in 3.3 verbatim "Dừng ngay"; 4.3 step 4 two-branch split; 4.4 item 5 red-first (a)/(b); G29, AC-B16 |
| C8 dry-run location | yes | 4.4 item 6 (required `--runs-dir`, `assertOutsideRepo`, never `DEFAULT_OUT` which really is in-repo, `vowasia-cli.ts:25`); OB5 command has `--runs-dir` |
| C9 rollback media/report/delete error | yes | 4.4 item 7 (full body scan + test, dry report on stdout, no archive fallback; GTP's fallback is at `rollback-main.ts:159-160`) |
| C10 OB-R | yes | 4.6 item 2, 4.5 G19 note |
| C11 G11 | yes | 4.5 + 3.7 last row: after G19, never in parallel |
| C12 pins | yes | 4.3 rule; touchpoints exclude `gtp-import-pins.ts` |
| C13 taxonomy STOP | yes | 4.3 step 2 (5 pillars, 17 sub-sections, 4 tags, 6 authors; all present in `scripts/lib/vowasia-taxonomy.ts`; KB-2 table has exactly 17 distinct targets), G30, AC-B17 |

## Owner-item rule check (O-B5, O-B12)

| Item | Hard STOP before the write it affects? | Default picked? | Verdict |
|---|---|---|---|
| O-B5 (4 links) | yes: OB6 waits for the answer in 3.3; `rewrite-links` refuses without `--old-site-links` (no default) | no | acceptable |
| O-B12 (published row made draft by a broken stored image) | yes: the redirect builder stops and lists the rows; this only blocks OB11 | no | acceptable |

## Hard-rule check

| Rule | Verdict |
|---|---|
| Owner runs every production write and legacy read | ok (OB1-OB12; G19 is a local rehearsal; B-beta never reads the old DB) |
| No secrets in files | ok in text. R2 names only. But G10c will trip, see CONCERN 2 (a risk to the gate, not a leak) |
| Create-only; never creates authors or taxonomy | ok (4.3 step 2, G30; rollback deletes only its own run; no archive fallback) |
| Rollback per run, new run-id, no `--resume` | ok |
| Dry-run default; `--apply` = TTY + `--confirm-host` + `/neondb` banner | ok (non-local; local rehearsal is exempt by guard design, same as GTP) |
| Rehearsal once, alone, background, 7200000, no parallel `npm ci` | ok (G19; G11 after G19) |
| VowAsia DARK | ok (OB11 PR not merged before cutover) |
| Never rotate REVALIDATE_SECRET / CENTRAL_SIGNING_SECRET | ok (not touched; 4.8) |
| No orchestrator defaults for owner decisions | ok (C1-C10, Q9-Q12 kept; O-B5/O-B12 open with no default) |
| rewrite-links / timestamps-fix only on same-run rows | ok (Q11; 4.4 items 9, 10) |

## Net Gate Derivation

### Layer 1 dimensions

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | PASS (guards, ports 54346/54347/3518/3519 free, pinned closure, Media `prefix` hook `upload-integrity.ts:52` sets `vowasia` on create) |
| Test coverage | CONCERN (CONCERN 2: the B-beta gate list is ambiguous and G10c conflicts with the rehearsal files) |
| Breaking changes | PASS (7 additive scripts; no schema/API change; redirect JSON matches vowasia-web as checked in pass 1) |
| Security surface | PASS (hard rules all held; owner items have no default) |

### Layer 2 sections

| Layer 2 sections | Status |
|---|---|
| 3.3 / 3.4 / 3.5 / 3.9 (old text) | CONCERN (CONCERN 1: contradicts §4, no precedence rule) |
| 4.1 measured facts | CONCERN (part of CONCERN 1: wrong caveat on the 349) |
| 4.2 consequences | PASS |
| 4.3 design | PASS |
| 4.4 checklist | CONCERN (CONCERN 3: rewrite-links answer and target) |
| 4.5 gates/ACs | CONCERN (CONCERN 2) |
| 4.6 owner steps | CONCERN (OB5 asks per link; flag is all-or-nothing; same as CONCERN 3) |
| 4.7 evidence pack | PASS |
| 4.8 out of scope | PASS |
| 4.9 strategy | PASS |

**Totals: 0 FAIL / 3 CONCERNs (counted once each) / 9 PASS.**

**→ Net Gate: CONDITIONAL.** No FAIL. Three small spec gaps, all fixable in one supplement. Two of them (gate list, rewrite-links) change what EXECUTE and EVL would do, so a contract should not be written around them.

## Findings

| # | Finding | Severity | Proposed fix |
|---|---|---|---|
| CONCERN 1 | Old §3 text contradicts §4, and Amendment 4 does not say which wins. (a) 3.4 step 8 (L703) still defines `--min-coverage = (số URL có mục map) / (số bài nguồn published)`. That is the CF1 bug: the ratio can go above 1. It is not marked superseded by 4.4 item 8 / G28. (b) 3.4 step 4 (L692) still sends text through `sanitizeLegacyHtml` and then `htmlToLexical`, and 3.5 item 2 (L730) says "làm sạch thân bài". 4.2.2 says the opposite: text is escaped, split on blank lines, and never parsed as HTML. (c) 3.9 (L800-809) still lists Q2 and Q3 as "Còn mở / còn chặn" and KB-2 as "chưa đo"; 4.1 closes all three. (d) 3.5 items 9-13 use different numbers and paths than 4.4: 3.5 has B-12 = rehearsal at `rehearse-vowasia.sh` with no `fixtures/` and B-13 = docs; 4.4 has B-12 = verify, B-13 = rehearsal under `fixtures/`, B-14 = docs. (e) 4.1 last bullet and AC-B15 say 349 holds "if none of the 9 no-cover rows is an old draft or rejected". The count does not depend on that: old drafts get no entry either way, and rejected rows get a 410 either way. It depends on importer rejects among published/archived rows (slug `page`, slug clash, shape) and on O-B12 rows. | CONCERN | Add one line at the top of Amendment 4: "For stage B-beta, where §3.x and §4.x differ, §4.x governs." Mark (a)-(d) in place `[superseded by Amendment 4 §4.x]`. Fix the caveat in (e) to "349 unless the importer rejects a published/archived row or an O-B12 row exists; the dry-run prints the exact number". |
| CONCERN 2 | The B-beta gate list is ambiguous, and one phase-A gate will go red. 3.7 (L767) says phase B re-runs G9, G10/G10a/G10c, G13 and G14. 4.5 keeps only G1-G8 and G16-G22 plus the new gates. G10c (`! grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia --exclude="*.test.ts" --exclude="keyset-probe.*"`) is the only check that keeps a connection-URL scheme out of `VOWASIA-LEGACY.md`, which B-beta edits (part B). The new rehearsal and fixture files need local Postgres URLs. The GTP model `rehearse-gtp.sh` has 2 literal `postgres://`. Copying that turns G10c red; dropping G10c loses the doc check. | CONCERN | In 4.5, name the phase-A gates kept for B-beta, with exact commands: SQL unchanged `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/sql`; G10c with extra `--exclude` for `rehearse-vowasia.sh`, `rehearse-bootstrap.ts` and `seed-vowasia-legacy-fixture.ts`, plus a check that every `postgres(ql)://` in those three files is followed by a 127.0.0.1/localhost host; G13 `test -f`; G6 (which includes G14a-d). State that G9's role (review) is taken by G22, and that G10/G10a are covered by "SQL unchanged". |
| CONCERN 3 | rewrite-links rule for `old-site-article` links (new in this supplement). (a) OB5 asks the owner "for each old-site-article link: rewrite or keep", but `--old-site-links=rewrite\|keep` holds one value for all links. A mixed answer cannot be carried out, and the plan does not say what happens then. (b) The rewrite target is not stated. GTP rewrites to `/article/<slug>` only when the target is `published` in the SAME run's slug-map (`rewrite-links-main.ts:49`) and keeps everything else. VowAsia needs `/<pillar>/<slug>` (C3, Q4), and must say how the linked article is looked up (this run only, or every run in `--runs-dir`) and what happens when it is archived, draft, rejected or not imported. | CONCERN | (a) Either a per-link answer file (`--old-site-links-file <outside repo>`, each URL → `rewrite\|keep`; every `old-site-article` link must be listed, otherwise refuse), or the rule "the answer must be the same for all links; a mixed answer = STOP and a new amendment". Make OB5/OB8 match. (b) State the target: the relative path `/<pillar>/<slug>`, only when the linked article is imported and `published` (lookup over all runs' slug-maps in `--runs-dir`, or this run only, pick one and say why); anything else stays verbatim with a report line. Red-first tests for both. |

## Proposed plan updates (for the supplement)

| # | What changes | Where | Why |
|---|---|---|---|
| P1 | Precedence line; mark 4 stale passages superseded; fix the 349 caveat | top of Amendment 4; 3.4 steps 4 and 8; 3.5 items 2, 9-13; 3.9; 4.1; AC-B15 | CONCERN 1 |
| P2 | Name the phase-A gates kept for B-beta with exact commands; G10c exclusions + local-host check | 4.5 (and a pointer from 3.7) | CONCERN 2 |
| P3 | Per-link answer or uniform-answer rule; rewrite target and lookup; tests | 4.2.3, 4.4 item 9, 4.6 OB5/OB8, AC-B14 | CONCERN 3 |

## Execute-agent instructions to carry into the B-beta contract (not gaps)

E1-E9 from pass 1 stand: reuse `verifySnapshotInput`; R2 preflight checks non-empty values and prints names only; `context: { disableRevalidate: true, skipTranslationEnqueue: true }` on every write; Media created with `tenant` so the prefix hook sets `vowasia`; author lookup by tenant + name AND slug; fake hosts only; evidence pack in `{task folder}/harness/`; G7/G7b base `9d9e5a4` with exactly 7 added `package.json` lines; G19 alone. New:

- E10 The rehearsal puts snapshot `--out`, the image store and `--runs-dir` under a fresh `mktemp -d /tmp/vowasia-rehearse-XXXXXX`. `assertOutsideRepo` refuses the in-repo `scripts/migrate/out/...` that GTP's rehearsal uses.
- E11 `rehearse-bootstrap.ts` creates the tenant from `VOWASIA_TENANT_FIELDS` (`scripts/lib/vowasia-taxonomy.ts`: `features.articles` on, `autoPublishEngineDrafts` not true). Otherwise the taxonomy script's tenant preflight refuses `--apply` (`add-vowasia-taxonomy.ts` header).
- E12 `seed-vowasia-legacy-fixture.ts` gives the fake legacy PG (54346) the schema/view the closed snapshot builders read (follow `keyset-probe.sh`). The B-alpha image server binds a random port, so the fixture extension adds a fixed-port (3519) entry.
- E13 G11 runs as `REHEARSE_MODE=native REHEARSE_SKIP_NPM_CI=1 timeout 7200000 npm run rehearse:gtp`, after G19 has exited.
- E14 Every new test file lives in `scripts/migrate/vowasia/lib/*.test.ts`, so the existing G1 glob picks it up with no `package.json` change.
- E15 Create the G23 backlog stub (`process/general-plans/backlog/`) and gate it with `test -f`.

## III. Test coverage plan (B-beta, draft for pass 3)

| Area | Tier | Proving test / command | Proves | Does NOT prove |
|---|---|---|---|---|
| transform/body/author/slug/media/tags (B-2..B-6) | Fully-Automated | G24, G16 inside `npm run test:migrate-vowasia` | real 4.1 shapes, text not HTML, section order, alt/credit chain, 0 pending upload nodes, tag table, round-robin ≤ 1 | real Lexical render on vowasia-web |
| image-failure split (B-6, B-7) | Fully-Automated | G29 | store failure → draft + section dropped; upload throw → stop, no article create | real R2 failure modes |
| apply gates, taxonomy STOP, lock, sha chain, R2 preflight (B-7) | Fully-Automated | G17, G26, G30 | refusals fire before any write | real TTY / Neon behaviour |
| rollback (B-8) | Fully-Automated | G27 + 3 required scenario tests | per-run isolation, body-ref Media kept, dry-run writes nothing, no archive fallback | Payload delete on real Neon |
| redirects (B-9a) | Fully-Automated | G28 + G16b | owner map rules, CF1 ratio ≤ 1, O-B12 stop | vowasia-web serving |
| rewrite-links (B-9b) | Fully-Automated | G24 part | external untouched, flag required (pending CONCERN 3 rule) | the owner's real answer (G23) |
| timestamps SQL (B-10) | Fully-Automated | golden-file test | SQL text, WHERE marker + tenant + journal ids | execution on Neon |
| dry-run count block | Fully-Automated | G25 | every printed number on fixture data | real numbers (G23) |
| end-to-end on PG16 + local Central | Hybrid | G19 `npm run rehearse:vowasia` (alone) | runs A/B/C, crash + stale lock + rollback, Q12 stop, `prefix === "vowasia"`, mutants red | R2 upload (KB-6) |
| GTP unchanged | Hybrid + Fully-Automated | G11 after G19; G4, G8/G20 | GTP byte-identical and green | — |
| review | Agent-Probe | G22 `vc-code-reviewer` | judgement on write safety | machine proof |
| real data | residual (gap-resolution D) | G23 owner OB5-OB10 | — | everything until the owner runs it |

Gap options: KB-6 R2 upload is proven only at G23. Options: (C) accept, since the rehearsal uses local disk, or (D) backlog stub. G23: (D) backlog stub; B stays CONDITIONAL until the owner reports.

## Open gaps

- CONCERN 1-3 above.
- O-B5, O-B12: open owner items, STOP points, no default (acceptable).
- KB-1, KB-3 (G23), KB-5, KB-6 unchanged.

## What this validation did NOT prove

- No B-beta code exists yet. Every "feasible" verdict is against B-alpha code, the 11 pinned GTP files, GTP `rewrite-links-main.ts` / `rollback-main.ts` / `rehearse-gtp.sh`, and the vowasia-web contract checked in pass 1.
- G2-G6 and both rehearsals were not re-run in this pass (no code change since pass 1, which measured G2-G5 green).
- The 4 off-allow-list URLs and the no-cover split are still unseen (dry-run only).

## SUPPLEMENT REQUEST

- Gap 1: Section amendment-4-20-10-26-real-snapshot-measurement-b-0b-and-full-b-beta-design (top; §4.1 last bullet; AC-B15) plus Amendment 3 §3.4 steps 4 and 8, §3.5 items 2 and 9-13, §3.9 | Concern: old §3 text contradicts §4 (min-coverage numerator, body text as HTML, Q2/Q3/KB-2 still "open", B-step numbering/paths) and there is no precedence rule; the 349 caveat names the wrong dependency | Severity: CONCERN | Suggested addition: add "for B-beta, §4.x governs where §3.x differs", mark each listed §3 passage superseded, and restate the 349 caveat as "unless the importer rejects a published/archived row or an O-B12 row exists".
- Gap 2: Section amendment-4-20-10-26-real-snapshot-measurement-b-0b-and-full-b-beta-design (§4.5) | Concern: phase-A gates kept for B-beta are not named (3.7 vs 4.5), and G10c will go red on rehearsal/fixture files that need local `postgres://` URLs, while it is the only check guarding `VOWASIA-LEGACY.md` part B | Severity: CONCERN | Suggested addition: list the kept phase-A gates with exact commands (SQL-unchanged diff at `9d9e5a4`, G10c with excludes for the 3 rehearsal/fixture files plus a local-host-only check on them, G13, G6/G14) and say G22 replaces G9.
- Gap 3: Section amendment-4-20-10-26-real-snapshot-measurement-b-0b-and-full-b-beta-design (§4.2.3, §4.4 item 9, §4.6 OB5/OB8, AC-B14) | Concern: `--old-site-links` is one value for all links while OB5 asks per link; rewrite target and lookup are not stated | Severity: CONCERN | Suggested addition: per-link answer file (every old-site-article link listed, else refuse) or a uniform-answer rule with STOP on a mixed answer; target = `/<pillar>/<slug>` only when the linked article is imported and published (state lookup scope), else unchanged + report; red-first tests.

Gate: CONDITIONAL

**Status:** DONE_WITH_CONCERNS
**Summary:** All pass-1 gaps (F1, C1-C13) are closed and no hard rule is broken, but 3 new CONCERNs (stale §3 text with no precedence rule incl. the unmarked min-coverage sentence, an ambiguous B-beta phase-A gate set with a G10c conflict, and an underspecified rewrite-links answer/target) keep the gate CONDITIONAL; no contract written.
**Concerns/Blockers:** CONCERN 1-3 in the SUPPLEMENT REQUEST; results.tsv row for this pass left to the orchestrator.
