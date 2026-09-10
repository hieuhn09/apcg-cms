---
name: spec:article-video-support
description: "Video support for articles, BriefAsia-first but built as a reusable template for 8+ tenant sites; hero image required only when a video is attached; hero-required-for-all-tenants is deferred as a named follow-up"
date: 10-09-26
feature: article-video-support
---

# SPEC — Video Support for Articles (BriefAsia-First, Reusable Template)

> **Revision note (this is the fourth and current revision of this SPEC):**
> An earlier revision added a second, separately-scoped requirement making
> `Articles.heroImage` required for ALL 12 tenants (including engine intake).
> The user has now **removed that requirement from this work** — it was
> bundled in only because of a poster-image question, a connection created
> during drafting, not an inherent one. It is deferred to a named follow-up
> (see Out Of Scope) with its analysis preserved so the follow-up does not
> have to re-derive it. This revision also restores a **conditional** hero
> rule scoped to video articles only, and adds a new requirement: the feature
> ships as a reusable template other tenant sites can adopt later without a
> code change to this repo.

## Summary

BriefAsia's newsroom wants to publish short video clips (under the existing
20MB upload ceiling, unchanged) alongside selected stories. This SPEC adds
that capability for BriefAsia first — no other tenant gets video turned on as
part of this work — but the feature must be built so that a second tenant
site can adopt it later by flipping a config flag and copying a small,
documented set of files, not by a fresh implementation. There are 8+ separate
frontend repos in this product family (brief-asia-web, dtw-web, wad-web,
gcv-web, wtb-web, asia-awards-web, dailytechwire-web, APCG-web); BriefAsia is
the reference implementation, not the only eventual target.

On the article's own page, a video (when present) replaces the hero image in
the hero slot; every listing/preview surface across the site always shows the
static hero image, never a video. An article gains a hero-image requirement
**only when it has a video attached** — an article with no video keeps
today's behavior exactly, including the existing generative-cover-art
fallback driven by `imageLabel`. (A separate, broader change — making
`heroImage` required for every article on every tenant, independent of
video — was considered during drafting and has been deliberately deferred;
see Out Of Scope.)

## User Stories / Jobs To Be Done

### Requirement A — Video (BriefAsia first)

- As a BriefAsia editor, I want to upload a short video file directly in the
  article editor, so that a story can carry motion rather than just a photo,
  without leaving the CMS or relying on an external video host.
- As a BriefAsia editor, I want the video field to simply not exist for me if I
  ever work on another tenant's site, so that I never accidentally try to add
  video where it isn't supported.
- As a BriefAsia editor, when I attach a video to an article, I want to be
  required to also have a hero image (used as the poster) — but if my article
  has no video, I want nothing new required of me at all.
- As a BriefAsia editor, I want to optionally add a short caption and a
  credit/source line to the video, the same way I already can for images, so
  that attribution and context travel with the clip.
- As a BriefAsia editor, I want to write one short text description of the video
  (like alt text for an image), so that the video isn't a completely opaque,
  inaccessible element for readers using assistive technology.
- As a BriefAsia reader opening an article that has a video, I want to see the
  familiar hero-image area now showing a play button over the (still-familiar)
  hero image, so that I recognize this is "the same spot," just enriched.
- As a BriefAsia reader on a slow mobile connection, I want the video to NOT
  start downloading or playing until I actually press play, so that I don't burn
  data or wait on a page that "auto-loads" video I didn't ask for.
- As a BriefAsia reader who chooses to play the video, I want normal video
  controls (play/pause, seek, volume, fullscreen), so that I have the same
  control I'd expect from any video player.
- As a BriefAsia reader browsing the homepage, a section front, or search
  results, I want to see the same still images I see today — never an
  autoplaying or inline-playing video — so that scrolling feeds stays fast and
  visually calm.
- As a reader on any of the other 11 tenant sites, I want this feature to be
  completely invisible to me — no video, no new required field, no behavior
  change anywhere on my site.

### Requirement C — Reusable Template (all future tenant adopters)

- As the engineer who eventually turns video on for a second tenant (e.g.
  `dtw-web` or `wad-web`), I want the CMS-side gating to be a single
  `Tenants.features` checkbox flip, with zero code changes anywhere in the
  feature, so that adoption is cheap and low-risk.
- As that same engineer, I want a short, concrete adoption note (which files
  to copy, what to wire up, what the CMS side needs) instead of having to
  reverse-engineer BriefAsia's implementation from scratch.
- As a frontend developer on any of the 8+ tenant repos, I want the API to
  hand me a fully-resolved video object — URL, mimetype, poster URL, caption,
  credit, description — so my player component contains no branching logic
  and is safe to copy into another repo verbatim.
- As a future maintainer, I want the upload-integrity protection that already
  exists for `Media` (the 11-08-2026 stranded-object incident fix) applied to
  video uploads too, from ONE shared implementation, so a future fix to that
  protection doesn't have to be applied twice and risk drifting.
- As a product owner, I want the collection, field, and gating logic named by
  function (`videoMedia`, `video-player`, feature key `video`) rather than by
  publication, so nothing in the codebase implies the feature is
  BriefAsia-exclusive when it isn't meant to be.

## What The User Wants (Behavioral Outcomes)

### Requirement A — Video (BriefAsia first)

