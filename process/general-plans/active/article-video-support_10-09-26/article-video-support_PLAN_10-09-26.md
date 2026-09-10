---
name: plan:article-video-support
description: "Video support for BriefAsia articles (reusable template for 8+ tenants): new videoMedia collection, tenant-gated Articles fields, conditional hero requirement, shared upload-integrity, resolved video object on the reader API, and brief-asia-web player wiring"
date: 10-09-26
feature: article-video-support
---

# PLAN — Video Support for Articles (BriefAsia-First, Reusable Template)

**Locked SPEC (4th revision):** `process/general-plans/active/article-video-support_10-09-26/article-video-support_SPEC_10-09-26.md` — implemented as written. This plan does not renegotiate scope.

**Date**: 10-09-26
**Status**: DRAFT — awaiting VALIDATE
**Complexity**: COMPLEX (see classification below)
**Context loaded:** `process/development-protocols/implementation-standards.md` and `apcg-cms/docs/` (this repo has no `process/context/all-context.md`); `brief-asia-web/process/context/all-context.md` + its `i18n`/`cms`/`tests` groups were consulted during RESEARCH for the reader-side chain.

## Complexity Classification: COMPLEX (single plan, not a phase program)

**Why COMPLEX:** touches a new Payload collection, a DB migration on two tables, a new tenant-gating primitive, a shared-code refactor of production-incident-hardened logic (`Media.ts`), two repos, and 18 acceptance criteria — well past SIMPLE's 8–15 atomic-step ceiling.

**Why NOT a phase program:** there are not 3+ independently-validatable phases with separate gates — this is one cohesive delivery (CMS collection + gating + migration, then reader rendering) with a hard sequencing dependency (CMS must ship and regenerate types before the reader can even typecheck). A single VALIDATE pass covering both repos, run once after the full checklist, is the right gate shape. Splitting it into an umbrella + phase-plan set would add coordination overhead (registries, per-phase PVL) without a matching increase in independent-progress value.

## Overview

