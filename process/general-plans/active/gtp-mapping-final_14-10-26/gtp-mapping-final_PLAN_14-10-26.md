---
name: plan:gtp-mapping-final
description: "Finalize GTP legacy-migration mapping: real legacy URL shapes, close all 8 owner-decision markers, keep rehearsal + tests green"
date: 14-10-26
feature: gtp-launch (stored in general-plans; repo has no process/features folder)
---

# GTP mapping final — PLAN (SIMPLE)

TL;DR: edit one JSON mapping (8 markers closed, real URLs), re-point 2 unit tests and 3 rehearsal checks
at a cloned provisional variant / apex host, light doc edits. 5-6 files. Rehearsal runnable natively.

## Goal
`scripts/migrate/legacy-mapping.gtp-network.json` passes `--require-final` with 0 markers, using owner-approved
(14-10-26) values, without weakening any test or rehearsal check.

## Approved values
- `_provisional` -> `[]`.
- `_evidence` += " Resolved 14-10-26: urls.* taken from the live old site's public sitemap and URL probes (articles at /article/{slug}, apex host, static pages at their final paths); archivedAs, formatTags, pin and countries.match accepted at their defaults by the owner."
- `urls.oldOrigin` "https://globaltravelpost.com"; `articlePathTemplate` "/article/{slug}"; `sectionPaths` news/destinations/business-of-travel/experiences-luxury/press-room/events-awards -> "/<same>"; `extraLegacyPaths` ["/about","/contact","/privacy","/terms","/advertise","/editorial-standards","/studio","/licensing","/press-room-submit","/newsletters","/team","/visa-tracker"].
- archivedAs "section", formatTags.enabled true, pin {fromFlags:false,maxPinned:0}, countries.match "either": unchanged values, accepted.

## Touchpoints
| File | Change |
|---|---|
| `scripts/migrate/legacy-mapping.gtp-network.json` | values above |
| `scripts/migrate/lib/gtp-mapping.test.ts` | G41: assert `provisional.length > 0` on a clone with `_provisional=["urls.articlePathTemplate"]`; committed mapping asserts `provisional.length === 0`. G46: build provisional variant the same way, keep `formatProvisional(...)` match `/urls\.articlePathTemplate .*OD-24/` and the requireFinal throw on it; ADD test: committed mapping passes `validateMapping(raw, overlay, {requireFinal:true})` with 0 markers. No other assertion weakened. |
| `scripts/migrate/fixtures/gtp-legacy/rehearse-assert.ts` | Step 5 (~l.162-168): run `--structural-only` and `--require-final` against a cloned provisional mapping written to the rehearsal OUT dir (mode 0600) for the "PROVISIONAL list" + "exit 2" checks; ADD check: committed mapping `--require-final` exits 0 with no PROVISIONAL text. G35 (~l.379): same cloned provisional mapping passed via `--mapping` to trigger exit 2. Sitemap host (~l.365-366) -> `https://globaltravelpost.com`. Re-homed check (~l.376): if `oldUrl` normalises to `/article/${slug}` the builder drops the identity redirect, so assert absence-or-equal (map entry undefined when identical, else `/article/<slug>`); pick a rehomed row whose oldUrl differs if one exists. |
| `scripts/migrate/fixtures/gtp-legacy/seed-gtp-legacy-fixture.ts` | **Added 15-10-26 by owner approval** (see "Owner-approved scope amendment 15-10-26"). Exactly two edits: `OLD_ORIGIN` (~l.22) to `https://globaltravelpost.com`; article-12 internal link (~l.180) to `${OLD_ORIGIN}/article/fixture-${WORDS[50 % WORDS.length]}-story-50`. Fixture data only. |
| `scripts/migrate/lib/verify-main.ts` | added 15-10-26 by owner approval (amendment 2). Confirm the cause first, then a minimal fix to the link-replacement in the body-text parity check (~l.156-163). No threshold change. See "Owner-approved scope amendment 2, 15-10-26". |
| `scripts/migrate/lib/verify-parity-links.test.ts` (new) | added 15-10-26 by owner approval (amendment 2). One unit test: old and new paths coincide, Central body still holds the absolute old URL. Picked up by the `scripts/migrate/lib/*.test.ts` glob of `npm run test:migrate-gtp`. |
| `scripts/migrate/lib/gtp-transform.test.ts` | Verify only (l.~108/111 pass template/origin as plain inputs); expected unchanged. |
| `scripts/migrate/GTP-LEGACY.md` (~l.20,30,85-86), `docs/12-migration.md` (~l.173) | Replace "provisional / owner-open" wording with resolved values + date; note `/studio`, `/visa-tracker` have no gtp-web route (owner question). |
| `scripts/migrate/lib/gtp-redirects.ts` | NOT changed (identity-drop behaviour is correct for the new template; STATIC_LEGACY only adds redirects for its own keys). |

