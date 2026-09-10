---
name: spec:article-video-support
description: "Video support for BriefAsia-tenant articles (R2 upload, conditional hero replacement) PLUS a separately-scoped, higher-risk requirement making Articles.heroImage mandatory for all 12 tenants, including engine intake"
date: 10-09-26
feature: article-video-support
---

# SPEC — Video Support for Articles (BriefAsia Only) + Hero Image Required (All Tenants)

> **Structural note:** this SPEC now bundles TWO requirements with different blast
> radii, at the user's explicit direction. **Requirement A (Video)** is
> BriefAsia-tenant-only. **Requirement B (Hero Image Required)** is a
> newly-added, separately-scoped, higher-risk requirement that touches all 12
> tenants and the engine intake API. Every section below keeps the two
> requirements in clearly separated subsections — their acceptance criteria,
> constraints, and out-of-scope items are never blended.

## Summary

**Requirement A — Video (BriefAsia only):** BriefAsia's newsroom wants to
publish short video clips (under the existing 20MB upload ceiling, unchanged)
alongside selected stories. This SPEC adds that capability for BriefAsia only —
no other tenant gets the option, and it can be extended to another tenant later
purely by a config toggle. On the article's own page, a video (when present)
replaces the hero image in the hero slot; every listing/preview surface across
the site always shows the static hero image, never a video.

**Requirement B — Hero Image Required, all 12 tenants (NEW, user-added this
session):** The user has decided, twice-reaffirmed with full knowledge of the
consequences, that `Articles.heroImage` becomes **REQUIRED for every article,
on every one of the 12 tenants**, including articles created through the
engine intake API. This is recorded here as a deliberate, informed decision —
**not an oversight, and this SPEC does not re-argue it.** It is a materially
different, higher-risk change from Requirement A: it touches every tenant, an
external-facing API contract that upstream content engines depend on, and
existing production data. It carries its own acceptance criteria, its own
constraints, and its own must-resolve pre-conditions, tracked separately from
the video feature throughout this document.

## User Stories / Jobs To Be Done

### Requirement A — Video (BriefAsia only)

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
- As a reader on any of the other 11 tenant sites, I want the VIDEO feature
  specifically to be completely invisible to me — no video ever appears or is
  offered on my site.

### Requirement B — Hero Image Required (all 12 tenants, NEW)

- As a System Admin, I want every article across every tenant to carry a hero
  image, so that no article is ever missing the visual identity every reader
  expects on a card, a share link, or the article page itself.
- As an editor on ANY tenant, when I open an existing article that has no hero
  image (created before this rule existed) to fix a typo, I understand I will
  be asked to add a hero image before I can save — even though I only meant to
  fix the typo.
- As the upstream content engine integration, when the hero image URL I sent
  fails to fetch (dead link, slow/failing image host, transient network fault),
  I need a predictable, decided server response (not a silent "publish without
  hero" as happens today), so my retry logic (or my operators) can react
  correctly instead of assuming success. (Verified from the `content-engine`
  source, `/home/user/content-engine`: three independent upstream gates drop
  any engine-originated article that lacks a hero image before it is ever
  written to the `articles` table, so an engine-published article reaching
  Central with a null hero is not possible via any code path — see Behavioral
  Outcomes and Constraints for the verified detail.)
- As a business stakeholder responsible for the engine pipeline, I want the
  tradeoff between "never lose an article to a transient image-fetch glitch"
  and "never publish an article with no hero" made explicit and deliberately
  chosen, not left as an accidental side effect of a validation flag.

## What The User Wants (Behavioral Outcomes)

### Requirement A — Video (BriefAsia only)

- **Editor UI (BriefAsia only):** the article editor shows a new, optional video
  upload field, plus optional caption and credit text fields, and a required
  short text description field for the video. The video upload accepts common
  video file types, stored in the same tenant-scoped cloud storage (R2) media
  already uses, under the same 20MB size ceiling that applies to all uploads
  today. On any other tenant's article editor, none of this exists — not even a
  greyed-out or hidden-but-present field a curious editor could discover.
- **Article page (BriefAsia reader site) — conditional hero:**
  - If the article HAS a video: the hero area on the article page shows the
    video player, with the article's hero image displayed as the "poster" (the
    still frame shown before the reader presses play).
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
  hero image, already loaded for the page) is shown up front.
