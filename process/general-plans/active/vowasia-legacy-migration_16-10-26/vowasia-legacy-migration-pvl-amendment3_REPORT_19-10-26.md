---
name: report:vowasia-legacy-migration-pvl-amendment3
description: "Inner PVL (VALIDATE V1-V7) of Amendment 3 (phase B import plan) of the VowAsia legacy migration: Gate CONDITIONAL, 0 FAIL, 18 CONCERN, SUPPLEMENT REQUEST"
date: 19-10-26
metadata:
  node_type: memory
  type: report
  feature: vowasia-launch
  phase: B (Amendment 3)
---

# PVL Amendment 3 (phase B) — vowasia-legacy-migration

Date: 19-10-26. Validator: vc-validate-agent (inner PVL, first pass for Amendment 3).
Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (section `## Amendment 3 (19-10-26)`), branch `claude/vowasia-launch`, HEAD `e29c7da` (pushed).

## TL;DR

**Gate: CONDITIONAL (first pass) — 0 FAIL, 18 CONCERN.** The direction is sound (snapshot + local image cache, create-only importer, per-run rollback, own marker, C8 table, round-robin authors). The plan is not yet an executable contract: the body-image pipeline as written cannot carry images (it would make the brief-asia "pending upload node" class of bug), the importer has no R2 preflight (a Mac run without R2 env vars writes production media to the Mac's disk), the crash/skip/adopt rules without `--resume` are undefined, the redirect output targets the wrong vowasia-web file and status, and the one-shot snapshot sitting does not yet say which columns and which body-image URLs it must capture. Validate-contract NOT written (rule: write only on PASS). SUPPLEMENT REQUEST below. Nothing was run against any real database; no code changed.

## V1 pre-check

- Tier-0 restatement: validate Amendment 3 (phase B: snapshot CLI, measure CLI, mapping/transform/body/author/slug/media libs, importer, rollback, rewrite-links, redirects, verify, timestamps SQL, fixture, rehearsal, owner steps) of the plan above, inner PVL.
- `validate-plan-artifact.mjs`: 0 FAIL / 0 warning (779 lines).
- Existing `## Validate Contract` = phase A only (Gate PASS, outer-pvl, 16-10-26); `### Validate Contract (Giai đoạn B)` is a placeholder. No `## Inner Loop Refresh Note`; Amendment 3 itself is the trigger. No Pre-PVL Conflict Resolution, no Phase Ordering section.
- Paths: every GTP file named in 3.4 exists (`media-fetch.ts`, `lexical-body.ts`, `gtp-transform.ts`, `run-dir.ts`, `failure-controls.ts`, `rollback-rules.ts`, `load-guard.ts`, `normalise-path.ts`, `import-gtp-main.ts`, `rollback-main.ts`, `verify-main.ts`, `gtp-redirects.ts`, `gtp-author-distribution.ts`, `slug-plan.ts`, `gtp-timestamps.ts`); `scripts/lib/vowasia-taxonomy.ts`, `scripts/lib/central-db-name-guard.ts` exist; all new B files are (correctly) absent.
- Baselines measured now: `test:migrate-vowasia` 59/59; `test:migrate-gtp` 69/69; `lint:migrate` 0 errors, 1 pre-existing warning (`seed-gtp-legacy-fixture.ts:179`); `typecheck` exit 0; PG16 native present; no listener on 543xx or 3508.

## V2 execution note

`vc-agent-strategy-compare`: signals S2 (DB/permission surface), S6 (trust-boundary + destructive writes via rollback), S7 (20+ files) = 3/7 MEDIUM, recommended 3 parallel sonnet subagents (as plan 3.10). This session has no subagent-spawn tool, so the 4 Layer 1 dimensions and the per-section Layer 2 checks were run SEQUENTIALLY by one agent, read-only, with direct code reading in apcg-cms, Payload internals (`node_modules/@payloadcms/richtext-lexical`) and `/home/user/vowasia-web`. Limitation: no independent second pair of eyes; compensated by citing file:line for every finding.

## Q4b answered (reserved slugs, vowasia-web @ `da9716c`)

- Article route is `src/app/[slug]/[article]/page.tsx` (two segments; `notFound()` unless `PILLARS[pillar]`). The only other route under a pillar is pagination `src/app/[slug]/page/[n]` (three segments). So the only second-segment name worth reserving is `page` (defensive; `/venues/page` would still resolve to an article). Top-level `preview`, `api`, `search`, `feed.xml` and the DOCS keys (`about`, `editorial-standards`, `team`, `contact`, `submit`, `get-listed`, `advertise`, `newsletters`, `privacy`, `terms`, `press-room-submit`) are first-segment only and never pillars. No pillar or DOCS key is `article`, so `/article/<slug>` is free for the redirect map. Discover showed 0 unsafe slugs; collision risk with routes is effectively nil.
- Collision with EXISTING vowasia tenant content is a different risk (slug is unique within tenant, `uniqueWithinTenant`): see U6.

## KB-2 note (C8 pair table)

The discover totals reconcile exactly if every subsection sits under its natural pillar: wedding-business 149 = 125+19+5; venues 93 = 88+4+1 (empty); style 70 = 26+18+16+5+5; destination-weddings 48 = 31+15+2; planning 8 = 3+3+1+1. Every C8 target exists in `scripts/lib/vowasia-taxonomy.ts` under the right pillar (`rings-jewellery`, `people-planners`, `trend-reports`, `destination-guides`, `budgets-real-costs`, `checklists-timelines` included). Arithmetic is not proof (swaps could balance), so the B-0b pair table stays required, but the risk is low.

## V3 net gate

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | CONCERN (U1, U8, U9, U15, U17) |
| Test coverage | CONCERN (U5, U6 crash case, U14 staging, U15) |
| Breaking changes / contracts | CONCERN (U10, U4) |
| Security surface | CONCERN (U16, U18, U1) |

| Layer 2 sections (Amendment 3) | Status |
|---|---|
| 3.1/3.2 facts | CONCERN (U18) |
| 3.3 owner decisions | CONCERN (U11, U12, U13) |
| 3.4 design B | CONCERN (U3, U4, U5, U6, U8, U9, U10) |
| 3.5 checklist | CONCERN (U2, U7, U14) |
| 3.6 owner steps | CONCERN (U1, U16, U17) |
| 3.7 gates | CONCERN (U14, U15, plus G17 cases from U8/U9/U16) |
| 3.8 touchpoints/contracts/blast radius | CONCERN (U10) |
| 3.9 open questions | PASS after recording Q4b (above) |
| 3.10 strategy | PASS |

Totals: 0 FAIL / 18 CONCERN. Net gate: **CONDITIONAL** (first pass, zero PVL fix cycles for Amendment 3 → not terminal; no contract written).

Vacuous-green check: every developed B behavior has a Fully-Automated or Hybrid gate in 3.7 except G23 (real data), which is correctly a named Known-Gap with a backlog stub. Not vacuous; the gaps are in what the gates must assert, listed below.

## Findings (gap list)

U1 — Snapshot column list undefined (CONCERN, Infra/Security). B needs columns phase A never mapped: `columnRoles` in `legacy-source.vowasia.json` has 9 roles (no excerpt, no `featured_image_credit`, no tags, no updated_at). The view in `02` exposes exactly `__ARTICLE_COLUMNS__` as filled by the owner. The snapshot sitting is one-shot (project may be paused), so a missing column means a new sitting. Fix: name the exact column list for the `02` refill and the snapshot (and the PII exclusion, C9), extend `columnRoles`, and make the snapshot CLI refuse when a required role is unmapped.

U2 — Body image URLs must be collected before Q3 is known (CONCERN). Q5b downloads body images in the same sitting, but where images live inside `body_sections` is only measured later (B-0b/Q3). Fix: snapshot collects image URLs generically (walk every string value in `body_sections` and other snapshotted text/jsonb columns; keep URLs whose host is allow-listed), reports counts of image-like URLs on other hosts, keys the manifest by exact URL. Test with a fixture whose image sits under an unknown key.

U3 — Body pipeline cannot carry images as written (CONCERN, highest). `sectionsToHtml` (`gtp-transform.ts:219`) escapes all text and drops a section with no heading/body (`:243`), so image sections vanish silently. Feeding `<img>` to `htmlToLexical` (`convertHTMLToLexical`) yields a PENDING upload node, not one with a media id (`@payloadcms/richtext-lexical/dist/features/upload/server/nodes/conversions.js`, `$convertUploadElement`): the brief-asia incident class. The post-check would reject those articles rather than corrupt them, but the plan's path would then reject every article with a body image. Fix: own vowasia section-to-segments step and splice a serialized upload node `{type:"upload",version:3,relationTo:"media",value:<id>,fields:{},id:<hex>}` (precedent `scripts/migrate/import-gcv-legacy.ts:338-418`), or emit `data-lexical-upload-relation-to`/`data-lexical-upload-id`; test "0 pending upload nodes".

U4 — "Neutral" imports are not all neutral (CONCERN, contracts). `stableFilename` hard-codes the `gtp-` prefix (`gtp-transform.ts:377`), so vowasia media would be named `gtp-<hash>-…` in tenant vowasia. `RUN_MESSAGES.exists` in imported `run-dir.ts:60` tells the user to "pass --resume" (contradicts HC4). `run-dir.ts:10` imports the GTP `out-dir.ts` (3-level `repoRoot()`), so vowasia must never take `assertOutDirSafe` from there. Fix: copy `stableFilename` with a `vowasia-` prefix; wrap the run-dir message; test that vowasia uses its own guard.

U5 — Drift guard is too weak (CONCERN, test). A test that symbols exist and have the right type does not go red when GTP changes behavior (e.g., a looser host check in `media-fetch.ts`). Fix: pin the sha256 of every imported GTP file in a vowasia golden test (pattern: `golden-normalise.json`), plus keep vowasia behavioral tests for the security-critical imported functions (host allow-list, SVG/magic bytes, size cap).

U6 — Skip/adopt/crash semantics without `--resume` undefined (CONCERN, safety rails). Legacy id is not stored on Articles, so detection is (tenant, slug) + marker + local journals. Copying GTP `handleExisting` (`import-gtp-main.ts:381-406`) would ADOPT an unjournaled marker row (crash between create and journal) into the CURRENT run, so rolling back run B would delete run A's row. Fix: never adopt; write an intent line (legacyId, slug, runId, startedAt) BEFORE each create so a crashed run's row stays attributable to its own run-id and rollbackable; `--apply` preflight lists marker rows unknown to every journal and refuses (or needs an explicit flag); slug collision with a NON-marker vowasia article → reject with report (C3 keeps slugs, no rename). Add a rehearsal crash case (kill hook between create and journal) followed by rollback of that run.

U7 — Rollback checks (CONCERN). GTP rollback keeps a media only if a `heroImage` still references it (`rollback-main.ts:142`); vowasia media are also referenced from BODY upload nodes, so a copied rollback could delete media still used in another article's body. Also carry the `timestamps-baseline.json` mechanism (`rollback-main.ts:56`, `rollback-rules.ts` `untouched`): after OB9 changes `updated_at`, rollback would otherwise treat every article as edited.

U8 — No R2 preflight (CONCERN, infra, high impact). With the four `R2_*` env vars unset, Payload falls back to local disk (`payload.config.ts:60-66`). An owner `--apply` from the Mac without them creates production Media docs whose bytes exist only on the Mac. Neither the GTP importer nor `GTP-LEGACY.md` checks this. Fix: refuse `--apply` against non-local Central unless storage-s3 is active; G17 case; OB5 line. (Same latent gap in GTP: note only, B3 forbids touching it.)

U9 — Dry-run vs run-id (CONCERN). GTP creates the run dir even in dry-run (`import-gtp-main.ts:181`); with vowasia's "refuse if run dir exists", `--run-id A` on a dry-run blocks the later `--apply --run-id A`. Fix: dry-run never creates a named run dir (always `dry-<ts>`, or refuses `--run-id`); G17 case.

U10 — Redirect contract mismatch (CONCERN, public contract). vowasia-web's exact map is `src/redirects/redirect-map.json` (object; value = path string or `{"status":410}`; keys normalised by `normalise-path.ts`, golden sha256 `e5b2247c…`), served by `src/lib/redirect-middleware.ts` with **308**. `src/lib/redirect-config.ts` is pattern rules capped at 200 (`MAX_PATTERN_RULES`), too small for ~350 exact URLs. The plan says "301" and "format of redirect-config.ts". Fix: emit `redirect-map.json` format, key with the GTP `normalise-path.ts` (neutral, pinned), call it "permanent (308)".

U11 — Archived and no-hero URLs (CONCERN, owner decision). C2 deferred "archived → section or 410" to after discover; the Amendment 3 C3 answer does not close it. Imported archived articles are not public (visibility is `workflowStatus === "published"`), so a 301/308 to `/<pillar>/<slug>` lands on 404 for 107 URLs; the same holds for the 9 published-but-no-hero articles imported as drafts. Needs an owner answer (410 / leave out (404) / redirect to the pillar page).

U12 — Tags (C4) have no rule (CONCERN, owner decision). "Map to the 6 tags" has no mapping and discover did not measure the legacy tag column. Add tags to B-0b and a mapping, or record "no tags imported" as the owner's choice. Do not invent one.

U13 — Post-import edits vs "không sửa" (CONCERN, owner confirmation). Contract A asked to get the owner's confirmation that `rewrite-links` (edits imported articles) and `timestamps-fix.sql` are separate, owner-run steps limited to marker + tenant + run, not covered by "importer only creates". Not recorded in 3.3.

U14 — Stage split not codified (CONCERN, structure). B-2/B-3 are blocked on Q2/Q3, which need the owner sitting, which needs B-0 to pass EVL. Define Stage B-α (B-0, B-0b, B-1, minimal fixture; gates G1-G5, G8, G20, G21, snapshot part of G18, G22 on snapshot) → EVL → owner OB1-OB4 + OB3b → plan supplement for Q2/Q3/U12 with its own inner PVL → Stage B-β (B-2..B-14, full G16-G22). One validate contract per stage.

U15 — Rehearsal resources (CONCERN, infra). GTP rehearsal uses ports 54326-54328 + 3508, the phase A probe 54336. Give `rehearse:vowasia` its own ports, a port-free precheck, `npm ci` off by default (HC6), and assert media `prefix === "vowasia"`. R2 itself is not exercised in rehearsal (local disk): name it as a residual.

U16 — Snapshot/cache integrity and exposure (CONCERN, security). (a) A sha256 stored next to the files detects corruption, not substitution: import should take the owner-recorded digest (`--expect-sha256`) of a manifest that lists every file's sha256. (b) Cache files named by content sha256 only; manifest strings never used as paths; re-sniff magic bytes and size at import. (c) `hostRewrite` is accepted with any target (`vowasia-config.ts:73`); `media-fetch.physicalUrl` would then fetch `http://<target>` while recording the allowed host: refuse unless the target is local and the run is a rehearsal. (d) Shorter role life: write rows, run `03e`, then download images from the snapshot (no DB needed). (e) Retention: an OB step to delete or archive the snapshot and cache after verify/cutover.

U17 — Journal durability (CONCERN, infra). Journals under `scripts/migrate/out/vowasia/runs/` live in the git working copy (ignored). A re-clone or `git clean -fdx` makes per-run rollback impossible. Store them out of repo next to the snapshot, or add a backup step before OB6.

U18 — Facts hygiene (CONCERN, minor). 3.3 "khoảng 249 bài published/archived" is inconsistent (229 + 107 = 336; minus at most 9 no-hero = 327 or more). The shared Supabase project ref is written verbatim in the pushed plan (3.2, 3.3, Q5) although phase A deliberately masked it (`vowasia-db-banner.ts`) and kept the image host out of repo (`legacy-source.vowasia.json` `_note`). Use `<ref>.supabase.co` in docs; keep the host in the overlay.

## Section III — test coverage plan (per area, B)

| Area | Tier | Gate | Proves | Does NOT prove |
|---|---|---|---|---|
| Snapshot CLI (rows + images) | Fully-Automated + Hybrid | G21 + G18 snapshot part (fixture image server) | SELECT-only, out-of-repo write 700/600, host allow-list, size/magic/SVG, generic URL collection (U2), digest check (U16) | real Supabase storage behavior, real egress limits |
| Measure CLI | Fully-Automated | G21 | no DB connection, shape report for title/excerpt/body/tags/pairs | correctness of owner's reading of the report |
| Mapping C8 + status/dates/taxonomy | Fully-Automated | G16 | pair table, reject unknown pair, C2/C6/C7 | real pair distribution (KB-2) |
| Body → Lexical with images | Fully-Automated | G16/G18 | serialized upload node with new id, 0 pending nodes, 0 old-host URLs (U3) | rendering in vowasia-web |
| Authors round-robin | Fully-Automated | G16 | per-pillar order, spread ≤ 1, union of runs, no author created | — |
| `--apply` gate | Fully-Automated | G17 | TTY, confirm-host, `/neondb`, new run-id, no `--resume`, R2 active (U8), dry-run run-id (U9) | owner's environment |
| Import/rollback/second run/crash | Hybrid | G19 rehearsal (native PG16, own ports) | runs A/B/C, skip-not-adopt, crash attribution (U6), rollback isolation incl. body refs + timestamps baseline (U7), mutations go red | R2 upload, Neon, real data (G23) |
| Redirect map | Fully-Automated | G16 | `redirect-map.json` format, normalise-path keys, 410 for rejected, archived/no-hero per U11 | live middleware |
| GTP unchanged + drift | Fully-Automated | G20 + G4 + hash pin (U5) | 0 GTP bytes, GTP suite green, imported files unchanged | `rehearse:gtp` end-to-end (G11, final EVL) |
| Real data | Known-Gap | G23 (backlog stub) | — | everything on `neondb`/R2 |

Fully-Automated failing stubs (for the stage contracts, not written yet):
- `test("should splice serialized upload nodes with new Central media ids and leave 0 pending nodes", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should splice serialized upload nodes with new Central media ids and leave 0 pending nodes") })`
- `test("should refuse --apply against non-local Central when R2 storage is not configured", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should refuse --apply against non-local Central when R2 storage is not configured") })`
- `test("should never adopt an unjournaled marker row and should attribute a crashed create to its own run-id", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should never adopt an unjournaled marker row and should attribute a crashed create to its own run-id") })`
- `test("should emit vowasia-web redirect-map.json entries keyed by normalise-path with 410 for rejected", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should emit vowasia-web redirect-map.json entries keyed by normalise-path with 410 for rejected") })`
- `test("should go red when any imported GTP file changes (sha256 pin)", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should go red when any imported GTP file changes (sha256 pin)") })`

High-risk classes: permission/secret/trust-boundary (legacy role, snapshot), destructive data mutation (rollback deletes). `vc-risk-evidence-pack` applies at the end of EXECUTE B (inside the task folder `harness/`).

## SUPPLEMENT REQUEST

Section id (the only `##` heading involved): `amendment-3-(19-10-26):-kết-quả-giai-đoạn-a-thật-+-kế-hoạch-giai-đoạn-b`; subsection given per gap.

- Gap 1 (U1): §3.6 / §3.5 B-0 | Snapshot/view column list undefined; `columnRoles` lacks excerpt, credit, tags, updated_at | CONCERN | Add the exact `__ARTICLE_COLUMNS__` list (no PII), extend `columnRoles`, and make the snapshot refuse when a required role is unmapped.
- Gap 2 (U2): §3.5 B-0 | Body image URLs must be captured before Q3 is known | CONCERN | Snapshot collects allow-listed image URLs from every string inside `body_sections` and other snapshotted text/jsonb columns, reports other-host counts; fixture with an image under an unknown key.
- Gap 3 (U3): §3.4 step 4 / §3.5 B-3 | `sectionsToHtml` drops image sections; `<img>` through `htmlToLexical` makes pending upload nodes | CONCERN | Specify own section-to-segments + serialized upload node splice (gcv precedent) and a "0 pending nodes" test.
- Gap 4 (U4): §3.4 D-B1 | `stableFilename` carries `gtp-` prefix; run-dir message says `--resume`; run-dir imports GTP out-dir | CONCERN | Move `stableFilename` to the copy list with `vowasia-` prefix, wrap the message, test that vowasia uses its own `assertOutDirSafe`.
- Gap 5 (U5): §3.4 D-B1 / §3.7 G16 | Symbol-only drift guard | CONCERN | Pin sha256 of each imported GTP file in a golden test plus behavioral tests of security-critical imported functions.
- Gap 6 (U6): §3.4 step 6 / §3.5 B-7 | No skip/adopt/crash rules without `--resume`; slug collision with non-marker content | CONCERN | Never adopt; intent journal line before each create; preflight refuses unknown marker rows; non-marker slug collision → reject; rehearsal crash case.
- Gap 7 (U7): §3.5 B-8 | Rollback ignores body upload references and timestamps baseline | CONCERN | Rollback keeps media referenced from any body node and uses `timestamps-baseline.json` for `untouched`.
- Gap 8 (U8): §3.4 CLI / §3.6 OB5 / §3.7 G17 | No R2 preflight | CONCERN | Refuse non-local `--apply` unless the four R2 env vars are set; G17 case; OB5 line.
- Gap 9 (U9): §3.4 CLI / §3.7 G17 | Dry-run creates the named run dir | CONCERN | Dry-run never creates a named run dir; G17 case.
- Gap 10 (U10): §3.4 step 8 / §3.5 B-9 / §3.8 | Redirect output targets `redirect-config.ts` and 301; web uses `redirect-map.json` and 308 | CONCERN | Emit `redirect-map.json` format with `normalise-path` keys; describe as permanent (308).
- Gap 11 (U11): §3.3 / §3.9 | Archived (107) and no-hero drafts (9) redirect target undecided; targets would 404 | CONCERN | Add owner question Q9 and block B-9 on it.
- Gap 12 (U12): §3.3 C4 / §3.5 B-0b | Tag mapping undefined, not measured | CONCERN | Add tags to measure and an owner mapping (or owner-confirmed "no tags").
- Gap 13 (U13): §3.3 / §3.4 step 8 | Owner confirmation for rewrite-links + timestamps-fix as post-import edits not recorded | CONCERN | Add Q10 (or record the confirmation) scoping both to marker + tenant + run.
- Gap 14 (U14): §3.5 / §3.7 / `### Validate Contract (Giai đoạn B)` | Stage boundary around the owner sitting not codified | CONCERN | Define Stage B-α and B-β with their own gate sets and contracts; B-β gets an inner PVL after Q2/Q3/U12.
- Gap 15 (U15): §3.7 G19 / §3.5 B-12 | Rehearsal ports and prefix assert unspecified | CONCERN | Assign own ports with a free-port precheck, `npm ci` off by default, assert media `prefix === "vowasia"`, name R2 as residual.
- Gap 16 (U16): §3.5 B-0, B-6 / §3.6 | Integrity anchor, cache naming, hostRewrite, role life, retention | CONCERN | `--expect-sha256`, content-addressed cache, refuse non-local `hostRewrite`, images after `03e`, retention OB step.
- Gap 17 (U17): §3.4 step 7 / §3.6 | Journals in git working copy | CONCERN | Journals out of repo (next to the snapshot) or a backup step before OB6.
- Gap 18 (U18): §3.2 / §3.3 | Wrong "249" count; project ref in a pushed plan | CONCERN | Fix the count; replace the ref with `<ref>.supabase.co`.
- Plan update (not a gap): record the Q4b answer (reserved second segment = `page`; `article` free) and the KB-2 reconciliation in §3.9.

## V7 handoff

Gate: CONDITIONAL
Plan path: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate-contract written: no (first-pass CONDITIONAL; written only on PASS per caller instruction)
Next step: PVL supplement cycle (vc-plan-agent, PVL-supplement mode, with the SUPPLEMENT REQUEST above), then re-spawn vc-validate-agent from V1.

EXECUTE strategy (when a stage contract passes): sequential, one opus vc-execute-agent per stage (files are tightly coupled); EVL by one sonnet vc-tester; G19 alone, in the background, timeout 7200000; G22 one sonnet vc-code-reviewer. Alternatives: parallel subagents (risk of interface drift between libs), workflow (no repeated item set), agent team (no blast-radius coordination needed). Estimated agents per stage: 1 + 1 + 1 = 3 (well under the 30 cost guard).
