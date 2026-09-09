---
name: plan:article-unpublish-sync
description: "Add syncNativeUnpublish — a mirrored beforeValidate hook so clicking Unpublish actually removes an article from the public API."
date: 09-09-26
metadata:
  node_type: memory
  type: plan
---

# PLAN — article unpublish sync (SIMPLE)

Date: 09-09-26
Status: VALIDATED — awaiting EXECUTE approval
Complexity: SIMPLE

## Overview / Context

Articles carry two independent statuses. Public visibility is gated on `workflowStatus === "published"` alone; Payload's native `_status` is deliberately not filtered because ~3,300 live imported rows sit at `_status: "draft"`. `syncNativePublish` syncs Publish → `workflowStatus`, but nothing syncs the reverse, so clicking **Unpublish** leaves the article live on the public site. This plan adds the missing mirror hook. Full problem statement, reproduction paths, and out-of-scope list: `article-unpublish-sync_SPEC_09-09-26.md` in this task folder.

**TL;DR** Add one new exported `beforeValidate` hook, `syncNativeUnpublish`, between the existing two in `Articles.ts`. It fires only when a **human** save carries `_status: "draft"` while the **stored** `workflowStatus` is `"published"`, and no explicit workflowStatus change is in the same save. It sets `workflowStatus = "hidden"`. Plus a one-line admin field-description change for the unfixable Save-Draft path. Two files touched, ~25 net lines.

## Decision Summary

### Chosen Approach

**New sibling hook `syncNativeUnpublish`, gated on stored `workflowStatus === "published"`** — a structural mirror of `syncNativePublish`, placed immediately before `enforceStatusAuthority` so the authority gate judges the lowered value exactly as it judges the raised one.

Trigger condition (all four must hold):
1. `data` present **and** `req.user` present (human write only — mirrors `article-workflow.ts:77`).
2. `data._status === "draft"`.
3. Stored `originalDoc.workflowStatus === "published"` — this is the "was live" signal.
4. No explicit workflowStatus change in the same save (`incoming === undefined || incoming === stored`) — mirrors the carve-out at `article-workflow.ts:85`.

Then: `data.workflowStatus = "hidden"`.

### Why This Over Alternatives

| Alternative | Why rejected |
|---|---|
| Extend `syncNativePublish` in place | Its documented contract and its first guard (`_status !== "published" → return`) are built around one direction. Inverting it forces a two-branch function whose 25-line docblock no longer describes either branch cleanly. Two named hooks read better and fail independently. |
| Gate on `originalDoc._status === "published" && data._status === "draft"` (an `_status` transition) | Depends on `_status` being reliably populated on `originalDoc` in `beforeValidate` for a drafts-enabled collection — unverified here and unverifiable without a running DB. Gating on stored `workflowStatus === "published"` needs only a plain, always-present column and expresses the intent directly ("it was live; make it not live"). |
| Gate on `data._status === "draft"` alone | **Actively wrong.** The console sets `workflowStatus` and `_status` together (`actions.ts:72,119,145`), so saving an article as `approved` sends `_status: "draft"`. A bare `_status` gate would rewrite `approved` → `hidden` on every console save. Condition 3 (+ 4) is what makes A4 hold. |
| Set `workflowStatus = "draft"` on unpublish | `draft` means "being written / never finished" and sends a complete article back to the start of the editorial lifecycle, where contributor-level authority applies. It is a lie about editorial state. |
| Set `workflowStatus = "archived"` on unpublish | `archived` reads as terminal — "done with this forever". Unpublish is routinely temporary (correction, embargo, legal hold). |
| **`hidden` (chosen)** | `ARTICLE_STATUSES` (`src/lib/constants.ts:37-45`) carries `hidden` and `archived` specifically to express "was live, now isn't". `hidden` is the reversible one: content complete, not public. Exactly what Unpublish means. `articleActivity` already logs `article_unpublished` for any `published → non-published` transition (`article-workflow.ts:211`), so no logging change is needed. |
| Fix Path B (Save Draft) with a hook | Impossible. With `versions: { drafts: true }` a draft save writes the versions row only; the main row the public API reads is untouched, and anything a hook mutates lands in that same version row. Scoped to A8 (field description) + known-gap. |
| Bulk repair the 3,300 legacy rows | Forbidden by constraint. No column separates deliberate-unpublish from legacy-split. Known-gap, out of scope. |

