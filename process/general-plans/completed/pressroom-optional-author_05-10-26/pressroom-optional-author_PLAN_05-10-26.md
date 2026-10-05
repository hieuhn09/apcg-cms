---
name: plan:pressroom-optional-author
description: "Article author optional only when the resulting primary pillar is single-home (Pressroom); stock required behaviour for everything else"
date: 05-10-26
---
# Pressroom: optional Article author — PLAN (SIMPLE)

TL;DR: `author` becomes `required: false` + custom `validate` that skips the requirement only for a single-home primary pillar; everything else delegates to Payload's stock `relationship` validator with `required: true`. No migration, no hook, no engine/FE change.

## SPEC (locked)
- Goal: editors can save/publish a Pressroom article with no author.
- Non-Pressroom: identical to today (field-level required; drafts still skip validation as today).
- Out of scope: new hook, draft-save tightening, beforeChange early-return change, migration, engine, FE.
- Fail closed: pillar unresolvable or lookup error => author required.

## Decision Summary
### Chosen Approach
Field-level custom validate (`makeArticleAuthorValidate(base = relationship)`) in `src/hooks/single-home-pillar.ts`, same pattern as `makeSubSectionPillarValidate`.
### Why This Over Alternatives
| Alternative | Why Rejected |
|---|---|
| beforeChange hook enforcement | Owner forbade; would tighten drafts |
| Drop `required` entirely | Loses requirement for all other tenants |
### Risk Predictions
Wrong pillar source on partial update (mitigated: effective value data/siblingData -> originalDoc); wad/gcv `pressroom` slug misread (mitigated: tenant-scoped `isSingleHomePillar`); admin asterisk lost (accepted, description added).
### Key Constraints Accepted
Admin asterisk disappears for all tenants.

## Touchpoints
- `src/hooks/single-home-pillar.ts` — add `makeArticleAuthorValidate` + `articleAuthorValidate` (pillar from `siblingData.pillar ?? data.pillar ?? originalDoc.pillar`, tenant likewise; resolve via `resolveSingleHome` with `findFor(req)`/`contextOf(req)`; try/catch -> fail closed; non-single-home -> `base(value, {...options, required: true})`).
- `src/collections/Articles.ts:346` — `required: false`, `validate: articleAuthorValidate`, `admin.description: "Required, except for Pressroom articles."`.
- `src/payload-types.ts` — regenerate (`npm run payload:generate-types`); fix typecheck fallout minimally.
- Tests: existing single-home hook test file (add cases); `scripts/single-home-probe.ts` (2 checks).
- Docs: `process/context/integrations/all-integrations.md` §Single-home pillar rule, `database/all-database.md` (author nullable), `tests/all-tests.md` (counts), `all-context.md` Last-updated.

## Public Contracts
Payload REST/GraphQL `Article.author` may be null for Pressroom articles. Public routes spot-checked: no unguarded `article.author.` deref in `src/app/api/public/**`; scripts guard (`typeof a.author === "object" && a.author`). Console `relId(doc.author)` page.tsx:103 — confirm null-safe during EXECUTE. FE uses normalized string author ("Staff" fallback) — no FE change.

## Blast Radius
2 source files + generated types + 1 test file + probe + 4 docs. Risk class: schema-adjacent validation (no DB change; columns already nullable).

## Verification Evidence
| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| `npm run typecheck` | Fully-Automated | types consistent |
| `npm run lint` (baseline warnings only) | Fully-Automated | no new lint |
| `npm run test:single-home` incl. 5 new cases | Fully-Automated | Pressroom passes; normal fails stock msg; Pressroom->normal fails; unresolved/lookup error fails closed; wad/gcv `pressroom` requires author |
| `npm run test:media-redirect` | Fully-Automated | no regression |
| `npm run probe:single-home` and `-- --http` (LOCAL disposable PG only) | Hybrid | real Payload create w/o author OK for Pressroom; rejected for normal on publish |

## Implementation Checklist
1. Add validate factory + export in `src/hooks/single-home-pillar.ts`.
2. Wire into `Articles.ts:346` (required false, validate, description).
3. `npm run payload:generate-types`; keep only `src/payload-types.ts` diff; fix fallout.
4. Verify console `relId` null-safety; grep public routes again.
5. Add 5 node:test cases; update counts.
6. Add 2 probe checks (local guard enforced).
7. Docs one-liners.
8. Run all gates.

## Test Infra Improvement Notes
(none identified yet)

## Resume and Execution Handoff
1. Plan: this file. 2. Last step: VALIDATE done. 3. Validate-contract: written (below). 4. Context: all-context, integrations, database, tests. 5. Next: EXECUTE checklist item 1.

## Validate Contract
generated-by: outer-pvl
date: 2026-10-05
Gate: PASS
- L1 Infra: PASS (no migration; columns nullable). Tests: PASS (node:test + local probe). Breaking: PASS (null author only for Pressroom; consumers null-safe). Security: PASS (no auth surface).
- L2 sections: validate factory PASS; Articles wiring PASS; types PASS; tests/probe PASS.
- Execute-agent instructions: E1 call base validator with `required: true` for non-single-home so message is stock; E2 never run probe against non-local DB; E3 do not open login.json; E4 no hook/migration/engine/FE edits; E5 discard stray generated files except payload-types.ts.
- Test gates: typecheck, lint, test:single-home, test:media-redirect, probe:single-home (+ --http).

## EVL and Closeout (05-10-26)
Closeout classification: Ready for UPDATE PROCESS archival (archived).
Shipped: apcg-cms#27, commit 6542f2e (merged to main). Companion FE work in brief-asia-web#32-#35 (Pressroom shows "Distributed by BriefAsia" instead of an author).
EVL result: CLEAN. Independent vc-tester re-run: typecheck, lint, test:single-home (171 tests), test:media-redirect, probe:single-home 59/59, probe `-- --http` 69/69 all green; 5 extra manual author checks (a)-(e) passed. Probe line `(cleanup) could not delete pillars N: Not Found` confirmed pre-existing on origin/main (probe double-delete bookkeeping), harmless.
SPEC achievement: all criteria met by passing automated/Hybrid gates (Pressroom saves without author; normal articles keep the stock "This field is required."; Pressroom -> normal fails; unresolved pillar / lookup error fails closed; wad/gcv `pressroom` still requires author).
Deviations: (1) `src/payload-types.ts` is gitignored, so checklist step 3 produced no tracked diff; (2) probe check pattern changed to the exact stock message; (3) probe deletes the author-less Pressroom article right away.
Known gaps (accepted, backlog-worthy, none block archival):
- Console UI not run; null-safety of `relId(doc.author)` checked statically only.
- Admin required asterisk is lost on the Author field for ALL articles (mitigated by field description).
- `scripts/hub-probe.ts` not run (not in the validate-contract).
Follow-on (historical wording note): the production `pressroom` Pillars row was created by hand in /admin by the owner, not via `audit:add-pressroom`.
Drift: MEDIUM. Recommend UPDATE PROCESS -- significant changes detected.