- **Editor UI (BriefAsia only, gated by the `video` feature flag):** the
  article editor shows a new, optional video upload field, plus optional
  caption and credit text fields, and a required short text description
  field for the video. The video upload accepts common video file types,
  stored in the same tenant-scoped cloud storage (R2) media already uses,
  under the same 20MB size ceiling that applies to all uploads today. On any
  tenant where the `video` feature flag is off, none of this exists — not
  even a greyed-out or hidden-but-present field a curious editor could
  discover.
- **Conditional hero requirement (restored, scoped to video only):** an
  article must have a hero image **if and only if it has a video attached**.
  An article with no video keeps today's behavior exactly — hero image
  remains optional, and the existing generative-cover-art fallback (driven by
  `imageLabel`) continues to apply unchanged. This is enforced as a
  **conditional validation rule on `heroImage`** (fires only when a video is
  present on the same document), NOT as a blanket `required: true` on the
  field. (See Constraints — this reverses an earlier INNOVATE mechanism
  decision made when a blanket-required rule was still in scope.)
- **Article page (BriefAsia reader site) — conditional hero:**
  - If the article HAS a video: the hero area on the article page shows the
    video player, with the article's hero image displayed as the "poster"
    (the still frame shown before the reader presses play). Because a video
    article is now guaranteed to have a hero image (the conditional rule
    above), the poster always exists — no "no hero image" fallback case
    remains for video articles.
  - If the article has NO video: the hero area shows the hero image (or the
    generative-cover-art fallback) exactly as it does today. Nothing about
    this case changes.
  - This is the ONLY behavior change to the hero area, and it only ever
    applies on the article's own page.
- **Every listing/preview surface — always static image:** homepage cards,
  pillar/section front cards, related-articles cards, tag-page cards,
  author-page cards, search-result cards, RSS feed entries, and OG/social share
  card images always use the static hero image (or its existing fallback) —
  never the video, never a video-derived thumbnail that behaves like a video,
  and never an autoplay preview. A reader must never see a video start
  playing, or a video file begin downloading, anywhere except by opening the
  article page and pressing play.
- **No autoplay, no pre-fetch:** the video file itself is not requested by the
  browser until the reader explicitly presses play. Only the poster image (the
  hero image, already loaded for the page) is shown up front.
- **Other 11 tenants:** completely unaffected — no new field visible anywhere
  in their admin UI, no new required-field behavior, no video behavior change
  on their public sites, until and unless a future adopter flips their
  `video` feature flag (see Requirement C).
- **Existing content:** no existing article, on BriefAsia or any other
  tenant, gains a video. Nothing is migrated or backfilled.

### Requirement C — Reusable Template (all future tenant adopters)

- **No tenant identity hardcoded anywhere in the feature.** The collection,
  the field definitions, the access/gating logic, and the reader-side
  rendering code contain no `"brief-asia"` (or any other tenant slug)
  string. Enabling video for a second tenant is a `Tenants.features`
  checkbox flip and nothing else.
- **One shared upload-integrity implementation, reused, not copy-pasted.**
  `Media.ts`'s `rememberSignedFilename` and `verifyClientUpload` — built
  after the real 11-08-2026 incident where a client-uploaded object stranded
  under a key no lookup could find — are extracted (or otherwise shared) so
  the new video collection calls the SAME implementation `Media` uses, not a
  second copy.
- **The API resolves everything server-side; the frontend player makes no
  decisions.** The reader-facing payload includes a fully-resolved video
  object carrying at minimum: `url`, `mimeType`, `posterUrl`, `caption`,
  `credit`, `description`. `posterUrl` is computed CMS-side from the article's
  hero image — no frontend has to look up or infer it. Each of the 8+
  frontend repos can therefore implement a small, branchless player component
  (~30 lines) that is safe to copy verbatim.
- **A short adoption note ships with this work** (in the task folder): which
  files a second site copies, what it wires up, and what the CMS side needs
  (the tenant feature flag). One page, not a full guide.
- **Naming is by function, not by publication:** collection `videoMedia`,
  reader component `video-player`, feature key `video`. No BriefAsia-specific
  names anywhere in the implementation.

## Flow / State Diagram

### Requirement A — Video (BriefAsia first), with conditional hero

**Editor flow:**

```
Editor opens article (any tenant)
        |
        v
  Tenant has `video` feature flag ON? ----No----> Video field does not
        |                                          exist/render (identical
       Yes                                         to today's editor)
        |
        v
  Video field visible (optional)
        |
        v
  Editor uploads video file (<=20MB, existing limit unchanged)
        |
        v
  Editor writes required short text description (accessibility)
        |
        v
  Editor optionally adds caption / credit
        |
        v
  Editor attempts to save
        |
        v
  Does the article have a video attached? ----No----> Hero image stays
        |                                              OPTIONAL, exactly as
       Yes                                             today (unaffected).
        |
        v
  Hero image required NOW (conditional
  validation rule fires) ----No hero----> Save BLOCKED, validation error
        |                                  shown, asking for a hero image
       Has hero
        |
        v
  Save succeeds — article now has:
  hero image + video + description +
  optional caption/credit
```

**Reader flow — article page vs. listing surfaces:**

