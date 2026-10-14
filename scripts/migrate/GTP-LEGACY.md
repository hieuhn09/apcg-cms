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
  `/editorial-standards`, `/studio`, `/licensing`, `/press-room-submit`,
  `/newsletters`, `/team`, `/visa-tracker`), taken from the live old site's
  public sitemap and URL probes; `archivedAs`, `formatTags`, `pin` and
  `countries.match` accepted at their defaults by the owner. Open owner
  question: `/studio` and `/visa-tracker` have no gtp-web route yet (build,
  redirect elsewhere, or 410). The rehearsal and unit tests exercise the
  provisional paths with a cloned mapping that carries one marker.
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
| Parity | `GTP_READ_TOKEN=... npm run migrate:gtp:verify -- --run-id <id> --mapping-overlay <overlay> [--public-base <url>]` |
| Rollback | `npm run migrate:gtp:rollback -- --run-id <id> [--list-orphans] [--apply] [--include-edited] [--include-orphans]` |

Non-local Central: add `--confirm-host=<host>`; the importer refuses
`IMPORT_TENANT_SLUG` other than `gtp`.

Load watchdog: the Payload-booting tools exit 75 when the module graph stalls
under the tsx loader (seen intermittently in the build environment; the older
`import-gcv-legacy.ts` shows the same). Nothing has been done at that point:
re-run the same command.

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
