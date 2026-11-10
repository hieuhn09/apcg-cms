# GTP legacy migration tools (operator guide)

Tooling to move GlobalTravelPost (tenant `gtp`) from the shared network Postgres
database into Central. Built and rehearsed on SYNTHETIC data only (gtp-launch
Phase 4). The real run is Phase 5 and happens only on explicit owner approval;
the Phase 5 runbook is authoritative for order and commands.

## Safety rules enforced by the code

- Legacy reads: only the 9 allow-listed tables (`articles, sites, site_authors,
  media_assets, scraping_sources, gtp_subscribers, visa_rules, events,
  press_submissions`), only through closed SQL builders, always filtered by the
  site id, in short `BEGIN READ ONLY` batches (`lib/legacy-sql.ts`). The site row
  must have slug `gtp`. `LEGACY_GTP_DB_URL` is read from the environment only.
- The real fence is the owner-created SELECT-only role (Phase 5 runbook); the
  session `default_transaction_read_only` is advisory.
- Central writes: dry run unless `--apply`; the local-DB guard runs in every
  mode, a non-local `DATABASE_URL` needs `--confirm-host=<exact host>` (plus a
  TTY for `--apply`); `--require-final` is implied for non-local runs and for the
  redirect builder, so provisional owner-decision values are fatal there.
- The importer never updates or deletes existing documents, never creates
  authors, adopts an existing article only when it carries the import marker
  (`origin=import`, `engineSourceName=legacy:globaltravelpost`, tenant `gtp`).
- Output directory: `scripts/migrate/out/` (git-ignored); an in-repo directory
  that git does not ignore is refused. Directories 700, files 600.

## Mapping

- `legacy-mapping.gtp-network.json`: committed STRUCTURAL mapping (columns,
  status/taxonomy/author rules, owner-decision markers in `_provisional`).
  It holds no site id and no image host. All owner decisions were resolved on
  14-10-26 (`_provisional` is empty, `--require-final` passes): old origin
  `https://globaltravelpost.com` (apex), articles at `/article/{slug}`, section
  pages at `/<section>` (news, destinations, business-of-travel,
  experiences-luxury, press-room, events-awards), static pages at their final
  paths (`/about`, `/contact`, `/privacy`, `/terms`, `/advertise`,
  `/editorial-standards`, `/licensing`, `/press-room-submit`, `/newsletters`,
  `/team`), taken from the live old site's public sitemap and URL probes;
  `archivedAs`, `formatTags`, `pin` and `countries.match` accepted at their
  defaults by the owner. Removed sections (Amendment 4, owner decision
  14/15-10-26): the new site drops `/studio` and `/visa-tracker`; they are
  listed in `urls.gonePaths` and the redirect builder emits a 410 Gone rule for
  each (`{ "status": 410 }` in the gtp-web `redirect-map.json`), never a
  redirect or a page. The 410 only takes effect at cutover if gtp-web ships
  the generated redirect map. The rehearsal and unit tests exercise the
  provisional paths with a cloned mapping that carries one marker.
- Bylines (Amendment 3, owner decision 14-10-26): legacy bylines are NOT kept
  (they were very skewed: Daniel Cheong 705, Priya Nair 569, Marcus Tan 143,
  Clara Widjaja 91, ..., 116 empty). `authors.distribute` gives EVERY imported
  article and every events-awards industry-calendar listing one of the 5 web
  authors (Daniel Cheong, Priya Nair, Marcus Tan, Natalie Ong, Yuki Hamada),
  split evenly (per-author counts differ by at most 1), never by pillar.
  Related items stay together: group = first country + calendar quarter of
  publishedAt; items without a country fill the rest round-robin by date
  (`lib/gtp-author-distribution.ts`). The map is computed once per run from
  the complete planned set and saved as `author-plan.json` in the run dir, so
  resume and rollback + re-import give the same bylines. The dry run prints
  the per-author totals, the spread and "pillars with fewer than 2 authors".
  No article is credited to "GTP Newsroom" (the mapping refuses that name and
  the retired `authors.fallbackName`); the Central author row "GTP Newsroom"
  stays unused and the owner may delete it later. The old Clara Widjaja ->
  Natalie Ong mapping is no longer needed (only read when `keepLegacy: true`).
- Overlay (`--mapping-overlay <path>`): exactly `source.siteFilter`,
  `media.hostAllowlist`, `media.hostRewrite`. The real overlay is held by the
  owner OUTSIDE the repository (OD-34). The committed
  `fixtures/gtp-legacy/overlay.fixture.json` is neutral (fake site uuid
  `...f001`, host `images.fixture.invalid`).
