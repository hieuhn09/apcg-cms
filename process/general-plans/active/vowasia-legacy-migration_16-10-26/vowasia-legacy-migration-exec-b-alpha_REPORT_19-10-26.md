---
name: report:vowasia-legacy-migration-exec-b-alpha
description: "EXECUTE report, VowAsia legacy migration Phase B stage B-alpha (snapshot, measure, C8 mapping, guards, pins)"
date: 19-10-26
phase: phase-b-alpha-execute
status: COMPLETE_WITH_GAPS
feature: general-plans
plan: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
metadata:
  node_type: memory
  type: report
  phase: B-alpha
---

# EXECUTE report: Phase B stage B-α (19-10-26)

TL;DR: B-0 snapshot CLI, B-0b offline measure CLI, B-1 C8 mapping, the strict outside-repo guard, the vowasia stable filename and the GTP sha256 pins are built, red-first, and every B-α gate is green locally. Nothing touched a real database or network service. B-β (B-2..B-14) was not started. Still open: the owner's real snapshot (OB1-OB4 + OB3b) and the G22 review.

## What Was Done

- `BASE_BA` = `84928ca`. At start, `git diff --name-only 84928ca HEAD -- . ':(exclude)process'` was empty (HEAD `5034473` only changed `process/`).
- Commits on `claude/vowasia-launch`. None are pushed.
  - `4169555` feat: `lib/assert-outside-repo.ts`, `lib/vowasia-stable-filename.ts`, `lib/gtp-import-pins.ts`, each with its test.
  - `be4fb09` feat: `lib/vowasia-mapping.ts` + test (B-1).
  - `5589de1` feat: `snapshot-vowasia.ts`, `lib/snapshot-vowasia-main.ts`, `measure-vowasia.ts`, `lib/measure-vowasia-main.ts` (+ tests), `fixtures/vowasia-legacy/{fake-legacy.ts,image-server.ts}`, the 4 new roles in `lib/vowasia-config.ts` (+ test) and `legacy-source.vowasia.json`, and 2 lines in `package.json`.
- Snapshot (B-0) has two steps in one sitting:
  - Step 1, read. It checks every required column role against `reader.columns()` after `loadCatalog()` and refuses before reading any row (E-B2). It checks the site row. It reads the 15 columns of U1 through the closed builders. It writes `snapshot.ndjson`, `snapshot-meta.json` (with the sha256) and `query-log.json`, then prints the digest.
  - Step 2, `--download-images`. It needs no database. It re-checks the digest, collects allow-listed URLs from any string or JSON string (U2), and fetches them with the GTP hardened fetch. Images are stored as `images/<sha256>`. `manifest.json` records the `snapshotSha256` (U23). The step prints the manifest digest.
  - `media.hostRewrite` is accepted only with the explicit `--rehearsal` flag AND local targets (E-B4). The flag is never read from the environment.
  - Every directory goes through `assertOutsideRepo` (mode 700). Files are written mode 600.
- `verifySnapshotInput()` checks the snapshot digest against its meta, the manifest's `snapshotSha256`, `--expect-sha256` against the manifest digest, and optionally every store file (sha256, size cap, magic bytes). B-β will reuse it for import.
- Measure (B-0b) is offline. It reports title/excerpt shapes (Q2), URL positions in `body_sections` by normalised path, split allow-listed/other (Q3), the (section, subsection) table with the C8 verdict (KB-2), and the shape and values of the `tags` column. It never prints a host, URL, title, body or site id.
- Mapping (B-1): the C8 table is hard-coded. It has the 5 pillars and the 6 renames; an empty sub-section maps to the pillar only, and any other pair is rejected. Every target is checked against `vowasia-taxonomy.ts` under the right pillar. The C3 URL templates are fixed literals. `media.hostAllowlist` comes from the overlay. `_provisional` and `requireFinal` are supported.

## Red-first evidence (E-B1)

- After the tests were written and before any implementation, `npm run test:migrate-vowasia` gave 65 tests, 59 pass, 6 fail. The 6 failing files: `assert-outside-repo`, `gtp-import-pins`, `measure-vowasia-main`, `snapshot-vowasia-main`, `vowasia-mapping`, `vowasia-stable-filename` (module not found). These hold the contract stubs by name:
  - "should refuse a snapshot --out inside the repo even when git-ignored"
  - "should refuse to snapshot when a required column role is not in the view catalog"
  - "should refuse import input when snapshot.ndjson sha256 differs from the manifest"
  - "should never open a DB connection in measure"
  - "should collect an allow-listed image URL found under an unknown JSON key"
  - "should reject SVG, wrong magic bytes, over 20 MB, non-https and off-allowlist redirects"
  - "should refuse hostRewrite outside explicit rehearsal mode"
  - "should fail when any imported GTP file changes by one byte"
  - "should map the 6 renamed sub-sections and reject an unknown (section, subsection) pair"
- Mapping went red a second time on its own (2 failing tests: zod 4.6.6 `.default({})` skips inner defaults). Fixed with `.prefault({})`.
- The config test "B-α U1 ... 13 snapshot roles" failed (14 tests, 1 fail) before the enum and JSON edits, then passed.
- G7b counted 0 added lines before the `package.json` edit, then exactly 2.

## Test Gate Outcomes (all run locally by the executor; EVL must re-run independently)