```
                    +-------------------------------+
                    |   Any page rendering this      |
                    |   article's card or metadata   |
                    +-------------------------------+
                                  |
                 Which surface is rendering it?
                 /                              \
        Article's OWN page                  Any listing surface
        (the full article view)      (home, section front, related,
                |                      tag page, author page, search,
                |                      RSS, OG/social card image)
                v                                  |
     Does article have a video?                    v
        /              \                 ALWAYS static hero image
      Yes               No               (or existing cover-art
       |                 |                fallback) — video never
       v                 v                renders here, never
  Hero slot shows    Hero slot shows      autoplays, never
  VIDEO PLAYER,      hero image (or       pre-fetched
  poster = hero      cover-art
  image, controls    fallback),
  visible, NOT        unchanged from
  autoplaying,        today
  NOT pre-fetching
  the video file
       |
       v
  Reader presses play
       |
       v
  Video file requested + plays with
  standard controls (pause/seek/
  volume/fullscreen)
```

**Cross-tenant isolation (always true, every path):**

```
Request/action from tenant X
        |
        v
  Does tenant X have `video` feature flag ON? ----No----> Video field:
        |                                                 invisible in admin
       Yes                                                UI, not settable
        |                                                 via API, never
        v                                                 present in reader
  Video feature available per the rules above             output for tenant X
```

### Requirement C — Reusable adoption (informational, not a runtime flow)

```
Future adopter wants video for Tenant Y (one of the other 8+ repos)
        |
        v
  1. Flip Tenant Y's `video` feature-flag checkbox in Tenants admin (CMS side)
        |
        v
  2. Copy the documented reader-side files per the adoption note into Tenant
     Y's frontend repo (per the note in the task folder)
        |
        v
  3. Wire the copied `video-player` component to the API's fully-resolved
     video object (url/mimeType/posterUrl/caption/credit/description) —
     no new logic needed, no lookups, no branching
        |
        v
  Tenant Y's editors can now attach video; no code change was needed in
  apcg-cms; the frontend copy is small and mechanical
```

## Acceptance Criteria (Testable Outcomes)

### Requirement A — Video (BriefAsia first)

1. **A BriefAsia editor can upload a video to an article and save it.**
   The video field appears in the BriefAsia article editor, accepts a video file
   under the existing 20MB upload ceiling, and the article saves successfully
   with the video attached (with a hero image present, per Criterion 12).
   `proven by:` manual verification in Payload admin (BriefAsia tenant) — upload
   a video, save, reload, confirm it persists. No automated harness exists for
   apcg-cms admin UI today (package.json exposes only `typecheck`/`lint`).
   `strategy:` Agent-Probe (manual admin walkthrough; no e2e harness in this repo).

2. **No other tenant's editor can see or set the video field.**
   Opening the article editor for any tenant without the `video` feature flag
   shows no video field, no caption/credit-for-video fields, and no
   video-description field — not hidden-via-CSS, genuinely absent. A direct
   API write attempt from a non-enabled tenant context setting the video
   field is rejected or ignored server-side (equivalent to the field not
   existing for that tenant).
   `proven by:` manual admin walkthrough for at least one non-BriefAsia tenant
   (editor UI) + a direct API/Payload local-API write attempt for a
   non-enabled tenant, confirming rejection or silent no-op (never persisted).
   `strategy:` Agent-Probe — this is the single most important, first-class
   criterion for Requirement A; both the UI path and the API path must be
   checked, not just one.

3. **On the article's own page, a video article shows the video player in the
   hero slot; a non-video article shows the hero image (or cover-art
   fallback) exactly as today.**
   `proven by:` manual browser check on `brief-asia-web` — one article with
   video, one without, confirm the hero slot renders correctly in each case and
   that the non-video article is pixel/behavior-identical to current production
   behavior.
   `strategy:` Agent-Probe (no e2e harness in brief-asia-web per
   `process/context/tests/all-tests.md` — verification is manual/browser only).

4. **On every listing surface, the hero image (or its existing fallback) is
   always shown — never the video, never an autoplaying preview.**
   Checked across: homepage cards, pillar/section front cards, related-articles
   cards, tag-page cards, author-page cards, search results, RSS feed entries,
   and OG/social share card images. Tested SEPARATELY from criterion 3 because
   it is a distinct, explicitly called-out hard requirement — a video must
   never render or autoload outside the article's own page.
   `proven by:` manual browser + view-source/network-tab check on
   `brief-asia-web` for a video-bearing article across each listed surface,
   confirming (a) the rendered element is an `<img>`/static image, not a
   `<video>` element or video-driven thumbnail, and (b) no video byte range is
   requested by the browser on any of these surfaces.
   `strategy:` Agent-Probe.

5. **The video does not autoplay and its file is not pre-fetched.**
   On the article page, before the reader presses play, only the poster
   (hero image) has loaded; the browser has not requested the video file
   itself. Full native controls (play/pause, seek, volume, fullscreen) are
   present once the player is visible.
   `proven by:` manual browser network-tab inspection on the article page
   (video article) confirming no video byte request prior to a user-initiated
   play, plus a manual control-by-control check of the player.
   `strategy:` Agent-Probe.

