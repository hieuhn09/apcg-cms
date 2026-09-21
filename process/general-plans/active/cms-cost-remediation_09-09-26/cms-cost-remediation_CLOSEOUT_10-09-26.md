---
name: report:cms-cost-remediation-closeout-10-09-26
description: "UPDATE PROCESS closeout packet — reconciles Phase 1 + gzip + Fix 2b production ships against the plan; program stays in active/, mid-flight"
date: 10-09-26
updated: 11-09-26
metadata:
  node_type: memory
  type: report
  feature: general
  phase: update-process
---

# Closeout Packet — cms-cost-remediation (10-09-26, refreshed 11-09-26)

**Refresh note (2026-09-11):** this file is refreshed in place rather than superseded by a new dated file — the 10-09-26 packet's structure and most findings still hold; this pass updates it to reflect the Fix 2b production ship and the GCV audit that unblocked it. No prior findings were removed, only extended.

## TL;DR

Four production changes now shipped and verified: Phase 1 (`0ae9fa3`), gzip (`0ecc6bb`), the GCV audit (`ef6b5e5`, no code — cleared the last Fix 2b blocker), and Fix 2b (`4917ef5`). Program is **still mid-flight, NOT archivable** — E13 (post-deploy Observability confirmation for gzip) remains unread, Phase 0 is only partially met (P1/P2b open), and Phase 3/4 haven't started. No source files touched this UPDATE PROCESS pass; drift is LOW.

1. **Selected plan path:** `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md`

2. **Closeout classification:** **Keep in active/testing.** Four production changes shipped and directly verified, but E13 has not been read, and the program's remaining phases (Phase 0 P1/P2b, Phase 2 Fix #1/#3, Phase 3, Phase 4) are open. Not ready for `## Validate Contract` PASS or archival.

3. **What was finished (this UPDATE PROCESS pass, no code):**
   - Reconciled the plan against everything that happened since the last UPDATE PROCESS pass (`fa63cc5`): GCV audit (`ef6b5e5`, 32d93bf — zero hits on all five leak fields, P10/P8d closed 5/5, E1 lifted) and the Fix 2b ship (`45a02b8` → merged `4917ef5`, production build `apcg-kmasetrjs` Ready 15:54 GMT+7).
   - Rewrote `## Current Execution State`: added a dedicated Fix 2b row (DONE, production-verified, with the measured before/after numbers), narrowed the Fix #1/#3/crawler-control row (Fix #3 may only need P1, not P1+P2b — flagged for the next agent to check), narrowed the Phase 3 row (P8d clear, P8a-c still the real blocker), and added an explicit E13-still-unread row with the exact dashboard path and revert command.
   - Updated `## Gzip's Effect on Fix 2b's Value` with a "SHIPPED" note: the pre-ship estimate (26.8% raw / 13.1% gzipped) matched production measurement almost exactly.
   - Updated `## Follow-up: Guard Comments for Contract Locks`: Fix 2b's own EXECUTE shipped the `LIST_SELECT` half of this follow-up (rationale/contract-lock comment added); the `refsView` half is still open — called out explicitly so it isn't lost.
   - Rewrote `## Resume and Execution Handoff` items 1-5 for a zero-context resume: E13 first, then P1/P2b, then Fix #1/#3, with Fix 2b now marked DONE (do not re-ship) and a new cleanup line (delete two merged remote branches; rotate `CMS_READ_TOKEN`/bypass secret).
   - Preserved byte-for-byte: `## ⚠️ INVALIDATED`, all 10 `## What NOT To Do` rows.