| Gate | Command | Result |
|---|---|---|
| G1 (+G18 snapshot part, G21, pins, mapping) | `npm run test:migrate-vowasia` | 95/95 pass (59 old + 36 new) |
| G2 | `npm run lint:migrate` | 0 errors, 1 existing warning (`seed-gtp-legacy-fixture.ts:179 't50sec'`) |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | 69/69 |
| G5 | `npm run test:single-home` | 267/267 |
| G6 | `npm run probe:migrate-vowasia` (run ALONE, port 54336) | exit 0, `ALL PROBE CHECKS PASSED`, cleanup done |
| G7 | `git diff --name-only 84928ca -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | only `package.json` |
| G7b | `git diff -U0 84928ca -- package.json` | +2 lines (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`), both contain `vowasia`; 0 removed |
| G7c | `git ls-files --others --exclude-standard \| grep -vE "^(scripts/migrate/vowasia/\|process/general-plans/)"` | empty |
| G8/G20 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 (0 GTP bytes changed) |
| SQL unchanged | `git diff --quiet 84928ca -- scripts/migrate/vowasia/sql` | exit 0 |
| G10 / G10a / G10c / password allow-list | as in the phase-A table | all pass (no write keyword in 01/01e, no password line, no `postgres://` outside tests/probe) |
| G13 | `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | pass |
| G22 | `vc-code-reviewer` | NOT run by the executor (orchestrator spawns it) |
| CLI smoke (no DB) | measure without `--snapshot`; snapshot with an unreadable overlay; `--apply` | exit 2, fixed messages |

The G10 password-gate mutation set (6 mutants) was not re-run: the SQL is byte-identical to 84928ca.

## Plan Deviations

All deviations stay inside the B-α blast radius. No hard-stop class was touched.

1. The pin file also pins `scripts/migrate/lib/legacy-sql.ts`. `gtp-mapping.ts` imports it at runtime, so it loads transitively. This is in the spirit of E-B6, and B-β will not need to edit the pin file.
2. The image store is fixed at `<snapshot>/images`; there is no separate `--images` flag. It is still checked with `assertOutsideRepo`. One fewer flag means one fewer way to point the store into the repo.
3. `ROLE_NAMES` in `vowasia-config.ts` is now exported (it was module-private). This only adds an export.
4. `fixtures/overlay.fixture.json` was NOT edited. The 4 new roles are optional, and G6 passed unchanged: the probe reports them as "role skipped" and that does not block.
5. `measure` reaches database code only transitively, because it imports `vowasia-cli.ts` and `snapshot-vowasia-main.ts` for `resolvePath`, `DEFAULT_SOURCE` and `verifySnapshotInput`. It never connects: the test patches `pg.Client.prototype.connect` and sees 0 calls with no URL set. The source test checks only that the two measure files do not import `pg` or the reader directly.
6. A `MappingError` raised inside measure (a malformed overlay host) exits 1 ("failed:") instead of 2, because `vowasia-cli.ts` (phase A, not editable in B-α) does not know the `mapping:` prefix. Snapshot wraps that case as a `SnapshotError` (exit 2).

## Test Infra Gaps Found

- The fake legacy client serves one keyset page only. The reader's multi-page keyset behaviour is already covered by `vowasia-reader.test.ts` and G6.
- The download tests run over plain-http localhost through `hostRewrite`. Real TLS, a real CDN and real redirects are not exercised (contract "What This Coverage Does NOT Prove").

## What Was Skipped or Deferred

- All of B-β (B-2..B-14), `VOWASIA-LEGACY.md` part B, the other 7 `package.json` lines, and rehearsal. These are not allowed in B-α.
- G22 review (orchestrator) and EVL (vc-tester).
- The owner steps:
  - OB1-OB4 + OB3b: the real snapshot, the digests, the image failure count, and the measure output (Q2/Q3/KB-2).
  - E-B9: before OB2, compare the 15 column names (`id`, `site_id`, `slug`, `status`, `section`, `subsection`, `title`, `excerpt`, `body_sections`, `featured_image`, `featured_image_credit`, `tags`, `created_at`, `published_at`, `updated_at`) with section 6b of the discover report on the owner's Mac, so `02` is filled correctly the first time.
- No follow-up plan stubs created (none needed). CONTEXT_PARTIAL: none.

## Known gaps (named)

- KB-1 (pooler TLS not verified) and KB-5 still apply to the next role creation.
- The real snapshot (gap-resolution C) is not proven by any B-α gate.
- High-risk evidence pack (trust boundary/secret): not produced by the executor. The orchestrator/G22 must decide whether to produce it before finalising.

## Closeout Packet

- Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (`### Validate Contract (Chặng B-α)`).
- Classification: Keep in active/testing. B-α is code-complete. EVL and G22 are pending, then the owner's snapshot, then the plan supplement and the B-β PVL.
- Next valid state: EVL (vc-tester, sonnet) re-runs G1-G8, SQL-unchanged, G10/G13 and G6 alone; then G22; then the owner runs OB1-OB4 + OB3b.

## Forward Preview

- Test Infra Found: `test:migrate-vowasia` picks up `lib/*.test.ts` automatically (95 tests now). The fixtures for B-β live in `fixtures/vowasia-legacy/` (fake legacy client, fake image server).
- Blast Radius Changes: none outside `scripts/migrate/vowasia/` + 2 `package.json` lines.
- Commands to Stay Green: G1-G5, G6 alone, G7/G7b against `84928ca` (B-β: base = `5589de1` or the last B-α commit, +7 lines), G8 against `fe88bc4`.
- Dependency Changes: none (zod 4 `.prefault` used; no new package).
