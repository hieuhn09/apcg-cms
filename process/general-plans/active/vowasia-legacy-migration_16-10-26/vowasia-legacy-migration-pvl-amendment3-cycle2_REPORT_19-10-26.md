---
name: report:vowasia-legacy-migration-pvl-amendment3-cycle2
description: "Inner PVL cycle 2 (V1-V7) of Amendment 3 (phase B) of the VowAsia legacy migration after supplement a02ed5d + owner answers 30a3df8: U1-U18 resolved in text; Gate CONDITIONAL, 0 FAIL, 7 new CONCERN (U19-U25), SUPPLEMENT REQUEST"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-launch
  phase: B (Amendment 3), PVL cycle 2
---

# PVL Amendment 3 (phase B), cycle 2 — vowasia-legacy-migration

Date: 19-10-26. Validator: vc-validate-agent (inner PVL, re-run from V1, cycle 2).
Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (`## Amendment 3 (19-10-26)`, lines 617-803), branch `claude/vowasia-launch`, HEAD `30a3df8`, working tree clean.
Prior pass: `vowasia-legacy-migration-pvl-amendment3_REPORT_19-10-26.md` (cycle 1, CONDITIONAL, U1-U18).

## TL;DR

**Gate: CONDITIONAL — 0 FAIL, 7 CONCERN (all new, U19-U25).** All 18 cycle-1 concerns are addressed in the plan text (cited below), and the owner answers Q9/Q10/Q11 close U11/U12/U13. Q2/Q3/KB-2 are correctly gated behind the B-0b measurement (B-β cannot start before it): accepted as B-β known-gaps, not defects. The supplement introduced or exposed seven gaps; the two that matter most: (1) an intent line whose create never happened (crash before create, or an ordinary failed create) lets `rollback` of that run delete a row a LATER run created for the same slug; (2) U1 requires editing phase-A files (`vowasia-config.ts` `ROLE_NAMES`, `legacy-source.vowasia.json`), but §3.8 says "only NEW files", so EXECUTE would hit HS2 and stop. Four of the seven touch stage B-α, so no stage contract can be written yet. Validate-contract NOT written (rule: PASS only). No code changed, no DB touched.

## V1 pre-check

- Tier-0 restatement: re-validate Amendment 3 (stages B-α and B-β) of the plan above after supplement `a02ed5d` and owner answers `30a3df8`; inner PVL cycle 2.
- `validate-plan-artifact.mjs` (run from repo root): 0 FAIL / 0 warning, 804 lines.
- No `## Inner Loop Refresh Note`, no `## Phase Ordering`, no Pre-PVL Conflict Resolution. Existing `## Validate Contract` covers phase A only; `### Validate Contract (Giai đoạn B)` (line 801) is still a placeholder.
- Baselines re-measured now (read-only): `test:migrate-vowasia` 59/59; `test:migrate-gtp` 69/69; `lint:migrate` 0 errors, 1 pre-existing warning; `typecheck` exit 0. Unchanged from cycle 1.
- Code re-read for this pass: `scripts/migrate/lib/{run-dir,out-dir,gtp-transform,rollback-main,rollback-rules,import-gtp-main,rewrite-links-main,media-fetch,normalise-path}.ts`, `scripts/migrate/import-gcv-legacy.ts`, `scripts/migrate/vowasia/{legacy-source.vowasia.json,lib/vowasia-config.ts,lib/out-dir.ts,lib/vowasia-sql.ts,lib/vowasia-reader.ts,sql/02-*.template}`, `scripts/lib/vowasia-taxonomy.ts`, `src/collections/{Media,Articles}.ts`, `src/lib/upload-integrity.ts`, `payload.config.ts`, `/home/user/vowasia-web` @ `da9716c` (`src/middleware.ts`, `src/lib/redirect-middleware.ts`, `src/lib/normalise-path.ts`, `src/redirects/redirect-map.json`).

## U1-U18: resolution check

