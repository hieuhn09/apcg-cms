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

Edit the tenant's **features** group. Turning a feature off immediately hides its
collection from admin nav (for users of that tenant), makes its public endpoint
return 404, and makes engine intake for that type return 422. Turning it on
reveals it again; existing data is preserved.

## Mint / rotate tokens

- **Read token** (frontend): `tsx scripts/mint-token.ts read --tenant <slug> --label frontend`.
  Prints the raw token once; stores only its hash on the tenant. Revoke by setting
  the matching `readTokens` row status to `revoked` in admin.
- **Engine token**: `tsx scripts/mint-token.ts engine --engine "<name>"`. Rotates
  the engine's credential (hash stored, raw printed once).

## Suspend / archive a website

Set the tenant **status** to `suspended` (engine intake + public reads rejected) or
`archived`. Content is retained.
