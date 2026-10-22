---
name: report:vowasia-legacy-migration-pvl-b-beta
description: "Inner PVL (pass 1) for Amendment 4 / stage B-beta of the VowAsia legacy migration: BLOCKED, 1 FAIL (draft redirects override owner decision) + 13 CONCERNs; no contract written"
date: 20-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-legacy-migration
  phase: B-beta
---

# PVL B-beta (Amendment 4), pass 1: Gate BLOCKED

## TL;DR

- **Gate: BLOCKED.** 1 FAIL, 13 CONCERNs. No `### Validate Contract (Chặng B-β)` written; the placeholder stays.
- **The FAIL:** Amendment 4 §4.2.7 (and the 4.1 redirect count, 4.4 item 8) sends the 21 OLD DRAFT rows to `/<pillar>` with a 308. The owner said three times that old drafts do NOT go into the redirect map (C3, Q1, Q9). An "orchestrator default, owner informed" cannot replace an owner decision (hard rule). It also contradicts 3.4 step 8, 3.5 item 9 and AC-B11, so EXECUTE would get two opposite specs.
- **The rest is sound.** All arithmetic in 4.1 checks out. CF1-CF4 are folded in with red-first tests and gates G26-G28. The sha chain is right and `verifySnapshotInput` already implements it. The vowasia-web contract (308/410, object map, `normaliseKey`) matches what Amendment 4 targets. Every baseline gate is green at `9d9e5a4`.
- **Fix size:** one plan-supplement cycle. Restore the owner rule (or record a new, explicit owner answer), then fix 13 small spec gaps (list below).

## Scope and base

- Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`, Amendment 4 (L944-1125), read together with Amendment 3 §3.1-3.10, the B-alpha contract and CF1-CF5.
- Base: branch `claude/vowasia-launch`, HEAD `9d9e5a4`. `git diff --name-only 9fe7f5c 9d9e5a4` = only the plan file, so `9d9e5a4` is a valid G7/G7b base for B-beta (pin it to this commit).
- generated-by (when a contract is eventually written): `inner-pvl: B-beta`.
- How this pass ran: this validate subagent has no Agent tool, so the 4 Layer 1 dimensions and the per-section Layer 2 checks ran in-session, one after another, against code (not against summaries). Strategy score 3/7 (S2, S6, S7) still holds.

## V1 pre-check

| Check | Result |
|---|---|
| `validate-plan-artifact.mjs` on the plan | 0 FAIL, 0 warning (1126 lines) |
| Paths Amendment 4 relies on | all present: `scripts/migrate/vowasia/**` (B-alpha), the 11 pinned GTP files, `scripts/lib/{local-db-guard,central-db-name-guard,vowasia-taxonomy}.ts`, `src/lib/constants.ts` |
| vowasia-web contract | clone present at `/home/user/vowasia-web` @ `da9716c`; checked directly (not a known-gap) |
| Phase-ordering / dependency-BLOCKED | n/a (single plan) |
| Existing contract | only the B-alpha PASS contract + the B-beta placeholder; no `supersedes:` needed later |

## Baseline gates at `9d9e5a4` (measured, read-only)

| Gate | Command | Result |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | 113/113 pass |
| G2 | `npm run lint:migrate` | 0 errors, 1 known warning (`seed-gtp-legacy-fixture.ts:179 t50sec`) |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | 69/69 |
| G5 | `npm run test:single-home` | 267/267 |
| G8/G20 | `git diff --quiet fe88bc4 HEAD -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 |
| G7 | `git diff --name-only 9d9e5a4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | empty (expected; B-beta will add only `package.json`) |
| G7c | `! git ls-files --others --exclude-standard \| grep -vE "^(scripts/migrate/vowasia/\|process/general-plans/)"` | ok |
| G6, G19 | not run (G6 proven at B-alpha EVL; G19 does not exist yet; rehearsals run once, alone, at EVL) | n/a |

All gate commands Amendment 4 names are runnable here: scoped `tsx --test` (the glob `scripts/migrate/vowasia/lib/*.test.ts` picks up new tests with no `package.json` change), typecheck, lint, disposable native PG16 (`/usr/lib/postgresql/16/bin/{initdb,pg_ctl}`, `runuser`, `psql` present; ports 54346/54347/3518/3519 unused anywhere in the repo).

## Arithmetic check (§4.1)

| Claim | Check | Verdict |
|---|---|---|
| 370 − 12 = 358 imported | 230+107+21+12 = 370; 230+107+21 = 358 | correct |
| 361 cover + 8 body = 369 manifest entries | 361 + 9 missing = 370 rows; 361 + 8 = 369 | correct |
| Pillar totals | wedding-business 125+19+5 = 149; venues 88+4+1 = 93; style 26+18+16+5+5 = 70; destination-weddings 32+16+2 = 50; planning 3+3+1+1 = 8; sum 370; KB-2 table rows sum to 370 | correct |
| Tag upper bounds | 125 / 88 / 32 / 26+5 = 31; no tag 370−276 = 94 | correct |
| No-cover split formula | published 230−p, archived 107−a, draft 21+p+a; sums to 358 | correct |
| 2% stop = 8 of 369 | 8/369 = 2.17% > 2%, 7/369 = 1.90% | correct |
| "140 date fallbacks" in AC-B15 | 140 is over all 370 rows incl. the 12 rejected; the imported-row count is unknown until dry-run | WRONG BASE (C1) |
| Redirect total 370 = 12×410 + 358×308 | arithmetic right, but it includes the 21 old drafts against the owner rule | FAIL (F1) |

## sha chain, lock, R2 preflight

- **sha chain (correct).** `--expect-sha256` = manifest digest `50c431a1…c105`; the manifest records the snapshot digest `95d017cd…df01`; `snapshot-meta.json` also records it. B-alpha already ships `verifySnapshotInput(dir, {expectManifestSha256, requireManifest, checkImages})` (`snapshot-vowasia-main.ts:261-310`): meta↔ndjson, manifest↔ndjson, `--expect-sha256`↔manifest bytes, then every image re-hashed + size + magic bytes. The importer should call it, not re-implement it (E-instruction).
- **CF4 lock (semantics fine, two holes).** `O_EXCL` lockfile in `--runs-dir`, holder printed, no override flag, removed on normal exit and handled errors. Holes: a crash (the rehearsal's kill case, or Ctrl-C) leaves the lock behind, and rollback also takes the lock, so the documented crash recovery ("run rollback A") is blocked until the owner deletes the lock by hand. Neither the rehearsal nor the runbook says so (C4). Also not said: whether dry-runs take the lock (they must not, CF2) and whether `rewrite-links --apply` takes it (it should; it writes Central + the run journal).
- **R2 preflight (correct, one detail).** `payload.config.ts:62-67` enables R2 only when all four `R2_*` values are truthy, so the preflight must test non-empty values, not presence. Printing names only is right. Separate issue C7 (an upload exception is treated as an "image failure").

## Hard-rule check

| Rule | Amendment 4 | Verdict |
|---|---|---|
| Owner runs every production write and legacy read | OB1-OB12 all owner; B-beta never reads the old DB | ok |
| No secrets in files/chat | R2 names only; journals outside repo | ok |
| Create-only, never update/delete, never create authors | ok for import; author missing → STOP. Tags/pillars/sub-sections missing: not stated (C13) | CONCERN |
| Rollback per run; new run-id; no `--resume` | ok | ok |
| Dry-run default; `--apply` = TTY + `--confirm-host` + `/neondb`; banner shows neondb | ok (`assertLocalOrConfirmed` then `assertCentralDbName`, name printed first) | ok |
| Rehearsal once, alone, background, 7200000, no parallel npm ci | ok for G19; OB-R says "agent or owner" on the Mac, which cannot run it (C10) | CONCERN |
| VowAsia stays DARK | OB11 PR not merged before cutover | ok |
| Never rotate REVALIDATE_SECRET / CENTRAL_SIGNING_SECRET | not touched | ok |
| No new defaults for owner-owned decisions | §4.2.7 overrides C3/Q1/Q9 | **FAIL (F1)** |
| rewrite-links / timestamps only on the run's own rows | ok (Q11; WHERE marker + tenant + id in journal) | ok |
| High-risk evidence pack | §4.7 requires it | ok (location not named, E-instruction) |

## Net Gate Derivation

### Layer 1 dimensions

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (C5 rehearsal bootstrap, C10 Mac rehearsal, C11 G11) |
| Test coverage | CONCERN (C1 count base, C9 body-ref Media test missing from 4.4) |
| Breaking changes | PASS (7 additive scripts; no schema/API change; redirect JSON matches vowasia-web `buildRedirectMap` + `normaliseKey`, identical function body to the pinned GTP helper) |
| Security surface | FAIL (F1 owner-decision override); CONCERN (C8 dry-run output may land in the public repo tree, C12 unpinned GTP imports) |

### Layer 2 sections

| Layer 2 sections | Status |
|---|---|
| 4.1 measured facts | CONCERN (C1) + FAIL (F1, redirect count) |
| 4.2 consequences | FAIL (F1, item 7); CONCERN (C2 item 3, C3 item 2) |
| 4.3 design | CONCERN (C7 upload error vs image failure, C12 pin rule vs touchpoints, C13 missing taxonomy) |
| 4.4 checklist | CONCERN (C4 lock/crash, C5/C6 rehearsal + fixture files, C9 rollback media) |
| 4.5 gates/ACs | CONCERN (C1 AC-B15, C2 AC-B14, C11 G11) |
| 4.6 owner steps | CONCERN (C8 OB5 has no `--runs-dir`, C10 OB-R) |
| 4.7 evidence pack | PASS |
| 4.8 out of scope | PASS |
| 4.9 strategy | PASS |

**Totals: 1 FAIL / 13 CONCERNs / 5 PASS.**

**→ Net Gate: BLOCKED.** One unresolved FAIL (F1). It cannot be fixed by the validator: either text is restored to the owner rule, or the owner gives a new explicit answer that is recorded verbatim.

## CF1-CF5 carry-forward status

| Item | Folded in? | Red-first test / gate | Note |
|---|---|---|---|
| CF1 coverage numerator | yes (4.4 item 8, AC-B13 revised) | "one published row missing + many archived must fail" / G28 | correct; ratio ≤ 1 |
| CF2 rollback dry-run writes nothing | yes (4.4 item 7) | "dry-run leaves run dir byte-identical" / G27 | GTP's rollback writes `rollback-report-dry.json` into the run dir; the copy must not (C9) |
| CF3 rollback `--runs-dir` guard | yes | in-repo + git-ignored refused / G27 | ok |
| CF4 lock | yes (4.4 item 6, item 7) | concurrent `--apply` refused; rollback while locked refused / G26 | stale lock after crash not handled in rehearsal/runbook (C4) |
| CF5 Q9 wording | partly | none needed | 4.2.7 states "archived stays archived" (good) but in the same sentence widens the map to old drafts (F1) |

## Findings

| # | Finding | Severity | Proposed fix |
|---|---|---|---|
| F1 | §4.2.7, §4.1 ("370 = 12×410 + 358×308"), §4.4 item 8 ("any imported non-public row -> `/<pillar>`") put the 21 old draft/scheduled rows into the redirect map. Owner decisions say the opposite: C3 "Nháp: không vào map" (L657), Q1 "Bài nháp KHÔNG vào redirect map" (L670), Q9 "nháp từ trạng thái cũ draft/scheduled vẫn KHÔNG vào map (không đổi)" (L674). The earlier orchestrator default (U24) only covered rows that BECAME draft (no cover, broken image); Amendment 4 extends it past the owner's words. Also leaves 3.4 step 8, 3.5 item 9 and AC-B11 contradicting 4.4 item 8. | FAIL | Restore the owner rule: old draft/scheduled rows get NO map entry and are listed in the redirects report. Expected map = 12 × 410 + 230 published-origin (`/<pillar>/<slug>` or `/<pillar>` if made draft) + 107 archived (`/<pillar>`) = 349 entries; the 21 old drafts appear in the report only. Keep the CF5 clarification ("archived stays archived"). Make 4.4 item 8, 4.1 and AC-B11 say the same thing. Only if the owner explicitly agrees to include old drafts may the plan change, and then the answer is recorded verbatim in 3.3. |
| C1 | AC-B15 and the dry-run block expect "140 date fallbacks", but 140 counts all 370 rows incl. the 12 rejected; the imported count is unknown. | CONCERN | Dry-run prints both: rows without `published_at` over all rows (= 140) and among imported rows (= 140 − r). AC-B15 compares the all-rows number to 140 and records the imported number. |
| C2 | The 4 off-allow-list URLs in `body.en`: B-9b rewrites old-site `/article/<slug>` links in text (as GTP does) but also says the 4 are "NOT rewritten"; measure counted 0 relative refs, so any internal link would be one of these 4. AC-B14 bakes in "unchanged" although the owner has not answered the open item. | CONCERN | Dry-run prints each of the 4 with a class: `old-site-article` (host `vowasia.com`, path `/article/…`) or `external`. State the rule: `external` stays verbatim; `old-site-article` is the owner's call at OB5. Make OB5 an explicit STOP point: OB6 does not start until the owner has answered for the 4 links. AC-B14 becomes "the 4 links match the owner's OB5 answer". |
| C3 | §4.2.2 says `body.en` "becomes paragraphs (sanitised…)" and 3.4 step 4 routes text through `sanitizeLegacyHtml`. The legacy source is the same network schema as GTP, whose proven path (`sectionsToHtml`, `gtp-transform.ts:219-258`) treats body text as TEXT (escape, split on blank lines). Parsing text as HTML would mangle any `<`, `>` or `&`. Also unspecified: where the image goes inside a `{heading, body, image}` section, and which alt/credit a body image gets (Media `alt` is required). | CONCERN | Spec: text parts → `escapeHtml` + blank-line paragraph split (GTP semantics), never parsed as HTML; `sanitizeLegacyHtml` only if a sniff ever finds HTML (measure found none). State the order inside a section (e.g. heading, image, body) and the alt/credit source (e.g. `image.alt`/`caption` if present, else the article title; credit from the image object if present). Red-first tests for `<`/`&` in text and for the order. |
| C4 | CF4 lock + crash: a kill (rehearsal crash case) or Ctrl-C leaves `.import.lock`; rollback also takes the lock, so the documented recovery ("rollback the crashed run") is blocked until the lock is removed by hand. Rehearsal (item 13) and runbook (item 14) do not say this. Dry-run and `rewrite-links` lock behaviour not stated. | CONCERN | Add: after any crash, the owner checks no import/rollback process runs (`ps`), deletes `<runs-dir>/.import.lock`, then runs rollback. Rehearsal crash case asserts the lock is still there and rollback refuses, then removes it and continues. Only `--apply` modes (import, rollback, rewrite-links) take the lock; dry-runs never create it. |
| C5 | Rehearsal needs tenant `vowasia` + 49 taxonomy rows (6 authors) in the local Central. GTP gets its tenant from `seed.ts` (`SEED_INCLUDE_GTP`); there is no vowasia seed, and `seed.ts` is outside the touchpoints. Item 13 does not say how. Item 13 also places `rehearse-vowasia.sh` at the vowasia root while 3.8 says `fixtures/rehearse-vowasia.sh`. | CONCERN | Spec: rehearsal creates the schema with the existing `seed.ts` + `PAYLOAD_DB_PUSH=true` (file unchanged), creates tenant `vowasia` locally through Payload behind `assertLocalDb` (in `rehearse-assert.ts` or a named helper added to the touchpoints), then runs `npm run audit:add-vowasia-taxonomy -- --apply` against the local DB (also rehearses OB1). Pick one path for the shell script and list every rehearsal file in the touchpoints. |
| C6 | `migrate:vowasia:fixture` (item 14) has no target file in item 11 or the touchpoints, so EXECUTE hits HS2 or invents a file. | CONCERN | Name the file (e.g. `fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts`) and what it does (seed the fake legacy PG for the snapshot CLI, or build a fixture snapshot + image store + manifest). |
| C7 | §4.3 step 4: "Image failure -> article becomes draft, failed section dropped; > 2% -> stop." A Payload/R2 upload exception during Media create (bad credentials, outage) would be counted as an image failure, so up to 7 articles get created as drafts with images dropped before the stop. The store has 0 failures, so any import-time failure is infrastructure, not a broken image. | CONCERN | State the split: store-level failure (manifest failure entry, missing file, sha/size/magic mismatch) → C6 draft rule; Media create/upload exception → stop the run before creating that article. C6 says "ảnh lỗi -> nháp", so tag the upload-exception rule as needing owner confirmation in 3.3 (no silent default). |
| C8 | Dry-run output location: OB5's command has no `--runs-dir`; `vowasia-cli.ts:25` `DEFAULT_OUT` is inside the repo (`scripts/migrate/out/vowasia`). The dry-run report holds slugs, titles and the 4 URLs from a private snapshot; the repo is PUBLIC (only git-ignore protects it). | CONCERN | Dry-run also needs `--runs-dir` (through `assertOutsideRepo`) and writes `dry-<timestamp>` there; never default to `DEFAULT_OUT`. Add `--runs-dir ~/vowasia-private/runs` to the OB5 command. |
| C9 | Rollback Media: 4.4 item 7 says "only if no other article references it" but drops the U7 detail (references from body `upload` nodes, not only `heroImage`). Payload keeps no relation index for Lexical upload nodes, so this needs a scan of all tenant-vowasia article bodies (`draft: true`, paginated). Also: GTP rollback writes `rollback-report-dry.json` into the run dir (breaks CF2's byte-identical test if copied), and on a delete error it falls back to archiving the article (`rollback-main.ts:160-166`), which is an update. | CONCERN | Restate in item 7: Media kept if referenced by any vowasia article's `heroImage` OR body `upload` node (full scan); red-first test "Media used only in another article's body is kept". Dry-run report goes to stdout (or outside the run dir). On delete error: report only, no archive fallback (or state explicitly that the GTP fallback is copied). |
| C10 | OB-R says the owner may run `rehearse:vowasia` on the Mac. The rehearsal uses `/usr/lib/postgresql/16/bin` + `runuser` (Linux) and must run once, alone. | CONCERN | G19 runs at EVL only (agent, Linux). OB-R becomes "owner reads the G19 result in the EVL report". |
| C11 | 3.7 lists G11 `rehearse:gtp` for "EVL cuối sau B"; 4.5 is silent. Two rehearsals must never overlap. | CONCERN | State it: G11 runs at B-beta EVL only after G19 has finished, never in parallel; or drop it with the reason (G20 + pin test prove GTP is byte-identical). |
| C12 | §4.3: "any new import of a GTP file adds a pin first". `gtp-import-pins.ts`'s own header says B-beta never edits it, and it is not in the B-beta touchpoints. GTP's importer pulls in `cli-common.ts`, `cli-spec.ts`, `args.ts` (unpinned). | CONCERN | Rule: B-beta imports ONLY the 11 pinned files; everything else (central-target helpers, CLI spec, run-dir intent/outcome journals) is copied into `scripts/migrate/vowasia/lib/`. Editing the pins file = HS2. |
| C13 | Only "author missing -> STOP" is stated. GTP creates tags by slug (`import-gtp-main.ts`), which must not be copied; missing pillars/sub-sections/tags are not covered. | CONCERN | Before any write (dry-run too): the 5 pillars, the 17 target sub-sections (under the right pillar), the 4 tags used (`wedding-industry`, `wedding-venues`, `honeymoons`, `bridal-fashion`) and the 6 authors must exist in tenant vowasia, else STOP with the missing list. Never create tags, pillars, sub-sections or authors. Red-first test. |

## Proposed plan updates (for the supplement)

| # | What changes | Where | Why |
|---|---|---|---|
| P1 | Old draft/scheduled rows: no map entry; map = 349; fix 4.1, 4.2.7, 4.4 item 8, AC-B11 so they all agree with 3.4 step 8 / 3.5 item 9 | §4.1, §4.2.7, §4.4 item 8, §4.5 | F1 |
| P2 | Date-fallback count on both bases | §4.1, §4.4 item 6, AC-B15 | C1 |
| P3 | Classify the 4 URLs; OB5 = STOP for the owner's answer; AC-B14 rewritten | §4.2.3, §4.4 items 6 and 9, §4.6 OB5, AC-B14 | C2 |
| P4 | Body text = escaped text; section order; body-image alt/credit | §4.2.2, §4.4 item 2 | C3 |
| P5 | Stale-lock procedure; lock scope (apply modes only, incl. rewrite-links) | §4.4 items 6, 7, 9, 13, 14 | C4 |
| P6 | Rehearsal bootstrap + file paths in touchpoints | §4.4 item 13, Touchpoints | C5 |
| P7 | Name the `:fixture` entry file | §4.4 items 11, 14, Touchpoints | C6 |
| P8 | Upload exception vs store failure (owner to confirm) | §4.3 step 4, §4.4 item 5, §3.9 open item | C7 |
| P9 | Dry-run needs `--runs-dir`; OB5 command | §4.4 item 6, §4.6 OB5 | C8 |
| P10 | Rollback media body-ref scan, dry-run report location, delete-error behaviour | §4.4 item 7 | C9 |
| P11 | OB-R = read EVL result | §4.6 | C10 |
| P12 | G11 decision | §4.5 | C11 |
| P13 | Import only the 11 pinned GTP files | §4.3 | C12 |
| P14 | Taxonomy presence STOP; never create tags | §4.3 step 2, §4.4 item 6 | C13 |

## Execute-agent instructions to carry into the B-beta contract (not gaps; for the next pass)

- E1 Reuse `verifySnapshotInput` (`snapshot-vowasia-main.ts:261`) for the sha chain; do not re-implement it.
- E2 R2 preflight tests that all four values are non-empty (mirror `payload.config.ts:62-67`), prints names only.
- E3 Every Payload write passes `context: { disableRevalidate: true, skipTranslationEnqueue: true }` (as GTP); never trigger the vowasia revalidate webhook or translation jobs.
- E4 Media created with `tenant` set so `tenantKeyPrefix` (`src/lib/upload-integrity.ts`) writes `prefix = "vowasia"`; never set the prefix by hand; rehearsal asserts it.
- E5 Author lookup in Central by tenant + name AND slug (the owner may have overridden slugs with `--authors-file`); any mismatch → STOP.
- E6 Fixtures and tests use fake hosts only (`*.invalid`, `localhost`); the 4 off-allow-list link cases in fixtures are fake; no old project ref (repo is PUBLIC).
- E7 Evidence pack lives in `{task folder}/harness/` (`risk-gate.json`, `context-snippets.json`, `verification.json`, `review-decision.json` from G22, `adversarial-validation.json`).
- E8 G7/G7b base pinned to `9d9e5a4`; exactly 7 new `package.json` lines, each containing `vowasia`, 0 removed lines (insert mid-list, as B-alpha did).
- E9 G19 runs alone, background, `timeout 7200000`, `REHEARSE_SKIP_NPM_CI=1`-style default; no other probe or `npm ci` in parallel.

## III. Test coverage plan (B-beta, draft for the next pass)

| Area | Tier | Proving test / command | Proves | Does NOT prove |
|---|---|---|---|---|
| transform/body/author/slug/media/tags (B-2..B-6) | Fully-Automated | G24 + G16 inside `npm run test:migrate-vowasia` | real 4.1 shapes, 0 pending upload nodes, tag table, round-robin ≤1 | real Lexical render on vowasia-web |
| apply gates, lock, sha chain, R2 preflight (B-7) | Fully-Automated | G17, G26 in the same suite | refusals fire before any write | real TTY/Neon behaviour |
| rollback (B-8) incl. 5 conditions, CF2, CF3, body-ref media | Fully-Automated | G27 + 3 required scenario tests | per-run isolation on fakes | Payload delete on real Neon (translation_jobs FK) |
| redirects (B-9a) | Fully-Automated | G28 + G16b | CF1 ratio, owner map rule (after F1 fix) | vowasia-web serving (separate repo) |
| timestamps SQL (B-10) | Fully-Automated | golden-file test | SQL text, WHERE marker+tenant+journal ids | execution on Neon |
| dry-run count block (AC-B15) | Fully-Automated | G25 on fixture | every printed number on fixture data | real numbers (G23) |
| end-to-end on PG16 + local Central | Hybrid | G19 `npm run rehearse:vowasia` (alone) | A/B/C runs, crash + rollback, `prefix === "vowasia"`, mutants red | R2 upload (KB-6) |
| review | Agent-Probe | G22 `vc-code-reviewer` | judgement on write safety | machine proof |
| real data | residual (gap-resolution D) | G23 owner OB5-OB10 | — | everything until the owner runs it |

Gaps and options: KB-6 R2 upload only proven at G23 (C: accept, rehearsal uses local disk; D: backlog stub). G23 real data (D: backlog stub; B stays CONDITIONAL until the owner reports).

## Open gaps

- F1 must be resolved in plan text (or by a recorded owner answer).
- C7 needs an owner confirmation line if the upload-exception rule is adopted.
- KB-1, KB-3 (G23), KB-5, KB-6 unchanged.

## What this validation did NOT prove

- No B-beta code exists yet; every "feasible" verdict is against current B-alpha code, the 11 pinned GTP files and vowasia-web @ `da9716c`, not against an implementation.
- G6 and both rehearsals were not run in this pass.
- The 4 off-allow-list URLs were not seen (counts only); their class is unknown.
- Whether any of the 9 no-cover rows or the 3 body-image articles are rejected is unknown until the dry-run.

## SUPPLEMENT REQUEST

- Gap F1: Section amendment-4-20-10-26-real-snapshot-measurement-b-0b-and-full-b-beta-design (§4.1, §4.2.7, §4.4 item 8, §4.5 AC-B11) | Concern: old draft/scheduled rows given a 308 to `/<pillar>`, overriding owner decisions C3, Q1, Q9; contradicts 3.4 step 8 / 3.5 item 9 | Severity: FAIL | Suggested addition: restore "old draft/scheduled rows get no map entry, listed in the redirects report", set the expected map to 349 entries (12 × 410 + 337 × 308), and align 4.1, 4.2.7, 4.4 item 8 and AC-B11 (or record a new explicit owner answer verbatim in 3.3).
- Gap C1: §4.1 / §4.5 AC-B15 | Concern: 140 date fallbacks counted over all 370 rows incl. rejected | Severity: CONCERN | Suggested addition: dry-run prints the count over all rows (140) and over imported rows; AC-B15 checks the all-rows number.
- Gap C2: §4.2.3 / §4.4 item 9 / §4.6 OB5 / AC-B14 | Concern: "not rewritten" vs rewrite-links of old-site links; AC-B14 presumes the owner's answer | Severity: CONCERN | Suggested addition: classify each of the 4 URLs in dry-run, make OB5 a STOP for the owner's answer, rewrite AC-B14 to match that answer.
- Gap C3: §4.2.2 / §4.4 item 2 | Concern: body text handled as HTML; section order and body-image alt/credit unspecified | Severity: CONCERN | Suggested addition: text parts are escaped text split on blank lines (GTP semantics); fixed order inside a section; alt/credit source; red-first tests.
- Gap C4: §4.4 items 6, 7, 9, 13, 14 | Concern: stale lock after a crash blocks the rollback recovery; lock scope for dry-runs and rewrite-links unstated | Severity: CONCERN | Suggested addition: stale-lock procedure in rehearsal and runbook; only `--apply` modes (import, rollback, rewrite-links) take the lock.
- Gap C5: §4.4 item 13 + Touchpoints | Concern: no way to create tenant vowasia + taxonomy in the local rehearsal Central; script path inconsistent with 3.8 | Severity: CONCERN | Suggested addition: bootstrap via `seed.ts` (unchanged) + local tenant create behind `assertLocalDb` + local `audit:add-vowasia-taxonomy --apply`; one script path; list helper files.
- Gap C6: §4.4 items 11, 14 + Touchpoints | Concern: `migrate:vowasia:fixture` has no target file | Severity: CONCERN | Suggested addition: name the fixture entry file and its job.
- Gap C7: §4.3 step 4 / §4.4 item 5 | Concern: a Media upload exception is treated as an image failure and drafts articles | Severity: CONCERN | Suggested addition: store-level failure → C6 draft; upload exception → stop before creating the article; mark for owner confirmation.
- Gap C8: §4.4 item 6 / §4.6 OB5 | Concern: dry-run output may default inside the public repo tree | Severity: CONCERN | Suggested addition: dry-run requires `--runs-dir` through `assertOutsideRepo`; add it to the OB5 command.
- Gap C9: §4.4 item 7 | Concern: body-upload-node Media references, dry-run report location, delete-error fallback not specified | Severity: CONCERN | Suggested addition: full-scan reference check + red-first test; dry-run report to stdout; delete error = report only (or state the copied fallback).
- Gap C10: §4.6 OB-R | Concern: owner cannot run the Linux-only rehearsal on the Mac | Severity: CONCERN | Suggested addition: G19 at EVL only; owner reads the result.
- Gap C11: §4.5 | Concern: G11 `rehearse:gtp` fate unstated; must never overlap G19 | Severity: CONCERN | Suggested addition: run G11 after G19 at EVL, or drop it with the reason.
- Gap C12: §4.3 | Concern: "add a pin first" conflicts with a frozen pins file outside the touchpoints | Severity: CONCERN | Suggested addition: import only the 11 pinned GTP files; copy everything else.
- Gap C13: §4.3 step 2 / §4.4 item 6 | Concern: missing tags/pillars/sub-sections not covered; GTP tag creation must not be copied | Severity: CONCERN | Suggested addition: STOP when any required taxonomy row is missing; never create taxonomy; red-first test.

Gate: BLOCKED

**Status:** BLOCKED
**Summary:** Amendment 4 is mechanically feasible and its arithmetic, sha chain and CF1-CF4 hold, but §4.2.7 overrides an owner decision (old drafts into the redirect map), so the gate is BLOCKED with 13 smaller spec gaps; no contract written.
**Concerns/Blockers:** F1 (owner-decision override); C1-C13 listed in the SUPPLEMENT REQUEST.