- **Other 11 tenants, regarding the VIDEO feature specifically:** unaffected —
  no new video field visible anywhere in their admin UI, no video behavior
  change on their public sites. (See Requirement B immediately below for a
  SEPARATE change that DOES affect all 12 tenants — this is no longer a
  blanket "other tenants unaffected" claim once Requirement B is included.)
- **Existing content (video):** no existing article, on BriefAsia or any other
  tenant, gains a video. Nothing about video is migrated or backfilled.

### Requirement B — Hero Image Required (all 12 tenants, NEW)

- `Articles.heroImage` becomes a required field for every article, on every
  tenant, for every write path: the admin UI, any direct/local API write, and
  the engine intake API.
- **Editor UI, any tenant:** attempting to save an article (new or existing)
  without a hero image is blocked with a clear validation error, the same way
  any other required field is enforced today. This applies even to an editor
  who only intended to change an unrelated field on an old article.
- **Engine intake API — two distinct sub-cases, weighted differently, now
  grounded in `content-engine` source (`/home/user/content-engine`, a third
  repo now in scope for reading — see Constraints):**
  - **Missing `heroImageUrl` entirely.** In `apcg-cms`, `route.ts:145` treats
    it as optional and `route.ts:191-192` only calls `uploadHero()` when a
    value is present — the CMS itself does not enforce a hero at intake.
    **Verified upstream (not just claimed):** the engine has its own policy
    gate, `src/jobs/editorial-job.ts:279-288`, which drops an image-less raw
    article BEFORE any AI processing spend, with the comment: *"Policy: a
    published article must have a hero image. Drop image-less raws upfront —
    BEFORE any Claude spend — since the ingest og:image fallback has already
    run, so a null here means no image could be found at all."* This is the
    FIRST of three independent gates, and it is not the only one:
    - **Gate 1** (`editorial-job.ts:279-288`, above) — no `hero_image_url` on
      the raw article at all → `filtered_out`, `filter_reason: 'no hero
      image'`, dropped before any AI spend.
    - **Gate 2** (`editorial-job.ts:556-575`, `prepareHeroImage`) — the
      resolve → fetch → validate → resize → min-width pipeline fails to
      produce a usable image → logs `'editorial: no usable hero image —
      dropping article (policy)'`, `filter_reason: 'no usable hero image
      (<reason>)'`, article dropped. The code comment states this directly:
      *"A null here is the exact same drop the pipeline always took for an
      unusable hero."*
    - **Gate 3** (`editorial-job.ts:907-926`, `storePreparedHero`) — the
      already-validated image fails to write to Supabase Storage → logs
      `'hero image upload failed (storage) — dropping article'`,
      `filtered_out`, article dropped.
    The article row is only ever inserted into `articles` AFTER all three
    gates pass, and `hero_image_url` is written as `heroPublicUrl`
    (`editorial-job.ts:975`) — `upload.publicUrl`, reachable only on Gate 3's
    success path. **Verified: there is no other write of `hero_image_url` on
    the published-articles path** — the `?? null` occurrences elsewhere in
    the file operate on the RAW article's URL during credit extraction, not
    on the row that gets published. **Conclusion, stated as verified fact:
    no code path exists by which an engine-published article reaches Central
    with a null hero.** A rejection at Central triggered by a missing
    `heroImageUrl` is therefore not a residual risk to design around — it is
    eliminated for engine-originated content by these three gates.
  - **`heroImageUrl` present but the fetch fails inside Central**
    (`route.ts:507-508` fetches the URL and throws on a non-ok response; the
    `catch` at `route.ts:520-523` today logs `"hero upload failed —
    publishing without hero"`, returns `undefined`, and the article is
    created anyway). This remains a **live, first-class risk** — with hero
    required, this resilience path becomes a hard failure, so a transient
    image-fetch error now costs the entire article, not just its image.
    **Re-weighted (not softened) by the same upstream finding:** because the
    URL Central fetches is the engine's own Supabase Storage bucket rather
    than an arbitrary third-party news CDN, the likelihood of this fetch
    failing is lower than initially assumed — but a decided behaviour is
    still required, and this sub-case is now the MORE important of the two to
    get right (see Constraints → MUST-RESOLVE (b)).
  - Deciding what the CMS does in each of these two sub-cases — and whether
    they should resolve to the same decided behaviour or two different ones —
    is an explicit MUST-RESOLVE decision this SPEC does NOT make (see
    Constraints → Requirement B → "Intake Failure Path — Undecided"), weighted
    toward the failed-fetch case as the more important half to get right.
