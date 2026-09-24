---
name: context:all-planning
description: "Plan-shape calibration for apcg-cms — SIMPLE vs COMPLEX, where plans actually live (no process/features folder here), and this repo's own recent plans as real-world shape examples"
keywords: plan, planning, prd, simple, complex, validate-contract, spec, task folder
related: [context:all-database, context:all-integrations]
date: 23-09-26
metadata:
  read_when: "creating a new plan with vc-generate-plan, or deciding whether work is SIMPLE or COMPLEX"
---

# Planning Context

Last updated: 2026-09-23

This is the canonical planning context entrypoint for **apcg-cms**.

Use it after `process/context/all-context.md` when the task needs plan-shape calibration or
planning conventions specific to this repo.

## Scope

This group covers:

- SIMPLE vs COMPLEX plan calibration (pointers to the kit's generic reference PRDs)
- where plans actually live in this repo (there is no dedicated feature-folder structure here)
- this repo's own recent plans as real-world shape examples, not just the generic templates

It does not cover:

- the active implementation plans themselves — `process/general-plans/active/`
- the SPEC/VALIDATE contract mechanics — `process/development-protocols/`

## Read When

Read this entrypoint when:

- creating a new plan with `vc-generate-plan`
- checking whether work should be `SIMPLE` or `COMPLEX`
- looking for a real, in-repo (not generic-template) example of this repo's plan-folder shape

## Quick Routing

- use `.claude/skills/vc-generate-plan/references/example-simple-prd.md` to calibrate a
  one-session plan
- use `.claude/skills/vc-generate-plan/references/example-complex-prd.md` to calibrate a complex
  or multi-phase plan
- use `process/general-plans/active/cms-cost-remediation_09-09-26/` as a real, in-repo COMPLEX
  example — a measurement-gated, multi-repo, multi-phase plan with a written PVL/EVL cycle history
  in its own `results.tsv`
- use `process/general-plans/active/article-unpublish-sync_09-09-26/` as a real, in-repo SIMPLE
  example — SPEC → PLAN → REPORT, single-repo, single concern

## Source Paths

- `.claude/skills/vc-generate-plan/references/example-simple-prd.md`
- `.claude/skills/vc-generate-plan/references/example-complex-prd.md`

## Update Triggers

Update this group when:

- the plan artifact contract changes (e.g. the task-folder shape or required frontmatter fields)
- `vc-generate-plan` expects different plan sections or statuses
- a new in-repo plan becomes a better real-world calibration example than the ones cited above

## Canonical Notes

- this repo has **no dedicated feature-folder structure** — every plan lives under
  `process/general-plans/`, inside a `{slug}_{date}/` task folder holding its `*_PLAN_*.md` plus
  any colocated `*_SPEC_*.md`, `*_REPORT_*.md`, `*_CLOSEOUT_*.md`, `*_NOTE_*.md`, and `results.tsv`
  (see `process/general-plans/active/cms-cost-remediation_09-09-26/` for the fullest real example of
  this shape)
- one legacy flat-shape plan exists
  (`process/general-plans/active/brief-content-type_PLAN_20-08-26.md`, written in Vietnamese,
  predating the current task-folder + SPEC convention) — treat it as a historical/compatibility
  shape per `process/development-protocols/plan-lifecycle.md`, not as a template for new plans