### Risk Predictions (vc-predict, 5 personas)

| Persona | Risk |
|---|---|
| Architect | Two hooks now write `workflowStatus` in `beforeValidate`. Their trigger conditions are disjoint (`_status === "published"` vs `"draft"`), so they can never both fire in one save — but that disjointness is implicit and must be stated in the docblock. |
| Operator | Ships to three live publications. A wrong trigger mass-changes editorial state. The console-save case (bare `_status` gate) is the concrete near-miss; condition 3 + 4 defuses it. Rollback must be trivial. |
| Security | `enforceStatusAuthority` runs after, so a contributor without publish rights clicking Unpublish gets thrown (`hidden` ∉ `CONTRIBUTOR_ALLOWED_STATUSES`). Symmetric with the existing Publish behaviour, so consistent — but the error text will say "may only set status to draft or pending review", which is confusing on an Unpublish click. Accepted CONCERN, not a blocker. |
| Data | Legacy rows: only ever written by scripts with no `req.user`, so guard 1 short-circuits. They also fail condition 2/3 combination unless a human deliberately unpublishes. Proven, not assumed. |
| Tester | Zero test runner exists in this repo. Every behavioural criterion lands in agent-probe or manual tiers. There is no automated way to prove A1–A7. |

### Key Constraints Accepted

- No `_status` filter anywhere in the public API.
- No bulk data repair; the 3,300-row split state is a permanent known-gap.
- Path B (Save Draft) is documented, not fixed.
- Behaviour must be a strict no-op for every non-human writer and for the console actions.

## Touchpoints

| File | Change |
|---|---|
| `src/hooks/article-workflow.ts` | Add exported `syncNativeUnpublish` (~20 lines incl. docblock) after `syncNativePublish` (line 92). No edits to existing functions. |
| `src/collections/Articles.ts` | Import `syncNativeUnpublish` (line 8-12 block); insert into `beforeValidate` array (line 83) between `syncNativePublish` and `enforceStatusAuthority`; update the ordering comment (line 81-82). Update `workflowStatus` field `admin.description` (line 167) for A8. |

**Read for context, not modified:** `src/lib/constants.ts`, `src/lib/scoped.ts`, `src/app/api/public/articles/**`, `src/app/(console)/console/sites/[tenant]/articles/actions.ts`, `src/app/api/engine/intake/route.ts`, `src/app/api/cron/publish-scheduled/route.ts`, `src/app/api/cron/unpin-expired/route.ts`, `src/hooks/translation.ts`.

## Public Contracts

| Contract | Change |
|---|---|
| `GET /api/public/articles` + `/[slug]` visibility rule (`workflowStatus === "published"`) | **Unchanged.** The filter is untouched; only which rows carry `published` changes, and only via deliberate human action. |
| `ARTICLE_STATUSES` values / semantics | Unchanged. `hidden` gains its first automatic writer. |
| Admin behaviour of the Unpublish button | **Changed (this is the fix).** It now also lowers `workflowStatus` to `hidden`. |
| `ActivityLog` event stream | Unchanged code; a genuine `article_unpublished` event will now be emitted where previously none was (the transition never happened). |
| Console server actions | Unchanged and must remain no-ops (A4). |
| Engine / cron / translation write paths | Unchanged and must remain no-ops (A5). |

## Blast Radius

- **Files changed:** 2. **Packages:** 1 (single Next.js app).
- **Risk class:** **HIGH** — public API visibility contract adjacent; ships to three live publications; touches a hook that runs on *every* article write including engine and cron paths.
- **Rows potentially affected at deploy time:** 0. The hook only runs on a subsequent human write.
- **Writers in blast radius — every one audited:**

