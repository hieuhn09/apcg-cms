---
name: report:vowasia-legacy-migration-pvl-amendment3-cycle3
description: "Inner PVL cycle 3 (V1-V7) of Amendment 3 (phase B) of the VowAsia legacy migration after supplement 84928ca: U19-U25 resolved; Gate PASS for stage B-alpha (contract written), stage B-beta gated behind B-0b measurement + own PVL with 5 carry-forward items"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-launch
  phase: B (Amendment 3), PVL cycle 3
---

# PVL Amendment 3 (phase B), cycle 3 — vowasia-legacy-migration

Date: 19-10-26. Validator: vc-validate-agent (inner PVL, re-run from V1, cycle 3).
Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`, branch `claude/vowasia-launch`, HEAD `84928ca` (working tree clean before this pass).
Prior passes: cycle 1 (`...pvl-amendment3_REPORT_19-10-26.md`, U1-U18), cycle 2 (`...pvl-amendment3-cycle2_REPORT_19-10-26.md`, U19-U25).

## TL;DR

**Gate: PASS for stage B-α — 0 FAIL, 0 open CONCERN.** All seven cycle-2 concerns (U19-U25) are resolved in the plan text and match the code. One stage-label slip was left (B-1 `vowasia-mapping.ts` is a B-α step but was listed under B-β touchpoints, which could trip HS2); I fixed it as a wording fix (V-W1, no scope change). The B-α validate contract, a gated B-β placeholder, and a B-α goal block are now in the plan. Stage B-β stays blocked on the B-0b measurement (Q2/Q3/KB-2) and its own inner PVL; five non-blocking carry-forward items are recorded for that PVL (the main one: the `--min-coverage` numerator can exceed 1 and hide missing published entries). No code changed, no DB touched, no commit, no `results.tsv` row.

## V1 pre-check

- Tier-0 restatement: re-validate Amendment 3 (stages B-α and B-β) of the plan above after supplement `84928ca`; inner PVL cycle 3; write a contract only on PASS.
- `validate-plan-artifact.mjs`: 0 FAIL / 0 warning (before and after the contract write).
- No `## Inner Loop Refresh Note`, no `## Phase Ordering`, no Pre-PVL Conflict Resolution. Existing `## Validate Contract` covers phase A only and is left untouched; the B placeholder was the only B contract surface.
- Baselines re-measured (read-only): `test:migrate-vowasia` 59/59; `test:migrate-gtp` 69/69; `lint:migrate` 0 errors, 1 pre-existing warning; `typecheck` exit 0; `git diff --quiet fe88bc4 HEAD -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` exit 0; G7 prints only `package.json` (3 phase-A lines); G7c empty.
- Code read this pass: `scripts/migrate/vowasia/lib/{vowasia-config,vowasia-reader,vowasia-sql,out-dir}.ts`, `discover-vowasia.ts`, `legacy-source.vowasia.json`, `fixtures/overlay.fixture.json`, `sql/02-*.template`; `scripts/migrate/lib/{media-fetch,gtp-transform,run-dir,rollback-main}.ts` (cited parts); `payload.config.ts:60-66`; `src/lib/upload-integrity.ts:52-56`; `/home/user/vowasia-web` @ `da9716c` `src/lib/redirect-middleware.ts:36-48`; `package.json:46-50`.

## U19-U25: resolution check

| Id | Resolved? | Where (plan line) | Code check |
|---|---|---|---|
| U19 dangling intent -> cross-run delete | Yes | 696-698, 734, 735, 739, 771, 773, 781 | Outcome line per attempt; 5-condition rule mirrors GTP orphan rule (`rollback-main.ts:110`); preflight refuses while any run has a dangling intent, so the cycle-2 scenario cannot occur |
| U20 HS2 vs phase-A file edits | Yes (+ V-W1) | 766, 786-789 | `ROLE_NAMES` strict enum at `vowasia-config.ts:65/68`, all roles optional, so 4 new roles do not break fixtures; new tests in `lib/*.test.ts` are picked by the existing glob (`package.json:49`), no script line changes |
| U21 B-α gate set | Yes | 717, 719, 766 | G6, G7/G7b (own base, 2 lines), G7c in B-α |
| U22 out-of-repo guard | Yes | 701, 710, 771, 775, 787 | `vowasia/lib/out-dir.ts` does accept git-ignored in-repo dirs, so the new `assertOutsideRepo` is needed |
| U23 snapshot digest anchoring | Yes | 705, 724, 754, 775 | manifest records `snapshot.ndjson` sha256; one owner digest covers both |
| U24 degraded-row redirects / body images | Yes, one B-β carry-forward | 690, 702, 736, 778, 781 | 308/410 confirmed at `redirect-middleware.ts:39-46`; non-public -> `/<pillar>` is the ORCHESTRATOR DEFAULT (not a defect). Residual: `--min-coverage` numerator (CF1) |
| U25 gates-table wording | Yes | 770, 781 | "redirect vĩnh viễn (308)", AC-B12, AC-B1..AC-B13 list |

## Mechanical feasibility of stage B-α (new checks)

