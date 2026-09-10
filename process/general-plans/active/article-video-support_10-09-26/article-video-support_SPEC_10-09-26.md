---
name: spec:article-video-support
description: "Video support for BriefAsia-tenant articles — R2-uploaded video, conditional hero replacement on article pages only, static hero everywhere else"
date: 10-09-26
feature: article-video-support
---

# SPEC — Video Support for Articles (BriefAsia Only)

## Summary

Today, articles in this multi-tenant CMS (`apcg-cms`) can only carry a still hero
image, which every one of the 12 tenant websites (including `brief-asia-web`)
renders the same way. BriefAsia's newsroom wants to publish short video clips
(under the news industry's existing file-size limit — 20MB, unchanged) alongside
selected stories, the way any modern news site does for breaking or visual
stories. This SPEC adds that capability for **BriefAsia only** — no other tenant
gets the option, and it can be safely extended to another tenant later purely by
flipping a config switch, without new code.

The reader experience is deliberately narrow and predictable: a video, when
present, **only ever plays on the article's own page**, replacing the hero image
in that one spot. Every other place the article appears on the site — homepage,
section fronts, related-article cards, tag pages, author pages, search results,
RSS, and social share cards — always shows the familiar static hero image, never
a video. This keeps page weight and reader experience uniform on listing pages
while giving individual stories a richer treatment on their own page.

## User Stories / Jobs To Be Done

**Editor side (apcg-cms admin, BriefAsia tenant only)**

- As a BriefAsia editor, I want to upload a short video file directly in the
  article editor, so that a story can carry motion rather than just a photo,
  without leaving the CMS or relying on an external video host.
- As a BriefAsia editor, I want the video field to simply not exist for me if I
  ever work on another tenant's site, so that I never accidentally try to add
  video where it isn't supported.
- As a BriefAsia editor, I want to optionally add a short caption and a
  credit/source line to the video, the same way I already can for images, so
  that attribution and context travel with the clip.
- As a BriefAsia editor, I want to write one short text description of the video
  (like alt text for an image), so that the video isn't a completely opaque,
  inaccessible element for readers using assistive technology.
- As a BriefAsia editor, I want the article's existing hero image to keep working
  exactly as it does today when I don't add a video, so that nothing changes for
  the vast majority of stories that stay photo-only.

**Reader side (brief-asia-web, public site)**

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
- As a reader on any of the other 11 tenant sites, I want my experience to be
  completely unaffected by this feature — it should be invisible to me, both in
  what I see and in how the site performs.

## What The User Wants (Behavioral Outcomes)

- **Editor UI (BriefAsia only):** the article editor shows a new, optional video
  upload field, plus optional caption and credit text fields, and a required
  short text description field for the video. The video upload accepts common
  video file types, stored in the same tenant-scoped cloud storage (R2) media
  already uses, under the same 20MB size ceiling that applies to all uploads
  today. On any other tenant's article editor, none of this exists — not even a
  greyed-out or hidden-but-present field a curious editor could discover.
- **Article page (BriefAsia reader site) — conditional hero:**
  - If the article HAS a video: the hero area on the article page shows the
    video player, with the article's existing hero image displayed as the
    "poster" (the still frame shown before the reader presses play).
  - If the article has NO video: the hero area shows the hero image exactly as
    it does today. Nothing about this case changes.
  - This is the ONLY behavior change to the hero area, and it only ever applies
    on the article's own page.
- **Every listing/preview surface — always static image:** homepage cards,
  pillar/section front cards, related-articles cards, tag-page cards,
  author-page cards, search-result cards, RSS feed entries, and OG/social share
  card images always use the static hero image — never the video, never a
  video-derived thumbnail that behaves like a video, and never an autoplay
  preview. A reader must never see a video start playing, or a video file begin
  downloading, anywhere except by opening the article page and pressing play.
- **No autoplay, no pre-fetch:** the video file itself is not requested by the
  browser until the reader explicitly presses play. Only the poster image (the
  existing hero image, already loaded for the page) is shown up front.
- **Other 11 tenants:** completely unaffected — no new field visible anywhere in
  their admin UI, no behavior change on their public sites, and (see Acceptance
  Criteria + Constraints) the underlying data model change must not let their
  editors accidentally attach a video to their own articles even by direct API
  call.
- **Existing content:** no existing article, on BriefAsia or any other tenant,
  gains a video. Nothing is migrated or backfilled.

## Flow / State Diagram

**Editor flow (BriefAsia only):**

```
BriefAsia editor opens article
        |
        v
  Editor is in BriefAsia tenant? ----No----> Video field does not exist/render
        |                                     (identical to today's editor)
       Yes
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
  Editor saves article  --------------------> Article now has: hero image (as
                                               before) + video + description +
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
      Yes               No               (video never renders here,
       |                 |                never autoplays, never
       v                 v                pre-fetched)
  Hero slot shows    Hero slot shows
  VIDEO PLAYER,      hero image,
  poster = hero      unchanged from
  image, controls     today
  visible, NOT
  autoplaying,
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
  Is tenant X = BriefAsia? ----No----> Video field: invisible in admin UI,
        |                              not settable via API, never present
       Yes                             in that tenant's reader-facing output
        |
        v
  Video feature available per the rules above
```

## Acceptance Criteria (Testable Outcomes)

1. **A BriefAsia editor can upload a video to an article and save it.**
   The video field appears in the BriefAsia article editor, accepts a video file
   under the existing 20MB upload ceiling, and the article saves successfully
   with the video attached.
   `proven by:` manual verification in Payload admin (BriefAsia tenant) — upload
   a video, save, reload, confirm it persists. No automated harness exists for
   apcg-cms admin UI today (package.json exposes only `typecheck`/`lint`).
   `strategy:` Agent-Probe (manual admin walkthrough; no e2e harness in this repo).

2. **No other tenant's editor can see or set the video field.**
   Opening the article editor for any of the other 11 tenants shows no video
   field, no caption/credit-for-video fields, and no video-description field —
   not hidden-via-CSS, genuinely absent. A direct API write attempt from a
   non-BriefAsia tenant context setting the video field is rejected or ignored
   server-side (equivalent to the field not existing for that tenant).
   `proven by:` manual admin walkthrough for at least one non-BriefAsia tenant
   (editor UI) + a direct API/Payload local-API write attempt for a
   non-BriefAsia tenant, confirming rejection or silent no-op (never persisted).
   `strategy:` Agent-Probe — this is the single most important, first-class
   criterion in this SPEC; both the UI path and the API path must be checked,
   not just one.

3. **On the article's own page, a video article shows the video player in the
   hero slot; a non-video article shows the hero image exactly as today.**
   `proven by:` manual browser check on `brief-asia-web` — one article with
   video, one without, confirm the hero slot renders correctly in each case and
   that the non-video article is pixel/behavior-identical to current production
   behavior.
   `strategy:` Agent-Probe (no e2e harness in brief-asia-web per
   `process/context/tests/all-tests.md` — verification is manual/browser only).

4. **On every listing surface, the hero image is always shown — never the
   video, never an autoplaying preview.**
   Checked across: homepage cards, pillar/section front cards, related-articles
   cards, tag-page cards, author-page cards, search results, RSS feed entries,
   and OG/social share card images. This is tested SEPARATELY from criterion 3
   because it is a distinct, explicitly called-out hard requirement — a
   video must never render or autoload outside the article's own page.
   `proven by:` manual browser + view-source/network-tab check on
   `brief-asia-web` for a video-bearing article across each listed surface,
   confirming (a) the rendered element is an `<img>`/static image, not a
   `<video>` element or video-driven thumbnail, and (b) no video byte range is
   requested by the browser on any of these surfaces.
   `strategy:` Agent-Probe.

5. **The video does not autoplay and its file is not pre-fetched.**
   On the article page, before the reader presses play, only the poster
   (existing hero image) has loaded; the browser has not requested the video
   file itself. Full native controls (play/pause, seek, volume, fullscreen)
   are present once the player is visible.
   `proven by:` manual browser network-tab inspection on the article page
   (video article) confirming no video byte request prior to a user-initiated
   play, plus a manual control-by-control check of the player.
   `strategy:` Agent-Probe.

6. **The video poster uses the article's existing hero image; an article with
   a video but no hero image is a known, non-blocking gap.**
   When a video article has a hero image, that image is the poster shown before
   play. When a video article has NO hero image (editorial mistake — see
   Constraints), saving is not blocked; the reader instead sees the browser's
   default behavior (typically the video's own first frame, or a blank box
   until playback starts, depending on browser). This is documented as an
   editorial guideline, not a hard validation rule, for v1.
   `proven by:` manual check with a video + hero image (poster = hero image) and
   a manual check with a video + no hero image (confirm save is NOT blocked and
   note the resulting fallback appearance).
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
   data migration or backfill occurs.**
   `proven by:` before/after count check — total article count and per-article
   video-field state for a sample of pre-existing BriefAsia and non-BriefAsia
   articles is unchanged (video field absent/null) immediately after this
   feature ships, mirroring the migration-parity check pattern already used in
   this repo's acceptance criteria (`docs/13-acceptance-criteria.md` §Migration
   & rollback).
   `strategy:` Fully-Automated where feasible — `tsc --noEmit` (apcg-cms
   `package.json` script `typecheck`) must pass with the new field as a purely
   additive, optional/nullable schema change; combined with a manual spot-check
   count.