| Writer | `req.user`? | Sets `_status: draft`? | Verdict |
|---|---|---|---|
| Admin Unpublish button | yes | yes | **Fires — intended.** |
| Admin Publish button | yes | no (`published`) | No-op (condition 2 fails). |
| Admin Save Draft | yes | yes | Hook runs but result lands in the versions row only — inert. Path B unchanged. |
| `setArticleStatusAction` (`actions.ts:145`) | yes | yes, when target ≠ published | No-op: either stored ≠ `published` (cond. 3) or incoming ≠ stored (cond. 4). |
| `createArticleAction` (`actions.ts:72`) | yes | yes, when target ≠ published | No-op: `operation === "create"`, no `originalDoc` (cond. 3). |
| `updateArticleAction` (`actions.ts:119`) | yes | yes, when target ≠ published | No-op by cond. 3 or 4, same as above. |
| `api/engine/intake/route.ts:210-211` | **no** | both set together | No-op (guard 1). |
| `api/cron/publish-scheduled/route.ts:92-93` | **no** | always `published` | No-op (guards 1 + cond. 2). |
| `api/cron/unpin-expired/route.ts:93-99` | **no**, `systemWrite` | draft-guarded | No-op (guard 1). |
| `src/hooks/translation.ts:39` | **no**, `translationWrite` | skips drafts | No-op (guard 1). |
| Import scripts (`import-central`, `import-gcv-legacy`) | **no** (local API) | write consistent pairs | No-op (guard 1). **This is the A6 proof.** |

## Intended change (proposal only — NOT applied)

`src/hooks/article-workflow.ts`, inserted after line 92:

```
/**
 * Native Unpublish → workflowStatus sync. The mirror of syncNativePublish.
 *
 * Public visibility is workflowStatus alone, so clicking Unpublish (which only
 * lowers `_status`) previously left the article live on the site. A HUMAN
 * clicking Unpublish on a LIVE article means "take this off the site", so
 * workflowStatus follows down to "hidden" — the status that exists precisely
 * to mean "was live, now isn't, content is complete" (vs "draft" = never
 * finished, "archived" = terminal).
 *
 * The trigger is deliberately gated on the STORED workflowStatus being
 * "published", not on an `_status` transition: the console actions set
 * workflowStatus and `_status` together, so a bare `_status: "draft"` gate
 * would rewrite an "approved" console save to "hidden".
 *
 * Carve-outs mirror syncNativePublish: an explicit workflowStatus change in
 * the same save wins, and non-human writes (engine/cron/translation, no
 * req.user) are untouched. "scheduled" cannot be the stored value here, so the
 * publish-scheduled cron's transition is unreachable by this hook.
 *
 * Runs BEFORE enforceStatusAuthority, so a contributor without publish rights
 * is rejected by the authority gate exactly as they are on the Publish side.
 */
export const syncNativeUnpublish: CollectionBeforeValidateHook = ({ data, originalDoc, req }) => {
  if (!data || !req.user) return data;
  if ((data as { _status?: string })._status !== "draft") return data;

  const stored = originalDoc?.workflowStatus as ArticleStatus | undefined;
  if (stored !== "published") return data;

  const incoming = data.workflowStatus as ArticleStatus | undefined;
  // Explicit change in the same save wins (console + Workflow-tab edits).
  if (incoming !== undefined && incoming !== stored) return data;

  data.workflowStatus = "hidden";
  return data;
};
```

`src/collections/Articles.ts`:

```
// line 81-83 — comment + array
    // Order matters: syncNativePublish may raise workflowStatus to "published"
    // and syncNativeUnpublish may lower it to "hidden" (their triggers are
    // disjoint — `_status` published vs draft); enforceStatusAuthority must
    // then judge the resulting value.
    beforeValidate: [syncNativePublish, syncNativeUnpublish, enforceStatusAuthority],

// line 167 — admin.description on workflowStatus, append:
//   "Changing this select only takes effect on the public site when you click
//    Publish — Save Draft stores it as a draft revision only."
```