- **Existing data:** rows that already have a null hero image are NOT deleted
  or blocked from being read — they simply become **unsaveable** until an
  editor adds a hero image. Whether this is an acceptable rollout risk depends
  entirely on how many such rows exist, which nobody in this session can
  determine (see Constraints → Requirement B → "Pre-Flight NULL Count —
  Gating Pre-Condition").

## Flow / State Diagram

### Requirement A — Video (BriefAsia only)

**Editor flow:**

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

**Cross-tenant isolation (video feature only, always true):**

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

### Requirement B — Hero Image Required (all 12 tenants, NEW)

**Editor save flow (any tenant):**

```
Editor saves an article (new or existing, ANY tenant)
        |
        v
  Does the article have a heroImage set? ----No----> Save BLOCKED,
        |                                             validation error shown,
       Yes                                            editor must add a hero
        |                                             image before saving
        v                                             ANYTHING (even an
  Save succeeds                                       unrelated field).
```

**Engine intake flow (decision NOT made in this SPEC — see Constraints):**

```
Engine POSTs article to intake API
        |
        v
  Request includes heroImageUrl? ----No-----> [UNDECIDED — see Constraints:
        |                                      may differ from the "fetch
       Yes                                     failed" case below]
        |
        v
  Attempt to fetch + upload hero image
        |
        v
  Fetch/upload succeeds? ----No----> [UNDECIDED — three options on record:
        |                             (1) 5xx, engine retries later
       Yes                            (2) 4xx terminal, article dropped
        |                             (3) per-tenant placeholder image
        v                             — INNOVATE/PLAN chooses, not this SPEC]
  Article created with hero image
  attached (existing happy path,
  unchanged)
```

**Pre-flight gating check (must happen before this ships — see Constraints):**

```
Before Requirement B ships:
        |
        v
  Count heroImage IS NULL across all 12 tenants
  (published rows + draft rows + _articles_v version rows)
        |
        v
  Count is small? ----No (large)----> STOP — this SPEC does not authorize
        |                              shipping as-is; return to PLAN for a
       Yes                             backfill plan or phased rollout
        |
        v
  Proceed with Requirement B as specified
```

## Acceptance Criteria (Testable Outcomes)

### Requirement A — Video (BriefAsia only)

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
   criterion for Requirement A; both the UI path and the API path must be
   checked, not just one.

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

6. **The video poster always uses the article's hero image — the "no hero
   image" gap is superseded and removed by Requirement B.**
   Because Requirement B (below) makes `heroImage` required for every article
   on every tenant, a BriefAsia article can no longer be saved with a video but
   without a hero image — saving the video requires re-saving the article,
   which now also requires the hero image to be present. This criterion
   therefore SUPERSEDES the previous "known gap" version of AC6 (no-hero
   fallback behavior): as long as Requirement B is in force, every video
   article has a hero image, and that hero image is always the poster.
   `proven by:` manual check — save a video on an article that already has a
   hero image and confirm that image is the poster; separately, confirm that
   attempting to save a video on an article with no hero image is blocked by
   Requirement B's required-field validation, not by any video-specific logic.
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

11. **Both repos' existing quality gates stay green (video feature).**
    `proven by:` `tsc --noEmit` and `next lint` in `apcg-cms` (per
    `package.json` scripts `typecheck`/`lint`); `npm run typecheck` and `npm run
    lint` in `brief-asia-web` (per `process/context/tests/all-tests.md`).
    `strategy:` Fully-Automated.

### Requirement B — Hero Image Required (all 12 tenants, NEW)

12. **`heroImage` is required for every article, on every tenant, for every
    write path.**
    A new article cannot be created, and an existing article cannot be saved,
    via the admin UI or a direct/local API write, without a hero image set —
    regardless of tenant.
    `proven by:` manual check in Payload admin for at least two different
    tenants (BriefAsia + one other) — attempt to save an article with no hero
    image (expect validation block) and with one set (expect success); plus a
    direct local-API write attempt confirming the same enforcement outside the
    admin UI.
    `strategy:` Agent-Probe.

13. **An editor cannot save ANY existing article — even for an unrelated
    change — without a hero image.**
    Opening a pre-existing article that currently has no hero image and
    attempting to save any change (e.g. a typo fix) is blocked until a hero
    image is added.
    `proven by:` manual check — locate (or construct, in a test/staging
    context) an article with a null hero image, attempt a trivial save, confirm
    it is blocked with a clear validation message referencing the hero image
    field.
    `strategy:` Agent-Probe.

14. **The engine intake API handles a hero-less article per the decided
    behaviour (decision owned by INNOVATE/PLAN, not this SPEC).**
    Once INNOVATE/PLAN selects one of the three recorded options (5xx-retry,
    4xx-terminal, or per-tenant placeholder — see Constraints), the intake
    route behaves accordingly and predictably for: (a) a request with no
    `heroImageUrl` at all, and (b) a request with a `heroImageUrl` that fails to
    fetch/upload. These two cases may resolve to different decided behaviours;
    this SPEC does not require them to be the same.
    `proven by:` manual/integration check against the engine intake route with
    (a) a payload omitting `heroImageUrl` and (b) a payload with an
    unreachable/invalid `heroImageUrl`, confirming the response code and
    article-creation outcome match whatever behaviour INNOVATE/PLAN selects.
    `strategy:` Agent-Probe (this criterion cannot be marked "provable" in
    concrete terms until the behaviour is chosen downstream — recorded here so
    it is not forgotten, not because it is already testable today).

15. **The pre-flight NULL-heroImage count was actually run, and its gating
    decision was honored, before this requirement shipped.**
    Before Requirement B goes live, someone with database access has counted
    `heroImage IS NULL` across all 12 tenants, across published rows, draft
    rows, and `_articles_v` version rows, and that count fed a go/no-go
    decision: small count → proceed as specified; large count → this SPEC does
    NOT authorize shipping as-is, and the work returns to PLAN for a backfill
    or phased rollout.
    `proven by:` a recorded count (with methodology: which tables, which
    tenants, published+draft+versions) attached to the plan or execute report
    before EXECUTE begins on Requirement B, plus explicit sign-off on which
    branch (proceed vs. return-to-PLAN) was taken.
    `strategy:` Agent-Probe / process gate — this is a pre-condition check, not
    a code-behavior check; no automated test can substitute for confirming a
    human actually ran the count.

## Out Of Scope

### Requirement A — Video (BriefAsia only)

- Raising the 20MB upload size limit — explicitly rejected by the user; stays
  as-is for video and every other upload type.
- YouTube, Vimeo, or any embed-URL / iframe-embed field for video — explicitly
  rejected by the user. Video is uploaded-file-only, stored on R2.
- Video transcoding, adaptive bitrate streaming, or multiple video renditions —
  not built. Whatever file the editor uploads (under 20MB) is what's served.
- Automatic thumbnail/poster generation from the video file — the media
  pipeline (`sharp`) is image-only and cannot transcode; the poster is always
  the article's hero image (guaranteed to exist once Requirement B ships — see
  Acceptance Criterion 6).