10. **The 20MB upload size ceiling is unchanged for video (and for every other
    upload type).**
    `proven by:` manual check — attempt to upload a video file over 20MB and
    confirm it is rejected the same way an oversized image is rejected today;
    confirm `payload.config.ts` `upload.limits.fileSize` value is unchanged
    from before this feature.
    `strategy:` Agent-Probe + a direct config-diff check (`git diff
    payload.config.ts` showing no change to `upload.limits.fileSize`).

11. **Both repos' existing quality gates stay green.**
    `proven by:` `tsc --noEmit` and `next lint` in `apcg-cms` (per
    `package.json` scripts `typecheck`/`lint`); `npm run typecheck` and `npm run
    lint` in `brief-asia-web` (per `process/context/tests/all-tests.md`).
    `strategy:` Fully-Automated.

## Out Of Scope

- Raising the 20MB upload size limit — explicitly rejected by the user; stays
  as-is for video and every other upload type.
- YouTube, Vimeo, or any embed-URL / iframe-embed field for video — explicitly
  rejected by the user. Video is uploaded-file-only, stored on R2.
- Video transcoding, adaptive bitrate streaming, or multiple video renditions —
  not built. Whatever file the editor uploads (under 20MB) is what's served.
- Automatic thumbnail/poster generation from the video file — the media
  pipeline (`sharp`) is image-only and cannot transcode; the poster is always
  the article's existing hero image (or the browser's own fallback if no hero
  image exists — see Acceptance Criterion 6).