6. **The video poster always uses the article's hero image — guaranteed by the
   conditional hero rule, not a blanket one.**
   Because Criterion 12 (below) requires a hero image whenever a video is
   attached, a BriefAsia article can never be saved with a video but without
   a hero image. This criterion therefore has NO "no hero image" fallback
   case to test for video articles specifically — the poster is guaranteed to
   exist. (Non-video articles are entirely unaffected and may or may not have
   a hero image, per today's existing rules.)
   `proven by:` manual check — save a video on an article that already has a
   hero image and confirm that image is the poster; separately, confirm that
   attempting to save a video WITHOUT a hero image is blocked by the
   conditional validation rule (Criterion 12), not by any video-specific
   logic.
   `strategy:` Agent-Probe.

7. **Optional caption and credit fields exist for video, mirroring Media's
   existing caption/credit pattern, and are never required.**
   `proven by:` manual check — save a video with caption/credit filled in, save
   another with both left blank; both save successfully and render correctly
   (or render nothing) as appropriate.
   `strategy:` Agent-Probe.

8. **A required short text description exists for accessibility (v1 scope:
   text description only — no subtitle track, no transcript).**
   The article cannot save a video without this description field filled in.
   No `.vtt`/subtitle upload field and no transcript field exist in v1 (see Out
   Of Scope).
   `proven by:` manual check — attempt to save a video with the description
   field empty (expect validation block) and with it filled (expect success).
   `strategy:` Agent-Probe.

9. **No existing article gains a video, on BriefAsia or any other tenant; no
   video-related data migration or backfill occurs.**
   `proven by:` before/after count check — total article count and per-article
   video-field state for a sample of pre-existing BriefAsia and non-BriefAsia
   articles is unchanged (video field absent/null) immediately after this
   feature ships, mirroring the migration-parity check pattern already used in
   this repo's acceptance criteria (`docs/13-acceptance-criteria.md` §Migration
   & rollback).
   `strategy:` Fully-Automated where feasible — `tsc --noEmit` (apcg-cms
   `package.json` script `typecheck`) must pass with the new field(s) as a
   purely additive, optional/nullable schema change; combined with a manual
   spot-check count.

10. **The 20MB upload size ceiling is unchanged for video (and for every other
    upload type).**
    `proven by:` manual check — attempt to upload a video file over 20MB and
    confirm it is rejected the same way an oversized image is rejected today;
    confirm `payload.config.ts` `upload.limits.fileSize` value is unchanged
    from before this feature.
    `strategy:` Agent-Probe + a direct config-diff check (`git diff
    payload.config.ts` showing no change to `upload.limits.fileSize`).

11. **Both repos' existing quality gates stay green (video feature).**
    `proven by:` `tsc --noEmit` and `next lint` in `apcg-cms` (per
    `package.json` scripts `typecheck`/`lint`); `npm run typecheck` and `npm run
    lint` in `brief-asia-web` (per `process/context/tests/all-tests.md`).
    `strategy:` Fully-Automated.

12. **Hero image is required WHEN a video is attached, and NOT otherwise —
    enforced by a conditional validation rule, not a blanket `required: true`.**
    Saving an article with a video but no hero image is blocked with a clear
    validation error. Saving an article with no video and no hero image
    succeeds exactly as it does today (unaffected).
    `proven by:` manual check — (a) attempt to save a video-bearing article
    with no hero image (expect validation block); (b) attempt to save the
    same article after adding a hero image (expect success); (c) attempt to
    save a NON-video article with no hero image (expect success, unchanged
    from current behavior) to confirm the rule is genuinely conditional, not
    a disguised blanket requirement.
    `strategy:` Agent-Probe.

### Requirement C — Reusable Template

13. **No tenant slug is hardcoded anywhere in the feature's touched files.**
    `proven by:` a grep for tenant slugs (`brief-asia`, `briefasia`, and the
    other 11 tenant slugs) across every file touched by this feature (the new
    collection, field definitions, access/gating logic, reader-side rendering
    code) returns zero matches, other than in comments/docs explicitly
    describing BriefAsia as the reference implementation.
    `strategy:` Fully-Automated — a single grep command is sufficient and
    should be added as a named check in the plan/validate-contract.

14. **Enabling a second tenant requires only a `Tenants.features` checkbox
    flip — no code change, no deploy.**
    `proven by:` manual check — with the implementation complete, flip a
    second tenant's `video` feature flag ON in a local/staging environment
    (no code edits) and confirm the video field appears in that tenant's
    editor and the reader payload includes the resolved video object for that
    tenant's articles, without touching source files.
    `strategy:` Agent-Probe.

15. **Video uploads share the SAME upload-integrity implementation `Media`
    uses — not a duplicated copy.**
    `Media.ts`'s `rememberSignedFilename` / `verifyClientUpload` protections
    (built after the 11-08-2026 stranded-object incident) are called by the
    new video collection from one shared implementation.
    `proven by:` code inspection confirming a single shared function/module is
    imported and called by both `Media` and the new video collection, with no
    second, independently-maintained copy of the same logic.
    `strategy:` Fully-Automated where feasible (a structural check that only
    one implementation exists) + manual review as the primary confirmation,
    since "shared, not duplicated" is a design-shape criterion.

16. **The reader-facing video object is fully resolved server-side; the
    frontend does no lookups or branching.**
    The API payload for a video-bearing article includes, at minimum: `url`,
    `mimeType`, `posterUrl`, `caption`, `credit`, `description` — with
    `posterUrl` computed from the article's hero image in the CMS, not left
    for the frontend to derive.
    `proven by:` manual/API inspection — fetch a video-bearing article via the
    public API and confirm all six fields are present and fully resolved
    (`posterUrl` is a real, directly-usable URL, not a reference the frontend
    must resolve itself).
    `strategy:` Agent-Probe.