- Enabling video for any tenant other than BriefAsia — the mechanism must be
  config-toggleable per tenant for the future, but no other tenant is turned on
  as part of this work. (This remains true and is NOT affected by Requirement
  B — Requirement B changes hero-image requiredness for all tenants, it does
  not enable video for anyone but BriefAsia.)
- Subtitle/caption TRACK files (`.vtt`) and full video transcripts — deferred
  (see Constraints — this is a conscious v1 tradeoff against the site's stated
  WCAG 2.1 AA accessibility goal, recorded here so it is not quietly dropped).
- Video playback anywhere except the article's own page hero slot — never on
  listing surfaces, never inline in the article body, never as a background/
  autoplay element.
- Migrating or backfilling any existing article with a video.
- Changing the two public API route handlers
  (`/api/public/articles/[slug]/route.ts`, `/api/public/articles/route.ts`) to
  actively strip the video field from non-BriefAsia tenants' JSON output — the
  field being present-but-always-empty for those 11 tenants is an accepted,
  deliberate outcome.
- Choosing *how* the video field is modeled (new dedicated collection vs.
  extending `Media` vs. another shape) and *how* field-level tenant gating is
  enforced — these are INNOVATE/PLAN decisions. This SPEC records the
  cross-collection mimetype-contamination risk as a constraint the chosen
  approach must respect, not as a solution.

