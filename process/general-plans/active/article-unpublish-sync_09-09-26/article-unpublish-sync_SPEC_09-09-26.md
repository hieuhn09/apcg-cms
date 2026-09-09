---
name: spec:article-unpublish-sync
description: "Unpublishing an article in the admin must actually remove it from the public API — reverse sync for the native _status → workflowStatus split."
date: 09-09-26
metadata:
  node_type: memory
  type: reference
---

# SPEC — Article unpublish does not take an article off the public site

**TL;DR** Publishing syncs both statuses; unpublishing syncs neither. An editor who clicks **Unpublish** sees the article go grey in the admin while it stays live on the public site. Fix the Unpublish path with a mirrored hook. The Save-Draft path is not fixable by a hook and is scoped to a field description + a known-gap.

## Problem statement

Articles carry two independent statuses:

| Status | Owner | Surface |
|---|---|---|
| `_status` (`draft` / `published`) | Payload versions engine | Admin's Publish / Unpublish / Save Draft buttons |
| `workflowStatus` (7 values) | This repo's editorial model | Workflow tab select |

Public visibility is gated on **`workflowStatus === "published"` alone** (`src/lib/scoped.ts:36-60`, `src/app/api/public/articles/route.ts:74`, `src/app/api/public/articles/[slug]/route.ts:33`). `_status` is deliberately not filtered.

`syncNativePublish` (`src/hooks/article-workflow.ts:76-92`) syncs **one way only**: a human clicking Publish raises `workflowStatus` to `published`. There is no reverse hook anywhere in `src/hooks/`. So the take-down half of the contract does not exist.

## Reproduction paths

**Path A — native Unpublish (in scope, fixable).**
1. Open a live article in the admin. Both statuses read `published`.
2. Click **Unpublish**. `_status` → `draft`. `workflowStatus` stays `published`.
3. `GET /api/public/articles/{slug}` still returns `200` with the doc. Article is still live.

**Path B — Workflow tab + Save Draft (in scope to diagnose, NOT fixable by a hook).**
1. Open a live article. Set the Workflow tab select to `draft` (or `hidden`).
2. Click **Save Draft**.
3. Payload writes the change to the **versions** table only; the main row is untouched. The public API reads the main row, so `workflowStatus` there is still `published`.
4. Article is still live. No `beforeValidate` / `beforeChange` mutation can change this — whatever the hook writes also lands in the version row.

## Acceptance criteria (observable)

| # | Criterion |
|---|---|
| A1 | After a human clicks **Unpublish** on a live article, `GET /api/public/articles/{slug}` returns `404 {"ok":false,"status":"not_found"}`. |
| A2 | After A1, the article's `workflowStatus` reads `hidden` in the admin Workflow tab (not `draft`, not `archived`). |
| A3 | Clicking **Publish** on that same article restores `workflowStatus: published` and the public endpoint returns `200` again (existing `syncNativePublish` behaviour, unregressed). |
| A4 | Console status controls (`setArticleStatusAction`, `createArticleAction`, `updateArticleAction`) are byte-for-byte unaffected: setting `approved` via the console still yields `workflowStatus: approved`, never `hidden`. |
| A5 | No non-human writer changes behaviour: engine intake, `cron/publish-scheduled`, `cron/unpin-expired`, and translation writes produce identical `workflowStatus` values before and after the change. |
| A6 | The ~3,300 legacy rows (`_status: draft` + `workflowStatus: published`) are unchanged by deploy and by any script/cron write. |
| A7 | An article in `workflowStatus: scheduled` is never rewritten by the new hook. |
| A8 | Path B is documented in the admin UI: the `workflowStatus` field description tells editors that changing the select requires **Publish**, not **Save Draft**. |

## Out of scope

- **The article delete bug** — still unexplained, separate track.
- **The ~3,300 legacy split-state rows.** No bulk data repair. Both importers (`scripts/migrate/import-central.ts:477-478,497`, `scripts/migrate/import-gcv-legacy.ts:621,632`) write *consistent* pairs and stamp `origin: "import"`, so the split rows came from the pre-10-08-2026 system write-back bug, not from import. Neither `origin` nor `editedByHuman` separates "human deliberately unpublished" from "legacy row". **No safe derivation query exists — declared a known-gap.**
- **Adding an `_status` filter to the public API.** Would hide most of every site's archive. Permanently forbidden.
- **Frontend cache / revalidate tag coverage** — lives in the consuming repos.
- **Making Path B work mechanically.** Payload's draft engine owns that behaviour; we document rather than fight it.

## Constraints inherited

1. Never filter `_status` in the public API.
2. Never bulk-derive one status from the other.
3. Reverse sync must not fire on non-human writes (`!req.user`) or on `translationWrite` / `systemWrite` / `engineWrite` contexts.
4. Respect the `scheduled` carve-out — the publish-scheduled cron owns that transition.
5. Do not rename or repurpose either status field.
