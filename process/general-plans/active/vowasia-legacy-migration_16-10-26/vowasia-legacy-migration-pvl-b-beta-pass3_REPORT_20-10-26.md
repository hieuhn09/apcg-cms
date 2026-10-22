---
name: report:vowasia-legacy-migration-pvl-b-beta-pass3
description: "Inner PVL pass 3 for Amendment 4 / stage B-beta of the VowAsia legacy migration: pass-2 gaps 1-3 closed; two new issues (answer-file scope vs OB8, G10c-local vacuous pass) fixed by validator wording V-W3/V-W4; Gate PASS; B-beta validate-contract and goal block written"
date: 20-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-legacy-migration
  phase: B-beta
---

# PVL B-beta (Amendment 4), pass 3: Gate PASS

## TL;DR

- **Gate: PASS.** 0 FAIL, 0 open CONCERN. `### Validate Contract (Chặng B-β)` replaces the GATED placeholder in the plan, with `generated-by: inner-pvl: B-beta`, `date: 2026-10-20`, and a `### Autonomous Goal Block (Chặng B-β)` after it.
- **Pass-2 gaps 1-3 are closed** (precedence line + superseded markers; kept phase-A gates with commands; per-link answer file with target and lookup).
- **The supplement added two new problems; both are fixed with small validator wording changes (V6 step 1, same as V-W1/V-W2 in the B-α pass):**
  - V-W3: the answer file's "extra entry" rule could be read as "not in this run". OB8 passes the same file to every run, so that reading would refuse run A or run B. It now says "not in the whole verified snapshot".
  - V-W4: G10c-local passed when its 3 files were missing (measured: exit 0). It now starts with 3 `test -f` checks. Measured after the fix: missing files exit 1, literal local URLs exit 0, a non-local URL exits 1.
- **Six implementation details go to EXECUTE as instructions (E16-E21), not plan changes.** The main ones:
  - `assertOutsideRepo` must be called on the answer file's directory. Called on the file itself, `git -C <file>` exits 128 and the guard refuses every valid file.
  - rewrite-links must re-record the baseline so rollback still deletes rewritten rows (Q11).
  - The pass-2 E13 used shell `timeout 7200000`, which means seconds. It is corrected to the Bash tool's 7200000 ms.
- **No hard rule is broken.** O-B5 and O-B12 remain open owner items, each a hard STOP with no default.
- **Next:** the owner says "ENTER EXECUTE MODE" for stage B-beta. G23 (the owner run on `neondb`) and the high-risk evidence pack are still needed before B-beta can be closed.

## Scope and base

- Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`, Amendment 4, read with Amendment 3 §3.3-3.10.
- Branch `claude/vowasia-launch`, HEAD `b5ccad6`; tree clean at start. `git diff --name-only 9d9e5a4 HEAD` = only files in this task folder, so `9d9e5a4` is still the G7/G7b base.
- Inputs: pass-2 report, iteration-005 report, supplement diff `f447a21..b5ccad6` (plan +53/-21).
- How it ran: this subagent has no Agent tool, so the 4 Layer 1 dimensions and the per-section Layer 2 checks ran in-session against the code and against measured shell runs, not summaries. Strategy score 3/7 (S2, S6, S7), as in passes 1-2.

## V1 pre-check

| Check | Result |
|---|---|
| `validate-plan-artifact.mjs` | 0 failures, 0 warnings (before and after the contract write) |
| Paths | B-α code under `scripts/migrate/vowasia/**`, the 11 pinned GTP files, `assert-outside-repo.ts`, GTP `rewrite-links-main.ts` / `rollback-main.ts` / `rehearse-gtp.sh`, `vowasia-web` @ `da9716c`: all present |
| Umbrella plan with `## Stable Program Goal` | none on disk (only "N/A" mentions in this plan) -> BRANCH A, goal block written |
| Prior contract | placeholder only ("Status: GATED", no gate) -> no `supersedes:` line |

Cheap gates re-run at `b5ccad6` (read-only): G1 113/113; G4 69/69; G5 267/267; G8 exit 0; SQL unchanged at `9d9e5a4` exit 0; G10c (new exclude form) exit 0; G7c exit 0; G13 exit 0. `vowasia-web` redirect contract unchanged (410 for object values, 308 for strings, map `{}`).

## Closure check: pass-2 gaps

| Gap | Closed? | Evidence |
|---|---|---|
| 1 precedence / stale §3 | yes | Precedence line under the Amendment 4 heading; `[Superseded ...]` on 3.4 steps 4 and 8, 3.5 items 2 and 9-13, the 3.7 intro; 3.9 Q2/Q3/KB-2 marked closed; 349 caveat restated in 4.1 and AC-B15 |
| 2 kept phase-A gates, G10c | yes, with a new hole (V-W4) | §4.5 list: SQL unchanged, G10c with 3 excludes, G10c-local, G13, G6, G9 -> G22 |
| 3 per-link answer / target | yes, with a new contradiction (V-W3) | §4.2.3 answer file, refusal rules, target `/<pillar>/<slug>` same-run only; §4.4 item 9 tests 1-10; OB5/OB8; AC-B14 |

## New findings in pass 3

| # | Finding | Severity | Resolution |
|---|---|---|---|
| N1 | §4.2.3 refuses "a link that is not found (extra/unknown entry)" right after "found in the run's articles". The natural reading is per run. OB8 passes ONE file to every run, and OB5 has the owner answer for all links in the whole snapshot. If the old-site links fall in both run A (`--limit 50`) and run B, the per-run reading refuses one of them. | CONCERN (fails safe, but blocks the owner flow) | **V-W3 (plan wording):** "extra" = not among the snapshot-wide `old-site-article` links; entries for other runs are accepted and ignored. Test (4) is reworded. E16 adds the shared extractor, an exact-URL key, and the empty-file rule. |
| N2 | The G10c-local command exits 0 when the 3 files are missing (measured). The main G10c excludes them by basename, so a file with one of those names in the wrong place escapes both checks. Also measured: the B-α `keyset-probe.ts` template form (`@127.0.0.1:${PORT}`) is flagged red, and E12 says to follow the keyset probe. | CONCERN (gate soundness) | **V-W4 (plan wording):** 3 `test -f` guards, plus a note that URLs need a literal host and port. E12 says not to copy the template form. E19 requires the gate to be shown red during EXECUTE. |
| N3 | §4.2.3 says the answer file is "checked with `assertOutsideRepo`". That guard is a directory guard. On an existing file it runs `git -C <file>`, which exits 128 ("Not a directory", measured), and it turns that into a `gitError` refusal. On a missing path it creates a directory. | implementation detail (red-first test 6 would catch it) | E17: guard `path.dirname(realpath)` with `create:false` and require a regular file. Tests for both accept and refuse. |
| N4 | Q11 says the run's rollback covers rewritten rows. Rollback keeps "edited" rows unless the baseline matches. GTP re-baselines after a rewrite (`rewrite-links-main.ts:79-81`), but no B-beta test checks this. GTP also writes a dry report into the run dir, which test (10) forbids. | implementation detail | E18: copy the re-baseline step and add a red-first test (import -> rewrite --apply -> rollback --apply deletes the row). Do not copy the dry report write. |
| N5 | The pass-2 E13 wrote `timeout 7200000 npm run rehearse:gtp`. GNU `timeout` reads that as 7,200,000 seconds. The hard rule means the Bash tool's 7200000 ms. | contract input error | E13 corrected: `run_in_background: true`, `timeout: 7200000` ms, and no shell `timeout`. |
| N6 | Rewriting a plain-text URL into a bare relative path inside prose may read oddly on `vowasia-web`. | note | E16: the rewrite-links dry-run prints the exact replacement text, so the owner sees it at OB8 before `--apply`. Listed under "does NOT prove". |

N1 and N2 change what EXECUTE/EVL would do, so they were fixed in the plan before writing the contract. Neither fix changes scope, files, gates or an owner decision. N3-N6 have exactly one correct implementation, so they are execute-agent instructions.

## Owner-item and hard-rule check

| Rule | Verdict |
|---|---|
| O-B5 | OB5 STOP before OB6; answer file required, no default (E21) — acceptable |
| O-B12 | redirect builder STOPS and lists rows, no default — acceptable |
| Owner runs every production write and legacy read | ok; agents run only local G19/G11 |
| No secrets in files | ok; answer file holds slugs + public URLs only; G10c/G10c-local enforce text hygiene |
| Create-only; no authors/taxonomy | ok (§4.3 step 2, G30) |
| Rollback per run, new run-id, no `--resume` | ok |
| Dry-run default; `--apply` = TTY + `--confirm-host` + `/neondb` | ok |
| Rehearsal once, alone, background, 7200000, no parallel `npm ci` | ok (E9, E13 corrected) |
| VowAsia DARK; never rotate REVALIDATE_SECRET / CENTRAL_SIGNING_SECRET | ok |
| No orchestrator defaults (C1-C10, Q9-Q12) | ok; V-W3 is a consistency fix forced by OB5+OB8, not a new decision |
| rewrite-links / timestamps-fix only same-run rows | ok (Q11; target lookup same run; E18 keeps rollback coverage) |

## Net Gate Derivation

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | PASS |
| Test coverage | PASS (after V-W4; E19 red proof required) |
| Breaking changes | PASS |
| Security surface | PASS |

| Layer 2 sections | Status |
|---|---|
| §3.x stale text | PASS (precedence + markers) |
| §4.1 measured facts | PASS |
| §4.2 consequences | PASS after V-W3 |
| §4.3 design | PASS |
| §4.4 checklist | PASS (E16-E18 carry details) |
| §4.5 gates/ACs | PASS after V-W4 |
| §4.6 owner steps | PASS |
| §4.7 / §4.8 / §4.9 | PASS |

**Totals: 0 FAIL / 0 open CONCERN (2 found and fixed in plan: V-W3, V-W4) / 12 PASS. Net Gate: PASS.**

## III. Test coverage plan (B-beta)

The full C3 table, failing stubs, legacy line form and "What This Coverage Does NOT Prove" are in the contract in the plan. Summary:

| Area | Tier | Proving gate |
|---|---|---|
| transform, body, author, slug, media, import gates, rollback, redirects, rewrite-links, timestamps, verify | Fully-Automated | G1 `npm run test:migrate-vowasia` (G24-G30, G16b, G17) |
| end-to-end on PG16 + local Central | Hybrid | G19 `REHEARSE_MODE=native npm run rehearse:vowasia` (alone, background, 7200000 ms) |
| GTP unchanged | Fully-Automated + Hybrid | G4, G8/G20, pins diff, G11 after G19 |
| phase A not broken | Hybrid | G6 alone |
| scope / hygiene | Fully-Automated | G7, G7b, G7c, SQL-unchanged, G10c, G10c-local (+ red proof), G13 |
| write-safety review | Agent-Probe | G22 |
| evidence pack structure | Fully-Automated | `validate-risk-artifacts.mjs <task>/harness` |
| real data + R2 | residual (D) | owner OB1, OB5-OB12; backlog stub `process/general-plans/backlog/vowasia-b-beta-owner-import_NOTE_20-10-26.md` |

Gap options: KB-6 (R2 upload) and G23 (real data) -> D (backlog stub, written by EXECUTE per E15); B-beta closeout stays conditional on the owner report (§4.5 verdict rule).

## Plan edits made in this pass

- V-W3: §4.2.3 answer-file "extra" scope; §4.4 item 9 test (4).
- V-W4: §4.5 G10c-local command (`test -f` x3) and literal-URL note.
- Status lines: Amendment 3 header line and Amendment 4 status line now point to the B-beta PASS.
- `### Validate Contract (Chặng B-β)` (replaces the GATED placeholder; CF1-CF5 recorded as closed) and `### Autonomous Goal Block (Chặng B-β)` (1,998 chars).
- V6 completeness greps: "What This Coverage Does NOT Prove" 2, "Accepted by:" 3, "generated-by:" 7, "## Autonomous Goal Block" 3, "Dimension findings" 3. Plan validator 0/0.

No code changed and nothing committed. The results.tsv row for this pass is left to the orchestrator.

## What this validation did NOT prove

- No B-beta code exists yet. Every "feasible" verdict is against B-α code, the 11 pinned GTP files, GTP `rewrite-links-main.ts` / `rollback-main.ts` / `rehearse-gtp.sh`, and `vowasia-web` @ `da9716c`.
- G2, G3, G6 and both rehearsals were not re-run (no code change since pass 1, which measured G2-G5 green).
- The G10c-local regex was tested on synthetic lines in the scratchpad, not on the real B-beta files, which do not exist yet. E19 requires the real red proof.
- The 4 links, their classes and how they split across runs are unseen until the OB5 dry-run.

## Recommended EXECUTE strategy

Sequential, as written in the contract: 1 `vc-execute-agent` (opus), then EVL with 1 `vc-tester` (sonnet) running G19 and then G11 alone, plus 1 `vc-code-reviewer` (sonnet) for G22. 3 agents in total. The alternatives were rejected: parallel subagents risk interface drift between the coupled libs, a workflow has no repeated item set to fan out over, and an agent team has no blast-radius coordination need.

Gate: PASS

**Status:** DONE
**Summary:** Pass 3 confirmed pass-2 gaps 1-3 are closed. Two new issues from the supplement were found and fixed with validator wording changes V-W3 and V-W4, both checked by measured runs. The B-beta validate-contract (Gate PASS, inner-pvl: B-beta, 2026-10-20) and its goal block are now in the plan.
**Concerns/Blockers:** None blocking. O-B5 and O-B12 remain owner STOP points. G23 and the high-risk evidence pack are required before B-beta closeout. EXECUTE must show G10c-local red (E19).
