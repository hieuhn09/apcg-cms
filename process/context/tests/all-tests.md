---
name: context:all-tests
description: "Verification quick-start for apcg-cms — there is no automated test framework here; the real gates are typecheck + lint + manual/live verification. Read before claiming any change is verified."
keywords: test, tests, testing, verify, verification, typecheck, lint, gate, validate-contract, evl, pvl, ci
related: [context:all-database, context:all-integrations]
date: 24-09-26
metadata:
  read_when: "running verification after implementation, deciding what a validate-contract's test gates should be, or debugging a failing typecheck/lint"
---

# apcg-cms — All Tests

Last updated: 2026-09-24 (APCGHub P4 / CMS-2 — `scripts/hub-probe.ts` gained `--setup2`/`--nullorder`/`--check2`; disposable one-shot local Postgres 16 pattern (not the Docker stack) used for CMS-2's `/api/hub/tenants`+`/api/hub/taxonomy` data-shape checks; corrected the CMS-1-era note claiming local seed tenant slugs don't match production — they do, the earlier note had the production slugs wrong, see Known Gaps). Previously: APCGHub P4 / CMS-1 — `npm run build` promoted to mandatory gate; loose-vs-strict Payload types trap + cheap `tsc` gate without `payload-types.ts`; `PAYLOAD_DB_PUSH=true` migration-hiding trap; Docker/seed/port pitfalls; unfiltered-grep lesson

Attach this file first when the task involves testing, verification, or gate design.

**The single most important fact in this file: apcg-cms has no automated test framework and no
CI.** Do not assume `npm test` exists, do not invent a test command, and do not design a
validate-contract around a test runner this repo does not have.

---

## How This File Works

This is the `all-tests.md` entrypoint for the `tests/` context group, following the `all-*.md`
routing convention: agents read `process/context/all-context.md` first and get routed here for
testing/verification tasks.

## What This Covers

- what verification commands actually exist in this repo (two: typecheck, lint)
- why there is no test-runner command to route to
- the verification pattern this repo's own plans have actually used in practice
- known testing/CI gaps worth remembering so nobody re-discovers them from scratch

## Read This When

Use this file when you need to:

- verify a change before calling it done
- decide what a validate-contract's test gates should be for this repo
- explain why `npm test` does not work here

## Quick Routing

No deeper `tests/` docs exist. This repo's verification surface is small enough (2 real commands,
no framework) that it fits entirely in this entrypoint — do not create a deeper doc for it unless a
real test framework is adopted later.

## Quick Decision Guide

### Use `npm run typecheck` for

any TypeScript change — `tsc --noEmit`, whole repo, strict mode is on
(`noUncheckedIndexedAccess` / `noImplicitOverride` / `noFallthroughCasesInSwitch`). No
package-scoped variant; it always checks the whole repo.

### Use `npm run lint` for

code-style / `next/core-web-vitals` concerns — but `next.config.ts` sets
`eslint: { ignoreDuringBuilds: true }`, so a lint failure will **not** block a Vercel deploy. Treat
it as a manual/review-quality signal, never as something that automatically gates anything.

### There is no automated behavioral test tier

No unit tests, no integration tests, no e2e tests, and no `vitest` / `jest` / `playwright` /
`mocha` dependency anywhere in `package.json` (confirmed by direct inspection, not inference). A
validate-contract for this repo cannot cite a "run the tests" command that asserts pass/fail on
behavior — design test gates around the tiers that actually exist here (typecheck/lint as the
fully-automated tier; manual/live verification as the remaining tier), per the tier model in
`.claude/skills/vc-test-coverage-plan/SKILL.md`.

### Use manual/live verification for

anything behavioral: a route's actual response shape, a hook's actual side effect, a migration's
actual effect on data. This repo's own completed plans do exactly this —
`process/general-plans/active/cms-cost-remediation_09-09-26/` is a fully worked example: curl
probes against a live Preview/Production deployment, direct admin-panel/SQL counts, and Vercel
Observability dashboard reads, all recorded as verification evidence in the plan body and its EVL
iteration reports (`cms-cost-remediation-pvl-iteration-*.md`, `results.tsv`).

## Default Verification Order