- Validate: `npm run migrate:gtp:validate-mapping -- --mapping <structural> --mapping-overlay <overlay> [--require-final]`.

## Commands (flags: `lib/cli-spec.ts`)

| Step | Command |
|---|---|
| Discovery (read-only) | `LEGACY_GTP_DB_URL=... npm run migrate:gtp:discover -- --site-id <site-uuid> --mapping-overlay <overlay> [--snapshot-dir <dir>]` |
| Exports (read-only) | `npm run migrate:gtp:export -- --mapping-overlay <overlay> --out <dir> [--include-contact]` |
| Import (dry run) | `npm run migrate:gtp:import -- --mapping-overlay <overlay> --run-id <id>` |
| Import (staged / full) | `... --apply --limit 50 --run-id <id>` then `... --apply --resume --run-id <id>` |
| Second pass | `npm run migrate:gtp:rewrite-links -- --run-id <id> [--apply]` |
| Redirects | `npm run migrate:gtp:redirects -- --run-id <id> --mapping-overlay <overlay> --known-routes <file> --emit-gtp-web <dir> --sitemap-urls <file> --min-coverage <pct>` |
| Parity | `GTP_READ_TOKEN=... npm run migrate:gtp:verify -- --run-id <id> --mapping-overlay <overlay> [--public-base <url>] [--batch 500]` |
| Rollback | `npm run migrate:gtp:rollback -- --run-id <id> [--list-orphans] [--apply] [--include-edited] [--include-orphans] [--only-status archived,draft]` |
| Import, old behaviour | add `--include-archived-drafts` to import / redirects / verify (fixture rehearsal only; see "Published-only") |

Non-local Central: add `--confirm-host=<host>`; the importer refuses
`IMPORT_TENANT_SLUG` other than `gtp`.

Load watchdog: the Payload-booting tools exit 75 when the module graph stalls
under the tsx loader (seen intermittently in the build environment; the older
`import-gcv-legacy.ts` shows the same). Nothing has been done at that point:
re-run the same command.

## Published-only (owner decision 10-11-26, supersedes OD-8)

Old-site ARCHIVED (~411) and DRAFT (~68) articles are DROPPED: not kept in
Central and no redirect for their URLs (no 301, no 410; they simply 404). Only
PUBLISHED legacy articles (~1,157) plus the active industry-calendar events are
migrated. OD-8 (301 vs 410 for archived) is moot; `archivedAs` is no longer used
for gtp.

- **Importer:** published-only is the default for gtp. Archived/draft rows (and
  inactive events) are skipped and counted in the report under
  `skip: status archived (published-only)` / `skip: status draft (published-only)`
  / `skip: event status archived (published-only)`, and listed in
  `rejects.ndjson`. They are also left out of the slug plan, the author plan and
  the source-url collision report. `--include-archived-drafts` restores the old
  behaviour (used by the fixture rehearsal only). Network tenants (aer, agr,
  amb, asn) are unaffected.
- **Redirects:** no rule for archived or draft slug-map entries (count
  `archivedNoRule`); published rules unchanged.
- **Parity:** expects 0 archived and 0 draft rows (and 0 inactive events) in
  tenant gtp; published expectations unchanged. Run it after the cleanup below.
- **Cleanup of rows already imported:** `migrate:gtp:rollback --only-status
  archived,draft` deletes, from ONE run id, only journaled rows whose status
  recorded in that run's `slug-map.json` (the mapped legacy status) AND whose
  current Central `workflowStatus` are both archived or draft. Everything else
  in the full rollback still applies: import marker + tenant gtp required,
  untouched since import (unless `--include-edited`), media only when
  `origin: created` and unreferenced, run-created tags only when unused, the
  run directory is kept. Published rows, rows an editor has since published,
  and non-import rows are never selected. `--only-status` cannot be combined
  with `--include-orphans`. The dry run prints counts per status and up to 20
  sample slugs; the full list is in `rollback-report-dry.json`.

Owner commands (run once per run id that imported archived/draft rows, e.g. the
first full run and any earlier delta run, all from the same `--out` directory):

