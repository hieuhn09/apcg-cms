# Rollout Plan & Risks

## Phased rollout

| Phase | Outcome | Live infra needed |
|---|---|---|
| 0 — Docs | Business + architecture deliverable set (this `docs/`) | none |
| 1 — Stand up Central | Deploy central-cms; Postgres + R2; run migrations; seed admin + 2 tenants + taxonomy + sample engine; mint tokens | Postgres + R2 |
| 2 — Engine intake live | Register engines; test intake via `engine-intake-tester` | Postgres |
| 3 — Public API + revalidation | Frontends fetch published content; webhook busts cache | Postgres + frontends |
| 4 — Translation | Translation engine claims jobs + returns results; editors review | Postgres + translation engine |
| 5 — Migrate Brief Asia | Export → import → backfill → parity → engine wiring → flip frontend | source + Central + R2 |
| 6 — Migrate DTW | Same machinery + live engine token repoint | source + Central + R2 |
| 7 — Decommission | Retire old per-site Payload/DB/buckets after a stable release | — |
| Later | Monitoring dashboards, rate-limit enforcement, log retention, per-tenant buckets | — |

This build delivers all the code + scripts for phases 1–6; the operator runs the
live steps (migrations, seed, R2 copy, prod flip) per [12-migration.md](12-migration.md).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Global slug uniqueness collides across tenants | `uniqueWithinTenant` hook (shipped) + composite `UNIQUE (tenant_id, slug)` index (add by migration before importing the 2nd tenant) |
| Cross-tenant leak on machine/public calls | Mandatory `scopedFind/scopedCreate/scopedUpdate`; explicit `tenant` + published filter in every handler; no raw `payload.find` in routes (code-review gate) |
| Idempotency global instead of per-tenant | Dedup keyed by `(tenant, engineDraftId|engineSourceUrl)`; add composite index in migration |
| No-overwrite only "aspirational" (as in brief-asia) | Implemented for real: `articleBookkeeping` (version/editedByHuman) + intake per-field lock/version enforcement + Engine Conflict Log |
| Broken relationships on import | Natural-key remap, dependency-ordered import, fail-loud on unresolved rel, parity asserts no new nulls |
| Locale gaps / fabricated translations | Export `locale=all`; import only stored locales; never synthesize; `fallback:true` |
| Media 404s | Re-upload from source URL (default) or copy originals + derivatives; keep old bucket read-only one release |
| SEO / URL change | Slugs + locale paths preserved exactly; diff sitemap/RSS/feed/hreflang; explicit 301 only if a slug must change |
| Engine token cutover (DTW live) | Central intake mirrors the existing body contract; repoint URL + rotate token during the freeze; old endpoint 410 one release |
| Membership query cost | Memberships read from the plugin-native `Users.tenants` array on the session user (no extra collection/N+1) |
| Per-tenant language subset app-enforced (not Payload-enforced) | Locale switcher + job creation + public API all clamp to `supportedLanguages` |
| DTW behavior change (engine auto-publish → review) | Intentional per the brief (human owns publish). If DTW must keep auto-publish, add a per-engine/per-tenant auto-publish flag (small, deferred). |
| Shared revalidate signing secret (vs per-tenant) | Acceptable for MVP (signed + expiring token). Per-tenant revalidate secrets are a documented enhancement. |
| Activity log growth | Index `(tenant, eventType, createdAt)`; add retention/rollup (deferred) |

## Decisions made (with rationale)

- **Shared data:** countries (reference), users + engines (identities), activity
  stream. **Per-tenant:** all content, taxonomy, media. **Per-tenant config:**
  tenant record + menus. Rationale: avoid N duplicate reference tables while keeping
  the shared schema small and content strictly isolated.
- **MVP now / later:** isolation, roles, multi-engine intake, public API, preview,
  revalidation, translation, migration tooling ship now; dashboards, advanced rate
  limiting, per-tenant buckets, reader accounts ship later (data already captured).
- **Approval workflow:** engine → `pending_review`; humans publish. Keeps editorial
  accountability (the brief's hard rule).
- **Translation strategy:** machine-translate supported targets on publish; human
  review for important languages; protect approved/locked; key jobs by source
  version to avoid re-translation.
- **Multi-engine management:** one identity + hashed token + allowedTenants +
  allowedActions per engine; suspend/revoke individually.
- **Preventing engine overwrite of human content:** `editedByHuman` + `lockedFields`
  + version, enforced in the intake handler with conflict logging.
- **Fastest way to add a website:** create a tenant + grant users/engines + mint
  tokens; the frontend reads the public API. No new CMS/repo/schema.
- **Keeping it handoverable:** strict tenant isolation + stable public contract +
  per-tenant tokens mean a tenant can be split out later by pointing its frontend
  elsewhere and exporting its rows.
