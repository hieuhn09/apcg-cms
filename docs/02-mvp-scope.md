# MVP Scope

MVP tenants: **DTW** and **Brief Asia** (both already have engine integration and
known taxonomy).

## In scope (MVP)

- One System Admin managing the whole system.
- Tenant-scoped users (Website Admin / Editor / Contributor).
- Articles, authors, taxonomy (pillars, sectors, tags, countries), media, and
  per-tenant site settings + menus.
- Multiple languages (8 platform locales; per-tenant subset).
- One or more content engines with per-engine hashed tokens.
- Automated draft intake (engine → `pending_review`, not auto-published).
- Duplicate prevention (idempotency per tenant).
- No-overwrite of locked / human-edited fields, with conflict logging (real
  enforcement, not just schema).
- Public content API for frontends (per-tenant read token, published-only).
- Preview (signed token, per tenant).
- Cache-revalidation webhook to frontends.
- Activity log of key events (designed for later reporting).
- Documentation for adding a new website and a new engine.
- **Live migration of both sites + frontend rewiring**, delivered as runnable
  scripts + a runbook (executed by the operator against their infra).

## Deferred (post-MVP)

- Monitoring **dashboards / UI** (the data is captured now; the views come later).
- Advanced rate-limit enforcement + activity-log retention/rollup jobs.
- Per-tenant **separate** R2 buckets (one bucket + isolation at the data layer
  ships now).
- Reader accounts (Better-Auth) — they stay in each frontend app.
- Full ad system / billing per tenant.
- Page builder.
- Multi-region database.
- Full AI translation of all content inside the CMS.

## What "done" means for MVP

The acceptance criteria in [13-acceptance-criteria.md](13-acceptance-criteria.md)
all pass: tenant isolation holds; two engines write only where allowed; intake is
idempotent and respects locks; a frontend gets only its tenant's published content
in a requested locale; translation marks targets stale and protects approved
translations; migration scripts import each site with matching counts and intact
relationships; rollback restores the old stack with a flag flip; and the
documentation is sufficient to onboard a new website and a new engine.