```bash
# (a) dry run: counts per status + sample slugs, nothing written
npm run migrate:gtp:rollback -- --run-id <id> --only-status archived,draft
# (b) apply (Neon direct host, from a TTY)
npm run migrate:gtp:rollback -- --run-id <id> --only-status archived,draft --apply --confirm-host=<Neon direct host>
# (c) delta/final import before DNS cutover: NEW run id, same --out; archived/draft are skipped by default
npm run migrate:gtp:import -- --mapping-overlay <overlay> --run-id <new-id>            # dry run first
npm run migrate:gtp:import -- --mapping-overlay <overlay> --run-id <new-id> --apply --confirm-host=<Neon direct host>
# (d) redirects (per run id whose slug map holds the published rows you ship) + parity
npm run migrate:gtp:redirects -- --run-id <id> --mapping-overlay <overlay> --known-routes <file> --emit-gtp-web <dir>
GTP_READ_TOKEN=... npm run migrate:gtp:verify -- --run-id <new-id> --mapping-overlay <overlay>
```

Note: the redirect builder reads ONE run's `slug-map.json` (unchanged
behaviour). A delta run's map holds only the rows that run created or adopted,
not the first run's rows; the archived/draft entries still sitting in the first
run's map now produce no rule, so rebuilding that run's map after the cleanup is
safe. Combining maps across runs is not part of this change.

## Second run (delta migration, Amendment 5)

Use this when the old site got new articles after the first import.

- Use a NEW `--run-id` (never `--resume` the old run) and the SAME `--out`
  directory as the first run: the first run's directory (its `slug-map.json`)
  must be present. A fresh run refuses `--apply` when Central holds import rows
  that no run directory in `--out` has journaled (it would otherwise adopt them).
- Create-only: every item the earlier run created and that still exists in
  Central keeps its Central slug and is skipped (`skippedExisting`); nothing
  already in Central is updated. Edits and deletions made on the old site after
  the first run are NOT carried over.
- Authors: existing items keep their real Central author (fixed in
  `author-plan.json`); only the new items are balanced, so the per-author
  counts over (existing + new) differ by at most 1 when possible. The report
  shows the plan totals and the actual totals (existing Central rows + new)
  with their spread.
- A new item whose slug is already held by an earlier-run item gets `-2`, `-3`
  (listed under slugChanged, reason `taken-by-earlier-run`).
- Rollback of the second run id removes only that run's articles.
- Dry run first: `planned` must equal the number of new importable articles.

Pagination note (Amendment 5): legacy rows are read page by page in
(created_at, id) order. The cursor now carries the exact created_at (with
microseconds) as text; before, it lost the microseconds and re-read rows at
page edges (the first real run read 1,843 rows for about 1,770, and verify
reported false count FAILs). Reports now show the true row counts; the result
no longer depends on `--batch`.

## Run artifacts (`scripts/migrate/out/<run-id>/`)

`slug-plan.json` (deterministic slugs for the whole population), `slug-map.ndjson`
(fsynced per-article journal) and `slug-map.json` (compacted), `media-map.ndjson`
/ `media-map.json`, `state.json`, `import-report.{md,json}`, `rejects.ndjson`,
`provenance.ndjson`, `timestamps-fix.sql` (OWNER-RUN ONLY; header says how to run
it with `psql -v ON_ERROR_STOP=1` on the direct URL), `timestamps-baseline.json`,
`timestamps-fix.skipped.json`, `redirects.json`, `redirect-coverage.md`,
`parity-report.md`, rollback reports. Rollback keeps the run directory (audit
trail): to reuse a run id, delete its directory first or pick a new id.

## Rehearsal

`npm run rehearse:gtp` (docker or native PG16; local ports 54326-54328 and 3508)
seeds the synthetic two-site legacy fixture and the Phase 1 gtp fixture in a
throwaway local database, then `fixtures/gtp-legacy/rehearse-assert.ts` asserts
discovery, dry run, staged and resumed import, events, tenant scoping,
interrupt/orphan recovery, snapshot round trip, second pass, redirects, exports,
parity (including a mutation that must FAIL), the timestamps SQL on the LOCAL
Central (G54), rollback rules and re-import. Summary:
`scripts/migrate/out/rehearse/rehearse-summary.json` (the UNPROVEN list must be
empty for a sign-off run).

## Troubleshooting

- `mapping: --require-final is set and provisional ...`: resolve the listed owner
  decisions in the structural mapping (empty `_provisional`) before any non-local run.
- `legacy: the site filter does not point at the site with slug gtp`: wrong site id.
- `import: the run directory already exists`: add `--resume` or use a new `--run-id`.
- `slugConflictForeign`: a non-import article in tenant `gtp` already uses a legacy
  slug; it is never touched. Resolve it by hand, then resume.