## Public Contracts
None changed. CLI flags and exit codes of migrate tools unchanged. Mapping file shape unchanged (values only).

## Blast Radius
5 files edited (+1 verified), all under `scripts/migrate/**` and `docs/`. No `src/`, no schema, no production run. Risk class: migration tooling (data-migration adjacent, offline only). Rollback: revert the commit.

## Risks
| Risk | Mitigation |
|---|---|
| Fixture counts/old-URL shapes shift with new template (identity redirects dropped) | Rehearsal assertions keyed on behaviour, not hard counts; executor re-reads every count check in G35 coverage and adjusts only where the shift is a direct consequence of the template, recorded in commit body |
| Weakening tests by accident | Each changed assertion keeps an equivalent provisional-path check + a new final-path check |
| Rehearsal infra flake | Native mode (`REHEARSE_MODE=native`); docker daemon is down |

## Rehearsal feasibility (checked read-only 14-10-26)
`docker info` fails (no daemon). `/usr/lib/postgresql/16/bin/{pg_ctl,initdb}` exist, running as root, `postgres` user exists, `psql` present, `node_modules` present. `rehearse-gtp.sh` supports native mode with exactly these paths. => **Runnable** via `REHEARSE_MODE=native npm run rehearse:gtp` (auto mode picks native). If it fails for an environment reason, EXECUTE must list each unrun check as UNPROVEN in the PR body.

## Open owner questions
1. Old `/studio` and `/visa-tracker` exist on the old site but gtp-web has no route. Kept in `extraLegacyPaths`, no code added. Decide: build pages, redirect elsewhere, or 410.

## Verification Evidence
| Gate / Scenario | Strategy | Proves |
|---|---|---|
| `npm run test:migrate-gtp` | Fully-Automated | unit tests incl. new final-mapping test |
| `npm run lint:migrate` | Fully-Automated | lint clean |
| `npm run migrate:gtp:validate-mapping -- --mapping scripts/migrate/legacy-mapping.gtp-network.json --mapping-overlay scripts/migrate/fixtures/gtp-legacy/overlay.fixture.json --require-final` | Fully-Automated | OK, no provisional list |
| `npm run rehearse:gtp` | Hybrid (native PG16) | exit 0, UNPROVEN empty in `scripts/migrate/out/rehearse/rehearse-summary.json` |
| `git diff --check` + `git diff --stat` | Fully-Automated | only planned files touched |

## Test Infra Improvement Notes
(none identified yet) — rehearse-assert hard-codes the www host; now apex. Consider deriving from mapping `urls.oldOrigin`.

## Execution strategy
EXECUTE: sequential, ONE opus agent (files tightly coupled). All other phases sonnet. EVL: one sonnet vc-tester.

## Commit (EXECUTE)
```
fix(gtp-migrate): set real legacy URL shapes and close owner-decision markers

Resolved markers: urls.oldOrigin, urls.articlePathTemplate, urls.sectionPaths,
urls.extraLegacyPaths, archivedAs, formatTags.enabled, pin, countries.match.
Evidence: live old site's public sitemap and URL probes (14-10-26); defaults
accepted by the owner. Tests/rehearsal now trigger provisional paths with a
cloned provisional mapping.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TKzrsUPVHxFLCnzgsqd9i1
```
Push needs `--force-with-lease` (branch reset to origin/main 8bde7ff). Never touch ~/gtp-private; never print secrets.