### Requirement B — Hero Image Required (all 12 tenants, NEW)

**Note:** unlike Requirement A, this requirement is explicitly NOT scoped to
"no change for the other 11 tenants" — it changes required-field behaviour for
ALL 12 tenants and the engine intake API by design. The items below are things
that are still out of scope even within this all-tenant change:

- **Choosing the intake failure-path behaviour** (5xx-retry vs. 4xx-terminal
  vs. per-tenant placeholder image) — recorded as a MUST-RESOLVE decision for
  INNOVATE/PLAN (see Constraints). The orchestrator's leaning (5xx + retry) is
  noted for reference only and is NOT a decision made by this SPEC.
- **Running the pre-flight NULL-heroImage count itself** — this SPEC requires
  it as a gating precondition (Acceptance Criterion 15) but does not compute
  the number; nobody in this session has database credentials.
- **Backfilling any existing hero-less article** — only in scope as a
  follow-up plan, and only if the pre-flight count (above) turns out to be
  large enough to require it. Not assumed to be needed, not assumed to be
  unnecessary.
- **Building a per-tenant placeholder image system** — only relevant if
  INNOVATE/PLAN selects that option for the intake failure path; not built
  speculatively here.
- **The 5-artifact high-risk evidence pack itself** (see Constraints) — this
  SPEC requires it to exist before the work is treated as ready, but producing
  it is an EXECUTE-adjacent step, not a SPEC deliverable.

## Constraints

### Requirement A — Video (BriefAsia only)

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
  field added in `apcg-cms` (this applies to BOTH Requirement A's new video
  field(s) AND Requirement B's `heroImage.required` change) will NOT
  automatically appear/apply in `brief-asia-web`'s types. **Owning step:**
  whichever plan implements this feature must include an explicit step to
  regenerate `apcg-cms`'s `payload-types.ts` and manually re-copy the updated
  file into `brief-asia-web/src/payload/payload-types.ts` before the
  reader-side (`cms-client.central.ts` → `central-api.ts` → `toArticleView()`
  → `article-content.tsx`) rendering work can typecheck. This must not be
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

### Requirement B — Hero Image Required (all 12 tenants, NEW) — MUST-RESOLVE items

> The user was shown both consequences below in plain language and chose this
> requirement anyway, twice-reaffirmed. It is recorded here as deliberate and
> informed. **This SPEC does not re-argue the decision.** The three items below
> are things the decision creates that still need resolving downstream — they
> are pre-conditions and open engineering decisions, not challenges to the
> decision itself.

**(a) Pre-flight NULL-heroImage count — the ONLY substantive open risk in
Requirement B, and it is unchanged.**
Payload enforces `required` at write time, not on existing rows. Existing
articles with a null hero stay in the database but become **unsaveable**: an
editor who opens one to fix a typo cannot save it until they add a hero image.
Before ANY of Requirement B ships, someone with database access MUST count
`heroImage IS NULL` across all 12 tenants — published rows, draft rows, AND
`_articles_v` version rows. **Nobody in this session has database credentials,
so this SPEC cannot state that number.** Reading the `content-engine` source
does NOT bound this number: the engine's three upstream gates (Behavioral
Outcomes) mean no NEW engine-originated null-hero article can reach Central,
but **legacy migrated content predates this pipeline entirely and is not
covered by any of the three gates** — those rows may already carry a null
hero today, independent of engine behaviour. With the engine-side risk
eliminated (see Gates 1–3), this pre-flight count is now the single gating
item standing between Requirement B and shipping. This is written as an
explicit pre-condition with a decision point (see Acceptance Criterion 15 and
the Pre-flight flow diagram above): if the count is small, proceed as
specified; if it is large, the plan must come back for a backfill or a
phased rollout before Requirement B ships broadly.

