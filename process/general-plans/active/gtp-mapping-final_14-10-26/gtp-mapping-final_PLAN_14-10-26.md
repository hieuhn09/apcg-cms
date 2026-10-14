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