| Id | Resolved? | Where (plan line) | Note |
|---|---|---|---|
| U1 column list | Yes | 720, 751 | 15 article columns + `sites` id/slug/name; roles `excerpt`/`imageCredit`/`tags`/`updatedAt`; refuse on unmapped role. Residual: needs edits to phase-A files, see U20 |
| U2 generic URL collection | Yes | 721, 770 | fixture with image under unknown key |
| U3 body images | Yes | 691, 727, 768 | own `vowasia-body.ts`, serialized upload node (gcv precedent verified: `import-gcv-legacy.ts` `uploadNode`, version 3), 0 pending nodes |
| U4 gtp- prefix / run-dir message / guard | Yes | 685, 731 | `stableFilename` copied with `vowasia-` prefix; `RUN_MESSAGES.exists` wrapped (verified `run-dir.ts:60`) |
| U5 drift guard | Yes | 684, 768 | sha256 pin per imported file + behavioral tests |
| U6 skip/adopt/crash | Yes, with a new hole | 694-698, 730, 732, 769, 771 | never adopt, intent line, preflight refuse, non-marker collision reject. Hole: U19 |
| U7 rollback refs + baseline | Yes | 707, 733 | body upload refs + `timestamps-baseline.json` |
| U8 R2 preflight | Yes | 704, 732, 755, 769 | matches `payload.config.ts:60-66` (`r2Configured`) |
| U9 dry-run run-id | Yes | 705, 732, 769 | |
| U10 redirect contract | Yes, wording residual | 657, 662, 672, 700, 781 | 308 confirmed at `redirect-middleware.ts:41/46`, 410 at `:39`; normalise-path bodies identical (only the header comment differs). Residual: G16 still says "301", see U25 |
| U11 archived/no-hero | Yes (Q9) | 674, 700, 734 | -> `/<pillar>`; regenerate when published. Coverage residual: U24 |
| U12 tags | Yes (Q10) | 675, 725, 727 | every tag target exists in `vowasia-taxonomy.ts:236-241`; sub-section sources exist under the right pillar |
| U13 post-import edits | Yes (Q11) | 676, 734-735 | |
| U14 stage split | Yes, gate-set residual | 714-717, 749, 803 | residual: U21 |
| U15 rehearsal resources | Yes | 737, 771, 795 | 54346/54347/3518/3519 do not overlap GTP (54326-54328, 3508) or the phase A probe (54331-54339) |
| U16 integrity/exposure | Yes, anchor residual | 703, 706, 722-724, 731, 752, 759, 769-770 | residual: U23 |
| U17 journals out of repo | Yes, guard residual | 699, 703, 732, 756, 769 | residual: U22 |
| U18 facts hygiene | Yes | 645, 659, 679 | count fixed; ref masked as `<old-project-ref>` in the current text. Observation (not a concern): the ref is still in the history of already-pushed commits (`f6ad3b9`..`e29c7da`); it is a hostname that also appears in public image URLs |

Q2/Q3/KB-2: still open by design; B-2/B-3 blocked (lines 716, 727-728, 787-788), B-β needs its own inner PVL after the measurement (716-717). Accepted as known-gaps of B-β.

Prefix check (claim in B-6): the importer does not need to build `vowasia/` itself; `Media.prefix` is stamped server-side from `data.tenant` on create (`src/lib/upload-integrity.ts:52-56` `tenantKeyPrefix`), and GTP media creates pass no prefix (`import-gtp-main.ts:367`). The rehearsal assert `prefix === "vowasia"` is the right check.

## New findings (cycle 2)

U19 — Dangling intent lines can make rollback delete another run's row (CONCERN, safety rails, highest). The intent line `{legacyId, slug, runId, startedAt}` is written before every create (line 696), and rollback "reads intent.ndjson too, confirmed by (tenant, slug) + marker" (line 696, B-8 line 733). An intent line whose create NEVER happened (crash after the intent fsync but before the create, or an ordinary failed create such as a validation error) stays in run A. If a later run B creates that article (same legacy slug; the preflight passes because no row existed), `rollback --run-id A` resolves A's dangling intent by slug and deletes B's row. Also undefined: the `untouched` test for an intent-only row (it has no `baselineVersion`/`baselineUpdatedAt`; GTP's orphan rule uses `version === 1 && createdAt >= state.startedAt`, `rollback-main.ts:110`). Fix: write an outcome line after each create attempt (`created` with id, or `failed`); rollback resolves an intent-only line to a row only if no outcome says `failed`, no OTHER run's slug-map claims that row id, the row has `version === 1` (or `--include-edited`) and `createdAt >= intent.startedAt`; and/or `--apply` preflight refuses while any run in `--runs-dir` has an intent line with neither an outcome nor a slug-map line (owner rolls that run back first). Add rehearsal/unit cases "crash before create, then run B creates it, then rollback A leaves B's row" and "failed create, then run B, then rollback A".

U20 — Touchpoints say "only NEW files", but the plan now requires edits to existing phase-A files (CONCERN, executability; HS2 conflict). U1 (line 720) extends `columnRoles`; `vowasia-config.ts:65` `ROLE_NAMES` is a strict zod enum (`rolesSchema ... .strict()`, `:68`), so `legacy-source.vowasia.json` cannot gain `excerpt`/`imageCredit`/`tags`/`updatedAt` without editing `vowasia-config.ts` and its test (and likely `fixtures/overlay.fixture.json`). §3.8 (line 780) lists only new files + `VOWASIA-LEGACY.md`; HS2 (line 84) stops EXECUTE on any file outside Touchpoints. §3.8 also misses new files the checklist needs: `measure-vowasia.ts` (+ its main/test, B-0b), the B-10 timestamps generator (copy of `gtp-timestamps.ts`), the sha256 pin file + test (U5), the own `stableFilename` module (U4), and a strict out-of-repo guard (U22). Fix: list every edited phase-A file (and why), every new file, per stage; state that G1 and G6 re-run because config/reader inputs change.

