# Central CMS

A single **multi-tenant Payload CMS** that centrally manages many content/news
websites (publications). One admin, one database, one media store. Content
engines push drafts in; thin website frontends pull **published** content out via
a per-tenant API.

This replaces the previous model where every website embedded its own Payload CMS
and database. See [docs/](docs/) for the full business + architecture + operations
documentation.

## What it does

- **One admin for all websites.** Each website is a *tenant* (publication) with
  its own brand, domains, languages, menus, SEO, feature flags, users, and engines.
- **Strict tenant isolation.** A website-scoped user/engine/frontend only ever
  sees its own tenant. Only a System Admin crosses tenants.
- **Multiple content engines.** Each engine has its own hashed token, allowed
  tenants, and allowed actions — no shared all-powerful credential.
- **Safe automation.** Idempotent intake; never overwrites human-edited or locked
  fields; never overwrites human-approved translations; full provenance + conflict
  logging; retry-safe.
- **Multi-language.** One source + many translations with per-language status,
  stale-on-source-change, and a per-tenant language subset.
- **Decoupled frontends.** Each site fetches only its tenant's published content
  via a read token; gets menus/settings; supports preview + cache revalidation;
  never touches the DB.

## Stack

Next.js 15 (App Router) · Payload 3.85 · Postgres (Supabase) ·
`@payloadcms/plugin-multi-tenant` · Cloudflare R2 (S3) · Lexical.

## Quickstart (local, Supabase)

```bash
cp .env.example .env.local        # fill DATABASE_URL, PAYLOAD_SECRET, CENTRAL_SIGNING_SECRET
npm install
npm run payload:migrate           # create schema (needs DATABASE_DIRECT_URL for DDL)
npm run db:seed                   # system admin + brief-asia & dtw tenants + taxonomy + sample engine
npm run dev                       # admin at http://localhost:3000/admin
```

## Quickstart (local, Docker Postgres — no Supabase)

A `docker-compose.yml` provides a local Postgres so you can run the whole stack
(admin + engine intake + `../engine-intake-tester`) offline. The app runs on the
host; only the database is containerized.

```bash
docker compose up -d              # local Postgres on localhost:54326
cp .env.docker.example .env.local # local DB URL + dev secrets + PAYLOAD_DB_PUSH + SEED_ENGINE_TOKEN
npm install
npm run db:seed                   # PAYLOAD_DB_PUSH=true syncs the schema, then seeds
npm run dev                       # admin at http://localhost:3000/admin
# docker compose down -v          # wipe the DB volume for a fresh seed/schema
```

The seed prints the **read tokens** (per tenant) and the **engine token** once —
copy them. Re-mint anytime with `tsx scripts/mint-token.ts`. For the docker flow,
`SEED_ENGINE_TOKEN` pins a known engine token so the intake tester works without
copy-paste.

## Project layout

```
payload.config.ts            Payload config: collections + multi-tenant plugin + R2 + locales
src/
  collections/               All collections (Tenants, Users, Articles, …)
  access/                     Tenant-aware access helpers + presets
  hooks/                     revalidate, article-workflow, translation, unique-within-tenant
  lib/                       crypto, engine-auth, public, scoped, tenant, activity, constants, locales
  app/(payload)/             Payload admin (/admin) + REST/GraphQL (/api)
  app/api/engine/intake/     Multi-engine draft intake
  app/api/engine/translation/  Translation queue + result submission
  app/api/public/*           Public read API (per-tenant read token)
  app/api/preview/*          Preview-token minting
scripts/                     seed, mint-token, migrate-prod, migrate/* (export/import/media/backfill)
docs/                        Business + architecture + ops + integration + migration docs
```

## Key documents

| Doc | For |
|---|---|
| [docs/01-business-requirements.md](docs/01-business-requirements.md) | Business analyst / product |
| [docs/02-mvp-scope.md](docs/02-mvp-scope.md) | Product / delivery |
| [docs/03-roles-and-permissions.md](docs/03-roles-and-permissions.md) | Admins |
| [docs/04-modules-and-data-model.md](docs/04-modules-and-data-model.md) | Architects / devs |
| [docs/05-flows.md](docs/05-flows.md) | Everyone |
| [docs/06-architecture-and-decisions.md](docs/06-architecture-and-decisions.md) | Architects / devs |
| [docs/07-website-management.md](docs/07-website-management.md) | System / website admins |
| [docs/08-content-engine-integration.md](docs/08-content-engine-integration.md) | Engine developers |
| [docs/09-website-integration.md](docs/09-website-integration.md) | Frontend developers |
| [docs/10-translation.md](docs/10-translation.md) | Editors / translation engine devs |
| [docs/11-operations.md](docs/11-operations.md) | Operations |
| [docs/12-migration.md](docs/12-migration.md) | Migration runbook (DTW + Brief Asia) |
| [docs/13-acceptance-criteria.md](docs/13-acceptance-criteria.md) | QA / sign-off |
| [docs/14-rollout-and-risks.md](docs/14-rollout-and-risks.md) | Delivery / risk |
```