4. **What was verified vs still unverified:**
   - **Verified (production, direct measurement):** GCV clean audit against `origin/main` tip `32d93bf` (zero hits on 5 leak fields, no persistence, no schema validator, no `next/image`, embedded Payload deleted). Fix 2b in production: 53 keys/doc (was 58), 78,633 B (was ~107,403 B raw pre-gzip baseline); health probes 200 on brief-asia (206 ms), WAD (165 ms), DTW (173 ms), GCV (164 ms); WTB homepage 200 with hero rendered (pin keys intact).
   - **Still unverified:** E13 (gzip Observability bytes) — the single next action, not a long-term gap; instructions are explicit (Usage → Fast Origin Transfer → apcg-cms → 48h, expect 6-8x step-down, revert `0ecc6bb` if it didn't drop). Admin `Users.useAsTitle="email"` display degradation — carried forward unverified from the prior pass; `email` is excluded by the `defaultPopulate` allowlist, so the admin "Last Edited By" column may render raw IDs instead of names. If confirmed, fix is `useAsTitle: "name"` (a required field) — never re-add `email` to the allowlist. P1/P2b (Phase 0 measurements) — unrun.

4b. **Validate-contract compliance:** VALIDATE ran three times (`results.tsv` iterations 0, 2, 5); no new PVL cycle this pass. Current contract: PVL cycle 3, `Gate: CONDITIONAL`, `generated-by: outer-pvl`, dated 2026-09-10, present inline in the plan (`## Validate Contract`). Fix 2b's EVL (iteration 7, `HALTED_SUCCESS`) confirmed its gates green under this same standing contract via the E1-LIFTED plan-supplement note — no re-validation from V1 was required since the contract already scoped Fix 2b's execute-agent instructions. CONDITIONAL remains correct — the whole-plan gate cannot reach PASS while Phase 0/2(remainder)/3/4 remain open.

5. **Cleanup done vs still needed:**
   - Done: plan-body reconciliation (this pass), closeout refresh (this file), Tier-1 plan audits (below), local `process:` commit.
   - Still needed: E13 read; P1/P2b measurement; `refsView` guard comment (code, deferred to next EXECUTE touching that file); optional audit of the other 3 tenants' `frontendUrl`; delete merged remote branches `probe/gzip-public-api` and `fix/list-select-drop-internal-fields`; user to remove `CMS_READ_TOKEN` from `.env.local` and regenerate the Vercel bypass secret; `vc-setup` still NOT run — `process/context/all-context.md` remains absent (noted once, not stalled on).

6. **Single best next valid state:** Keep the plan active. Next agent picking this up should read E13 (Vercel Observability) first, then run P1/P2b, then start Fix #1 (or Fix #3 if P1 alone is enough to unblock it — check the Phase 2 branch logic). Do NOT re-ship Fix 2b or start Phase 3 — Phase 3 remains P8a-c-blocked.

7. **Commit-checkpoint recommendation:** **Process commit belongs after UPDATE PROCESS — already the case here.** All implementation commits (`ef6b5e5` GCV audit — no code, `45a02b8`/`4917ef5` Fix 2b, and the PVL/EVL commits in between) were already made during EXECUTE/EVL, before this session started. This pass produces only plan/closeout artifacts inside the task folder — one `process:` commit, local only, no push (per task instructions).

8. **Regression status:** N/A in the phase-program sense (single general plan, not an umbrella/phase-program). Within-plan regression already ran during Fix 2b's EVL: E1/A3/A4/depth:0 re-verified intact against the merged tree, plus a field-name sanity check confirming `tenant` is `multiTenantPlugin`-injected (not a silent no-op) — see `results.tsv` iteration 7 and the fix2b EVL note.

9. **SPEC achievement:** No `*_SPEC_*.md` exists for this plan (predates the SPEC convention; governed by its own `## Acceptance Criteria`). Re-scoring against that section with Fix 2b now shipped:
   - "Phase 0's five measurements... recorded before any Phase 2 code change lands" — **met by design, unchanged from prior pass**: gzip and Fix 2b are both explicitly carved out as `r`-independent (CMS-only, no dependency on the unmeasured fan-out share); Fix #1/#3 (the `r`-dependent items) correctly have NOT started.
   - "TTL-raise idea is never re-shipped" — **met**. Not touched.
   - "Fix #2 ships with the security `defaultPopulate` fix, not `depth: 0`" — **met**. Fix 2a verified in code and production; Fix 2b (the field-drop half) also now shipped and verified without touching `depth: 0`.
   - "Fix #4 (R2 cutover) does not go live before... P8a-d all pass" — **met (not started)**. Phase 3 untouched; P8a-c still not run.
   - "No `media.url`/`sizes_*_url` backfill task created" — **met**. Not created.
   - "Every fix row names repo, file:line, expected saving, risk level, blocking precondition" — **met**, unchanged from PLAN.
   - No unmet criteria this pass → no new backlog NOTE required for SPEC gaps.

## Drift Signal Scoring

Signals present:
- (a) Files touched during EXECUTE (this UPDATE PROCESS pass): 0 source files — **+0**. (Fix 2b's own EXECUTE touched 1 file across a prior session, already captured in its own report/EVL note, not this pass.)
- (b1) `.claude/`/`.codex/`/agent harness files changed this pass: none — **+0**
- (b2) `README.md`/`AGENTS.md`/`CLAUDE.md`/`process/development-protocols/` changed this pass: none — **+0**
- (c) 3+ memory-worthy observations this session: GCV clean-audit pattern reused for a 5th tenant with zero findings, Fix 2b's pre-ship estimate matching production measurement almost exactly, the `refsView`-comment-still-missing gap surviving two EXECUTE passes — **+1**
- (d) Feature-folder structural change: none (no new task folder, no archival, no backlog NOTE written) — **+0**
- (e) Validate-contract deviation: none new this pass — **+0**

Total: **1 signal → LOW.**

**UPDATE PROCESS available if you want.**

(This UPDATE PROCESS pass is itself the response to that recommendation — already executed.)

## Move-On Recommendation

Keep the plan active and continue validation/measurement on the same selected plan. Next concrete action: read Vercel Observability for E13, then run P1/P2b, then start Fix #1 (or Fix #3 if P1's `q=` share alone is sufficient).