U21 — Stage B-α gate set is incomplete (CONCERN, structure). Line 715 lists G1-G5, G8, G20, G21, G18 (snapshot part), G22. Missing: G6 (keyset/discover probe parses the same config whose roles change, and the snapshot reuses the reader/builder), G7 + G7b + G7c (no B-α check that only allowed files changed and no stray untracked file). G7b as written (line 764) requires "exactly 9 package.json lines", which only holds at the end of B-β; B-α adds 2 or 3 (`snapshot`, `measure`, maybe `fixture`). Fix: give each stage its own G7/G7b base commit and line count, and add G6 + G7c to B-α.

U22 — "Outside repo" is not what `assertOutDirSafe` does (CONCERN, infra). Line 699 says the vowasia `assertOutDirSafe` "refuses paths in the repo", and G21 (line 773) says "writes only outside the repo (`assertOutDirSafe`)". The vowasia guard (`scripts/migrate/vowasia/lib/out-dir.ts`, header) ACCEPTS a git-ignored directory inside the repo, same as GTP (`scripts/migrate/lib/out-dir.ts:34-49`). The snapshot + image cache are irreplaceable (the old project may be paused), so they carry the same `git clean -fdx` risk as the journals. Fix: a new strict check (e.g. `assertOutsideRepo`) for snapshot `--out` and `--runs-dir`, used in addition to `assertOutDirSafe`; keep `assertOutDirSafe` unchanged for discover; G17/G21 cases for an in-repo git-ignored path.

U23 — The owner-recorded digest anchors the manifest only, not the snapshot rows (CONCERN, minor, security). OB3 records the snapshot digest (line 752) but the import takes one `--expect-sha256` = the manifest digest (lines 703, 722, 753); the snapshot `.ndjson` is checked only against the sha256 file stored next to it, which detects corruption, not substitution. Fix: the manifest records the sha256 of `snapshot.ndjson` (so the one anchored digest covers rows and images), or the import also takes `--expect-snapshot-sha256`.

U24 — Redirect and body-image outcome for degraded rows (CONCERN, minor, contract). Q9 names archived + the 9 no-hero rows. Not covered: published rows imported as draft for another reason (C6 image failure under 2%), and published/archived rows not imported at all (unknown C8 pair, title/excerpt shape, slug collision); `--min-coverage` has no stated denominator. Also step 3 says a failed image makes the article a draft, while step 4 says an old-host URL left in the body is a reject: the plan should say a failed BODY image segment is dropped (never keeps the old URL), the article becomes a draft, and a report line is written. Fix: derive the map from the Central state for every legacy published/archived URL: published in Central -> `/<pillar>/<slug>`; imported as draft for any reason -> `/<pillar>` (direct application of Q9; orchestrator to tell the owner); not imported -> absent + listed in the report; `--min-coverage` = mapped / legacy published+archived.

U25 — Text hygiene in the gates table (CONCERN, minor). G16 "Proves" (line 768) still says "AC-B11 redirect 301" and omits the Q9 pillar redirect and the Q10 tag table; AC-B1..AC-B11 exist only inline in the gate column. Fix: "permanent (308)", add AC-B12 (Q10 tag table) and the Q9 behavior to AC-B11, or add a short AC-B list.

## V3 net gate

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (U22, U21) |
| Test coverage | CONCERN (U19 cases, U21) |
| Breaking changes / contracts | CONCERN (U24, U25) |
| Security surface | CONCERN (U23; U19 is a destructive-write correctness gap) |

| Layer 2 sections (Amendment 3) | Status |
|---|---|
| 3.1/3.2 facts | PASS |
| 3.3 owner decisions (incl. Q9/Q10/Q11) | PASS |
| 3.4 design B | CONCERN (U19, U22, U24) |
| 3.5 checklist / stages | CONCERN (U20, U21, U23) |
| 3.6 owner steps | PASS (U23 touches OB3, fixed in 3.4/3.5) |
| 3.7 gates | CONCERN (U21, U25) |
| 3.8 touchpoints/contracts/blast radius | CONCERN (U20) |
| 3.9 open questions | PASS (Q2/Q3/KB-2 gated, accepted for B-β) |
| 3.10 strategy | PASS |