## Resume and Execution Handoff
1. Plan: this file. 2. Last step: VALIDATE done. 3. Validate-contract: written below. 4. Context: all-context.md, tests/all-tests.md, scripts/migrate/GTP-LEGACY.md. 5. Next: on "ENTER EXECUTE MODE", one opus vc-execute-agent applies Touchpoints in order JSON -> unit tests -> rehearse-assert -> docs, runs gates.

## Validate Contract
generated-by: outer-pvl
date: 2026-10-14
Date: 14-10-26
Gate: PASS

| Layer 1 | Status |
|---|---|
| Infra fit | PASS (native PG16 present) |
| Test coverage | PASS (provisional paths kept via clone; final path newly tested) |
| Breaking changes | PASS (values only; no CLI/schema change) |
| Security | PASS (offline; clone written 0600 in OUT; no secrets) |

| Layer 2 | Status |
|---|---|
| JSON mapping | PASS |
| gtp-mapping.test.ts | PASS (targets l.16, l.41-46 confirmed) |
| rehearse-assert.ts | PASS (targets l.165-168, 365-366, 376, 379 confirmed) |
| docs | PASS |

Totals: 0 FAIL / 0 CONCERN. Net Gate: PASS.

Execute-agent instructions:
- E1: Do not change gtp-redirects.ts unless a gate proves it necessary; if so, stop and report why.
- E2: Any rehearsal count change must be explained in the commit body.
- E3: If rehearsal cannot run, record UNPROVEN checks in PR body; do not claim green.

Test gates: the five rows in Verification Evidence, in that order.

## Owner-approved scope amendment 15-10-26

Status: owner-approved scope, recorded here. The validate-contract above and its `Gate: PASS` lines are unchanged and kept.