- Enabling video for any tenant other than BriefAsia. The mechanism must be
  config-toggleable per tenant for the future, but no other tenant is turned on
  as part of this work.
- Subtitle/caption TRACK files (`.vtt`) and full video transcripts — deferred
  (see Open Questions / Constraints — this is a conscious v1 tradeoff against
  the site's stated WCAG 2.1 AA accessibility goal, recorded here so it is not
  quietly dropped).
- Video playback anywhere except the article's own page hero slot — never on
  listing surfaces, never inline in the article body, never as a background/
  autoplay element.
- Migrating or backfilling any existing article with a video.
- Changing the two public API route handlers
  (`/api/public/articles/[slug]/route.ts`, `/api/public/articles/route.ts`) to
  actively strip the video field from non-BriefAsia tenants' JSON output — the
  field being present-but-always-empty for those 11 tenants is an accepted,
  deliberate outcome (see Constraints).
- Choosing *how* the video field is modeled (new dedicated collection vs.
  extending `Media` vs. another shape) and *how* field-level tenant gating is
  enforced — these are INNOVATE/PLAN decisions, not fixed here. This SPEC
  records the cross-collection mimetype-contamination risk as a constraint the
  chosen approach must respect, not as a solution.

## Constraints

- **Tenant scope (hard):** the feature is BriefAsia-only. It must be
  implementable as a config/feature toggle so a future tenant can be enabled
  without a code change (mirrors the existing `FEATURE_KEYS` /
  `Tenants.features` pattern used for other per-tenant modules, e.g.
  `newsletters`, `podcasts`, `marketData`).
- **Storage (hard):** video files are uploaded directly to Cloudflare R2, the
  same object storage already used for `Media`. No third-party video host, no
  embed URL field.
- **Size (hard):** the existing `payload.config.ts` `upload.limits.fileSize`
  value is NOT raised. Video, like every other upload, must fit under 20MB.
- **Cross-collection mimetype contamination (recorded risk, not solved here):**
  Payload validates upload mimetypes at the collection level, not per
  relationship field. Widening any existing upload collection's accepted
  mimetypes to include `video/*` would make every field pointing at that
  collection accept video — including `Articles.heroImage` and `Tenants.logo`,
  across all 12 tenants (Payload GitHub Discussion #653 — no field-level
  mimetype restriction exists upstream). Whatever approach INNOVATE/PLAN
  chooses must not let a non-video field (e.g. `heroImage`, tenant `logo`)
  silently start accepting video uploads for ANY tenant, including BriefAsia's
  own other upload fields.
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
  present-but-empty in the JSON response for the other 11 tenants' articles.
  This is accepted as the simpler, smaller-blast-radius option — not an
  oversight.