## Verification Evidence

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) exits 0 | Fully-Automated | Compile correctness of the new hook + import only |
| `npm run lint` (`next lint`) exits 0 | Fully-Automated | Style/lint only |
| Manual script step 1–4 (Unpublish → curl → 404) | Hybrid (live CMS) | A1, A2 |
| Manual script step 5–6 (Publish → curl → 200) | Hybrid (live CMS) | A3 |
| Manual script step 7 (console set `approved`, re-read) | Hybrid (live CMS) | A4 |
| Manual script step 8 (Workflow tab → Save Draft → curl still 200) | Hybrid (live CMS) | Path B still broken as documented; A8 context |
| Code read of all 11 writers vs the 4 trigger conditions | Agent-Probe | A5, A6, A7 |
| Engine intake / cron behaviour under real traffic | Known-Gap | A5 not provable without a live engine run |
| Legacy-row invariance under a full cron sweep | Known-Gap | A6 not provable without prod DB |

## Test Infra Improvement Notes

This repo has **no test runner** — `package.json` offers only `lint` and `typecheck`. There is no vitest/jest/playwright anywhere. Every behavioural criterion (A1–A8) is therefore Hybrid-manual or Known-Gap; none can be automated today. Backlog candidate: introduce a hook-level unit runner (vitest) with a fixture harness for `beforeValidate` hooks so status-sync logic gains a real regression gate. Recorded as a gap, not scheduled here.

## Implementation Checklist

1. `src/hooks/article-workflow.ts` — add exported `syncNativeUnpublish` after line 92, exactly as in **Intended change**. Do not modify `syncNativePublish`, `enforceStatusAuthority`, `articleBookkeeping`, or `articleActivity`.
2. `src/collections/Articles.ts` — add `syncNativeUnpublish` to the import block (lines 8-12).
3. `src/collections/Articles.ts` — replace the `beforeValidate` array (line 83) and its ordering comment (lines 81-82).
4. `src/collections/Articles.ts` — append the Save-Draft sentence to the `workflowStatus` field `admin.description` (line 167).
5. Run `npm run typecheck` — must exit 0.
6. Run `npm run lint` — must exit 0.
7. Hand the manual verification script to the user. Do not self-certify A1–A8.

## Acceptance Criteria

Verbatim from the SPEC (A1–A8). Testing context: this repo has **no test runner**; `npm run lint` and `npm run typecheck` are the only automated gates, and all behavioural criteria are verified by the manual post-phase testing script in the validate-contract.

| # | Criterion | Gate |
|---|---|---|
| A1 | After Unpublish, `GET /api/public/articles/{slug}` returns `404` | Manual step 3 |
| A2 | `workflowStatus` reads `hidden` after Unpublish | Manual step 4 |
| A3 | Publish restores `published` + `200` | Manual steps 5–6 |
| A4 | Console actions unaffected (`approved` stays `approved`) | Manual step 7 |
| A5 | Engine / cron / translation writes unchanged | Code-read probe + known-gap |
| A6 | ~3,300 legacy rows unchanged | Code-read probe |
| A7 | `scheduled` articles never rewritten | Code-read probe |
| A8 | `workflowStatus` field description explains the Save-Draft caveat | Checklist item 4 |

## Phase Completion Rules

Single-phase plan. This phase is complete only when **all** of the following hold:

1. Checklist items 1–4 applied, touching exactly the two files in Touchpoints.
2. `npm run typecheck` and `npm run lint` both exit 0 (post-phase testing gate).
3. The manual verification script has been handed to the user and steps 1–8 confirmed by a human on the live CMS.
4. Code-only completion is `CODE DONE`, **not** `VERIFIED`. The plan may not be archived until step 3 returns a human-confirmed pass, because A1–A7 have no automated coverage.
5. If any manual step fails, execute the Rollback Plan and return to PLAN — do not patch forward on a live publication.