- Snapshot can reuse phase-A reading code without edits: `LiveVowasiaReader.pages()` accepts any column list present in the catalog (`vowasia-reader.ts:79-87`) and `keysetPage` is already a closed builder (`vowasia-sql.ts:181-193`). Caveat turned into instruction E-B2: `pages()` silently drops columns not in the catalog (`:85`), so the snapshot must check required columns itself and refuse, as the plan requires (L722).
- `media-fetch.ts` is neutral and takes `allow`/`rewrite`/`maxBytes` as options; usable read-only.
- R2 preflight and tenant prefix claims re-verified (`payload.config.ts:60-66`, `upload-integrity.ts:52-56`); both are B-β concerns.

## Validator wording fixes applied (V6 step 1; no scope/file/gate change)

- V-W1 (3.8 Touchpoints): `lib/vowasia-mapping.ts` (+ test, B-1) moved from "Chặng B-β, file MỚI" to "Chặng B-α, file MỚI", matching the stage split at L717. Without it, EXECUTE B-α could stop at HS2 when writing B-1.
- V-W2 (Amendment 3 Status line): points to the two per-stage contracts instead of the old placeholder name.

## Notes (not concerns; carried into the contract)

Execute instructions for B-α (E-B1..E-B11 in the contract): red-first stubs; snapshot refuses missing required columns itself (E-B2); `assertOutsideRepo` uses realpath of the nearest existing ancestor, with symlink and git-ignored cases (E-B3); explicit CLI flag for rehearsal `hostRewrite` (E-B4); fake hosts only in the public repo (E-B5); pin ALL GTP files to be imported in B-α so B-β need not edit the pin file (E-B6); tests under `lib/*.test.ts` (E-B7); query-log + no secrets in output (E-B8); compare the 15 columns with the discover schema report before OB2 (E-B9); G6 alone, no rehearsal in B-α (E-B10); HS2 list (E-B11).

Carry-forward for the B-β PVL (CF1-CF5 in the B-β placeholder):
- CF1 `--min-coverage` numerator "URLs with a map entry" includes archived -> `/<pillar>` and rejected -> 410 entries, so the ratio can exceed 1 and hide missing published entries. Fix at B-β: numerator = source `published` rows that have an entry.
- CF2 dry-run rollback must not write `resolved`.
- CF3 rollback writes into `--runs-dir`, so it also needs `assertOutsideRepo`.
- CF4 no lock against two concurrent `--apply` runs (owner runs sequentially; consider a lockfile).
- CF5 Q9 sentence (L674) can be read as "archived imported as drafts"; C2 keeps archived as archived; reword.

## V3 net gate

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | PASS |
| Test coverage | PASS |
| Breaking changes | PASS |
| Security surface | PASS (high-risk pack: yes, trust-boundary/secret) |

| Layer 2 sections (Amendment 3) | Status |
|---|---|
| 3.1/3.2/3.3 facts and decisions | PASS |
| 3.4 design | PASS (B-β carry-forwards CF1-CF5) |
| 3.5 checklist / stages | PASS |
| 3.6 owner steps | PASS |
| 3.7 gates | PASS |
| 3.8 touchpoints | PASS after V-W1 |
| 3.9 open questions | PASS (Q2/Q3/KB-2 gate B-β by design) |
| 3.10 strategy | PASS |

Totals: 0 FAIL / 0 CONCERN / all PASS. **Net Gate: PASS (stage B-α).** Vacuous-green check: every developed B-α behavior has a Fully-Automated gate (G1 incl. G18 snapshot part and G21) or Hybrid (G6); the real snapshot run is a named residual (owner-run, resolution C), not the reason anything passes.

## Contract written

- `### Validate Contract (Chặng B-α)`: Status PASS, `date: 2026-10-19`, `generated-by: inner-pvl: phase-B (chặng B-α)`, no `supersedes:` (no prior B contract; the phase-A contract is untouched). C3 5-column gate table with exact commands (base `84928ca` for G7/G7b/G7c and the SQL-unchanged check, `fe88bc4` for G8/G20), failing stubs, legacy line form, dimension findings, E-B1..E-B11, open gaps, "What This Coverage Does NOT Prove", Gate, Accepted by.
- `### Validate Contract (Chặng B-β)`: GATED placeholder with CF1-CF5.
- `### Autonomous Goal Block (Chặng B-α)` (BRANCH A, no umbrella plan; 1955 chars).
- V6 greps: "What This Coverage Does NOT Prove" 1, "Accepted by:" 2, Dimension findings matches present, "generated-by:" 5, "## Autonomous Goal Block" 2.

## V7 handoff

Gate: PASS
Plan path: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate-contract written: yes (stage B-α; B-β gated)
Next step: EXECUTE MODE for stage B-α only, after the owner says "ENTER EXECUTE MODE" (B-β must not start).

Strategy for EXECUTE B-α (`vc-agent-strategy-compare`, 3/7: S2, S6, S7): sequential, 1 vc-execute-agent (opus); EVL 1 vc-tester (sonnet), G6 run alone; G22 1 vc-code-reviewer (sonnet). Total 3 agents. Alternatives rejected: parallel subagents (snapshot, config, guard, pins and mapping share one test tree and the pin/config files; collisions likely), workflow (no repeated item set), agent team (no mid-run coordination need).