1. **Why.** During EXECUTE (commit 2d8c166 on branch `claude/clever-gates-h5xyd8`, pushed as WIP to PR #40) `npm run rehearse:gtp` failed at step 9 ("pass 1 flags exactly the fixture row with an internal link": got `[]` instead of one row, then `invalid input syntax for type integer: "NaN"`). Cause: the fixture seed still writes old-shape internal links. With the new mapping every old URL is `/article/{slug}`, and the importer only flags a link whose path matches a known old URL (`scripts/migrate/lib/import-gtp-main.ts` ~l.645-656). This is a consequence of the approved URL template, not a code bug.

2. **New touchpoint (owner replied "đồng ý bổ sung fixture" on 15-10-26):** `scripts/migrate/fixtures/gtp-legacy/seed-gtp-legacy-fixture.ts`, exactly two edits:
   - (a) line ~22: `OLD_ORIGIN` from `"https://www.globaltravelpost.com"` to `"https://globaltravelpost.com"`.
   - (b) line ~180: the article-12 internal link from `${OLD_ORIGIN}/${t50sec}/fixture-${WORDS[50 % WORDS.length]}-story-50` to `${OLD_ORIGIN}/article/fixture-${WORDS[50 % WORDS.length]}-story-50`.
   - Keep the deliberate dangling link `${OLD_ORIGIN}/news/deleted-story` unchanged.
   - Fixture data only: no database, no product code. If `t50sec` becomes unused after the edit, remove only that unused binding if lint/typecheck requires it.

3. **Rule for further drift.** Any other rehearsal expectation that turns out to depend on the old URL shape (only visible after step 9) must STOP the run and be reported as NEEDS_CONTEXT. Never weaken or skip a check. Each additional file needs a further owner approval.

4. **Corrections to the plan text.**
   - (a) `validate-mapping --require-final` prints `PROVISIONAL: none` (the tool always prints that line). The gate is: exit code 0, output contains `PROVISIONAL: none`, and no marker name is listed. This supersedes "no provisional list" wording in the Verification Evidence table and the rehearse-assert "no PROVISIONAL text" check description.
   - (b) The push of the EXECUTE commit is a normal `git push -u origin claude/clever-gates-h5xyd8`. The branch already contains the plan commit e5c1e94 and the WIP commit 2d8c166, so `--force-with-lease` is no longer needed and must not be used (supersedes the "Commit (EXECUTE)" push note).

5. **Gate.** All five validate-contract gates stay as written, plus the full `npm run rehearse:gtp` must now exit 0 with an empty UNPROVEN list in `scripts/migrate/out/rehearse/rehearse-summary.json`. The existing `Gate: PASS` verdict is kept; this amendment is owner-approved scope, recorded here, and the independent EVL run after EXECUTE is the confirmation.

## Owner-approved scope amendment 2, 15-10-26

Status: owner-approved scope (owner replied "đồng ý sửa verify-main" on 15-10-26), recorded here. The validate-contract and its `Gate: PASS` lines are unchanged and kept.

1. **Why.** After amendment 1 (fixture seed edits, commit 1468adf, WIP on PR #40), `npm run rehearse:gtp` runs to the end: 127 checks ok, 1 failed. The failure is G50 "parity on the snapshot import exits 0": `[verify] FAIL body text parity: aaaaaaaa-0000-4000-8000-00000000000d body ratio 1.109 similarity 0.929`. That row is the fixture article with the internal link (`internalLinkFrom`). `rehearse-summary.json` shows `ok: false`, `unproven: []`.

2. **Suspected cause (from reading `scripts/migrate/lib/verify-main.ts` lines ~156-163; NOT yet confirmed on the Central row).** The verifier maps each old link `u` to its new path `to` and, if the Central body contains `to`, replaces the full `u` in the source text with `to`. With the real mapping the old and new paths coincide (`/article/{slug}` on both sides), so the absolute old URL `https://globaltravelpost.com/article/...` contains `to` as a substring. When the Central body still holds the full absolute URL (link not rewritten in that run), the test is fooled: the source text is shortened but the Central text is not, and similarity falls below 0.97. Under the old template `/{section}/{slug}` this could not happen. This also matters for the real run (G6 part b): bodies with absolute internal links could be falsely reported as FAIL.

3. **Approved change.**
   - FIRST confirm the cause by inspecting the actual Central body text of that fixture row during or after the rehearsal. Read-only, against the throwaway local rehearsal database only.
   - THEN make the minimal fix in `scripts/migrate/lib/verify-main.ts` so the replacement applies only when the Central body contains `to` AND no longer contains the full old URL `u`. The agent may choose the exact expression that matches the confirmed cause, for example `to && texts.includes(to) && !texts.includes(u)`.
   - Add ONE unit test in the new file `scripts/migrate/lib/verify-parity-links.test.ts` (next to the other lib tests; picked up by `npm run test:migrate-gtp` via its `scripts/migrate/lib/*.test.ts` glob). It covers the case where old and new paths coincide and the Central body still holds the absolute URL. It must fail without the fix and pass with it. If the verifier's logic is not unit-testable as is, extract the minimal pure helper and test that, keep the diff small, and say so in the report.
   - No change to any check's threshold (ratio 0.9-1.1, similarity 0.97) and no weakening of any check.

4. **Stop rule.** If the cause turns out to be different from the suspicion, or the fix needs more than `verify-main.ts` plus its one test, STOP and report NEEDS_CONTEXT. Each further file needs a further owner approval.

5. **Gates.** The five original gates plus the full `npm run rehearse:gtp` must exit 0 with an empty UNPROVEN list and `failed: []`. `npm run test:migrate-gtp` must now include the new test (pass count increases by at least 1). The existing `Gate: PASS` verdict is kept; this amendment is owner-approved scope and the independent EVL run after EXECUTE is the confirmation.