## Rollback Plan

Single-commit revert. The change is additive and stateless:

1. `git revert <commit>` (or remove `syncNativeUnpublish` from the `beforeValidate` array in `Articles.ts` — a one-line hotfix that fully disables the behaviour without touching the hook file).
2. Redeploy.
3. **No data migration is needed to roll back.** The hook writes no rows at deploy time; it only changes what a human save produces. Any article already flipped to `hidden` by the hook was a deliberate human Unpublish and can be restored individually by clicking Publish (which `syncNativePublish` already handles).
4. If a wrong flip is discovered in production: fix per-article via the console status control; never via a bulk update.

**Rollback trigger conditions:** any console save producing `hidden` unexpectedly (A4 violation); any engine/cron write changing `workflowStatus` (A5 violation); any drop in live article counts on any of the three sites.

## Resume and Execution Handoff

1. **Selected plan file:** `process/general-plans/active/article-unpublish-sync_09-09-26/article-unpublish-sync_PLAN_09-09-26.md`
2. **Last completed step:** VALIDATE complete; validate-contract written below. EXECUTE not started — no source file has been modified.
3. **Validate-contract status:** written (09-09-26), gate CONDITIONAL.
4. **Supporting context loaded:** `src/hooks/article-workflow.ts`, `src/collections/Articles.ts`, `src/lib/constants.ts`, `src/lib/scoped.ts`, `src/app/api/public/articles/[slug]/route.ts`, `src/lib/public.ts`, console `actions.ts`, `process/development-protocols/plan-lifecycle.md`. `process/context/all-context.md` does not exist in this repo (harness not set up) — durable knowledge lives in `docs/` and source header comments.
5. **Next step for a fresh agent:** execute checklist items 1–4 exactly, run 5–6, then STOP and surface the manual verification script. Do not touch any file outside the two named in Touchpoints. Do not run any migration or data-repair script.

## Validate Contract

```yaml
generated-by: outer-pvl
date: 2026-09-09
plan: process/general-plans/active/article-unpublish-sync_09-09-26/article-unpublish-sync_PLAN_09-09-26.md
mode: simple
risk-class: public-API-adjacent, multi-tenant-live
```

### Layer 1 dimensions

| Dimension | Status | Findings |
|---|---|---|
| Infra fit | PASS | Two file edits in one Next.js app. Hook registration point verified at `Articles.ts:83`. No new dependency, runtime surface, port, or migration. |
| Test coverage | **CONCERN** | No test runner exists. Only `lint` + `typecheck` are automated, and neither can execute here (`node_modules` absent, `DATABASE_URL` unset). All behavioural criteria are Hybrid-manual or Known-Gap. |
| Breaking changes | **CONCERN** | The public visibility *filter* is unchanged, but the observable behaviour of the admin Unpublish button changes on three live publications. Editors who currently use Unpublish as a no-op "take out of the Payload publish flow" gesture will now see articles leave the site. This is the intended fix, but it is a behaviour change users must be told about. |
| Security surface | **CONCERN** | `enforceStatusAuthority` runs after the new hook, so a contributor without publish rights clicking Unpublish now throws `"Contributors without publish rights may only set status to draft or pending_review."` — correct denial, confusing message. Symmetric with the existing Publish-side behaviour; accepted, not fixed here. |

### Layer 2 sections

| Section | Status | Notes |
|---|---|---|
| Hook addition (`article-workflow.ts`) | PASS | Insertion point line 92 unique and matchable. `ArticleStatus` and `CollectionBeforeValidateHook` already imported. No collision. Highest-risk edit in the plan; mitigated by the four-condition gate. |
| Hook registration (`Articles.ts`) | PASS | `beforeValidate: [syncNativePublish, enforceStatusAuthority]` at line 83 is a unique string. Ordering rationale documented in-file. |
| Field description (`Articles.ts:167`) | PASS | Cosmetic string append; no behaviour. |
| Non-human writer no-op guarantee | **CONCERN** | Proven by code read of all 11 writers, but unprovable by execution in this environment. Carried as a known-gap into the manual script. |
| Legacy 3,300-row invariance | PASS | Import scripts use the local API with no `req.user`; guard 1 short-circuits before any condition is evaluated. Deploy touches zero rows. |