17. **A short adoption note exists in the task folder.**
    One page covering: which files a second site copies, what it wires up,
    and what the CMS side needs (the tenant feature flag).
    `proven by:` the file exists in the task folder and covers the three
    named topics.
    `strategy:` Fully-Automated (file-existence + section-presence check) +
    manual read-through for adequacy.

18. **Naming is by function, not by publication, across the new surfaces.**
    The collection is named `videoMedia` (or equivalent function-based name),
    the reader component is `video-player` (or equivalent), and the feature
    key is `video` — none reference BriefAsia or any other publication name.
    `proven by:` code inspection of the new collection name, component name,
    and `FEATURE_KEYS` entry.
    `strategy:` Fully-Automated (name-pattern grep) + manual confirmation.

## Out Of Scope

### Requirement A — Video (BriefAsia first)

- Raising the 20MB upload size limit — explicitly rejected by the user; stays
  as-is for video and every other upload type.
- YouTube, Vimeo, or any embed-URL / iframe-embed field for video — explicitly
  rejected by the user. Video is uploaded-file-only, stored on R2.
- Video transcoding, adaptive bitrate streaming, or multiple video renditions —
  not built. Whatever file the editor uploads (under 20MB) is what's served.
- Automatic thumbnail/poster generation from the video file — the media
  pipeline (`sharp`) is image-only and cannot transcode; the poster is always
  the article's hero image (guaranteed to exist for video articles by the
  conditional rule, Acceptance Criterion 12).
- Subtitle/caption TRACK files (`.vtt`) and full video transcripts — deferred
  (see Constraints — this is a conscious v1 tradeoff against the site's stated
  WCAG 2.1 AA accessibility goal, recorded here so it is not quietly dropped).
- Video playback anywhere except the article's own page hero slot — never on
  listing surfaces, never inline in the article body, never as a background/
  autoplay element.
- Migrating or backfilling any existing article with a video.
- Changing the two public API route handlers
  (`/api/public/articles/[slug]/route.ts`, `/api/public/articles/route.ts`) to
  actively strip the video field from non-enabled tenants' JSON output — the
  field being present-but-empty for tenants without the `video` flag is an
  accepted, deliberate outcome.
- Choosing *how* the video field is modeled (new dedicated collection vs.
  extending `Media` vs. another shape) and *how* field-level tenant gating is
  enforced beyond what's fixed here — these are INNOVATE/PLAN decisions. This
  SPEC records the cross-collection mimetype-contamination risk as a
  constraint the chosen approach must respect, not as a solution.

### Requirement B — Hero Image Required, All 12 Tenants (REMOVED from this
work; deferred as a named future follow-up)

**This requirement is explicitly out of scope for this SPEC.** It was
included in an earlier revision, bundled in only because of a poster-image
question — a connection created during drafting of this SPEC, not an
inherent dependency of the video feature. The user has removed it. It is
recorded here, with its analysis preserved, so a future follow-up SPEC does
not have to re-derive the investigation:

- **What it would do:** make `Articles.heroImage` required for every article,
  on every one of the 12 tenants, including articles created through the
  engine intake API (`/api/engine/intake`) — independent of whether the
  article has a video.
- **Payload's `required: true` is enforced at the application layer, not the
  database layer.** It validates on write (create/update through the Payload
  API), not as a `NOT NULL` database constraint. This matters for a future
  follow-up in two ways: (1) existing rows with a null hero are NOT touched
  or made invalid by turning the flag on — they simply become unsaveable on
  next write, and (2) the change is fully reversible at the flag level:
  turning `required` back off does not require a data migration, only a
  config/schema change.
- **The three verified engine-side gates (preserved for the follow-up,
  verified against `content-engine` source, `/home/user/content-engine`):**
  Gate 1 (`src/jobs/editorial-job.ts:279-288`) drops a raw article with no
  `hero_image_url` before any AI spend; Gate 2
  (`src/jobs/editorial-job.ts:556-575`, `prepareHeroImage`) drops it if the
  resolve/fetch/validate/resize pipeline can't produce a usable image; Gate 3
  (`src/jobs/editorial-job.ts:907-926`, `storePreparedHero`) drops it if the
  validated image fails to write to Supabase Storage. The published article
  row is only inserted after all three pass, with `hero_image_url:
  heroPublicUrl` (`editorial-job.ts:975`) reachable only on Gate 3's success
  path — verified to be the only write of `hero_image_url` on the
  published-articles path. **Net effect, verified: no code path exists by
  which an engine-published article reaches Central with a null hero** — so a
  future "hero required at intake" change would have NO practical effect on
  new engine-originated articles; its only real effect would be on (a)
  legacy/migrated articles predating this pipeline, and (b) any editor
  resaving an old hero-less article by hand.
  - A stale comment in `content-engine`'s `src/editorial/image-uploader.ts:159,229`
    describes a "let team source manually" null-hero fallback that its
    caller does not implement (the three gates above always drop the article
    instead). This is worth a one-line comment fix in `content-engine`, but
    is a separate, out-of-scope change.