- **Non-localized field precedent:** `Articles.heroImage` is `type: "upload"`,
  NOT localized. The closest precedent for adding a single non-localized field
  to `Articles` incrementally is `src/migrations/20260824_000000_add_exclusive_flag.ts`
  (`exclusive` checkbox) — ALTER TABLE on `articles` AND `_articles_v`, plus
  indexes. A localized field would instead need `articles_locales` /
  `_articles_v_locales` — materially heavier. This SPEC does not mandate
  non-localization for the new field(s), but flags that a localized shape has a
  real cost that INNOVATE/PLAN should weigh.
- **Manual cross-repo type sync (recorded risk with an owning step):**
  `brief-asia-web/src/payload/payload-types.ts` is a Payload-generated file
  manually copied from `apcg-cms` — there is no automated sync and
  `brief-asia-web`'s `package.json` has no `generate:types` script. Any new
  field added in `apcg-cms` will NOT automatically appear in
  `brief-asia-web`'s types. **Owning step:** whichever plan implements this
  feature must include an explicit step to regenerate `apcg-cms`'s
  `payload-types.ts` and manually re-copy the updated file into
  `brief-asia-web/src/payload/payload-types.ts` before the reader-side
  (`cms-client.central.ts` → `central-api.ts` → `toArticleView()` →
  `article-content.tsx`) rendering work can typecheck. This must not be
  silently assumed to "just happen."
- **Reader chain (informational, not prescriptive):** the reader-side rendering
  path is `cms-client.central.ts` → `central-api.ts` → `Article` type in
  `payload-types.ts` → `toArticleView()` (`article-view.ts:229`, hero handling
  around lines 242, 332-335) → `article-content.tsx` (hero `<figure>`, hardcoded
  16:9 box around lines ~508-551). INNOVATE/PLAN will decide the exact
  implementation shape; this SPEC only fixes the observable behavior at each
  point in that chain.
- **Branch:** all work happens on `claude/tender-ptolemy-njgwwt` in both
  `apcg-cms` and `brief-asia-web`.
- **Test gates (existing, unchanged by this feature):**
  - `apcg-cms`: `npm run typecheck` (`tsc --noEmit`), `npm run lint` (`next
    lint`) — no automated test runner exists in this repo.
  - `brief-asia-web`: `npm run typecheck`, `npm run lint` — no automated test
    runner exists in this repo either (`process/context/tests/all-tests.md`);
    all UI/behavioral verification is manual/browser-based.

## Open Questions

None. All open questions from RESEARCH were resolved by the user in this
session (verdict: 1A, 2A-with-refinement, 3A, 4A, 5A, 6A, 7A — captured
verbatim in the sections above). No items remain open for PLAN.

## Background / Research Findings

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

**User decisions captured verbatim this session:**

- Q1 (public API visibility): **A** — accept field present-but-empty for the
  other 11 tenants; do not change the two public route handlers; recorded as a
  deliberate simplicity/blast-radius decision, not an oversight.
- Q2 (hero placement): **A, with mandatory refinement** — the hero slot is
  CONDITIONAL: video only ever replaces the hero on the article's own page when
  a video is present; every listing surface (home, pillar/section fronts,
  related articles, tag pages, author pages, search results, RSS, OG/social
  cards) ALWAYS shows the static hero image, never video. Written as two
  separate, separately-testable acceptance criteria (3 and 4) per explicit user
  instruction.
- Q3 (poster): **A** — reuse the existing hero image as the video poster; no
  separate poster-upload field in v1; an article with video but no hero image
  is a known gap, handled as an editorial guideline, not a blocking validation
  (Acceptance Criterion 6).
- Q4 (autoplay): **A** — no autoplay, full native controls, no pre-fetch of the
  video body (poster image only loads up front); rationale: protect readers on
  slow mobile connections in Asia from unrequested data usage.
- Q5 (caption/credit): **A** — optional `caption` and `credit` fields for
  video, mirroring existing `Media` fields; neither required.
- Q6 (accessibility v1): **A** — required short text description
  (alt-text-equivalent) only; no `.vtt` subtitle track, no transcript in v1;
  explicitly recorded in Out Of Scope as a conscious v1 tradeoff against the
  site's WCAG 2.1 AA goal, to be picked up later rather than quietly dropped.
- Q7 (existing data / other tenants): **A** — no data migration, no existing
  article gains a video, other 11 tenants see no video field anywhere in their
  admin editing UI.