**(b) The intake failure path needs a decided behaviour — NOT decided here.**
With hero required, `uploadHero()` returning `undefined` must do *something*.
The route's own header comment documents its contract as "5xx for transient
faults (engine retries), 4xx terminal." Three options are on record; INNOVATE/
PLAN chooses among them, this SPEC does not:
  - **5xx** — treat a hero-fetch failure as a transient fault so the engine's
    existing retry logic re-attempts later. Fits the route's documented
    retry-safe contract.
  - **4xx terminal** — drop the article outright; the engine does not retry.
  - **Per-tenant placeholder image** — substitute a fallback image so the
    article is still created.
  The orchestrator's leaning, for the record only: **5xx + retry**, because
  permanently losing an article is the worst outcome and the endpoint is
  already built to be retried.
  **Re-weighted twice after reading `content-engine` source directly, final
  state:** the missing-`heroImageUrl` sub-case is now **eliminated, not just
  low-likelihood** — the engine's three independent upstream gates (Gates
  1–3, see Behavioral Outcomes) mean no engine-published article can ever
  arrive at Central without a `heroImageUrl`. The failed-fetch sub-case is
  the ONLY sub-case that still needs a decided behaviour, and it too is
  **low-likelihood, defensive rather than expected**: Central fetches from
  the engine's own Supabase Storage bucket, and Gate 3 already confirmed that
  exact object was written successfully before the engine ever sent the URL
  to Central — so the fetch targets a URL known to have existed at write
  time, not an arbitrary third-party link. A decided behaviour is still
  required for correctness (defensive coding against transient network
  faults), but it should be built and tested as a rare defensive path, not a
  frequently-hit branch (see Acceptance Criterion 14).

**(c) Risk class escalation — public API contract change, all 12 tenants.**
This requirement changes the behaviour of a public API contract
(`/api/engine/intake`) that external content engines depend on, across all 12
tenants, not just BriefAsia. Per `process/development-protocols/
orchestration.md` §High-Risk Execution Handoff, "public API contract changes"
is an explicitly named high-risk class. The manual-first 5-artifact evidence
pack required by that section (see `vc-risk-evidence-pack`) MUST be produced
before this requirement's implementation is treated as ready for finalize or
review closure. This is a process requirement carried forward into PLAN/
VALIDATE/EXECUTE, not something this SPEC produces itself. **Unchanged** by
the content-engine findings above.

**(d) `content-engine` is now a third repo in scope for reading.** Path:
`/home/user/content-engine`. Unlike `apcg-cms` and `brief-asia-web` (both
`tsc --noEmit` + lint only, no automated test suite — see Constraints →
Requirement A), `content-engine` DOES have an automated test suite (vitest,
`vitest.config.ts`). This is relevant only if a future INNOVATE/PLAN decision
requires an engine-side change (e.g. the engine sending a different signal on
a Central-side hero-fetch failure) — no engine-side code change is in scope
for this SPEC's Requirement A or B as currently written; `content-engine` was
read for verification only. See Background for two engine-repo findings
recorded for awareness but explicitly out of scope for this work.

## Open Questions

None requiring a return to the user in this session. The user has made the
underlying product decision for both requirements (video scope + hero-required
scope), twice-reaffirmed for Requirement B with full knowledge of the stated
consequences.

The three items under Requirement B → Constraints — (a) pre-flight NULL count,
(b) intake failure-path choice, (c) risk-class evidence pack — are **carried
forward as explicit MUST-RESOLVE pre-conditions and downstream decisions**,
not as open questions blocking this SPEC. They are engineering/process
decisions and a data-dependent gating check, not ambiguity about what the user
wants. They are owned by, respectively: (a) whoever has DB access, at PLAN/
EXECUTE time; (b) INNOVATE; (c) the orchestrator's high-risk handoff process
at EXECUTE readiness.

## Background / Research Findings

### Requirement A — Video (BriefAsia only)

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

**User decisions captured verbatim this session (Requirement A):**

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
- Q3 (poster): **A** — reuse the hero image as the video poster; no separate
  poster-upload field in v1. (Originally recorded with a "no hero image" known
  gap; that gap is now superseded by Requirement B — see Acceptance
  Criterion 6.)
- Q4 (autoplay): **A** — no autoplay, full native controls, no pre-fetch of the
  video body (poster image only loads up front); rationale: protect readers on
  slow mobile connections in Asia from unrequested data usage.
- Q5 (caption/credit): **A** — optional `caption` and `credit` fields for
  video, mirroring existing `Media` fields; neither required.
- Q6 (accessibility v1): **A** — required short text description
  (alt-text-equivalent) only; no `.vtt` subtitle track, no transcript in v1;
  explicitly recorded in Out Of Scope as a conscious v1 tradeoff against the
  site's WCAG 2.1 AA goal, to be picked up later rather than quietly dropped.
