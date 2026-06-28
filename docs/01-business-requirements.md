# Business Requirements

## Problem

Each publication currently runs its own CMS and database. That means: hard to
manage centrally, multiple admin logins, duplicated configuration and schema,
hard to reuse the content engine, slow to launch new sites, and operating cost
that rises with every site. The goal is to grow to 10–20+ sites without that cost
curve.

## Goal

A **Central CMS** that:

- manages all websites from one admin;
- treats each website as a separate publication / tenant;
- lets a new website be added quickly;
- accepts content created manually OR sent by content engines;
- supports multiple content engines;
- supports multiple independent website frontends;
- supports multiple languages;
- guarantees each website's data is clearly separated;
- reduces operating effort as the number of sites grows.

## User groups

- **System Admin** — sees/manages all websites; creates websites; configures
  languages, domains, features; manages users and access; manages which content
  engines may connect; monitors integration errors and system activity.
- **Website Admin** — manages only their assigned website: articles, authors,
  categories/sections/tags, media, header/footer/menu/site config, translations,
  publish state.
- **Editor** — create/edit articles, submit for review, edit translations, view
  edit history; cannot change system config.
- **Contributor** — create drafts; edit only assigned content; cannot self-publish
  unless granted.
- **Content Engine** — automated systems that send/update content, send market /
  podcast / specialized data, receive jobs (e.g. translation); cannot access data
  outside their granted scope.
- **Website Frontend** — its own codebase + deployment; pulls only its own
  website's published content; never connects to the DB; can be notified to
  refresh cache.

## Multi-website management

Each website has: name, identifier (slug), domain, frontend URL, logo/brand,
default language, supported languages, timezone, default SEO, header menu, footer
menu, contact info, socials, per-feature on/off flags, allowed users, allowed
content engines. **Users of website A cannot view or edit website B** (except
System Admin).

## Content types

Articles, authors, sections/verticals, categories, tags, countries, sectors,
media, podcasts, newsletters, sponsored content, menus, header/footer, SEO config,
announcement banners, and site-specific content. **Not every website uses every
type** — features are toggled per website (e.g. site A has podcasts, site B does
not; site C has market data; site D only basic articles).

## Article workflow

States: **draft → pending review → approved → scheduled → published → hidden →
archived.** An article may be created by an admin, editor, contributor, content
engine, or import tool. The system records: creator, content source, created/edited
timestamps, last editor, version history, publish state, which parts were human-edited,
and which parts must never be auto-overwritten.

## Multiple content engines

Do not assume one engine. There may be a news crawler, an AI writer, a translation
engine, a finance-data engine, a podcast generator, an importer. Each engine has:
its own identity, its own permissions, a list of allowed websites, a list of allowed
actions, the ability to be suspended/revoked, an activity log, and an optional rate
limit. **Engines must not share one all-powerful admin account.**

## Automated-update rules

Content engines may update articles, but must: not create duplicates when the same
content is re-sent (idempotency); not overwrite fields an editor has locked; not
overwrite human-approved translations; clearly identify which engine the content came
from; store provenance + processing version; record conflicts and let humans decide;
never silently change important content; and be retryable on transient errors.

## Multi-language

One source + many translations. Per-language translation status:
none / pending / translating / machine-translated / needs-review / approved / locked /
outdated / failed. Translations marked stale when the source changes; locked
translations never auto-overwritten. Each website configures its own language subset.

## Translation flow (desired)

1. Source created/updated. 2. System determines target languages. 3. Creates jobs
for a translation engine. 4. Engine returns results to the CMS. 5. CMS stores per
language. 6. Editor can review/edit. 7. Website reads the stored translation. 8. No
re-translation when a reader opens the page.

## Frontend integration

Each frontend: connects with its own credentials; pulls only its own published
content; selects language; gets article by slug; lists articles; gets menu/footer/site
settings; shows preview when authorized; refreshes cache when the CMS changes.

## Media

Belongs to a specific website; isolated; alt/caption per language; uploadable from
admin or engine; stored in object storage (R2), not the server's temp disk; with
size/type limits.

## Monitoring (designed-for, not full dashboard in v1)

Article counts per website/status, human vs engine counts, pending/failed
translations, which engines are active/erroring, which sites have integration
errors, publish/unpublish history, blocked overwrite attempts. The data model must
support these reports later even if no dashboard ships in v1.

## Extensibility

Add a website without a new CMS; add an engine without rewriting the system; add a
language without a structural change; add a content type without disrupting live
sites; allow a website to be handed over or split out later; grow from 2 → 10–20
sites; change DB/hosting provider if needed.

## Data strategy

A centralized database that cleanly separates: data shared across all sites, data
belonging to one site, modules enabled only for some sites, and future bespoke
business logic. Some business systems may live **outside** the CMS but link to CMS
content. Avoid one giant unmaintainable schema. (See
[04-modules-and-data-model.md](04-modules-and-data-model.md) for the classification.)