- **The three MUST-RESOLVE items carried into the follow-up, unchanged:**
  - **(a) Pre-flight NULL-heroImage count** — before any future version of
    this requirement ships, someone with database access must count
    `heroImage IS NULL` across all 12 tenants (published rows, draft rows,
    AND `_articles_v` version rows). This remains the single substantive open
    risk for that future work — nobody in this session has database
    credentials, and the count is not bounded by anything in the engine
    source (legacy content predates the engine's gates entirely). Small count
    → proceed; large count → needs a backfill or phased rollout plan.
  - **(b) Intake failure-path decision** — if a future version of this
    requirement is scoped to also touch `/api/engine/intake`, a decided
    behaviour is needed for `uploadHero()`'s fetch-failure path (currently:
    catch, log, publish without hero, `route.ts:498-523`). Options on record:
    5xx-retry, 4xx-terminal, per-tenant placeholder image. Given the verified
    gates above, this would be a rare defensive path, not a frequently-hit
    one.
  - **(c) High-risk evidence pack** — IF a future version of this requirement
    touches the engine intake API contract, it would trigger
    `process/development-protocols/orchestration.md` §High-Risk Execution
    Handoff ("public API contract changes") and require the manual-first
    5-artifact evidence pack before being treated as ready. **This does NOT
    apply to the current SPEC** — see Constraints, this work touches no
    engine-facing code.
- Enabling video for any tenant other than BriefAsia as part of THIS
  work — the mechanism must be config-toggleable (see Requirement C), but no
  other tenant is turned on as part of this SPEC.

### Requirement C — Reusable Template

- Actually enabling video for any tenant other than BriefAsia — Requirement C
  is about making that FUTURE step cheap, not about performing it now.
- Building out a second tenant's frontend player — the adoption note
  describes what a future adopter would do; this SPEC does not implement it
  for any tenant beyond BriefAsia.
- A generic, all-purpose media-abstraction refactor beyond what's needed to
  share the upload-integrity implementation between `Media` and the new video
  collection.

## Constraints

### Requirement A — Video (BriefAsia first) + Requirement C — Reusable Template

- **Tenant scope (hard):** the feature is gated by a `video` feature flag,
  BriefAsia-only for this work. It must be implementable as a config/feature
  toggle (mirroring the existing `FEATURE_KEYS` / `Tenants.features` pattern
  used for `newsletters`, `podcasts`, `marketData`) so a future tenant can be
  enabled without a code change — this is now a first-class, tested
  requirement (Requirement C), not just an aspiration.
- **Storage (hard):** video files are uploaded directly to Cloudflare R2, the
  same object storage already used for `Media`. No third-party video host, no
  embed URL field.
- **Size (hard):** the existing `payload.config.ts` `upload.limits.fileSize`
  value is NOT raised. Video, like every other upload, must fit under 20MB.
- **Conditional hero rule — mechanism constraint (D3 reversal):** an earlier
  INNOVATE decision (D3) chose a static `required: true` on `heroImage`,
  explicitly reasoned on the grounds that there was no carve-out to express
  at the time (Requirement B, hero-required-for-everyone, was still in
  scope). **That reasoning no longer applies and that decision is reversed.**
  With Requirement B removed and the conditional "hero required only when
  video is attached" rule restored, `heroImage` MUST be enforced via a
  **conditional `validate` function** (or equivalent field-level/
  document-level conditional validation), not a static `required: true`.
  PLAN must not inherit the stale D3 mechanism — INNOVATE should re-visit
  this decision point explicitly given the changed scope.
- **Cross-collection mimetype contamination (recorded risk, not solved here):**
  Payload validates upload mimetypes at the collection level, not per
  relationship field. Widening any existing upload collection's accepted
  mimetypes to include `video/*` would make every field pointing at that
  collection accept video — including `Articles.heroImage` and `Tenants.logo`,
  across all 12 tenants (Payload GitHub Discussion #653 — no field-level
  mimetype restriction exists upstream). Whatever approach INNOVATE/PLAN
  chooses (e.g. a dedicated `videoMedia` collection, per Requirement C's
  naming constraint) must not let a non-video field (e.g. `heroImage`,
  tenant `logo`) silently start accepting video uploads for ANY tenant.
- **No existing field-level, single-tenant field-gating pattern exists.**
  Today's tenant gating (`FEATURE_KEYS`, `Tenants.features`,
  `src/access/features.ts`) works at the whole-collection level. Payload has
  two unwired primitives available — field `admin.condition` (admin-UI-only,
  does not block API writes) and field-level `access.create/update/read`
  (enforces on API, precedent: `Articles.exclusive` /
  `canFlagExclusive`, `Articles.ts:35-49`). Acceptance Criterion 2 requires
  BOTH UI invisibility and API-level rejection, so `admin.condition` alone is
  not sufficient on its own — INNOVATE must account for this.
- **Public API field visibility (accepted, deliberate limitation):** the two
  public route handlers (`/api/public/articles/[slug]/route.ts`,
  `/api/public/articles/route.ts`) return the whole article document with no
  field allow-list. This feature does NOT change that. The video field will be
  present-but-empty in the JSON response for tenants without the `video` flag.
  This is accepted as the simpler, smaller-blast-radius option — not an
  oversight.