- Q7 (existing data / other tenants, video): **A** — no data migration, no
  existing article gains a video, other 11 tenants see no video field anywhere
  in their admin editing UI.

### Requirement B — Hero Image Required (all 12 tenants, NEW)

- **New user decision, twice-reaffirmed with full knowledge of consequences:**
  `Articles.heroImage` becomes required for every article, on every tenant,
  including engine-intake-created articles. The user's two stated consequences
  were checked against source across two rounds of correction and now stand
  as follows:
  1. **CMS enforcement at intake, and the engine's own upstream policy
     (verified from source, corrected across two rounds to its final,
     accurate state):** `apcg-cms`'s `route.ts:145` treats `heroImageUrl` as
     optional and `route.ts:191-192` only calls `uploadHero()` when present —
     Central does not itself enforce a hero at intake. The engine does,
     however, via **three independent upstream gates**, all verified directly
     from `content-engine` source (`/home/user/content-engine`):
     Gate 1 (`editorial-job.ts:279-288`) drops a raw article with no
     `hero_image_url` before any AI spend; Gate 2 (`editorial-job.ts:556-575`,
     `prepareHeroImage`) drops it if the resolve/fetch/validate/resize
     pipeline can't produce a usable image; Gate 3
     (`editorial-job.ts:907-926`, `storePreparedHero`) drops it if the
     validated image fails to write to Supabase Storage. The published
     article row is only inserted after all three pass, with
     `hero_image_url: heroPublicUrl` (`editorial-job.ts:975`) reachable only
     on Gate 3's success path — verified to be the only write of
     `hero_image_url` on the published-articles path. **Net effect, stated as
     verified fact: no code path exists by which an engine-published article
     reaches Central with a null hero — this consequence is eliminated for
     engine-originated content, not merely low-likelihood.** (An earlier
     draft of this SPEC cited a stale comment in `image-uploader.ts` as
     evidence of an open "manual sourcing" fallback path; that comment does
     not match its own call site and has been removed — see the two Background
     findings below, recorded for awareness only.)
  2. **`uploadHero()`'s resilience path (kept, now correctly weighted as
     low-likelihood/defensive):** `uploadHero()`
     (`src/app/api/engine/intake/route.ts:498-523`, fetch at `:507-508`,
     catch at `:520-523`) currently has a deliberate resilience path — catch
     fetch failure, log `"hero upload failed — publishing without hero"`,
     return `undefined`, create the article anyway — which becomes a hard
     failure once hero is required, so a transient image-fetch error will now
     cost the whole article rather than just its image. This is the ONLY
     remaining live path for Requirement B's consequence 2, and it is
     defensive rather than expected: Central fetches from the engine's own
     Supabase Storage bucket, and Gate 3 already confirmed that exact object
     was written successfully before the URL was ever sent to Central. A
     decided behaviour is still required for correctness, but INNOVATE/PLAN
     should treat it as a rare defensive branch, not a frequently-hit one.
- This requirement is recorded as a **separate, higher-risk requirement** from
  Requirement A because its blast radius is all 12 tenants plus an
  external-facing API contract, versus BriefAsia-only for the video feature.
  Per `process/development-protocols/orchestration.md` §High-Risk Execution
  Handoff, "public API contract changes" triggers the manual-first 5-artifact
  evidence pack requirement before this work is treated as ready.
- **Two findings recorded for awareness, explicitly OUT OF SCOPE for this
  work:**
  1. **Stale comment in the engine repo.** `src/editorial/image-uploader.ts:159`
     and `:229` describe a null-hero fallback ("let team source manually")
     that its caller (`editorial-job.ts`'s three gates, above) does not
     implement — every one of the three gates drops the article instead. The
     comment is misleading and was the source of an earlier drafting error in
     this SPEC. Worth a one-line fix in `content-engine`, but that is a
     separate change, not part of this SPEC.
  2. **Silent drops are observable, if anyone wants to quantify them.** The
     engine records every image-related drop on `raw_articles` as
     `status: 'filtered_out'` with `filter_reason` of `'no hero image'` or
     `'no usable hero image (<reason>)'`, plus an `error_log` of
     `{stage: 'image', reason, message}`. These rows are queryable in the
     engine's Supabase and would quantify how much content is being lost to
     image problems upstream. Useful operational context; not a requirement
     of this SPEC.