1. `npm run typecheck` — cheapest, catches the most common class of break
2. `npm run lint` — cheap, style/best-practice only, non-blocking for deploy
3. **`npm run build` — MANDATORY gate for any code change, not optional/nice-to-have.** Added to
   this ordering 24-09-26 after `npm run typecheck` + `npm run lint` both passed clean on a change
   that then failed Vercel Preview's build (APCGHub P4 / CMS-1). `next build` runs Next's own
   generated-route type-checking (`.next/types/app/**`, picked up by `tsconfig.json`'s `include`)
   and pre-render/import-map steps that `tsc --noEmit` alone does not reach — this is the tier that
   would have caught a bad route export or import-map issue if the CMS-1 Preview failure had turned
   out to be code-caused (it did not — see the note below).
   **⚠️ A green `npm run build` on your machine does NOT prove the Vercel build is green — and the
   reason is now known.** `src/payload-types.ts` is gitignored (`.gitignore:28`), and `build` runs
   only `payload generate:importmap`, never `generate:types`. So Vercel (a fresh clone) builds
   WITHOUT that file, the `declare module 'payload'` augmentation in it (`payload-types.ts:2446`)
   never applies, and Payload falls back to its **loose** types (e.g. `find().docs` is
   `JsonObject & TypeWithID`). A dev machine has the file (the dev server regenerates it), so every
   local gate — `typecheck`, `lint`, `npm run build` — checks against **strict** types. Because
   `tsconfig.json` includes `**/*.ts`, `next build` type-checks `scripts/` too, not just `src/app/`.
   CMS-1's Preview failed (twice, ~60 s) on exactly this: a direct cast in
   `scripts/hub-probe.ts:328` that only compiled under strict types. Fixed by casting through
   `unknown`; reproduced red/green on a clean clone and confirmed `784424f` (pre-hub) builds green.
   - **Cheap gate (seconds) — MANDATORY before pushing any code change:** move
     `src/payload-types.ts` out of the tree, run `npx tsc --noEmit` (must be 0 errors), then move it
     back and confirm with `ls` (it is gitignored, so `git status` will NOT tell you it is missing).
   - **Full gate:** clean `git clone` + `npm ci` + `VERCEL_ENV=preview npm run vercel-build`, with no
     `src/payload-types.ts` and no `.env.local` (set `DATABASE_URL`/`DATABASE_DIRECT_URL`/
     `PAYLOAD_SECRET`/`CENTRAL_SIGNING_SECRET` in the shell, pointing at the local Docker DB).
   - Gap `cms-gates-run-with-strict-types-but-vercel-builds-loose`: the root cause is NOT fixed.
     Options (adding `generate:types` to `build`, or committing `payload-types.ts` once the
     pre-existing strict-type casts are fixed — see the `.gitignore` comment) are a separate
     decision, out of scope here.
4. manual/live verification scoped to exactly what changed — the only tier that can confirm
   *behavior*, not just that the code compiles, lints, and builds

## Commands

| Command | What it does | Notes |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`, whole repo | strict; no partial/package-scoped variant |
| `npm run lint` | `next lint` (flat config, `eslint.config.mjs`) | not a deploy gate |
| `npm run build` | `payload generate:importmap && next build` | **MANDATORY gate as of 24-09-26** (see §Default Verification Order #3) — closest thing to an integration check; a bad Payload config, an import cycle, or a Next route-typing issue can fail here even when `typecheck` passed clean. Green locally ≠ green on Vercel — local builds see strict Payload types, Vercel builds loose ones (see §Default Verification Order #3 for the cheap loose-type gate). |
| `npm run db:status` | `tsx scripts/db-status.ts` | quick live DB-connectivity/migration-state check — closest thing to a smoke test |
| `npx tsx scripts/hub-probe.ts --setup / --check / --paging` | one-shot data-layer probe for the `/api/hub/*` route family (added APCGHub P4 / CMS-1, kept in `scripts/` for reuse by future CMS-N hub routes) | requires the Docker Postgres local stack running (see §Debugging Quick Reference); `--setup` seeds two `ContentEngines` fixture rows + articles and prints a fresh test token (never hardcode a token in code/plan/report); `--check` runs the read/leak/filter assertions; `--paging` runs mutation-based red/green checks on `scopedFindMultiTenant`'s pagination invariants. Not a general test runner — scoped to this one route family. |
| `npx tsx scripts/hub-probe.ts --setup2 / --nullorder / --check2` | CMS-2 (24-09-26) extensions to the same probe, for `/api/hub/tenants`+`/api/hub/taxonomy`+the extended `/api/hub/articles` (`q`/`pillar`/`sort=views`) | **run order matters and is NOT interchangeable with the CMS-1 trio**: `--setup`/`--check`/`--paging` must run BEFORE `--setup2` (which adds 201 pillars to `wad`, 12+ authors to `dtw`, and writes values into `dtw`'s previously-empty withheld fields — `contact`/`themeTokens`/`dashboards`/`socials`/`additionalDomains` — specifically so the `/tenants` leak-check test has something to leak if the allowlist regresses); `--paging`'s "at most 10 articles" assumption goes red for the wrong reason if run AFTER `--setup2`. `--nullorder` isolates the D14 null-ordering fix (see `process/context/integrations/all-integrations.md` §Cross-tenant reads EXTENDED) — run it on the unfixed helper first to confirm a genuine red (wrong article ids, not a crash), then again after the fix for green. `--check2` is the umbrella: 125 assertions across search-escaping, pillar filtering, tenant/taxonomy allowlists (recursive key-set diff + raw-body string grep for `readTokens`/`tokenHash`/`contact`/etc.), and auth (401/403) on all three routes. |

There is no `npm test`. Do not add one to a plan's test-gate list without first adding an actual
test framework as its own, explicitly-scoped piece of work — that is a real, separate project, not
a one-line addition.

## Debugging Quick Reference

- **No CI**: `.github/` does not exist in this repo at all (not just an empty `workflows/` — the
  whole directory is absent, confirmed directly). Nothing runs typecheck/lint automatically on push
  or PR; a broken build is only caught at Vercel deploy time or by a human running the commands
  above locally.
- **Lint never gates a deploy**: see `next.config.ts`'s `eslint.ignoreDuringBuilds`. Do not report
  "lint failed, so I stopped" as equivalent to a blocking error.
- **Local dev DB vs. deployed DB use different schema-sync strategies**: local Docker Postgres uses
  `PAYLOAD_DB_PUSH=true` (schema synced live from collection config on boot, no migration file
  needed); deployed environments use committed migrations only, applied automatically as part of
  `vercel-build`. A local-only schema drift will not show up as a typecheck/lint failure — it shows
  up as a runtime DB error. See `process/context/database/all-database.md` §Migrations.
- **`src/payload-types.ts` can go stale**: if a collection's fields change, regenerate it
  (`npm run payload:generate-types`) before trusting `typecheck` — a stale generated-types file can
  make `typecheck` pass against types that no longer match the real schema.
- **`PAYLOAD_DB_PUSH=true` silently hides missing migrations.** `.env.docker.example:18` turns it on
  for local dev, which makes Payload sync the live collection config straight onto the schema on
  boot — including any brand-new field, with no migration file needed. This means a bootable,
  fully-working local dev server is **not evidence** that the corresponding migration exists or is
  correct: verified directly (APCGHub P4 / CMS-1) that a route/probe suite passing 19/19 and 17/17
  under `PUSH=true` completely failed to notice production would be missing the column entirely.
  **Any test of a schema change must additionally be run with `PAYLOAD_DB_PUSH=false` plus the real
  migration applied**, matching how `vercel-build`/`migrate-prod.mjs` actually runs in deployed
  environments — `PUSH=true` alone is not a valid verification of a schema change.
- **Docker daemon may need a manual start in this sandbox**: if `docker compose up -d` fails because
  the daemon isn't running, `sudo -n dockerd &` (non-interactive) was the working fix in this
  environment (24-09-26); daemon state may differ session to session.
- **Local dev server port is 3508, not 3000.** `docker-compose.yml`'s own comment and
  `.env.docker.example` both say `localhost:3000` — this is a pre-existing documentation error;
  the real port comes from `package.json`'s `next dev -p 3508`. Don't trust the compose-file comment
  for the URL; check `package.json` or pass the base URL explicitly to any script that calls the
  local server (e.g. `scripts/hub-probe.ts` reads `HUB_PROBE_BASE`).
- **`scripts/seed.ts` died partway through, at the Podcasts fixture, until CMS-2 patched it
  (24-09-26)** (`ValidationError: The following field is invalid: Youtube Url`, thrown from
  `scripts/seed.ts:348`) — a pre-existing bug, confirmed to still reproduce on unpatched `6adbb7a`.
  It seeds tenants first, so an unpatched `db:seed` run left you with a **partial** tenant set (the 4
  tenants the pre-CMS-2 fixture data declared: `brief-asia`, `dtw`, `world-travel-brief`, `gcv` — and
  NEVER `wad`, since the fixture didn't declare it at all) rather than failing cleanly with zero
  data. CMS-2's patch (`70232a5`) adds a valid `youtubeUrl` to the 3 podcast fixtures and a `wad`
  tenant fixture, so seed now completes and produces all 5 tenants. Any local test that assumes "N
  tenants seeded" should still verify the actual count after seeding rather than trusting the
  fixture file's declared count, in case the fixture changes again.
- **CORRECTED (24-09-26, was wrong in an earlier version of this note): local seed tenant slugs DO
  match production.** This file previously claimed local seed slugs (`brief-asia`,
  `world-travel-brief`) do NOT match what `content-engine`'s intake clients send in production
  (claiming production uses `briefasia`/`wtb`). That was backwards — the production
  `publicationId` values, confirmed directly from the sending code
  (`content-engine admin/src/lib/briefasia-intake-client.ts:184`, `wtb-intake-client.ts:177`), ARE
  `brief-asia` and `world-travel-brief`, matching the local seed exactly. See
  `process/context/all-context.md` §Open Questions, gap `cms-context-tenant-slugs-stale` (now
  resolved) for the full correction, and `process/context/database/all-database.md` §Tenants for the
  corrected slug list.
- **Disposable one-shot local Postgres 16, used for CMS-2's `/tenants`+`/taxonomy` data-shape
  checks instead of the Docker stack** (24-09-26). The Docker stack's data volume
  (`apcg-cms_central_cms_pgdata`) already held the CMS-1 session's data, and CMS-2 needed a
  guaranteed-clean DB without writing into it, so CMS-2 used a scratch instance:
  `P=$(mktemp -d /tmp/cms2-pg.XXXX); chown postgres:postgres $P`, then as the `postgres` user
  `initdb -D $P/data` and `pg_ctl -D $P/data -o '-p 54326 -k $P' -l $P/pg.log -w start` (exact
  command: the CMS-2 plan's checklist step 4 in content-engine). It is `/tmp`, not the session
  scratchpad, because `initdb`/`pg_ctl` refuse to run as root and the `postgres` user cannot enter
  the scratchpad (its parent `/tmp/claude-0` is `drwx------ root`). **TCP port 54326 is the port
  `.env.local`'s `DATABASE_URL`/`DATABASE_DIRECT_URL` already point at** (the Docker stack's host
  port), so `.env.local` is NOT edited — the Docker Postgres must simply be stopped so the port is
  free; `-k $P` only moves the Unix socket into the temp dir. Then
  `PAYLOAD_DB_PUSH=true npm run payload:migrate` (or just booting the dev server, which pushes
  schema on boot) to get a clean schema. **Cleanup is mandatory and must include**: stop the dev
  server (do NOT `pkill -f "next dev"` — it kills the invoking shell too, use the tracked PID or
  `next dev`'s own `Ctrl-C` semantics via a scoped process group instead), `pg_ctl -m fast stop`
  (as `postgres`), `rm -rf $P`, and compare `.env.local`'s sha256 before/after to prove it was never
  touched. This pattern
  is reusable for any future CMS-N work that needs a schema state the shared Docker volume doesn't
  have (e.g. testing a fresh migration against an empty DB, or testing `PAYLOAD_DB_PUSH=false` +
  real migrations rather than push-sync — see the `PAYLOAD_DB_PUSH=true` gap above).
- **Clean-clone build gate is now a standing pre-push check, not a one-off.** CMS-1 discovered the
  Vercel loose-Payload-types build gap (see §Default Verification Order #3); CMS-2 reused the exact
  same gate (`git clone` to a scratch dir with no `src/payload-types.ts`, `npm ci`,
  `VERCEL_ENV=preview npm run vercel-build`) as a standard pre-push step and it passed clean on the
  first try — treat this as evidence the gate is worth keeping in the default order for every future
  hub-route change, not just the one that originally surfaced the bug.
- **A `grep`/consumption-point check with a file-extension filter is a conditional result, not an
  absolute fact about the codebase.** A prior pass concluded `ENGINE_ACTIONS` had "exactly 2"
  consumption points using `grep --include=*.ts`, which silently excluded `.tsx` — the real count
  was 3, the third being a `.tsx` Console form (see
  `process/context/integrations/all-integrations.md` §Cross-tenant reads). When citing a grep result
  as evidence in a plan/report, **state the exact command run, including any filter flags** — a
  reader needs to know the scope of what was actually checked, not just the conclusion. Prefer
  running consumption-point checks with no extension filter (`grep -rn "SYMBOL" src/`) as the
  default, and only narrow afterward if the unfiltered result is too noisy to read.

## Known Gaps

- No automated test framework of any kind (unit / integration / e2e) — the single largest testing
  gap in this repo.
- No CI.
- No automated regression check for the public API's response *shape* (the cross-repo wire
  contracts in `process/context/integrations/all-integrations.md`) — a field accidentally dropped or
  renamed would currently only be caught by a consuming frontend breaking, not by anything in this
  repo itself.
- `scripts/hub-probe.ts` query-count is not measured (gap `cms2-query-count-not-measured`, CMS-2) —
  the probe asserts response *correctness*, not how many DB round trips each `/api/hub/*` call makes
  per tenant; no automated check would catch a future change that turns one query into N.