Totals: 0 FAIL / 7 CONCERN. Net gate: **CONDITIONAL** (cycle 2; not terminal under the loop rules; no contract written per caller instruction).

Vacuous-green check: every developed B behavior has a Fully-Automated or Hybrid gate except G23 (real data), which is a named Known-Gap with a backlog stub. Not vacuous; U19/U21 are about what the gates must contain.

Stage split for the next cycle: U20 (config edits part), U21, U22, U23 block B-α; U19, U24 block B-β; U25 is wording. After a supplement, a B-α contract can be written even while B-β stays gated on Q2/Q3/KB-2.

## SUPPLEMENT REQUEST

Section id: `amendment-3-(19-10-26):-kết-quả-giai-đoạn-a-thật-+-kế-hoạch-giai-đoạn-b` (subsection per gap).

- Gap 1 (U19): §3.4 step 6-7, §3.4 rollback CLI, §3.5 B-7/B-8/B-12 | Dangling intent lines (crash before create, or a failed create) let rollback of that run delete a row a later run created; `untouched` for intent-only rows undefined | CONCERN | Add an outcome line per create attempt; rollback resolves intent-only lines only when not failed, not claimed by another run's slug-map, `version === 1`, `createdAt >= startedAt`; `--apply` preflight refuses while any run has unresolved intent lines; add the two crash/failure cases to unit tests and G19.
- Gap 2 (U20): §3.8 Touchpoints/Blast Radius, HS2 | Plan requires edits to phase-A files (`vowasia-config.ts` `ROLE_NAMES` + test, `legacy-source.vowasia.json`, overlay fixture) and new files not listed (measure CLI, timestamps generator, sha256 pin file, own `stableFilename`, strict out-of-repo guard) | CONCERN | List every edited existing file with reason and every new file, per stage; note G1/G6 re-run.
- Gap 3 (U21): §3.5 stage B-α line, §3.7 G7/G7b | B-α gates omit G6, G7, G7b, G7c; G7b "9 lines" fits only the end of B-β | CONCERN | Per-stage G7/G7b base and line count; add G6 and G7c to B-α.
- Gap 4 (U22): §3.4 step 7, §3.5 B-0, §3.7 G17/G21 | `assertOutDirSafe` accepts git-ignored in-repo dirs; plan says it refuses | CONCERN | New strict out-of-repo check for snapshot `--out` and `--runs-dir` (keep `assertOutDirSafe` for discover); test with an in-repo git-ignored path.
- Gap 5 (U23): §3.4 CLI `--expect-sha256`, §3.5 B-0, §3.6 OB3 | Owner digest anchors the manifest only; snapshot rows checked against a sidecar | CONCERN | Manifest records `snapshot.ndjson` sha256, or add `--expect-snapshot-sha256`.
- Gap 6 (U24): §3.4 steps 3, 4, 8, §3.5 B-9 | No outcome for published rows drafted for other reasons or not imported; failed body image handling ambiguous; `--min-coverage` denominator undefined | CONCERN | Map from Central state (published -> article, drafted for any reason -> `/<pillar>`, not imported -> absent + reported); failed body image segment dropped, article draft; define the coverage ratio.
- Gap 7 (U25): §3.7 G16 row | "redirect 301", Q9/Q10 behaviors not in the AC list | CONCERN | Say "permanent (308)", add Q9 to AC-B11 and an AC for the Q10 tag table.

## Execute-agent notes (advisory, for when a stage contract passes)

- Copy GTP `rewrite-links-main.ts` behavior that re-records `baselineVersion`/`baselineUpdatedAt` after each rewrite (`rewrite-links-main.ts:81`), so Q11 edits do not make rollback treat rows as hand-edited.
- Media `alt` is required and localized (`Media.ts` field `alt`): never empty (fallback: article title, as GTP's `alt || filename`).
- Before OB2, compare the 15 column names with the discover schema report on the owner's Mac (01 section 6b) so `02` is filled right the first time; a wrong name aborts `02` safely but costs a re-run.

## V7 handoff

Gate: CONDITIONAL
Plan path: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate-contract written: no (CONDITIONAL; written only on PASS per caller instruction)
Next step: PVL supplement cycle 2 (vc-plan-agent, PVL-supplement mode, SUPPLEMENT REQUEST above), then re-spawn vc-validate-agent from V1 (cycle 3).

Strategy for the supplement: one sonnet vc-plan-agent, sequential. All seven gaps edit the same subsections (3.4, 3.5, 3.7, 3.8) of one file, so parallel plan-fix agents would collide. Agent count: 1 (plus 1 validator next cycle). Alternatives rejected: parallel subagents (same file regions), workflow (no repeated item set), agent team (no cross-agent coordination need).