- **Non-localized field precedent:** `Articles.heroImage` is `type: "upload",
  relationTo: "media"`, NOT localized. The closest precedent for adding a
  single non-localized field to `Articles` incrementally is
  `src/migrations/20260824_000000_add_exclusive_flag.ts` (`exclusive`
  checkbox) — ALTER TABLE on `articles` AND `_articles_v`, plus indexes. A
  localized field would instead need `articles_locales` /
  `_articles_v_locales` — materially heavier. This SPEC does not mandate
  non-localization for the new field(s), but flags that a localized shape has
  a real cost that INNOVATE/PLAN should weigh.
- **This work touches NO engine-facing code.** `src/app/api/engine/intake/
  route.ts` is untouched by this SPEC. As a direct consequence: this is no
  longer a public-API-contract change, so the `orchestration.md` §High-Risk
  Execution Handoff manual-first 5-artifact evidence pack requirement does
  NOT apply to this work (it would apply only to the deferred Requirement B
  follow-up, IF that follow-up's scope ever touches intake).
- **No unresolved external pre-condition.** Nothing in this SPEC waits on
  database access or any other external dependency — that pre-condition
  belonged only to the now-deferred Requirement B.
- **Manual cross-repo type sync (recorded risk with an owning step):**
  `brief-asia-web/src/payload/payload-types.ts` is a Payload-generated file
  manually copied from `apcg-cms` — there is no automated sync and
  `brief-asia-web`'s `package.json` has no `generate:types` script. Any new
  field/collection added in `apcg-cms` will NOT automatically appear in
  `brief-asia-web`'s types. **Owning step:** whichever plan implements this
  feature must include an explicit step to regenerate `apcg-cms`'s
  `payload-types.ts` and manually re-copy the updated file into
  `brief-asia-web/src/payload/payload-types.ts` before the reader-side
  (`cms-client.central.ts` → `central-api.ts` → `toArticleView()` →
  `article-content.tsx`) rendering work can typecheck. This must not be
  silently assumed to "just happen." (Requirement C's adoption note should
  flag this same step for any future second-tenant adopter's frontend repo.)
- **Reader chain (informational, not prescriptive):** the reader-side rendering
  path is `cms-client.central.ts` → `central-api.ts` → `Article` type in
  `payload-types.ts` → `toArticleView()` (`article-view.ts:229`, hero handling
  around lines 242, 332-335) → `article-content.tsx` (hero `<figure>`, hardcoded
  16:9 box around lines ~508-551). INNOVATE/PLAN will decide the exact
  implementation shape; this SPEC only fixes the observable behavior at each
  point in that chain.
- **Upload-integrity sharing (hard requirement, not PLAN-discretion):**
  `Media.ts`'s `rememberSignedFilename` and `verifyClientUpload` — built to
  fix the real 11-08-2026 stranded-object incident — MUST be called from a
  single shared implementation by both `Media` and the new video collection.
  An earlier INNOVATE pass left this as an open implementation choice; the
  user's explicit "no patchwork" instruction closes it: two independently
  maintained copies is not acceptable.
- **Branch:** all work happens on `claude/tender-ptolemy-njgwwt` in both
  `apcg-cms` and `brief-asia-web`.
- **Test gates (existing, unchanged by this feature):**
  - `apcg-cms`: `npm run typecheck` (`tsc --noEmit`), `npm run lint` (`next
    lint`) — no automated test runner exists in this repo.
  - `brief-asia-web`: `npm run typecheck`, `npm run lint` — no automated test
    runner exists in this repo either (`process/context/tests/all-tests.md`);
    all UI/behavioral verification is manual/browser-based.

## Open Questions

None. All open questions from prior revisions were resolved by the user this
session. Requirement B (previously the source of the only unresolved
pre-conditions) has been removed from this work's scope entirely and its
MUST-RESOLVE items travel with it into the deferred follow-up (see Out Of
Scope) — they are not open questions against THIS SPEC.

## Background / Research Findings

### Requirement A — Video (BriefAsia first)

Key facts from RESEARCH that shaped this SPEC (verified, not re-derived here):

- Payload validates upload mimetypes at the **collection** level, not per
  relationship field. Widening `Media.mimeTypes` (or any upload collection) to
  accept `video/*` would make every field pointing at that collection accept
  video — including `Articles.heroImage` and `Tenants.logo`, across all 12
  tenants. This is a cross-tenant data-integrity risk (Payload GitHub
  Discussion #653: no field-level mimetype restriction exists upstream).
- `Articles.heroImage` (`Articles.ts:430`) is `type: "upload", relationTo:
  "media"`, not localized. `exclusive` (checkbox, non-localized,
  `src/migrations/20260824_000000_add_exclusive_flag.ts`) is the closest
  precedent for an incremental single-field migration on `articles` +
  `_articles_v`. A localized field would instead hit `articles_locales` /
  `_articles_v_locales` — materially heavier.
- `FEATURE_KEYS` (`src/lib/constants.ts:10`) + `Tenants.features` checkboxes
  (`Tenants.ts:164-180`) + `src/access/features.ts` gate whole **collections**
  per tenant. There is no existing field-level or single-tenant field-gating
  pattern. Payload offers `admin.condition` (UI-only, does not block API) and
  field-level `access.create/update/read` (API-enforcing; precedent:
  `Articles.exclusive` / `canFlagExclusive`, `Articles.ts:35-49`). Tenant
  identity resolves via `data.tenant`/`doc.tenant` (cf. `tenantSlugById` in
  `Media.ts:14-29`).
- The public API (`/api/public/articles/[slug]/route.ts`,
  `/api/public/articles/route.ts`) returns the whole document with no field
  allow-list — confirmed and accepted (see Constraints) rather than changed.
- `brief-asia-web/src/payload/payload-types.ts` is manually copied from
  `apcg-cms`; no `generate:types` script exists in `brief-asia-web`, no
  automated cross-repo sync. Recorded as a risk with an owning step.
- Reader chain: `cms-client.central.ts` → `central-api.ts` → `Article` type in
  `payload-types.ts` → `toArticleView()` (`article-view.ts:229`, hero handling
  lines 242, 332-335) → `article-content.tsx` (hero `<figure>`, hardcoded 16:9
  box, lines ~508-551).
- `brief-asia-web` has zero video/iframe rendering today. Test gates in both
  repos are `tsc --noEmit` + lint only; no automated test suite in either repo.
- R2 delivery path already correct for video: `clientUploads: true` (browser
  PUTs direct to R2, bypassing Vercel's 4.5MB body cap) and
  `disablePayloadAccessControl: true` + custom `generateFileURL` serving from
  the R2 public domain (no proxy through Next; Range requests / seeking work).
- Existing acceptance-criteria style in this repo
  (`docs/13-acceptance-criteria.md`) uses admin/API-verifiable checklist items
  grouped by capability — mirrored in the Acceptance Criteria section above.
- `Media.ts`'s `rememberSignedFilename` and `verifyClientUpload` exist because
  of a real production incident (11-08-2026) where a client-uploaded object
  stranded under a key no lookup could find. This protection must extend to
  video uploads via one shared implementation (Requirement C, Constraints).

**User decisions captured verbatim this session (Requirement A):**

- Q1 (public API visibility): field present-but-empty for tenants without the
  `video` flag is accepted; the two public route handlers are not changed.
- Q2 (hero placement): the hero slot is CONDITIONAL — video only ever
  replaces the hero on the article's own page when a video is present; every
  listing surface ALWAYS shows the static hero image, never video. Two
  separate, separately-testable acceptance criteria (3 and 4).
- Q3 (poster): reuse the hero image as the video poster; no separate
  poster-upload field in v1. (No longer has an open "no hero image" gap — see
  Acceptance Criterion 12's conditional hero rule.)
- Q4 (autoplay): no autoplay, full native controls, no pre-fetch of the video
  body (poster image only loads up front); rationale: protect readers on slow
  mobile connections in Asia from unrequested data usage.
- Q5 (caption/credit): optional `caption` and `credit` fields for video,
  mirroring existing `Media` fields; neither required.
- Q6 (accessibility v1): required short text description
  (alt-text-equivalent) only; no `.vtt` subtitle track, no transcript in v1;
  explicitly recorded in Out Of Scope as a conscious v1 tradeoff against the
  site's WCAG 2.1 AA goal, to be picked up later rather than quietly dropped.
- Q7 (existing data / other tenants, video): no data migration, no existing
  article gains a video, non-enabled tenants see no video field anywhere in
  their admin editing UI.
- **New this revision — hero requirement scope corrected:** the user split
  out the "hero required for every article, all tenants" idea into a
  deferred follow-up (see Out Of Scope → Requirement B) after the
  coordinator pointed out it had only been bundled in because of the poster
  question. The CONDITIONAL "hero required only if video attached" rule is
  restored as part of Requirement A, reversing INNOVATE's D3 static
  `required: true` mechanism decision (see Constraints).
- **New this revision — reusable template requirement:** the user identified
  8+ separate frontend repos (brief-asia-web, dtw-web, wad-web, gcv-web,
  wtb-web, asia-awards-web, dailytechwire-web, APCG-web) as future potential
  adopters. BriefAsia is the reference implementation, not the sole target —
  see Requirement C.

### Requirement B — Hero Image Required, All 12 Tenants (deferred; see Out Of
Scope for the full preserved analysis)

The verified three-gate engine analysis, the `required: true` app-layer-not-
DB finding, and the three MUST-RESOLVE items are preserved in the Out Of
Scope section above rather than duplicated here, since this requirement is no
longer part of this SPEC's active scope.

### Known context (recorded for awareness, not actioned by this SPEC)

Two foundational gaps the user was told about and explicitly chose NOT to
bundle into this work (correctly — bundling them in would be its own
patchwork):

- **`apcg-cms` has no `process/context/all-context.md`.** It is the only one
  of the three repos in this product family (`apcg-cms`, `brief-asia-web`,
  `content-engine`) without a durable architecture-map context router. This
  SPEC used `docs/` (`01-business-requirements.md`, `04-modules-and-data-
  model.md`, `13-acceptance-criteria.md`) and `process/development-protocols/`
  in its place. Not a requirement of this SPEC.
- **Neither `apcg-cms` nor `brief-asia-web` has any automated test suite.**
  Both rely on `tsc --noEmit` + lint only, with manual/browser verification
  for behavior. Only `content-engine` (a third, separate repo) has an
  automated test suite (vitest, `vitest.config.ts`). Not a requirement of
  this SPEC.