Add optional short-video support to BriefAsia articles: a new `videoMedia` upload
collection (video/* only, no image derivatives), four new plain (non-localized)
fields on `Articles` (`video` relationship + `videoCaption` + `videoCredit` +
`videoDescription`), a conditional hero-image requirement that fires only when a
video is attached, tenant gating via a new `video` feature flag (collection-level
for `videoMedia`, field-level for the four `Articles` fields — both UI-hidden and
API-rejected), a shared upload-integrity implementation reused by `Media` and
`videoMedia`, and a fully server-resolved video object on the public article API
that `brief-asia-web` renders in the article hero slot only (never on listings).
Everything is named by function, not by publication, so a second tenant can adopt
it later via one `Tenants.features` checkbox flip plus a documented file copy.

## Goals

1. BriefAsia editors can attach a video to an article, gated on a hero image being present.
2. No other tenant can see or set video, in the admin UI or via direct API writes.
3. The article page shows the video player (poster = hero image) only when a video exists; every listing surface always shows the static hero image.
4. `Media.ts`'s upload-integrity protections are shared, not duplicated, with the new collection.
5. The feature is a reusable template: no tenant slug hardcoded anywhere, and a short adoption note exists for future adopters.

## Scope

In scope: `apcg-cms` (collection, fields, gating, migration, shared upload-integrity module, public API resolution) and `brief-asia-web` (regenerated types, hero-slot player, no listing-surface changes needed since `ArticleView` is deliberately not widened — see Design Decision D-3 below). Out of scope: everything listed in the SPEC's Out Of Scope section (Requirement B is fully removed from this work; no engine-intake changes; no transcoding/embeds/size-limit changes; no second-tenant enablement).

## Design Decisions Carried From INNOVATE (still valid — not re-litigated)

- **D1 — dedicated `videoMedia` collection**, `mimeTypes: ["video/*"]`, no `imageSizes`. Wired into `payload.config.ts`'s multi-tenant `collections` map and its `s3Storage({ collections: {...} })` map with its own `disablePayloadAccessControl: true` + `generateFileURL`.
- **D2 — tenant gating, two halves.** `videoMedia` (whole collection) uses the EXISTING `featureGatedAccess("video", tenantManagedAccess)` primitive (same pattern as `Podcasts.ts:10`) — no new primitive needed there. The four `Articles` fields need a NEW single-record primitive `tenantHasFeature(payload, tenantId, key)` because `featureGate()` (`src/access/features.ts`) is shaped for row-list filtering, not single-doc field access; it is built by composing the EXISTING `findTenantById()` (`src/lib/tenant.ts:34-46`) with the EXISTING `featureEnabled()` (`src/lib/tenant.ts:52-56`) — genuinely new glue, zero new lookup logic.
- **Not localized.** `video`, `videoCaption`, `videoCredit`, `videoDescription` are plain (non-localized) columns on `articles` + `_articles_v`, following the `exclusive` precedent (`src/migrations/20260824_000000_add_exclusive_flag.ts`), NOT the `Media.caption`/`Media.alt` localized precedent. This is the carried decision from the task brief and reflects the smaller migration footprint the SPEC's Constraints section flags.
- **Player placement.** A conditional branch in `brief-asia-web/src/components/article/article-content.tsx`'s existing hero `<figure>` (~lines 508-551). Listings never show video BY CONSTRUCTION — see Design Decision D-3 below, which is the concrete mechanism for the "structural, not per-card guard" requirement.
- **Type sync.** Explicit, ordered, hand-executed checklist step (Section "CMS-Before-Reader Ordering" below). No sync script is built.

## Design Decisions Superseding earlier INNOVATE output (re-decided per the 4th-revision SPEC)

- **D3 (reversed).** `heroImage` requirement is a **conditional `validate` function** on the `Articles.heroImage` field (fires only when `video` is present on the same document), NOT `required: true`. See Checklist Step 6.
- **Field-level admin-UI invisibility mechanism (new PLAN decision — SPEC left this open).** Payload's static `admin.condition(data, siblingData, { user, operation })` is synchronous and has no live access to the currently-selected tenant's `features.video` value (the admin's selected tenant is tracked client-side via a cookie/React context from `@payloadcms/plugin-multi-tenant`, not passed into `admin.condition`). A custom Field admin Component is required to make invisibility genuinely live (not a stale/cached boolean). See Checklist Step 9 for the exact design and its **documentation-verification gate** — the precise hook name/version compatibility must be confirmed via `vc-docs-seeker` against the installed `@payloadcms/plugin-multi-tenant@` version before the component is written; a documented fallback (cookie-parse + REST fetch) is specified in case the expected client hook does not exist at the installed version.
- **Where caption/credit/description live.** On `Articles` (mirroring `Media`'s caption/credit/alt fields conceptually, but as plain top-level fields on the article per the Not-Localized decision above), NOT on the `videoMedia` collection. `videoMedia` itself carries no bespoke fields beyond what `upload` requires — it is a pure file-storage collection, keeping the mimetype-contamination blast radius as small as possible.

## Touchpoints

### apcg-cms

| File | Change |
|---|---|
| `src/lib/upload-integrity.ts` (NEW) | Extract `tenantSlugById`, `tenantKeyPrefix`, `prefixFromSelectedTenant`, `rememberSignedFilename`, `verifyClientUpload` from `src/collections/Media.ts` verbatim (all five are already collection-agnostic — none reference `media` by name). Export all five. |
| `src/collections/Media.ts` | Remove the five extracted functions; import them from `@/lib/upload-integrity` instead. No behavior change — this is the shared-implementation refactor Criterion 15 requires. |
| `src/collections/VideoMedia.ts` (NEW) | New collection, slug `videoMedia`. `access: featureGatedAccess("video", tenantManagedAccess)`. `hooks: { beforeChange: [rememberSignedFilename], afterChange: [verifyClientUpload] }` (imported from `upload-integrity.ts`). `upload: { mimeTypes: ["video/*"] }` — no `imageSizes`. Fields: only the plugin-injected `tenant` + a `prefix` field identical in shape to `Media.ts`'s (reusing `tenantKeyPrefix`/`prefixFromSelectedTenant` hooks from the shared module). |
| `src/lib/tenant.ts` | Add `tenantHasFeature(payload, tenantId, key)` — thin wrapper: `featureEnabled(await findTenantById(payload, tenantId), key)`. Exported alongside the existing `findTenantById`/`featureEnabled`. |
| `src/access/collections-article-video.ts` (NEW, or inline in `Articles.ts` if under ~15 lines) | `canSetVideo` field-access function: `isSystemAdmin(req)` short-circuit, else resolve `tenantId = toId(doc?.tenant ?? data?.tenant)`, then `await tenantHasFeature(req.payload, tenantId, "video")`. Mirrors `canFlagExclusive` (`Articles.ts:35-49`) shape exactly, made async. |
| `src/collections/Articles.ts` | In the "Media" tab fields array (currently `heroImage`, `imageLabel`, `leadImageCaption`, `imageUrl`, lines ~427-433): add `video` (upload, `relationTo: "videoMedia"`, `access: { create: canSetVideo, update: canSetVideo }`, `admin.components.Field` = the gate component from Step 9), `videoCaption` (text, same access+admin gate), `videoCredit` (text, same), `videoDescription` (text, same access+admin gate, `validate`: required whenever `video` is present — see Step 6b). Also modify `heroImage` field: add the conditional `validate` function (Step 6a). |
| `payload.config.ts` | Import `VideoMedia`; add `videoMedia: {}` to the `multiTenantPlugin({ collections: {...} })` map (~line 178); add `videoMedia` to the `s3Storage({ collections: {...} })` map (~line 208) with its own `disablePayloadAccessControl: true` + `generateFileURL` block mirroring `media`'s (same `r2PublicBaseUrl` base, same `clientUploads: true` inheritance from the plugin-level config — no per-collection `clientUploads` override needed). |
| `src/migrations/{timestamp}_add_video_support.ts` (NEW) | `ALTER TABLE "articles"` add `video_id integer` (FK → `videoMedia.id`, `ON DELETE SET NULL`), `video_caption text`, `video_credit text`, `video_description text`; same four columns prefixed `version_` on `"_articles_v"`; index on `articles.video_id` and `_articles_v.version_video_id` (mirrors `20260824_000000_add_exclusive_flag.ts` + the `hero_image_id` FK/index shape at `20260702_231336_initial_schema.ts:409,872,1061`). Payload will also auto-generate the `videoMedia` table (upload collection) and its `tenant`/`prefix` columns the first time the app boots against a migrated-DB dev environment — this plan does NOT hand-write that table's DDL; it is produced by `payload generate:types`/first-boot schema push per this repo's existing collection-creation convention (confirm via `docs/` migration convention before writing — see Checklist Step 1). |
| `src/app/api/public/articles/route.ts` | `LIST_SELECT` (line ~39, currently `{ body: false }`): add `video: false` (and, if Payload requires explicit exclusion of each new field for select-exclusion semantics to apply per-field, also `videoCaption: false, videoCredit: false, videoDescription: false`). This is the structural "listings never carry video data" guarantee on the list endpoint. |
| `src/app/api/public/articles/[slug]/route.ts` | After `scopedFind` returns `doc` (which is fetched at `depth: 2`, so `doc.video` and `doc.heroImage` are already populated relation objects): if `doc.video` is a populated object, replace it with the resolved shape via a new helper `resolveArticleVideo(doc)` (see next row). If `doc.video` is null/absent, leave the field as-is (null). |
| `src/lib/article-video.ts` (NEW) | `resolveArticleVideo(doc: { video, videoCaption, videoCredit, videoDescription, heroImage })` → `{ url, mimeType, posterUrl, caption, credit, description } \| null`. `url`/`mimeType` come from the populated `video` (a `VideoMedia` doc — `url`/`mimeType` are Payload upload-field standard properties). `posterUrl` comes from the populated `heroImage`'s `sizes.hero.url ?? url` (mirrors the "hero" size precedent used elsewhere for the largest still). `caption`/`credit`/`description` map straight from the Articles fields. Returns `null` when `doc.video` is absent (non-video articles — the field is present-but-null per the accepted public-API-visibility Constraint). |

### brief-asia-web

| File | Change |
|---|---|
| `src/payload/payload-types.ts` | HAND-COPIED from apcg-cms's regenerated file (see CMS-Before-Reader Ordering below) — brings in `videoMedia`, `Article.video`/`videoCaption`/`videoCredit`/`videoDescription`, and `Tenant.features.video`. |
| `src/lib/article-video-view.ts` (NEW) | New, SEPARATE type + function — deliberately NOT part of `article-view.ts`'s `ArticleView`/`toArticleView()`. Exports `interface ArticleVideoView { url: string; mimeType: string; posterUrl: string; caption: string \| null; credit: string \| null; description: string }` and `toArticleVideoView(article: Article): ArticleVideoView \| null`, reading the already-server-resolved `video` object the public API now returns (see apcg-cms row above) directly off the raw `Article` shape — no re-derivation, no lookups, matching Criterion 16 ("frontend does no lookups or branching"). |
| `src/app/(reader)/[locale]/article/[slug]/page.tsx` | Alongside the existing `toArticleView(article, locale)` call, add `const video = toArticleVideoView(article)`. Pass `video` as a NEW, separate prop to `<ArticleContent article={view} video={video} related={...} />` — NOT merged into `view`/`ArticleView`. This is the structural mechanism: `ArticleView` (the type every listing/card component imports) never gains a video field, so no card codepath can reach it even by accident. |
| `src/components/article/article-content.tsx` | Add `video: ArticleVideoView \| null` to `ArticleContentProps` (~line 19). In the hero `<figure>` block (~lines 508-551): if `video` is non-null, render a new `<VideoPlayer>` component (poster=`video.posterUrl`, `preload="none"`, standard `<video controls>` — no autoplay attribute, no `<source>` prefetch beyond what `preload="none"` already prevents) instead of the `<img>`; keep the existing `<img>`/`CoverArt` branch unchanged when `video` is null. |
| `src/components/article/video-player.tsx` (NEW) | The reusable, ~30-line, branchless player component named per Requirement C's naming constraint (`video-player`, not `briefasia-video-player`). Props: exactly the six `ArticleVideoView` fields it needs (`url`, `mimeType`, `posterUrl`, `caption`, `credit`, `description`) — no tenant/site logic inside it, so it is copy-paste-safe into a second tenant repo per Criterion 16/Requirement C. |

### Not touched (blast radius exclusions — explicit)

- `src/app/api/engine/intake/route.ts` — SPEC Constraints: "this work touches NO engine-facing code."
- Every card/listing component in `brief-asia-web` (`home-hero.tsx`, `deep-dive.tsx`, `exclusive-band.tsx`, `related-row.tsx`, `account-tabs.tsx`, `asia-spotlight.tsx`, any RSS/OG/sitemap code) — none of these read `ArticleVideoView`, none are modified; they continue to consume `ArticleView` exactly as today. This is proof of the structural guarantee, not an assertion — the plan does not touch these files at all.
- Any other tenant's `Tenants.features.video` value (defaults `false` for all 12 via `featureEnabled()`'s existing "unknown key → false" fallback (`src/lib/tenant.ts:54-56`) — no seed/migration needed to set it explicitly false).
- `content-engine` repo — read-only reference per task instructions; zero writes.
- `Media.ts`'s own fields, access, or upload config — only its five helper functions move to a shared module; `Media`'s collection definition (mimeTypes, imageSizes, fields) is byte-for-byte unchanged.
- Any existing article's data — no migration/backfill of content, only schema-additive columns (nullable, default null).

## Public Contracts (new/changed surfaces visible outside this feature's own files)

- **New Payload collection `videoMedia`** — a new admin-facing and REST/GraphQL-facing collection slug. Additive; no existing collection's contract changes.
- **`Articles` document shape** gains 4 new optional fields (`video`, `videoCaption`, `videoCredit`, `videoDescription`) — additive, backward compatible (existing consumers ignore unknown fields).
- **`Tenants.features` group** gains a `video: boolean` field — additive.
- **Public API response shape** (`/api/public/articles/[slug]`) — the `video` field on a returned `doc` changes shape from "raw Payload relation" (id or populated media-shaped doc) to the resolved `{ url, mimeType, posterUrl, caption, credit, description }` object (or `null`). This is a **new, additive contract**, not a breaking change to an existing field, since `video` did not exist on `Articles` before this work. The list endpoint's contract is unchanged except that `video`/`videoCaption`/`videoCredit`/`videoDescription` are now explicitly excluded (they would otherwise have appeared as raw/unresolved noise).
- **No change** to `/api/engine/intake` request or response contracts.

## Blast Radius

- **apcg-cms:** 1 new collection file, 1 new lib file (upload-integrity), 1 new lib file (article-video resolution), 1 refactored file (`Media.ts`, behavior-preserving), 1 new access helper (small, may be inlined), 2 edited existing files (`Articles.ts`, `payload.config.ts`, `src/lib/constants.ts`, `src/lib/tenant.ts`, `Tenants.ts` — 5 edits total), 2 edited public API route files, 1 new migration file, 1 new admin Field Component file (Step 9). **Total: ~13 files touched/created**, all within `src/` — no `docs/`, no `scripts/`, no `content-engine`.
- **brief-asia-web:** 1 hand-copied generated file, 1 new lib file, 1 new component file, 1 edited component file, 1 edited page file. **Total: 5 files.**
- **Risk class:** schema/migration (Postgres ALTER on `articles` + `_articles_v`, additive/nullable only, reversible via `down()`), NOT auth/billing/public-API-contract-in-the-high-risk sense (SPEC explicitly rules out the intake-contract trigger for `orchestration.md` §High-Risk Execution Handoff — this work touches no engine-facing code, so the 5-artifact evidence pack does NOT apply). No secrets, no destructive writes, no deploy/proxy changes.
- **Cross-repo dependency:** brief-asia-web CANNOT typecheck the new fields until apcg-cms's `payload-types.ts` is regenerated and hand-copied — this is a hard ordering constraint, not just a nice-to-have (see next section).

## CMS-Before-Reader Ordering (hard precondition)

1. Complete ALL apcg-cms Implementation Checklist steps (below) through the migration.
2. Run `npx payload generate:types` (or the repo's equivalent `package.json` script — confirm exact script name in `apcg-cms/package.json` before running; do not assume `generate:types` is the literal script name without checking) in `apcg-cms`.
3. Copy the regenerated `apcg-cms/src/payload-types.ts` (confirm exact generated-file path from `payload.config.ts`'s `typescript.outputFile`, if configured, before copying) content into `brief-asia-web/src/payload/payload-types.ts`, overwriting it wholesale (it is already a full-file mirror today, per the SPEC's Constraints).
4. Only THEN begin the brief-asia-web Implementation Checklist steps — `tsc --noEmit` in brief-asia-web will fail on `Article.video` / `ArticleVideoView` construction until this copy has happened.

## Phase Completion Rules

This plan has ONE phase (not a multi-phase program). It is considered CODE DONE when
Implementation Checklist steps 1–24 are complete and both repos' `typecheck`/`lint` gates
(Verification Evidence table) are green. It is considered VERIFIED only after the Agent-Probe
manual checks in Verification Evidence have been walked through and confirmed by the user —
code-complete and VERIFIED are not the same status; do not mark this ✅ VERIFIED without explicit
user confirmation of the manual checks.

## Acceptance Criteria

This plan implements all 18 acceptance criteria from the locked SPEC verbatim — see
`article-video-support_SPEC_10-09-26.md` §Acceptance Criteria for the full text, and the
Verification Evidence table below for how each is proven and which strategy applies. No
acceptance criterion is added, dropped, or reworded here.

## Implementation Checklist

### apcg-cms

1. Confirm the exact `payload generate:types` script name in `apcg-cms/package.json` and the collection-creation/migration convention in `docs/04-modules-and-data-model.md` (or nearest equivalent) before writing the migration file — this repo has no `all-context.md`; `docs/` is the source of truth per the task brief.
2. Create `src/lib/upload-integrity.ts`: move `tenantSlugById`, `tenantKeyPrefix`, `prefixFromSelectedTenant`, `rememberSignedFilename`, `verifyClientUpload` out of `src/collections/Media.ts` verbatim (no logic changes — this is a pure extraction). Export all five with their existing JSDoc comments intact (the comments document the 11-08-2026 incident; do not lose them).
3. Update `src/collections/Media.ts` to import the five functions from `@/lib/upload-integrity` instead of defining them locally. Confirm `Media.ts`'s remaining content (collection config, fields) is byte-identical apart from the import swap.
4. Add `"video"` to `FEATURE_KEYS` in `src/lib/constants.ts` (after `"citiesMap"`, alphabetical/logical placement is not enforced elsewhere in the array so append at the end).
5. Add `{ name: "video", type: "checkbox", defaultValue: false }` to the `features` group's `fields` array in `src/collections/Tenants.ts` (~line 180, after `citiesMap`).
6. Add `tenantHasFeature(payload: Payload, tenantId: number | string, key: FeatureKey): Promise<boolean>` to `src/lib/tenant.ts`, implemented as `featureEnabled(await findTenantById(payload, tenantId), key)`. Export it.
7. Create `src/collections/VideoMedia.ts`:
   - `slug: "videoMedia"`
   - `admin: { useAsTitle: "filename", group: "Editorial" }` (no `alt` field exists here, unlike Media, so use `filename` as the title — confirm Payload upload collections always expose `filename` as a usable `useAsTitle` target before finalizing; if not, omit `useAsTitle` and let Payload's default apply)
   - `access: featureGatedAccess("video", tenantManagedAccess)` (import both from their existing locations, same as `Podcasts.ts:2-3,10`)
   - `hooks: { beforeChange: [rememberSignedFilename], afterChange: [verifyClientUpload] }` imported from `@/lib/upload-integrity`
   - `upload: { mimeTypes: ["video/*"] }` — explicitly NO `imageSizes` key at all (not an empty array — omit the key)
   - `fields: [{ name: "prefix", type: "text", index: true, admin: { hidden: true, readOnly: true }, defaultValue: prefixFromSelectedTenant, hooks: { beforeValidate: [tenantKeyPrefix] } }]` — same shape as `Media.ts`'s `prefix` field, imported hooks from `upload-integrity.ts`.
8. Create `canSetVideo` (in `src/access/collections.ts` if that file already holds `canFlagExclusive`-style helpers, otherwise inline at the top of `Articles.ts` next to `canFlagExclusive`, whichever the existing `canFlagExclusive` placement convention dictates — confirm by re-reading `Articles.ts:1-49` structure): `async ({ req, doc, data }) => { if (isSystemAdmin(req)) return true; const tenantId = toId(doc?.tenant ?? data?.tenant); if (tenantId == null) return false; return tenantHasFeature(req.payload, tenantId, "video"); }`.
9. **Admin-UI-invisibility Field Component** (verify via `vc-docs-seeker` before writing): build a small client Field Component, e.g. `src/components/admin/VideoFieldGate.tsx` (exact directory: confirm this repo's convention for custom Payload admin components — check for an existing `admin.components` usage anywhere in `src/collections/*.ts` first; if none exists, this is the first one and should live under `src/admin/` or `src/components/admin/`, whichever matches the repo's existing non-Payload component layout). Required behavior: read the currently-selected admin tenant (via `@payloadcms/plugin-multi-tenant/client`'s selection hook — CONFIRM THE EXACT EXPORT NAME AND ITS AVAILABILITY AT THE INSTALLED PLUGIN VERSION via `vc-docs-seeker`/package `node_modules` inspection before use), fetch that tenant's `features.video` (via the existing authenticated `/api/tenants/:id?depth=0` REST endpoint, cached per-mount), and render `null` when false, or Payload's default field renderer for the given field type when true. **Fallback if the expected client hook does not exist at the installed version:** parse the `payload-tenant` cookie directly (same cookie name `getTenantFromCookie` reads server-side, confirm the cookie's literal name via `@payloadcms/plugin-multi-tenant/utilities` source) client-side, then perform the same REST fetch. Wire this component into `admin.components.Field` on all four Articles fields (Step 10).
10. Edit `src/collections/Articles.ts`'s "Media" tab fields array:
    - Keep `heroImage`, `imageLabel`, `leadImageCaption`, `imageUrl` unchanged in position/config except `heroImage` gains a `validate` function (Step 6a below — folded into this step).
    - Add `video`: `{ name: "video", type: "upload", relationTo: "videoMedia", access: { create: canSetVideo, update: canSetVideo }, admin: { components: { Field: "@/components/admin/VideoFieldGate#default" } } }` (exact Payload 3.x custom-component import-map string syntax — confirm the `#default` / named-export convention against this repo's `payload.config.ts` `admin.importMap` setup, if any, before finalizing).
    - Add `videoCaption`: `{ name: "videoCaption", type: "text", access: { create: canSetVideo, update: canSetVideo }, admin: { components: { Field: ... } } }`.
    - Add `videoCredit`: same shape as `videoCaption`.
    - Add `videoDescription`: same shape, PLUS the conditional-required `validate` (Step 6b).
6a. On `heroImage`, add: `validate: (value, { siblingData }) => { if (siblingData?.video && !value) return "A hero image is required whenever a video is attached."; return true; }` (exact `siblingData` shape/whether `video`'s sibling value is available inside the same field-group tab at validate-time must be confirmed against Payload's field `validate` signature for grouped/tabbed fields — if `siblingData` does not expose `video` reliably in this nesting, fall back to a document-level `hooks.beforeValidate` on the `Articles` collection that checks `data.video && !data.heroImage` and throws a `ValidationError`).
6b. On `videoDescription`, add the mirrored conditional-required `validate`: `(value, { siblingData }) => { if (siblingData?.video && !value) return "A description is required whenever a video is attached."; return true; }` (same fallback caveat as 6a).
11. Edit `payload.config.ts`: import `VideoMedia`; add `videoMedia: {}` to the `multiTenantPlugin({ collections: {...} })` map; add `videoMedia` to the collections array passed to `buildConfig({ collections: [...] })` (confirm this array's exact location — likely near the top-level `collections:` key, separate from the plugin's per-collection map); add a `videoMedia` entry to `s3Storage({ collections: {...} })` mirroring `media`'s `disablePayloadAccessControl: true` + `generateFileURL` block, reusing the same `r2PublicBaseUrl` constant.
12. Write the migration `src/migrations/{YYYYMMDD}_{HHMMSS}_add_video_support.ts` (get the exact timestamp/filename convention by inspecting the two most recent files in `src/migrations/` immediately before writing — do not hardcode a guessed timestamp): `ALTER TABLE "articles" ADD COLUMN "video_id" integer, ADD COLUMN "video_caption" text, ADD COLUMN "video_credit" text, ADD COLUMN "video_description" text; ALTER TABLE "_articles_v" ADD COLUMN "version_video_id" integer, ADD COLUMN "version_video_caption" text, ADD COLUMN "version_video_credit" text, ADD COLUMN "version_video_description" text;` plus the FK constraints (`articles_video_id_videoMedia_id_fk` → `videoMedia.id` ON DELETE SET NULL, and the `_articles_v` equivalent) and btree indexes on both `video_id` columns, mirroring the exact style of `20260702_231336_initial_schema.ts:872,1061` (hero_image FK/index) and `20260824_000000_add_exclusive_flag.ts` (multi-statement `up`/`down` pair). Write a symmetric `down()` that drops the indexes, then the FKs (implicitly dropped with columns in Postgres, but drop explicitly if the existing pattern does so), then the columns.
13. Confirm (do NOT hand-write) that Payload's own schema-push/migration tooling will create the `videoMedia` table itself (tenant + prefix columns, standard upload-collection columns) the first time migrations run against a dev DB — verify by running the migration generation command locally per this repo's documented workflow BEFORE committing to the hand-written migration file's exact column set, since Payload may bundle the new collection's own table creation into the same auto-generated migration rather than requiring a second hand-written one. Adjust Step 12 to include or exclude the `videoMedia` table DDL based on this confirmation.
14. Edit `src/app/api/public/articles/route.ts`: change `LIST_SELECT` to `{ body: false, video: false, videoCaption: false, videoCredit: false, videoDescription: false } as const` (confirm whether Payload's `select` semantics require top-level relation fields to be listed individually for exclusion, or whether excluding `video` alone suffices — test with a manual request per Verification Evidence below).
15. Create `src/lib/article-video.ts` exporting `resolveArticleVideo(doc)`: reads `doc.video` (expects a populated `VideoMedia` doc when `depth >= 1`), `doc.heroImage` (populated `Media` doc), `doc.videoCaption`, `doc.videoCredit`, `doc.videoDescription`; returns `null` if `doc.video` is not a populated object (absent/id-only/null); otherwise returns `{ url: video.url, mimeType: video.mimeType, posterUrl: heroImage?.sizes?.hero?.url ?? heroImage?.url ?? "", caption: doc.videoCaption ?? null, credit: doc.videoCredit ?? null, description: doc.videoDescription ?? "" }`.
16. Edit `src/app/api/public/articles/[slug]/route.ts`: after `const doc = result.docs[0];` and the existing not-found check, add `const resolvedVideo = resolveArticleVideo(doc); const responseDoc = { ...doc, video: resolvedVideo };` and return `jsonPublic(request, { doc: responseDoc }, 200)` instead of the raw `doc`.
17. Run `npm run typecheck` and `npm run lint` in `apcg-cms`. Fix until green.

### CMS-Before-Reader Ordering gate (see dedicated section above) — execute before continuing

18. Regenerate `payload-types.ts` in apcg-cms (exact command confirmed in Step 1) and hand-copy into `brief-asia-web/src/payload/payload-types.ts`.

### brief-asia-web

19. Create `src/lib/article-video-view.ts`: `export interface ArticleVideoView { url: string; mimeType: string; posterUrl: string; caption: string | null; credit: string | null; description: string }` and `export function toArticleVideoView(a: Article): ArticleVideoView | null` — reads `a.video` (now typed per the copied `payload-types.ts` as the resolved shape, since the public API returns it pre-resolved — this function is a thin pass-through/type-narrowing, NOT a re-derivation, matching Criterion 16). Guard against `a.video` being `null`/absent (non-video article) by returning `null`.
20. Create `src/components/article/video-player.tsx`: a functional component taking the six `ArticleVideoView` fields as props (or the whole `ArticleVideoView` object), rendering `<video controls preload="none" poster={posterUrl} aria-label={description}>` with a single `<source src={url} type={mimeType} />` child, and rendering `caption`/`credit` in a `<figcaption>` matching the existing hero figcaption's visual style (reuse the same inline style object literal from `article-content.tsx` rather than inventing new CSS). No autoplay attribute anywhere. No `<video>` prop that would trigger eager loading (verify `preload="none"` is sufficient and no `autoPlay` default sneaks in from any shared video-element wrapper — there is none today, so this is a from-scratch element).
21. Edit `src/app/(reader)/[locale]/article/[slug]/page.tsx`: add `import { toArticleVideoView } from "@/lib/article-video-view";`, compute `const video = toArticleVideoView(article);` alongside the existing `const view = toArticleView(article, locale);` in the page's main render function (NOT in `generateMetadata`, which only needs `view` for OG tags — video does not affect metadata per Out Of Scope), and pass `video={video}` as a new prop to `<ArticleContent>`.
22. Edit `src/components/article/article-content.tsx`: add `video: ArticleVideoView | null;` to the props interface (~line 19, alongside `article: ArticleView;`); import `ArticleVideoView` type and the new `VideoPlayer` component; in the hero `<figure>` block (~lines 508-551), wrap the existing `{article.heroImageFullUrl ? <img .../> : <CoverArt .../>}` ternary with an outer check: if `video` is non-null, render `<VideoPlayer {...video} />` instead of the whole ternary; otherwise render the ternary exactly as it exists today (byte-identical for the non-video case).
23. Run `npm run typecheck` and `npm run lint` in `brief-asia-web`. Fix until green.

### Adoption note (deliverable, not an afterthought)

24. Write `process/general-plans/active/article-video-support_10-09-26/article-video-support_ADOPTION-NOTE_10-09-26.md` — one page, three sections: (a) **Files to copy** — `src/lib/article-video-view.ts`, `src/components/article/video-player.tsx`, and the video-branch edit shape for the adopting site's own hero-figure component (named per-site, so describe the edit pattern rather than a literal diff); (b) **What to wire up** — regenerate/copy `payload-types.ts` from apcg-cms first (name the exact CMS-Before-Reader Ordering dependency), then thread a `video` prop the same way Step 21/22 do, keeping it OFF the shared list/card view type; (c) **What the CMS side needs** — flip the target tenant's `Tenants.features.video` checkbox in the apcg-cms admin; no code change in apcg-cms is required for a second tenant, since the field/collection is already there org-wide, gated purely by the flag.

## Data Flow (prose architecture note)

1. Editor (BriefAsia tenant, `video` flag on) uploads a file to the `video` field on an `Articles` doc in the Payload admin → browser signs a presigned PUT directly to R2 (same `clientUploads: true` path `Media` already uses, inherited at the plugin level — no per-collection override needed) → `VideoMedia`'s `beforeChange`/`afterChange` hooks (shared with `Media`) verify/relocate the object exactly as they do for images today.
2. On save, `Articles`' conditional `validate` functions (Steps 6a/6b) block the save if `video` is present without `heroImage`/`videoDescription`.
3. A reader's browser requests `/api/public/articles/[slug]` → `scopedFind` fetches the doc at `depth: 2` (already populating `heroImage` and, newly, `video`) → `resolveArticleVideo()` computes the resolved object server-side → the route returns `doc.video` as that resolved object (or `null`).
4. `brief-asia-web`'s article page calls `toArticleVideoView()` (pure pass-through/type-narrow, no network call, no lookup) and threads the result as a prop parallel to, not merged into, `ArticleView` → `article-content.tsx` renders `<VideoPlayer>` in the hero slot only if `video` is non-null.
5. Every listing/card codepath continues to call `toArticleView()` only, whose output type never includes a video field — there is no code path by which a card component could render or fetch the video, because the data simply is not there to reach.
6. Cross-tenant isolation: for any tenant with `features.video` false/absent, `canSetVideo` denies field-level writes server-side (silent field-value discard, matching `exclusive`'s established Payload field-access-denial semantics) and the admin Field Component renders nothing — both enforced independently, satisfying Criterion 2's dual (UI + API) requirement.

## Failure Modes / Edge Cases (from `vc-scenario`-style review of the 3 highest-risk checklist items)

**Risk 1 — the admin Field Component (Step 9) cannot get live tenant-feature state client-side (Payload/plugin API mismatch).**
- Edge case: `@payloadcms/plugin-multi-tenant/client` does not export a stable selection hook at v3.85.1, or exports it under a different name.
- Mitigation already built into the checklist: `vc-docs-seeker` verification gate BEFORE writing the component; documented cookie-parse fallback.
- Edge case: the fallback REST fetch to `/api/tenants/:id` races the admin form's initial render, briefly showing the field before the fetch resolves.
- Mitigation: default to `null` (hidden) while loading, flip to visible only on a confirmed `true` — fail closed, not open. Document this explicitly in the component so a future editor doesn't "fix" a flash-of-hidden-content bug by defaulting to visible.

**Risk 2 — conditional `validate`'s `siblingData` may not see `video`'s value if the fields are nested under different tabs/groups (Step 6a/6b).**
- Edge case: `heroImage` and `video` are declared in the same "Media" tab fields array (flat, not nested groups), so `siblingData` at the tab level should include both — but Payload's exact `siblingData` scope for `validate` on a field inside a `tabs`-type field's `fields` array needs confirmation, not assumption.
- Mitigation: the checklist names an explicit fallback (document-level `beforeValidate` hook) precisely so this isn't a silent gap if the assumption is wrong; execute-agent must test this specific case manually (save video without hero → expect block) before considering Step 10/6a/6b done, not just typecheck-green.

**Risk 3 — `LIST_SELECT` exclusion of a relationship field (`video: false`) may not fully suppress it from the JSON response (Step 14).**
- Edge case: Payload's `select` option semantics for excluding upload/relationship fields sometimes behave differently from excluding plain text/richText fields (the existing `body: false` precedent is a richText field, not a relationship).
- Mitigation: Verification Evidence row for Criterion 4 includes an explicit manual check of the LIST endpoint's raw JSON (not just the detail endpoint) confirming `video` truly does not appear, not just that it renders as `null`/unresolved — both would look "fine" in a component but only actual field-absence proves the structural claim.

## Dependencies

- `apcg-cms`'s exact `generate:types` script name and migration filename convention (Checklist Step 1) — must be confirmed by reading the repo, not assumed, before Step 12/18.
- `vc-docs-seeker` verification of `@payloadcms/plugin-multi-tenant/client`'s exported hooks at the installed version (Checklist Step 9) — blocks the admin Field Component's exact implementation.
- Branch: `claude/tender-ptolemy-njgwwt` in both repos (per SPEC Constraints) — confirm both repos are on this branch before EXECUTE begins.

## Risks (carried to Validate Contract)

| Risk | Class | Mitigation |
|---|---|---|
| `videoMedia` table auto-creation vs hand-written migration overlap (Checklist Step 13) | Migration correctness | Confirm via local migration-generation run before finalizing Step 12's file content |
| Admin Field Component library-API mismatch (Risk 1 above) | Implementation blocker | `vc-docs-seeker` gate + documented fallback |
| Conditional `validate` siblingData scope (Risk 2 above) | Silent acceptance-criterion failure | Documented fallback + mandatory manual test before Step 10 is considered done |
| `LIST_SELECT` relationship-field exclusion semantics (Risk 3 above) | Structural guarantee not actually enforced | Explicit raw-JSON manual check in Verification Evidence |
| Cross-repo type-sync step silently skipped | Reader typecheck failure disguised as "unrelated" error | CMS-Before-Reader Ordering is a named, gated checklist section, not an assumption |

## Verification Evidence

_Test Procedure note: both repos have no automated test runner beyond `tsc --noEmit` + lint (confirmed via `brief-asia-web/process/context/tests/all-tests.md` and `apcg-cms/docs/13-acceptance-criteria.md`); every other row below is Agent-Probe manual verification, consistent with that constraint._


| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| `cd apcg-cms && npm run typecheck` (exact script name confirmed Step 1) | Fully-Automated | Criterion 9 (additive/nullable schema, no break), Criterion 11 (apcg-cms typecheck) |
| `cd apcg-cms && npm run lint` | Fully-Automated | Criterion 11 |
| `cd brief-asia-web && npm run typecheck` | Fully-Automated | Criterion 11 (brief-asia-web typecheck) |
| `cd brief-asia-web && npm run lint` | Fully-Automated | Criterion 11 |
| `grep -rEn "brief-asia\|briefasia\|dtw-web\|wad-web\|gcv-web\|wtb-web\|asia-awards-web\|dailytechwire-web\|APCG-web" src/collections/VideoMedia.ts src/lib/upload-integrity.ts src/lib/tenant.ts src/lib/article-video.ts src/access/collections.ts src/collections/Articles.ts (video-related hunks only) — repeat for brief-asia-web's src/lib/article-video-view.ts and src/components/article/video-player.tsx` | Fully-Automated | Criterion 13 (no tenant slug hardcoded) — zero matches = pass, other than doc comments explicitly describing BriefAsia as reference implementation |
| `git diff payload.config.ts \| grep "fileSize"` (expect no output) | Fully-Automated | Criterion 10 (20MB ceiling unchanged) |
| Grep confirming `Media.ts` and `VideoMedia.ts` both import `rememberSignedFilename`/`verifyClientUpload` from `@/lib/upload-integrity` and neither file defines them locally | Fully-Automated | Criterion 15 (shared, not duplicated, upload-integrity) |
| Grep confirming collection slug `videoMedia`, component name `video-player`, `FEATURE_KEYS` entry `video` | Fully-Automated | Criterion 18 (function-based naming) |
| File-existence + section-presence check on `article-video-support_ADOPTION-NOTE_10-09-26.md` (3 named sections present) | Fully-Automated | Criterion 17 (adoption note exists) |
| Manual: BriefAsia editor uploads a video (<20MB) with hero image present, saves, reloads, confirms persistence | Agent-Probe | Criterion 1 |
| Manual: attempt to upload a video >20MB, confirm same rejection UX as an oversized image | Agent-Probe | Criterion 10 |
| Manual: open article editor for a non-BriefAsia tenant, confirm `video`/`videoCaption`/`videoCredit`/`videoDescription` fields are absent from the DOM (inspect element, not just visually hidden) | Agent-Probe | Criterion 2 (UI half) |
| Manual/local-API: attempt a direct Payload local-API `update` call on a non-enabled tenant's article setting `video`, confirm the field value is discarded/rejected, never persisted | Agent-Probe | Criterion 2 (API half) |
| Manual: BriefAsia article WITH video — article page shows video player in hero slot, poster = hero image | Agent-Probe | Criteria 3, 6 |
| Manual: BriefAsia article WITHOUT video — article page hero slot pixel/behavior-identical to pre-feature production | Agent-Probe | Criterion 3 |
| Manual + raw JSON inspection: homepage, pillar front, related-articles, tag page, author page, search results, RSS, OG/social-share image for a video-bearing article — confirm `<img>` only, never `<video>`, AND confirm raw `/api/public/articles` (list) JSON has no `video`/`videoCaption`/`videoCredit`/`videoDescription` keys at all | Agent-Probe | Criterion 4 (both DOM AND network-tab/JSON layers, per Risk 3) |
| Manual, browser network tab: on a video article page, confirm no video byte-range request occurs before the reader presses play; confirm full controls present after | Agent-Probe | Criterion 5 |
| Manual: save video with hero image present (poster reuse) + separately attempt save with video but no hero (expect validation block) + save non-video article with no hero (expect success, unchanged) | Agent-Probe | Criteria 6, 12 |
| Manual: save video with caption/credit filled, and separately with both blank; both succeed | Agent-Probe | Criterion 7 |
| Manual: attempt save with video but empty `videoDescription` (expect block); fill it (expect success) | Agent-Probe | Criterion 8 |
| Before/after spot-check: count of existing articles + null video-field state unchanged post-deploy for a BriefAsia + a non-BriefAsia sample | Agent-Probe (+ Fully-Automated typecheck as the schema-additivity proof) | Criterion 9 |
| Manual: flip a second (non-BriefAsia) tenant's `video` flag ON in a local/staging environment with zero source edits; confirm field appears in that tenant's editor and resolved video object appears in that tenant's article API response | Agent-Probe | Criterion 14 |
| Manual/API inspection: fetch a video-bearing article via `/api/public/articles/[slug]`, confirm all six `url`/`mimeType`/`posterUrl`/`caption`/`credit`/`description` fields present and fully resolved (posterUrl is a real usable URL) | Agent-Probe | Criterion 16 |

## Test Infra Improvement Notes

(none identified yet)

## Resume and Execution Handoff

1. **Selected plan file path:** `process/general-plans/active/article-video-support_10-09-26/article-video-support_PLAN_10-09-26.md` (this file).
2. **Last completed phase or step:** PLAN — plan written, not yet validated.
3. **Validate-contract status:** pending (placeholder below — `vc-validate-agent` writes this section before EXECUTE).
4. **Supporting context files loaded:** locked SPEC (`article-video-support_SPEC_10-09-26.md`), `apcg-cms/src/collections/{Media,Articles,Tenants,Podcasts}.ts`, `apcg-cms/src/access/features.ts`, `apcg-cms/src/lib/{tenant,constants}.ts`, `apcg-cms/payload.config.ts`, `apcg-cms/src/migrations/{20260702_231336_initial_schema,20260824_000000_add_exclusive_flag}.ts`, `apcg-cms/src/app/api/public/articles/{route,[slug]/route}.ts`, `brief-asia-web/src/lib/article-view.ts`, `brief-asia-web/src/components/article/article-content.tsx`, `brief-asia-web/src/app/(reader)/[locale]/article/[slug]/page.tsx`, `brief-asia-web/src/payload/payload-types.ts` (partial).
5. **Next step for a fresh agent picking up mid-execution:** if VALIDATE has not run, say `ENTER VALIDATE MODE` next. If VALIDATE has passed and EXECUTE is mid-flight, re-read this plan's Implementation Checklist numbering (1–24) and the CMS-Before-Reader Ordering gate to determine exact resume point — apcg-cms steps (1–18) must ALL be complete, including the type-copy at Step 18, before any brief-asia-web step (19–23) is attempted.

## Validate Contract

(placeholder — vc-validate-agent writes this section before EXECUTE)
