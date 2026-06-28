# Migration & Cutover Runbook (DTW + Brief Asia)

Moves each site's editorial data into the Central CMS as a tenant and repoints its
frontend at the public API. **Sequence: Brief Asia first** (canonical superset:
localization + all relationship types + full provenance + reader stack; not yet
engine-wired = lower-risk engine step), **then DTW** (subset + the live engine
token repoint).

All live steps run against **your** Postgres + R2 + source sites — the scripts are
provided; you execute them. Nothing here needs the CMS to be guessed at: every
command is real.

## Method

Payload **Local-API export → transform → import** (not raw SQL, not re-seed).
Round-trips localized fields, Lexical body, relationships, arrays, drafts, and
provenance as documents; preserves slugs; fires hooks; idempotent + re-runnable.

| Script | What it does |
|---|---|
| `scripts/migrate/export-source.ts` | Logs into the LIVE source site's REST API, exports every collection (all locales, published + drafts) to NDJSON. Run with `SOURCE_URL`, `SOURCE_ADMIN_EMAIL/PASSWORD`, `EXPORT_TENANT`. |
| `scripts/migrate/import-central.ts` | Imports NDJSON into Central as one tenant; remaps relationships by natural key; writes each locale; re-uploads hero media; writes `article-id-map.json`. Run with `IMPORT_TENANT_SLUG`, `IMPORT_DIR`, `SOURCE_MEDIA_BASE`. |
| `scripts/migrate/copy-media.ts` | (Alternative to re-upload) bulk-copies R2 objects into the central bucket under a per-tenant prefix, incl. derivatives. |
| `scripts/migrate/reader-id-backfill.ts` | Updates the frontend's reader tables that reference articles by numeric id → new central id (slug-keyed refs need no change). |

Every script supports `--dry-run`.

## What moves vs stays

- **Moves to Central:** articles + all taxonomy + authors + media + newsletters +
  podcasts + corrections + sponsorSlots + market/fx/trending + wireDrops +
  engineConflictLog.
- **Stays in each frontend (not migrated):** reader-side Better-Auth/Drizzle data
  (accounts, bookmarks, reading queue, history, follows, newsletter subs,
  translation cache, analytics). It already references CMS content by plain text
  id/slug — backfill those refs after import.

## Ordered runbook (per tenant — Brief Asia first)

1. **Pre-flight (no Central dependency):**
   - Build + dry-run the export against the source: `SOURCE_URL=… SOURCE_ADMIN_EMAIL=… SOURCE_ADMIN_PASSWORD=… EXPORT_TENANT=brief-asia npm run migrate:export -- --dry-run`.
   - Audit reader tables: which columns store a numeric `article_id` vs a slug
     (sizes the backfill).
   - Confirm Central has the per-tenant composite unique indexes (see Operations) —
     **a global slug unique constraint is a blocker; fix before importing the 2nd tenant.**
2. **Stand up Central:** migrations applied; `npm run db:seed` created the
   `brief-asia` tenant (taxonomy shells) + tokens; R2 configured.
3. **Editorial freeze (this tenant only):** pause publishing + pause engine intake
   to this tenant (short window — hours).
4. **Export:** `… EXPORT_TENANT=brief-asia npm run migrate:export` → `migration-data/brief-asia/*.ndjson`.
5. **Media:** either let import re-upload from source URLs (`SOURCE_MEDIA_BASE`), or
   bulk-copy: `SRC_R2_* R2_* COPY_TENANT=brief-asia npm run migrate:media`.
6. **Import:** `IMPORT_TENANT_SLUG=brief-asia IMPORT_DIR=migration-data/brief-asia SOURCE_MEDIA_BASE=https://briefasia.com npm run migrate:import` (dry-run first).
7. **Reader backfill:** `READER_DATABASE_URL=… READER_ID_MAP=migration-data/brief-asia/article-id-map.json READER_TABLES=bookmarks:article_id,reading_queue:article_id,reading_history:article_id,follows:article_id npm run migrate:reader-backfill -- --dry-run` then for real.
8. **Parity verification** (next section) on a staging frontend pointed at Central.
9. **Engine cutover:** Brief Asia = NEW wiring (register an engine in Central with
   `allowedTenants=[brief-asia]`, mint a token, point the engine at
   `{CMS_URL}/api/engine/intake`). DTW = repoint the existing engine URL + rotate
   its token to the Central per-tenant intake; keep the old endpoint returning 410
   for one release. Run the `engine-intake-tester` against Central.
10. **Flip the frontend:** set `CMS_URL` + `CMS_READ_TOKEN` + `REVALIDATE_SECRET`,
    repoint reader imports (`@/lib/payload-server` → `@/lib/cms-client`), redeploy.
    (Track with a `CMS_SOURCE` env if you prefer a barrel.)
11. **Lift the freeze;** monitor Activity Log + frontend.
12. **Repeat for DTW.**
13. **Decommission** old per-site Payload + DB + bucket after both tenants are
    stable for one release.

## Parity checklist (must pass before each flip)

- [ ] **Counts per collection** match source vs Central, per tenant (articles
      published+draft, pillars, authors, tags, sectors, countries, media,
      newsletters, podcasts, corrections, sponsorSlots, wireDrops, market/fx/trending,
      engineConflictLog).
- [ ] **Localized coverage:** sampled articles have every source locale in Central
      (none fabricated); a non-en page renders translated title/dek + English-fallback
      body where untranslated.
- [ ] **Slugs render identically:** N high-traffic slugs + every pillar hub + a
      country page + markets + corrections, compared local vs Central.
- [ ] **Images load:** hero + in-body + responsive derivatives 200 from the central
      bucket; no wrong-bucket/mixed-content URLs.
- [ ] **Relationships intact:** sampled articles show correct pillar color/label,
      author, tags, country (no nulls where source had values).
- [ ] **Provenance intact:** engine-origin articles keep
      `origin/engineSourceUrl/version/lockedFields/editedByHuman`.
- [ ] **Engine intake E2E** via `engine-intake-tester` against Central's tenant:
      creates a `pending_review` draft on the right tenant; idempotent on
      `engineDraftId`/`engineSourceUrl`; respects `lockedFields`/version on a 2nd
      write; publish → revalidate webhook → article appears on the reader site.
- [ ] **Reader-data linkage:** a test account's bookmarks/queue/history/follows
      resolve to the right articles (validates the backfill).
- [ ] **SEO:** sitemap, RSS/feed, JSON-LD, hreflang regenerate with preserved URLs.

## Cutover & rollback

- **Parallel run:** keep the old stack live and untouched during import; verify a
  staging frontend on Central before flipping production. Flip **one tenant at a
  time** (env change + redeploy).
- **Rollback (within the release window):** repoint the frontend back to the local
  data layer (`CMS_SOURCE=local` / revert the import swap) + redeploy → the reader
  site is instantly back on the untouched old Payload/DB/R2. Repoint the engine
  intake URL/token back. Re-apply any Central-window edits (bounded — the window was
  frozen). Imports are idempotent, so a fixed re-run is safe.

## Known one-off frontend change

`ensureArticleTranslation` (on-demand translation write) becomes a **no-op** in
Central mode — translations are pre-stored in Central and the public API serves the
requested locale. The reference `cms-client.ts` already implements this. (If the
frontend wants its own translation cache, keep it in the frontend's own DB.)
