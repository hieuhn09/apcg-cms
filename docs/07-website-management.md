# Website (Tenant) Management

For System Admins. A "website" is a row in the **Tenants** collection.

## Create a new website

1. Admin → **Tenants → Create**.
2. Set **name** and **slug** (the stable `publicationId`, e.g. `brief-asia`). The
   slug must match the content-engine registry id and never change after launch.
3. Set **domain**, **additionalDomains**, and **frontendUrl** (where the revalidate
   webhook is sent, e.g. `https://briefasia.com`).
4. Set **defaultLanguage** and **supportedLanguages** (the subset of platform
   locales this site uses).
5. Set **timezone**.
6. Toggle **features** (articles, newsletters, podcasts, marketData, sponsorSlots,
   wireDrops, corrections, translations). Disabled types are hidden in admin, 404
   in the public API, and rejected by engine intake.
7. (Optional) brand: logo, brandColor, favicon, default OG image, SEO defaults,
   contact emails, socials.
8. Save. Then mint a read token (below) and create header/footer **Menus** for the
   tenant.

### Example: GlobalTravelPost (`gtp`)

Owner-run, systemAdmin only (gtp-launch P1 plan section 7 is the full sheet):

- Name `GlobalTravelPost`, slug `gtp`, status `active`, default language `en`,
  supported languages `[en]`, timezone `Asia/Singapore`.
- **Domain / additional domains: EMPTY at creation** (the live domain still serves the old
  site until the DNS cutover).
- **Frontend URL: staged.** Leave EMPTY at creation (the revalidate webhook is then
  skipped and preview mint answers 400); set the gtp-web PREVIEW URL for the smoke, and
  `https://globaltravelpost.com` only at cutover. Never point it at a dead host (every
  editorial save then waits up to 5 s).
- Features: `articles`, `newsletters`, `corrections` on; everything else off (incl.
  `translations`).
- **Auto publish engine drafts: OFF.** `npm run audit:add-gtp-taxonomy` refuses `--apply`
  while it is on.
- Status 13-10-26: tenant, taxonomy, read token and `content-engine-gtp` exist; frontend URL
  is the gtp-web preview (`https://gtp-web-lac.vercel.app`). The Console engine form has
  no hub-flag checkboxes (hub flags are Payload /admin only); leave them off for intake.
- Then create the taxonomy with `npm run audit:add-gtp-taxonomy` (dry run first; see
  `docs/11-operations.md` "GTP rollout"), and mint tokens with environment-named labels:
  `frontend-preview` first, `frontend-prod` at cutover, so they can be revoked
  independently. The engine record for content-engine is a separate one
  (`content-engine-gtp`, allowed tenants `[gtp]`, actions `create_article` +
  `update_article`), created in Console `/console/engines/new`.
- **Seed is local-only.** Never run `npm run db:seed` against production: it re-upserts
  fixture rows. The gtp seed fixture is behind `SEED_INCLUDE_GTP=true` and refuses a
  non-local database.

## Configure domain & languages

- **Domain**: `domain` + `additionalDomains` are informational/CORS hints; the
  authoritative tenant identity is the slug + the read token. Add the frontend's
  origin to `PUBLIC_API_ALLOWED_ORIGINS` (env) for CORS.
- **Languages**: edit `supportedLanguages`. To add a brand-new platform language
  first add it to `src/lib/locales.ts` (a code change + migration), then add it to
  the tenant. Translation jobs + the public API clamp to `supportedLanguages`.

## Grant users access

User + membership management is a System Admin function (MVP).

1. Admin → **Users → Create** (or edit). Set name, email, password, and the
   top-level **role** (System Admin or Standard).
2. For a Standard user, add a row to **Tenants** (the per-user tenant array): pick
   the tenant, the **roles** (websiteAdmin / editor / contributor), and tick
   **canPublish** for a contributor who may publish.
3. A user can have different roles on different tenants.

## Enable / disable a feature

Edit the tenant's **features** group. Turning a feature off immediately (next
request) hides its collection(s) from the admin nav, dashboard, direct URLs, and
the authenticated REST API **whenever that tenant is selected in the admin
tenant selector** — including for System Admins. It also makes the feature's
public endpoint return 404 and engine intake for that type return 422. Turning
it on reveals everything again; existing data is preserved.

Visibility rules when **no tenant is selected** in the selector:

- A System Admin sees every collection (global view).
- A Standard user sees the union of enabled features across their member
  tenants; list views are constrained to rows of tenants that have the feature
  enabled.

The gate implementation is `src/access/features.ts` (applied per collection);
the feature → collection map is documented in `FEATURE_COLLECTIONS`
(`src/lib/constants.ts`).

**When adding a new feature key**, four places must all be updated together, or
`npm run typecheck` fails or the `console` app's per-tenant settings page silently
drops the flag: `FEATURE_KEYS` + `FEATURE_COLLECTIONS` (`src/lib/constants.ts`),
the `Tenants.features` checkbox (`src/collections/Tenants.ts` — needs a DB
migration, since each checkbox is a real column, not a JSON blob), and BOTH
`src/console/data/schema.ts` (Drizzle mirror) and `src/console/data/tenants.ts`
(`getSiteConfig()`'s `Record<FeatureKey, boolean>` literal) in the separate
`console` app. See `docs/06-architecture-and-decisions.md` §Payload gotchas
learned.

## Mint / rotate tokens

- **Read token** (frontend): `tsx scripts/mint-token.ts read --tenant <slug> --label frontend`.
  (`tsx` is not on PATH: use `npx tsx`. The script has no local-DB guard and writes to
  whichever `DATABASE_URL` is exported: print
  `node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)'` first.)
  Prints the raw token once; stores only its hash on the tenant. Revoke by setting
  the matching `readTokens` row status to `revoked` in admin.
- **Engine token**: `tsx scripts/mint-token.ts engine --engine "<name>"`. Rotates
  the engine's credential (hash stored, raw printed once).

## Suspend / archive a website

Set the tenant **status** to `suspended` (engine intake + public reads rejected) or
`archived`. Content is retained.