**Totals: 0 FAILs / 4 CONCERNs / 6 PASSes**

### Test gates (for whoever runs EXECUTE — cannot run in the planning environment)

| Tier | Command | Precondition |
|---|---|---|
| Fully-automated | `npm run typecheck` — must exit 0 | `node_modules` installed |
| Fully-automated | `npm run lint` — must exit 0 | `node_modules` installed |
| Hybrid | Manual verification script below | Deployed CMS + tenant read token |
| Known-gap | Engine/cron no-op under real traffic; legacy-row invariance under a prod sweep | — |

### Manual verification script (run against the live CMS)

Set once:
```bash
export CMS=https://<cms-host>
export TOKEN=<tenant read token>          # public API bearer, per tenant
export SLUG=<slug of a live test article>
```

Baseline — confirm the article is live:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$CMS/api/public/articles/$SLUG"
```
Expected: `200`.

1. Admin → open the article. Confirm the Workflow tab reads `published` and the sidebar shows Published.
2. Click **Unpublish**.
3. Re-run the curl above. **Expected `404`** (before the fix: `200` — this is the bug).
4. Reload the article in the admin. **Expected Workflow tab reads `hidden`** (A2).
5. Click **Publish**.
6. Re-run the curl. **Expected `200`**, Workflow tab back to `published` (A3).
7. Console → same article → set status to `approved` via the inline workflow control. Reload the admin. **Expected Workflow tab reads `approved`, NOT `hidden`** (A4). Re-run curl → `404` (approved is not public). Then set it back to `published`.
8. Path B regression check: admin → set the Workflow select to `draft` → click **Save Draft** (not Publish). Re-run curl. **Expected `200` — still live.** This confirms Path B remains unfixed and is covered only by the field description (A8). Restore the select to `published` and click **Publish**.

Abort and roll back if step 3 returns `200`, step 4 shows `draft` or `archived`, or step 7 shows `hidden`.

### Execute-agent instructions

| # | Instruction | Trigger |
|---|---|---|
| E1 | Touch **only** `src/hooks/article-workflow.ts` and `src/collections/Articles.ts`. Any need to touch a third file means the design is wrong — stop and return to PLAN. | Entry |
| E2 | Do **not** add an `_status` filter to any public route, and do not modify `src/lib/scoped.ts`. | Entry |
| E3 | Do **not** run, write, or propose any migration or bulk data-repair script. | Entry |
| E4 | Preserve all four trigger conditions verbatim. Dropping condition 3 or 4 breaks the console actions (A4) — this is the single highest-risk deviation. | Hook write |
| E5 | If `npm run typecheck` reveals `originalDoc` is typed such that `workflowStatus` is not accessible, cast as in the existing `syncNativePublish` (line 80) — do not change the trigger design. | After step 5 |
| E6 | Do not self-certify A1–A8. Hand the manual script to the user and report `DONE_WITH_CONCERNS` with the manual gates listed as unrun. | Completion |

### Known gaps carried

1. Path B (Workflow tab + Save Draft) remains functionally broken; mitigated only by the field description. Payload's draft engine owns this behaviour.
2. The ~3,300 legacy split-state rows are not repaired and cannot be safely derived.
3. No automated regression gate exists for status-sync logic (no test runner in repo).
4. A5/A6 are proven by code read only, not by execution.

**Gate: CONDITIONAL** — 0 FAILs, 4 CONCERNs, all documented above and accepted as known-gaps. Proceed to EXECUTE only on explicit user approval; the manual verification script and rollback plan are mandatory, not optional.
