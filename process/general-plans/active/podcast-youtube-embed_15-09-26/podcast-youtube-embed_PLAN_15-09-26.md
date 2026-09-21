---
name: plan:podcast-youtube-embed
description: "YouTube-embedded podcasts — required youtubeUrl on apcg-cms Podcasts collection, click-to-load nocookie embed on brief-asia-web reader"
date: 15-09-26
feature: general
metadata:
  status: Draft
  complexity: COMPLEX
---

# YouTube-Embedded Podcasts — Implementation Plan

Date: 15-09-26
Status: Draft
Complexity: COMPLEX (single plan artifact, not a phase program)

## Overview

BriefAsia podcasts become YouTube-embedded videos, watchable on-site via a click-to-load
`youtube-nocookie.com` player — never a link-out, never autoplay, never an eager iframe load. This
plan covers two repos: `apcg-cms` (the CMS — adds a required `youtubeUrl` field + derived
`youtubeId` to the existing `Podcasts` collection, migration, validation) and `brief-asia-web` (the
reader — new `getPodcasts` data fetcher, a new click-to-load embed component, and real `/podcasts`
index + `/podcasts/[slug]` detail pages replacing the current `redirect("/")` stubs).

**Why COMPLEX, not SIMPLE:** this touches a Postgres migration + collection schema change in
apcg-cms, a hand-maintained cross-repo `payload-types.ts` merge as a hard precondition, and two new
UI surfaces (index + detail page) plus a new shared component in brief-asia-web — real blast radius
across two repos even though it is smaller than the article-video work (no new collection, no new
upload/mimetype surface, no new per-tenant gating mechanism — `podcasts` is already gated
end-to-end).

**Why one plan, not a phase program:** none of these pieces need an independent validate gate
between them — no 3+ dependent phases, no repeated milestone gates, single package pair (not
multi-service). They land together as one reviewable unit.

Both repos are on branch `claude/tender-ptolemy-njgwwt`.

---

## Locked Requirements (verbatim from spec — do not renegotiate)

1. A podcast episode is a YouTube video. YouTube link is the only publishing path for now.
2. Watchable on the BriefAsia site itself, not a link-out.
3. `youtubeUrl` is REQUIRED — block save with no link, never render an empty player.
4. Click-to-load embed: thumbnail + play control; iframe loads only on click.
5. Use `youtube-nocookie.com` for the iframe.
6. No YouTube API key/OAuth. Thumbnails via `https://img.youtube.com/vi/<id>/<quality>.jpg`,
   with `hqdefault` fallback since `maxresdefault` is absent for some videos.
7. No autoplay anywhere.

## Out of Scope (explicit)

Audio upload/self-hosting; YouTube Data API; auto-fetching titles/durations; RSS output for
Spotify/Apple; enabling `podcasts` for any tenant other than BriefAsia; `/about/newsroom` page.

---

## Decisions and Justification

### D1 — `youtubeUrl` storage shape: raw URL + derived `youtubeId`, both non-localized

Add two plain (non-localized) text columns to `podcasts`:
- `youtube_url` — the raw URL as pasted by the editor, required at the Payload field level.
- `youtube_id` — the extracted 11-char video ID, derived server-side, `admin.readOnly: true`.

**Why not localized:** `title`/`description`/`tag` are localized because they are translated prose;
a YouTube link is not translatable — same reasoning already applied to `heroImage` and `exclusive`
in `Articles.ts` (non-localized structural/reference fields sit alongside localized editorial
fields in the same collection without incident). Localizing would additionally require a new
`podcasts_locales` child table — unnecessary migration weight for a field with one canonical value.

**Why derive and store `youtubeId` instead of parsing at read time in every consumer:** the URL
comes in five shapes (`watch?v=`, `youtu.be/`, `live/`, `shorts/`, plus `?t=`/playlist/tracking
params). Parsing that regex twice — once in apcg-cms admin preview, once in brief-asia-web's reader
— means two places can drift. Extracting once at save time via a `beforeValidate` hook and storing
the clean ID means every reader-side consumer (thumbnail URL, embed src) is a straight string
interpolation, no regex duplication, and the "required at save time" requirement (R3) is enforced
at the same hook that does the parsing — a URL that fails to parse to a valid ID IS the validation
failure.

**Rejected alternative:** store only `youtubeUrl`, parse at read time in brief-asia-web. Rejected
because it pushes the "what counts as a valid link" logic into the reader repo where a bad/legacy
row would only be caught at render time (empty player — exactly what R3 forbids), not at save time
in the CMS admin where an editor can fix it immediately.

**Confirmed non-localized (coordinator cross-check):** a YouTube URL is identical in every locale —
there is no translation surface here. This keeps the migration to plain `ALTER TABLE "podcasts" ADD
COLUMN IF NOT EXISTS "youtube_url" varchar` / `"youtube_id" varchar` with **no new `podcasts_locales`
child table**. This is the same class of omission that has already broken production once on this
feature area (see D8/migration note on `20260910_010000_add_video_media_credit_fields.ts`) — but in
the opposite direction: that defect was a missing `_locales` table a localized field needed; here
the fix is to correctly NOT add one, because the field is not localized. Getting this decision wrong
in either direction (localizing a non-localizable field, or skipping a needed `_locales` table for a
field that should be localized) is the exact bug class to avoid.

### D2 — `audioUrl`: left in place, hidden in admin (not removed, not required)

`audioUrl` stays exactly as-is in the schema and generated types — untouched per the locked
requirement ("YouTube is the only path for now" implies audio is dormant, not dead). Add
`admin: { hidden: true }` to the field only — this is an admin-UI-only change (no schema/migration
impact) that stops editors from filling in a field the reader no longer consumes, without deleting
data or breaking any other tenant that might reference `audioUrl` in the future. If WTB or another
tenant later needs it, un-hiding is a one-line revert.

**AMENDMENT (VALIDATE finding, resolved) — `audioUrl` must also come out of the console whitelist,
same commit.** `audioUrl` is currently a live, unrequired text field in
`MANAGED_COLLECTIONS.podcasts.fields` (`src/console/data/collection-config.ts`) — the simplified
tenant editor most console-only staff actually use. Hiding `audioUrl` in the Payload admin (above)
while leaving it visible and fillable in the console defeats this decision's own stated rationale
("stops editors from filling in a field the reader no longer consumes") for exactly the editors who
never touch full Payload admin. Per D9's own "which surface is authoritative" reasoning (Payload
admin is authoritative; console is a simplified subset), a field hidden on the authoritative surface
should not remain live on the subset surface. **Decision: remove `audioUrl` from
`MANAGED_COLLECTIONS.podcasts.fields` in the same commit as the `youtubeUrl` whitelist addition
(Implementation Checklist step 2a).** This is safe and non-destructive: the console form is
create-only (D9 — there is no console edit path for any collection), so removing the whitelist
entry only affects podcasts created via the console *from this point forward*; it does not touch
the schema, does not drop the column, does not affect existing rows, and does not affect the
Payload-admin path (an editor with full admin access can still see/fill `audioUrl` there if the
`admin.hidden` flag is later reverted). This is NOT the same category as the console's other
pre-existing gaps (`poster`/`duration`/`tag`/`publishedAt`, which were never in the console list and
stay out of scope per D9) — `audioUrl` IS currently in the console list, and this plan is actively
changing its status via D2, so keeping both surfaces consistent with that change is completing D2's
intent, not scope creep.

**Assumption, not fact (flag for someone with DB access):** `podcasts` defaults to disabled on
`Tenants.features` and no session in this workspace can query the CMS database. The working
assumption is that the collection has near-zero real rows today. **Check before relying on this:**
`SELECT tenant_id, count(*) FROM podcasts GROUP BY tenant_id;` — if any tenant has non-demo rows,
re-open D3 (making `youtubeUrl` required) before EXECUTE runs the migration.

### D3 — `youtubeUrl` required: Payload-level required, NOT a DB `NOT NULL` constraint

The migration adds `youtube_url` and `youtube_id` as **nullable** columns (`ALTER TABLE ... ADD
COLUMN IF NOT EXISTS "youtube_url" varchar;`) — no `NOT NULL`. Enforcement of "required" happens at
the Payload field config (`required: true`) plus the `beforeValidate` hook that fails the save when
the URL cannot be parsed to a valid ID. This is deliberate: per D2's assumption, existing rows are
believed empty/demo, but that is unverified in this session. A `NOT NULL` column added to a table
that turns out to have real rows would break every existing document's next read/write in Payload
until backfilled — the same class of defect the `video_media_locales` comment in
`20260910_010000_add_video_media_credit_fields.ts` warns about, just the DB-constraint variant
instead of the missing-child-table variant. App-level `required: true` gives the same block-at-save
behavior (R3) without a destructive migration if the assumption in D2 is wrong. **Someone with DB
access should run the D2 check before EXECUTE; if rows exist, EXECUTE must additionally plan a
backfill step (out of scope for this plan to write blind).**

### D4 — Pages: both `/podcasts` (index) and `/podcasts/[slug]` (detail)

Build both. `slug` is already `required: true, index: true, unique-within-tenant` on the
collection — the hook already exists, so a detail route costs one dynamic segment, not new backend
work. `BUSINESS.md` §11 and `DESIGN.md` "Podcast" section both describe a **featured episode +
episode list** pattern, which reads naturally as an index page with cards, and a shareable
individual-episode URL is the obvious next step once a stable per-episode slug already exists.
Rejected alternative: index-only with everything playing inline on one page — rejected because it
gives every episode the same URL, which is worse for sharing/socials and does not use the slug
field the collection already guarantees is unique.

### D5 — New component, not a `video-player.tsx` extension

`video-player.tsx` renders a self-hosted `<video>` element for article body/hero video; it is
explicitly documented as "site-agnostic, branchless, no tenant logic" and reused verbatim by future
publications. A YouTube embed is a different contract end to end: no `<video>`/`<source>`, an
`<iframe>` swapped in on click, a thumbnail `<img>` with a fallback chain, and a nocookie domain —
forcing them into one component would mean prop-branching on "is this YouTube or self-hosted,"
which contradicts `video-player.tsx`'s own branchless design note. New file:
`src/components/podcast/youtube-embed.tsx`. It shares the **behavioral contract** (no autoplay, no
eager iframe load) with `video-player.tsx` but not the code — call this out explicitly in the file's
header comment so a future reader does not "fix" the duplication.

### D6 — Click-to-load mechanism: facade `<button>` swap, no third-party embed library

A plain client component: state `loaded: boolean`, initial render is a real `<button>` wrapping the
poster `<img>` (`aria-label="Play episode: {title}"`), `onClick` flips `loaded` to `true`, which
swaps the button+image for an `<iframe src="https://www.youtube-nocookie.com/embed/{id}?rel=0"
title="{title}" allow="encrypted-media; picture-in-picture" allowFullScreen />` — no `autoplay=1` in
the query string (R7). No `?autoplay=1` is ever added. This is the standard "YouTube facade" pattern
(same idea as `lite-youtube-embed`) implemented inline rather than as a new dependency — no new
package needed for ~30 lines of component code, matching this repo's no-new-dependency bias.

### D7 — Thumbnail fallback: client-side `onError` swap, `img.youtube.com` allow-listed

`<img src="https://img.youtube.com/vi/{id}/maxresdefault.jpg" onError={swap to hqdefault} />` — a
plain `<img>`, not `next/image`, because `next/image` requires the exact final URL to be known
server-side for optimization and the fallback decision (`maxresdefault` 404 → `hqdefault`) is a
client-side runtime fact. Using `next/image` would need `unoptimized` anyway to make the `onError`
swap work, which defeats the point of using it. **`next.config.ts` — corrected (VALIDATE finding):**
NO config change is required for this plan, unconditionally. `images.remotePatterns` is a
`next/image`-only allow-list mechanism — a plain `<img>` tag never consults it, under any
circumstance, because it never routes through Next's image optimizer. Confirmed by reading the live
`next.config.ts`: it defines no `images` key at all today. If a *future* pass ever swaps this
thumbnail to `next/image` (e.g. for LCP), *that* future change — not this one — would need to add
`img.youtube.com` to `images.remotePatterns`; this is already flagged as a watch-item in Test Infra
Improvement Notes below. EXECUTE must not touch `next.config.ts` for this plan.

### D8 — `payload-types.ts` cross-repo merge: hard, ordered pre-condition

apcg-cms's generated `src/payload-types.ts` (2432 lines) and brief-asia-web's hand-maintained copy
at `src/payload/payload-types.ts` (1429 lines, confirmed drifted this session — see comparison
below) are NOT the same file and a wholesale copy breaks brief-asia-web's typecheck in ~10
unrelated places per the task brief. Confirmed drift on `Podcast` alone: brief-asia-web's copy is
missing `tenant`, `tag`, `poster`, `audioUrl`, and has `show`/`description`/`duration`/`host` marked
required when apcg-cms has them optional. This means the merge is not just "add two fields" — it
must also true-up the existing drifted fields or the reader's runtime shape (from the live API) and
its type will keep disagreeing regardless of this plan.

**Ordered pre-condition (blocks all brief-asia-web EXECUTE steps that import `Podcast`):**
1. In apcg-cms: land the collection field change (D1) + migration, run `payload generate:types`
   to regenerate `src/payload-types.ts`.
2. Diff apcg-cms's regenerated file against its pre-change git state; extract ONLY the
   `export interface Podcast { ... }` and `export interface PodcastsSelect<T ...> { ... }` blocks.
3. In brief-asia-web, manually replace those two blocks in `src/payload/payload-types.ts` (same
   interface names, same file) with the apcg-cms versions verbatim — do not touch any other
   interface in the file. This both adds `youtubeUrl`/`youtubeId` and fixes the pre-existing drift
   on `tenant`/`tag`/`poster`/`audioUrl`/optionality in one surgical edit.
4. Run `npm run typecheck` in brief-asia-web immediately after the merge, before writing any new
   component/page code, to confirm the merge did not introduce unrelated breakage and that no other
   file in the repo was relying on the old (wrong) `Podcast` shape in a way that now fails.

### D9 — apcg-cms admin console has its OWN field whitelist; must be updated alongside `Podcasts.ts`

`src/console/data/collection-config.ts` defines `MANAGED_COLLECTIONS.podcasts.fields` as an
explicit array — currently `title`, `slug`, `show`, `episode`, `host`, `audioUrl`, `description` —
which drives the simplified tenant editor at `/console/sites/[tenant]/podcasts`
(`src/app/(console)/console/sites/[tenant]/podcasts/page.tsx`). This is a SEPARATE surface from the
full Payload admin. Adding `youtubeUrl` to `Podcasts.ts` alone makes the field appear in Payload
admin but NOT in the console — the console's `CollectionManager` only renders fields present in its
own whitelist. **This plan must add `youtubeUrl` to both.**

**`FieldType` confirmed compatible:** `src/console/data/collection-config.ts:9` defines
`FieldType = "text" | "textarea" | "number" | "select" | "relation"` — `youtubeUrl` is a plain
`{ name: "youtubeUrl", label: "YouTube URL", type: "text", required: true }` entry, no new field
type needed.

**Which surface is authoritative:** Payload admin is authoritative (it is the full collection
schema with the `beforeValidate` hook enforcing R3); the console is a simplified subset editor for
tenant staff. A tenant editor using ONLY the console today could not have set `youtubeUrl` before
this plan and will be able to after — the console update is what makes R3 actually reachable from
the surface most tenant editors use day to day, not just from the full Payload admin.

**Scope boundary (explicit, do not drift):** the console list is already missing `poster`,
`duration`, `tag`, `publishedAt` relative to the full collection — this is pre-existing divergence,
not something this plan introduces or is asked to fix. Do not expand this plan to add those other
missing fields to the console; add `youtubeUrl`, and remove `audioUrl` (see the D2 AMENDMENT above —
this is completing D2's own decision, not new scope, since `audioUrl` is currently live in this
exact whitelist and D2 is what changes its status).

**AMENDMENT — this is a hard-coupled blocking prerequisite, not an optional nicety.**
`createItemAction` in
`src/app/(console)/console/sites/[tenant]/manage/collection-actions.ts` builds the payload sent to
Payload **exclusively** by iterating `def.fields` (the console whitelist) — a field absent from that
array is never read from the submitted form and never included in the `create` call. Confirmed in
source: `for (const f of def.fields) { const raw = s(formData, f.name); ...; data[f.name] = ...; }`
then `await createDoc(collection, data, user, ...)`.

Consequence: if `youtubeUrl` is `required: true` on the Payload collection (D3) and is **not** added
to `collection-config.ts` in the same change, **every "Add podcast" submission through the console
fails** for every tenant with `features.podcasts` enabled — Payload's create-time validation throws
because the required field was never in the payload, and the console surfaces a validation error
for a field the editor cannot see or fill. This is a hard functional break of the console flow, not
a cosmetic gap, and it is not scoped to BriefAsia — it would hit any tenant using the console
podcasts editor. **The `Podcasts.ts` collection change and the `collection-config.ts` whitelist
change must land in the same EXECUTE pass/commit** — see Implementation Checklist step 2a and
Blast Radius below.

**Console entry required to match the collection:**
`{ name: "youtubeUrl", label: "YouTube URL", type: "text", required: true, placeholder:
"https://youtube.com/watch?v=..." }`. `CollectionManager` has no `url` input type
(`type: FieldType = "text" | "textarea" | "number" | "select" | "relation"`; anything not
`textarea`/`select`/`relation` renders as `<Input type={f.type === "number" ? "number" : "text"}
/>`) — use `type: "text"` and put format guidance in `placeholder`, matching the pattern every other
console text field already uses.

**Two pre-existing behaviors to record, not fix:**
- **The console form is create-only.** There is an "Add {singular}" form and a per-row Delete
  button; there is no edit form for any collection in the console, not just podcasts. A podcast
  created via the console can never have its `youtubeUrl` (or any other field) changed from the
  console afterward — only from the full Payload admin. This is existing behavior for every
  console-managed collection; this plan does not change it and should not attempt to add an edit
  path as a side effect.
- **`required` is enforced server-side only in the console**, not via an HTML `required` attribute
  on the rendered `<Input>` (the label just appends ` *`) — the check is
  `if (f.required && !raw) return { ok: false, error: ... }` inside `createItemAction`. This means
  the console's own required check fires and returns a friendly error (`"YouTube URL is required."`)
  before the request even reaches Payload's `beforeValidate` hook — a better UX outcome, and another
  reason the whitelist entry must carry `required: true` to match the collection exactly, not just
  to avoid the silent-payload-omission failure above.

---

## Touchpoints

**apcg-cms:**
- `src/collections/Podcasts.ts` — add `youtubeUrl` (required text field) + `youtubeId` (derived,
  readOnly text field) + `beforeValidate` hook to parse/validate the URL; add `admin.hidden: true`
  to `audioUrl`.
- `src/console/data/collection-config.ts` — add `{ name: "youtubeUrl", label: "YouTube URL", type:
  "text", required: true, placeholder: "https://youtube.com/watch?v=..." }` to
  `MANAGED_COLLECTIONS.podcasts.fields`, and **remove the existing `audioUrl` entry from the same
  array** (D2 AMENDMENT — completes the admin-hide decision on the console's create-only surface).
  **HARD-COUPLED to the item above (D9) — must land in the
  same commit/EXECUTE pass**, not as a follow-up; skipping the `youtubeUrl` addition breaks every
  console "Add podcast" submission for every tenant with `features.podcasts` on the moment
  `youtubeUrl` becomes required.
- `src/migrations/{new}_add_podcast_youtube_fields.ts` (`.ts`-only — **no** matching `.json`
  snapshot; VALIDATE checked `src/migrations/` and confirmed the last 4 migrations, including both
  cited as this migration's style precedent, have no `.json` pair, and `src/migrations/index.ts`
  never reads a `.json` file at runtime — only the first 5 legacy migrations have snapshots) — adds
  `youtube_url`, `youtube_id` nullable columns to `podcasts`.
- `src/lib/` — new small shared parser util, e.g. `src/lib/youtube.ts`, exporting
  `extractYoutubeId(url: string): string | null` used by the Podcasts hook. (Read
  `src/lib/` directory listing at EXECUTE time to confirm no existing util already does this before
  creating a new file.)
- `src/payload-types.ts` — regenerated via `payload generate:types` (not hand-edited).

**brief-asia-web:**
- `src/payload/payload-types.ts` — surgical `Podcast`/`PodcastsSelect` merge (D8).
- `src/lib/cms-client.central.ts` — new `getPodcasts` (mirrors `getNewsletters`/`getCorrections`
  pattern: `unstable_cache` wrapping `fetchModule("podcasts", locale)`, tag `["podcasts:all"]`).
- `src/lib/cms-client.ts` — re-export `getPodcasts` from `central` alongside the other exports.
- `src/lib/central-api.ts` — `fetchModule()`'s union type already includes `"podcasts"`; no change
  needed here (confirmed this session) — do not add a redundant entry.
- `src/components/podcast/youtube-embed.tsx` — new click-to-load embed component (D5/D6/D7).
- `src/app/(reader)/[locale]/podcasts/page.tsx` — replace the entire 20-line `redirect("/")` stub
  (real index page, per `DESIGN.md` "Podcast" section). **Must also delete the stub's own comment
  block** ("no real episodes exist yet", "nothing here is revived") — leaving that comment above a
  now-working page is a stale-comment defect this codebase has already shipped multiple times;
  replace it with a comment describing the real implementation.
- `src/app/(reader)/[locale]/podcasts/[slug]/page.tsx` — new detail page (D4).
- `src/app/(reader)/[locale]/podcast/page.tsx` — the 17-line singular-alias stub. Change
  `redirect("/")` to `redirect("/podcasts")` and replace its comment block (which currently explains
  the fabricated content was deleted and says "point this at the new page when one exists") with a
  short note that it now does. Do not redirect to home — the coordinator confirmed the alias should
  land on `/podcasts`, not `/`.
- `src/lib/data.ts:74` — `NAV_EXTRA`'s `{ id: "podcasts", label: "Podcasts", slug: "/podcasts" }`
  entry already exists; confirmed no change needed here.
- `src/lib/i18n.tsx:182` — `NAV_I18N.podcasts` (`vi`/`id` translations) already exists; confirmed no
  change needed here.
- `src/components/header.tsx:894` — the `["Newsletters", ...]`/`["RSS", ...]` PRODUCTS nav array has
  a `// "Podcast" removed (BA-UI-20)` comment in place of the link. Restore
  `["Podcast", "/podcasts"]` in that array, in its original position between Newsletters and RSS,
  and remove the BA-UI-20 comment.
- `src/components/footer.tsx:39` — same pattern, same fix: restore `["Podcast", "/podcasts"]` in the
  PRODUCTS links array, remove the `// "Podcast" removed (BA-UI-20)` comment.
- `src/app/sitemap.ts` — line 31 has a comment: `// "podcasts" → route hidden while the shows are
  demo content (BA-UI-20)`. Remove that suppression and add `podcasts` (+ per-episode slugs) back
  into the sitemap generation, following whatever pattern `newsletters`/`corrections` already use
  there.
- `next.config.ts` — no change required per D7 (plain `<img>`, not `next/image`); explicitly do NOT
  touch `images.remotePatterns` in this plan.

---

## Public Contracts

- **Payload collection field contract (apcg-cms):** `podcasts.youtubeUrl` — required string,
  validated as a parseable YouTube URL at save time. `podcasts.youtubeId` — derived, read-only,
  11-char YouTube video ID. Both surface through `/api/public/podcasts` (already-live route, no
  route change) and through Payload's admin/REST/GraphQL API automatically.
- **`GET /api/public/podcasts` response shape:** unchanged endpoint, additive fields only
  (`youtubeUrl`, `youtubeId` join the existing `title`/`slug`/`description`/etc.). No breaking
  change to the existing response envelope. **Confirmed no code change needed:**
  `src/app/api/public/[module]/route.ts:24` already maps `podcasts` → the collection via
  `scopedFind`, and `scopedFind` returns whole documents with no field projection/whitelist — so
  `youtubeUrl`/`youtubeId` flow through automatically the moment they exist on the collection. Do
  NOT add a redundant field whitelist to this route; none exists today and none is needed.
- **`getPodcasts()` (brief-asia-web, new):** `unstable_cache`-wrapped, `revalidate: 300`, tag
  `podcasts:all` — mirrors `getNewsletters`/`getCorrections` exactly. **Corrected (VALIDATE
  finding):** the original claim that an existing `afterChange`/`afterDelete` revalidation hook
  "already fires" on podcast writes is FALSE — verified directly in apcg-cms source
  (`src/collections/Podcasts.ts`, `Newsletters.ts`, `Corrections.ts`): none of the three wire
  `revalidateHooks()`. Only `Articles`/`Cities`/`Pillars`/`SubSections`/`WireDrops` (5 of 26
  collections — the high-churn ones) get an on-demand webhook to the reader's `/api/revalidate`.
  Podcasts, like Newsletters and Corrections, gets NO on-demand cache bust — freshness is bounded
  solely by the `revalidate: 300` (5-minute) time window. **This is existing, accepted behavior for
  flat gated modules, not a regression this plan introduces or a gap this plan must close** — do
  NOT add a `revalidateHooks(["podcasts:all"])` wiring to `Podcasts.ts` as part of this plan; that
  would be an unscoped change (it would also need a `tenantTag()`-prefixed tag scheme to match the
  cross-repo webhook contract, which is a separate design decision outside this plan's locked
  requirements). EXECUTE should not "confirm" a hook that does not exist — treat 5-minute staleness
  as accepted for this collection, same as Newsletters/Corrections today.
- **`<YoutubeEmbed>` component prop contract:** `{ youtubeId: string; title: string; posterUrl?:
  string }` — `posterUrl` optional because the component can derive the thumbnail URL from
  `youtubeId` alone (D7); an explicit `posterUrl` (e.g. from `poster` upload field) overrides the
  YouTube-derived thumbnail when editors have uploaded a custom poster.

---

## Blast Radius

- **apcg-cms:** 1 collection file edit, **1 console-whitelist edit (hard-coupled to the collection
  edit — D9; both must land together or the console "Add podcast" flow breaks for every tenant with
  `features.podcasts` on)**, 1 new migration file (+ json snapshot), 1 new small lib util, 1
  regenerated types file. Risk class: **schema/migration** (per orchestration.md's High-Risk
  Classes) — this plan's migration is additive-only (new nullable columns, no drops, no type changes
  to existing columns), which is the lowest-risk shape within that class, but it still requires the
  hybrid-minimum test tier (see Verification Evidence).
- **brief-asia-web:** ~9 files touched/created (types merge, 2 lib files, 1 new component, 2 page
  files replacing stubs including their stale comment blocks, 1 sitemap edit, 2 nav-file edits at
  confirmed exact line anchors — `header.tsx:894`, `footer.tsx:39`). No schema/auth/billing surface
  in this repo (it is a pure HTTP reader of apcg-cms's Central API). Risk class: **public-facing UI
  surface**, not high-risk per the orchestration.md classes list (no auth/billing/migration/
  API-contract-breaking change on this side — the API response is additive).
- **Total file count:** ~14 files across 2 repos. This sits at the low end of "COMPLEX" — no
  phase-program signals present (not 3+ dependent phases, no repeated validation gates between
  milestones, single package pair not multi-service).

---

## Verification Evidence

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| `npm run typecheck` (apcg-cms) | Fully-Automated | Collection field types, migration file compiles, `payload-types.ts` regeneration is internally consistent |
| `npm run lint` (apcg-cms) | Fully-Automated | New `src/lib/youtube.ts` and collection edit meet repo lint rules |
| Manual: save a Podcasts doc in apcg-cms admin with `youtubeUrl` empty | Agent-Probe | R3 — save is blocked, no empty-player state is possible |
| Manual: submit "Add podcast" in the tenant console (`/console/sites/[tenant]/podcasts`) with `youtubeUrl` filled in the console form | Agent-Probe | D9 — console whitelist entry actually reaches Payload create; confirms the hard-coupled fix, not just the Payload-admin path |
| Manual: submit "Add podcast" in the console with `youtubeUrl` left blank | Agent-Probe | D9 — console's own server-side required check fires with a friendly error before Payload validation |
| Manual: save with a malformed/non-YouTube URL (e.g. `https://vimeo.com/123`) | Agent-Probe | R3/D1 — the `beforeValidate` hook rejects unparseable URLs, not just empty ones |
| Manual: save with each of the 4 documented URL shapes (`watch?v=`, `youtu.be/`, `live/`, `shorts/`, plus one with `?t=42` and one with playlist params) | Agent-Probe | D1 — parser handles all real-world YouTube link shapes named in the spec |
| `curl {CMS_URL}/api/public/podcasts` after a save, confirm `youtubeUrl`/`youtubeId` present | Hybrid (needs running CMS + seeded tenant) | Public Contracts — new fields surface through the existing route with no route code change |
| `npm run typecheck` (brief-asia-web), run immediately after the D8 types merge, BEFORE any new component/page code is written | Fully-Automated | D8 — merge did not break the ~10 other call sites hand-drift previously papered over; hard gate before proceeding |
| `npm run typecheck` (brief-asia-web), full run after all new files land | Fully-Automated | New component/page/lib code is type-correct against the merged `Podcast` type |
| `npm run lint` (brief-asia-web) | Fully-Automated | New files meet repo lint rules |
| Manual (browser devtools, Network tab): load `/podcasts` with 3+ episode cards, confirm zero requests to `youtube.com`/`youtube-nocookie.com` before any click | Agent-Probe | R4 — click-to-load; index page with many episodes does not eagerly embed players |
| Manual: click one episode's play button, confirm iframe `src` starts with `https://www.youtube-nocookie.com/embed/` and has no `autoplay=1` param | Agent-Probe | R5, R7 — nocookie domain, no autoplay |
| Manual: inspect the play control in devtools, confirm it is a `<button>` with a non-empty `aria-label`, reachable via Tab, activatable via Enter/Space | Agent-Probe | Accessibility requirement — real button, not a bare clickable image |
| Manual: simulate a `maxresdefault.jpg` 404 (e.g. use a known video ID without a maxres thumbnail) and confirm the `<img>` swaps to `hqdefault.jpg` without a broken-image icon | Agent-Probe | R6 — thumbnail fallback |
| Manual: visit `/podcasts/[slug]` for a known episode slug, confirm the same click-to-load contract applies (no eager load, correct nocookie iframe) | Agent-Probe | D4 — detail page reuses the same embed contract |
| Manual: confirm `/podcasts` and `/podcasts/[slug]` appear in `sitemap.ts` output | Agent-Probe | Touchpoints — sitemap restoration |
| Manual: confirm footer/mobile-menu Podcasts link is present and routes to `/podcasts` | Agent-Probe | Touchpoints — nav restoration |
| Manual: confirm `/podcast` singular alias now redirects to `/podcasts` (if EXECUTE takes the one-line improvement in Touchpoints) | Agent-Probe | Touchpoints — legacy alias correctness |

**Known-gap:** no automated E2E/integration test exists in either repo for this surface (per
`tests/all-tests.md`, brief-asia-web's automated-test landscape is currently empty; apcg-cms has no
E2E harness for admin-save flows referenced in this session). All CMS-save-validation and
reader-embed-behavior scenarios above are Agent-Probe by necessity, not by choice — this matches
the repo's actual current test maturity, it is not a shortcut taken by this plan. This is
acceptable per the vacuous-green ban because these behaviors ARE covered — just by the
Agent-Probe tier, not left as Known-Gap. The only true Known-Gap in this plan is: **no automated
regression test protects the `youtubeUrl` parser against a future YouTube URL-shape change** (e.g.
if YouTube ships a new URL pattern) — flagged for a follow-up backlog item, not blocking this plan.

---

## Test Infra Improvement Notes

- (D7 watch-item) If a future pass switches the thumbnail `<img>` to `next/image` for LCP reasons,
  `next.config.ts` will need `images.remotePatterns` to allow-list `img.youtube.com` — not needed
  for this plan's plain-`<img>` implementation, but will block that specific future change if
  forgotten.
- No automated test exists in brief-asia-web for "does this component avoid eager network
  requests" — the Network-tab manual check above is the only current coverage. A future
  Playwright/Vitest-with-DOM harness could assert `fetch`/`iframe` call counts before/after click,
  but no such harness exists in this repo today (confirmed via `tests/all-tests.md`) and building
  one is out of scope for this plan.
- No automated test exists in apcg-cms for Payload `beforeValidate` hook behavior on a specific
  collection — all coverage here is manual admin-UI probing. A future collection-hook test harness
  (if one gets built for a different feature) should retroactively pick up the `youtubeUrl` parser
  as a regression case.

---

## Implementation Checklist

1. **apcg-cms — parser util.** Check `src/lib/` for an existing URL-parsing helper before
   creating `src/lib/youtube.ts`. Implement `extractYoutubeId(url: string): string | null` covering
   `watch?v=`, `youtu.be/`, `live/`, `shorts/`, with `?t=`/playlist/tracking params stripped/ignored.
2. **apcg-cms — collection field.** Edit `src/collections/Podcasts.ts`: add `youtubeUrl` (text,
   `required: true`) and `youtubeId` (text, `admin.readOnly: true`) fields; add a `beforeValidate`
   hook on `youtubeUrl` that calls `extractYoutubeId`, throws a validation error if it returns
   `null`, and writes the result into `youtubeId`. Add `admin.hidden: true` to `audioUrl`.
2a. **apcg-cms — console whitelist (MUST land with step 2, same commit — D9).** Edit
   `src/console/data/collection-config.ts`: add `{ name: "youtubeUrl", label: "YouTube URL", type:
   "text", required: true, placeholder: "https://youtube.com/watch?v=..." }` to
   `MANAGED_COLLECTIONS.podcasts.fields`, **and remove the existing `audioUrl` entry from the same
   array** (D2 AMENDMENT — completes the Payload-admin hide decision on the console's create-only
   surface; affects only podcasts created via console from this point forward, no data touched). Do
   not land step 2 without the `youtubeUrl` half of this step in the same pass — skipping it breaks
   every console "Add podcast" submission the moment `youtubeUrl` is required.
3. **apcg-cms — migration.** Write `src/migrations/{timestamp}_add_podcast_youtube_fields.ts`
   (`.ts` only — no `.json` snapshot; see corrected Touchpoints note) adding nullable
   `youtube_url`/`youtube_id` columns to `podcasts`, following the
   idempotent `IF NOT EXISTS` style of `20260910_010000_add_video_media_credit_fields.ts`. Do NOT
   run the migration in this session — no database is available.
4. **apcg-cms — regenerate types.** Run `payload generate:types` to produce the new
   `src/payload-types.ts` with `Podcast`/`PodcastsSelect` reflecting the new fields.
5. **apcg-cms — gates.** Run `npm run typecheck` and `npm run lint`; fix until green.
6. **D8 pre-condition — types merge (HARD BLOCKER for step 7+).** Diff apcg-cms's
   `Podcast`/`PodcastsSelect` interfaces pre/post step 4; manually replace only those two blocks in
   brief-asia-web's `src/payload/payload-types.ts`. Run `npm run typecheck` in brief-asia-web
   immediately — do not proceed to step 7 until this is green.
7. **brief-asia-web — data layer.** Add `getPodcasts` to `src/lib/cms-client.central.ts`
   (mirror `getNewsletters` pattern exactly: `unstable_cache`, tag `podcasts:all`, `revalidate:
   300`). Re-export from `src/lib/cms-client.ts`.
8. **brief-asia-web — embed component.** Create `src/components/podcast/youtube-embed.tsx` per
   D5/D6/D7: facade `<button>` + `<img>` with fallback, swaps to nocookie `<iframe>` on click, no
   autoplay.
9. **brief-asia-web — index page.** Replace `src/app/(reader)/[locale]/podcasts/page.tsx` stub with
   the real index page per `DESIGN.md` "Podcast" pattern (featured episode + episode cards), using
   `getPodcasts()` and `<YoutubeEmbed>`.
10. **brief-asia-web — detail page.** Create `src/app/(reader)/[locale]/podcasts/[slug]/page.tsx`
    using the same data/component, filtered by slug; 404 on unknown slug.
11. **brief-asia-web — alias.** Update `src/app/(reader)/[locale]/podcast/page.tsx`:
    `redirect("/")` → `redirect("/podcasts")`. Replace the stale comment block (fabricated-content
    explanation) with a short note describing the real page it now points to.
12. **brief-asia-web — nav restore (exact anchors, confirmed this session).** In
    `src/components/header.tsx:894`, restore `["Podcast", "/podcasts"]` to the PRODUCTS nav array
    (between Newsletters and RSS) and remove the `// "Podcast" removed (BA-UI-20)` comment. Same fix
    in `src/components/footer.tsx:39`. No change needed to `src/lib/data.ts:74`
    (`NAV_EXTRA.podcasts`) or `src/lib/i18n.tsx:182` (`NAV_I18N.podcasts`) — both already correct.
13. **brief-asia-web — sitemap restore.** Edit `src/app/sitemap.ts`: remove the BA-UI-20 suppression
    comment/logic at line 31, add `podcasts` + per-episode slugs following the
    newsletters/corrections pattern already present in the file.
14. **brief-asia-web — gates.** Run `npm run typecheck` and `npm run lint`; fix until green.
15. **Manual verification pass.** Work through every Agent-Probe row in Verification Evidence in
    order; record actual outcomes (not assumed) in the EXECUTE report.

---

## Resume and Execution Handoff

1. **Selected plan file path:** `process/general-plans/active/podcast-youtube-embed_15-09-26/podcast-youtube-embed_PLAN_15-09-26.md`
2. **Last completed phase or step:** PLAN written; no VALIDATE or EXECUTE work has started.
3. **Validate-contract status:** pending — placeholder below; `vc-validate-agent` writes V1-V7
   before EXECUTE.
4. **Supporting context files loaded this session:** `src/collections/Podcasts.ts`,
   `src/lib/constants.ts`, `src/app/api/public/[module]/route.ts`, and
   `src/migrations/20260910_010000_add_video_media_credit_fields.ts` (apcg-cms); `central-api.ts`,
   `cms-client.ts`, `cms-client.central.ts`, both `podcasts`/`podcast` page stubs,
   `video-player.tsx`, `data.ts` (`NAV_EXTRA`), `sitemap.ts`, `payload/payload-types.ts`
   (apcg-cms's `src/payload-types.ts` for comparison), `DESIGN.md` §Podcast, `BUSINESS.md` §11
   (brief-asia-web). apcg-cms has no `process/context/all-context.md`; `docs/` and
   `process/development-protocols/` were the substitute context surfaces per the task brief.
5. **Next step for a fresh agent picking up mid-execution:** run `ENTER VALIDATE MODE` on this
   plan file first. If resuming after VALIDATE, re-read this plan's D8 section before touching any
   brief-asia-web file that imports `Podcast` — the types-merge pre-condition is a hard ordering
   requirement, not a suggestion.

---

## Acceptance Criteria

1. Saving a Podcasts doc in apcg-cms admin with `youtubeUrl` empty is blocked — no document can
   ever have a null/empty YouTube link (R3).
2. Saving a Podcasts doc with a non-YouTube or unparseable URL is blocked (D1 validation hook).
2a. The tenant console's "Add podcast" form includes a `youtubeUrl` field, enforces it as required
   (server-side, matching the console's existing required-field pattern), and successfully creates a
   podcast doc through Payload when filled — the console flow is not broken by making the field
   required on the collection (D9).
3. Saving a Podcasts doc with any of the 5 documented URL shapes (`watch?v=`, `youtu.be/`, `live/`,
   `shorts/`, and URLs carrying `?t=`/playlist/tracking params) succeeds and derives the correct
   `youtubeId`.
4. `GET /api/public/podcasts` returns `youtubeUrl` and `youtubeId` on every episode, with no route
   code change required (existing route already serves `podcasts`).
5. `/podcasts` renders an index of episodes with click-to-load thumbnails; zero requests to
   `youtube.com`/`youtube-nocookie.com` fire before any click (R4).
6. Clicking an episode's play control loads an iframe pointed at `youtube-nocookie.com` with no
   `autoplay=1` parameter (R5, R7).
7. The play control is a real `<button>` with a non-empty `aria-label`, keyboard-reachable and
   keyboard-activatable (accessibility requirement).
8. Thumbnail loading falls back from `maxresdefault.jpg` to `hqdefault.jpg` on a 404 without a
   broken-image state (R6).
9. `/podcasts/[slug]` renders an individual episode using the same click-to-load contract (D4).
10. `audioUrl` remains in the schema/types, unrequired, hidden from the Payload admin UI, and
    removed from the console's create-form whitelist (D2 AMENDMENT/D9) — no data loss, no
    forced migration of existing rows (D2/D3).
11. brief-asia-web's `npm run typecheck` passes both immediately after the D8 types merge and again
    after all new files land (D8 hard gate).
12. Both repos' `npm run typecheck` and `npm run lint` pass with zero errors.
13. Footer/mobile-menu Podcasts nav link and `sitemap.ts` both correctly reference `/podcasts` (and
    per-episode slugs for the sitemap).

## Phase Completion Rules

This is a single-session COMPLEX plan, not a phase program — there is one phase, and it is
"CODE DONE" only when ALL of the following hold; it is NOT "VERIFIED" until the Agent-Probe manual
pass (Verification Evidence table) has actually been run and its outcomes recorded, not assumed:

- All 15 Implementation Checklist steps complete.
- Both repos' `npm run typecheck` and `npm run lint` are green (Fully-Automated gates).
- The D8 types-merge hard gate (step 6) was run and passed BEFORE any brief-asia-web component/page
  code was written — if this ordering was violated, the phase is not complete regardless of final
  green state; redo the merge-then-typecheck step in the correct order and re-verify.
- Every Agent-Probe row in Verification Evidence has been executed at least once with a recorded
  real outcome (pass/fail/notes) in the EXECUTE report — "should work" is not a completion state.
- The D2/D3 assumption check (`SELECT tenant_id, count(*) FROM podcasts GROUP BY tenant_id;`) has
  either been run by someone with DB access, or is explicitly logged as an open risk in the EXECUTE
  report if it could not be run in this session (no DB access confirmed at PLAN time).
- Code-only completion (all files written, gates green, but the manual Agent-Probe pass not yet
  run) is `CODE DONE`, not `VERIFIED` — do not report this plan as fully verified until the manual
  pass has real recorded outcomes.

---

## Validate Contract

Status: PASS
Date: 15-09-26
date: 2026-09-15
generated-by: outer-pvl

Parallel strategy: sequential (single validate-agent pass, no fan-out spawn available in this
session — findings below were produced by direct source verification across both repos rather than
parallel dimension/section subagents; see Fan-Out Note below)
Rationale: this VALIDATE pass ran as a single agent session (no Agent/Task tool available to spawn
Layer 1/Layer 2 subagents). The two-layer fan-out defined by `vc-validate-findings` was executed
**sequentially by hand** against the four Layer 1 dimensions (infra fit, test coverage, breaking
changes, security surface) and against each Layer 2 section (apcg-cms schema/console/migration,
brief-asia-web types-merge, brief-asia-web UI/nav/sitemap), using direct file reads and installed
Payload 3.85 source inspection rather than isolated subagent context windows. For a plan this size
(~14 files, 2 repos, 0 phase-program signals), `vc-agent-strategy-compare`'s own signal count would
land at 2/7 (S6 high-risk-class present: schema/migration; S7 not met, <5 files per repo) —
MEDIUM tier, i.e. parallel subagents would have been the recommended strategy had spawn access been
available. Sequential-by-hand was the fallback, not the preferred strategy; it does not change the
findings' validity since every claim below is backed by a direct source-code citation, not
inference.

**Fan-Out Note:** `vc-security` (STRIDE/OWASP scan) was applied inline under Security Surface below
(no new auth/billing/secret surface — schema-only field additions + admin-UI visibility change).
`vc-scenario` was applied inline for each CONCERN found (see per-finding "Scenario" notes).
`vc-predict` was not triggered — no finding here was flagged high-risk enough to warrant a
dedicated prediction pass; all CONCERNs were resolved via direct plan-text correction this session
(see below), not left open for EXECUTE to interpret.

### Directed Checks (user-requested, resolved this session)

**1. `audioUrl` internal contradiction — CONFIRMED REAL, RESOLVED.** Verified `audioUrl` was live,
unrequired, and visible in `MANAGED_COLLECTIONS.podcasts.fields`
(`src/console/data/collection-config.ts:123`) while D2 (as originally written) only hid it in the
Payload admin — the console (the surface most tenant editors actually touch) would have kept
exposing it, defeating D2's own stated rationale. **Resolution applied to the plan this session:**
D2 now carries an AMENDMENT requiring `audioUrl` removal from the same console whitelist array, in
the same commit as the `youtubeUrl` addition (Implementation Checklist step 2a), justified via D9's
own "Payload admin is authoritative, console is a simplified subset" reasoning, and confirmed safe
via the console's create-only design (`createItemAction`, confirmed by reading
`src/app/(console)/console/sites/[tenant]/manage/collection-actions.ts:37-41` — the whitelist is
the *sole* source of what the console ever writes, so removing an entry cannot destroy existing
data, only stop new console-created rows from setting it). D9's "Scope boundary" and Acceptance
Criterion 10 were both amended to reflect this. No longer self-contradictory.

**2. D7 `next.config.ts` paragraph — CONFIRMED muddled, RESOLVED.** Read the live
`brief-asia-web/next.config.ts`: it defines no `images` key at all today. `images.remotePatterns`
is a `next/image`-only allow-list; a plain `<img>` tag (what D6/D7 actually use) never consults it
under any condition — the original "even for a plain `<img>` tag IF..." framing was simply wrong (no
such conditional exists). **Resolution applied:** D7's paragraph now states plainly that NO
`next.config.ts` change is required, unconditionally, for this plan; the future-`next/image`
watch-item is preserved verbatim in Test Infra Improvement Notes. The plan's own Touchpoints bullet
for `next.config.ts` was already correct before this fix ("no change required... explicitly do NOT
touch `images.remotePatterns`") — only the D7 prose paragraph was misleading; it is now aligned.

**3. D2/D3 unverified DB-emptiness assumption — VERIFIED SAFE, confirmed against Payload 3.85
installed source, not memory.** Traced the actual code path:
`node_modules/payload/dist/fields/hooks/beforeChange/promise.js:86-97` shows field `validate()`
functions (which is where `required: true` is enforced, per
`node_modules/payload/dist/fields/validations.js:50-56`) run ONLY inside `beforeChange`, which is
invoked ONLY from `collections/operations/create.js` and `updateByID.js`
(`grep beforeChange` confirms the import + call sites there and nowhere else).
`collections/operations/find.js` and `findByID.js` — the paths used by the Payload admin list/detail
views, `payload.find` (local API), and `GET /api/public/podcasts` (via `scopedFind` →
`src/lib/scoped.ts` → `payload.find`) — call `validateQueryPaths` (a *query-filter* validator) and
never touch field-level `validate`/`beforeChange` at all. **Conclusion: the plan's stated failure
mode is exactly correct** — a `required: true` field with a null value on a pre-existing row reads
fine everywhere (admin list, admin detail, public API), and is blocked ONLY on that row's next
create/update save attempt, until the field is filled. This is further corroborated by direct
in-repo precedent: `src/migrations/20260910_010000_add_video_media_credit_fields.ts`'s own header
comment documents this *exact* pattern already shipped for `videoMedia.alt` (`required: true`,
nullable column, no backfill, deliberately) — D3's approach is not just theoretically safe, it
matches an already-accepted convention in this codebase. **No FAIL required here — D3's design and
its stated non-destructive failure mode both hold.**

### Additional findings (VALIDATE-discovered, not user-directed — resolved this session)

**4. Revalidation-hook claim in Public Contracts was factually wrong (benign impact) — RESOLVED.**
The plan claimed an existing `afterChange`/`afterDelete` hook on `Podcasts.ts` "already fires" on
podcast writes. Verified false: grepped all 26 collections in `src/collections/*.ts` for
`revalidateHooks(` — only `Articles`, `Cities`, `Pillars`, `SubSections`, `WireDrops` wire it.
`Podcasts.ts`, `Newsletters.ts`, and `Corrections.ts` (the very two collections the plan cites as
the "mirrored" pattern) have **no** collection-level `hooks` at all. Impact is benign — Podcasts
will behave exactly like Newsletters/Corrections today (freshness bounded by the 5-minute
`revalidate: 300` window, no on-demand webhook), which is already-accepted product behavior, not a
regression. But the plan's reasoning and its EXECUTE instruction ("confirm... do not add a
redundant hook if it does") were both wrong/incomplete — it never said what to do if the hook does
NOT exist (the actual case), which could have sent EXECUTE chasing a nonexistent hook or, worse,
prompted it to improvise an unscoped new hook wiring. **Resolution applied:** Public Contracts now
states the corrected reality directly and explicitly forbids EXECUTE from adding
`revalidateHooks(["podcasts:all"])` as an unscoped addition (a real implementation would also need
a `tenantTag()`-prefixed tag scheme — a separate design decision outside this plan's locked scope).
**Scenario check (vc-scenario):** worst case if this had shipped uncorrected — EXECUTE either
wastes a cycle looking for a hook that isn't there, or unilaterally adds hook wiring that changes
the webhook-fan-out surface without a validate pass on that decision. Both are now foreclosed by
the corrected plan text.

**5. Migration `.json` snapshot instruction did not match actual current convention — RESOLVED.**
The plan instructed writing a paired `.json` snapshot "per the repo's migration convention," citing
`20260910_000000_add_video_support.ts` as the paired example. Verified: `ls src/migrations/*.json`
returns only 5 files, `ls src/migrations/*.ts` returns 10 — the last 4 `.ts` migrations (including
BOTH migrations this plan cites as its own style precedent) have no `.json` pair, and
`src/migrations/index.ts` (the file Payload's migration runner actually imports) only ever imports
`.ts` `up`/`down` exports — it never reads a `.json` file at runtime. The `.json`-snapshot
convention was abandoned after the first 5 migrations. **Resolution applied:** both the Touchpoints
migration bullet and Implementation Checklist step 3 now state `.ts`-only, with the verification
evidence cited inline. Impact if left uncorrected would have been low (a stray unused `.json` file
is not imported by anything and would not break typecheck/lint) but a hand-authored Payload
snapshot JSON (these run 290–325KB, normally machine-generated) is a real risk of producing an
invalid/malformed file if an agent tried to hand-craft one to satisfy a nonexistent requirement.

### Layer 1 dimensions

| Layer 1 dimensions | Status |
|---|---|
| Infra fit | PASS — additive-only nullable-column migration matches established precedent (`20260910_010000...`); console `FieldType` compatibility confirmed (`"text"` type, no new field type needed); `beforeValidate` hook pattern precedented by `uniqueWithinTenant` (`src/hooks/unique-within-tenant.ts`) |
| Test coverage | PASS — 0 FAILs; one narrow, explicitly-named Known-Gap (future URL-shape regression) does not leave any *developed* behavior uncovered (all behaviors carry an Agent-Probe or Fully-Automated gate) — net-gate vacuous-green ban is satisfied |
| Breaking changes | CONCERN → RESOLVED this session (findings 1, 4, 5 above); `GET /api/public/podcasts` response is additive-only, confirmed via `scopedFind` passthrough (`src/app/api/public/[module]/route.ts` — no field whitelist/projection exists, so new fields flow through automatically) |
| Security surface | PASS — no new auth/session/secret/trust-boundary surface; `featureGatedAccess("podcasts", tenantManagedAccess)` access control is unchanged; console's server-side `required` check (`createItemAction`) confirmed to fire before Payload validation, matching existing console UX pattern for every other collection |

### Layer 2 sections

| Layer 2 sections | Status |
|---|---|
| Section A — apcg-cms schema/parser/migration (D1, D3, D9-console) | PASS — mechanically feasible; `youtubeUrl`/`youtubeId` field additions and `beforeValidate` hook are straightforward given the `uniqueWithinTenant` precedent; migration style (nullable + app-level required) directly precedented; console whitelist hard-coupling (D9) verified byte-for-byte against `createItemAction` source |
| Section B — apcg-cms `audioUrl` hide decision (D2) | CONCERN → RESOLVED (finding 1) — console whitelist amendment applied to plan |
| Section C — brief-asia-web D8 types merge | PASS — drift claims independently verified against both `payload-types.ts` files: brief-asia-web's `Podcast` interface is confirmed missing `tenant`/`tag`/`poster`/`audioUrl` and has `show`/`description`/`duration`/`host` as incorrectly non-optional (matches plan's claim exactly); merge is correctly sequenced as a hard blocker (Implementation Checklist step 6) before any consuming code is written |
| Section D — brief-asia-web UI (embed component, index/detail pages, nav, sitemap) | CONCERN → RESOLVED (finding 2, D7 prose) — all nav/sitemap line anchors independently re-verified exact (`header.tsx:894`, `footer.tsx:39`, `sitemap.ts:31` all confirmed byte-exact via `grep -n "BA-UI-20"`); `central-api.ts:243` already includes `"podcasts"` in its module union, confirmed, no change needed |
| Section E — Public Contracts / revalidation | CONCERN → RESOLVED (finding 4) |

**Totals: 0 FAILs / 5 CONCERNs found, all 5 resolved via direct plan-text correction this session / 0 unresolved CONCERNs remaining.**

**→ Net Gate: PASS**

### Test gates (C3 5-column table)

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC1 | Save blocked with `youtubeUrl` empty | Agent-Probe | Manual: save Podcasts doc in apcg-cms admin with `youtubeUrl` empty; confirm save is rejected | A |
| AC2 | Save blocked with malformed/non-YouTube URL | Agent-Probe | Manual: save with `https://vimeo.com/123`; confirm `beforeValidate` hook rejects it | A |
| AC2a | Console "Add podcast" enforces + succeeds with `youtubeUrl` | Agent-Probe | Manual: submit console create form filled and blank, confirm friendly required error blank / successful create when filled | A |
| AC3 | All 5 documented URL shapes parse to correct `youtubeId` | Agent-Probe | Manual: save with `watch?v=`, `youtu.be/`, `live/`, `shorts/`, `?t=`/playlist-param variants | A |
| AC4 | `GET /api/public/podcasts` returns new fields, no route change | Hybrid (needs running CMS + seeded tenant) | `curl {CMS_URL}/api/public/podcasts` after a save, confirm `youtubeUrl`/`youtubeId` present | A |
| AC5 | `/podcasts` zero eager network requests before click | Agent-Probe | Manual (Network tab): load `/podcasts` with 3+ cards, confirm zero `youtube.com`/`youtube-nocookie.com` requests pre-click | A |
| AC6 | Click loads nocookie iframe, no autoplay | Agent-Probe | Manual: click play, confirm `iframe src` starts `https://www.youtube-nocookie.com/embed/`, no `autoplay=1` | A |
| AC7 | Play control is a real, accessible `<button>` | Agent-Probe | Manual devtools: confirm `<button>` with non-empty `aria-label`, Tab-reachable, Enter/Space-activatable | A |
| AC8 | Thumbnail fallback `maxresdefault` → `hqdefault` | Agent-Probe | Manual: force a `maxresdefault.jpg` 404, confirm swap with no broken-image icon | A |
| AC9 | `/podcasts/[slug]` detail page reuses embed contract | Agent-Probe | Manual: visit known slug, confirm same click-to-load contract | A |
| AC10 | `audioUrl` hidden in both admin surfaces, no data loss | Agent-Probe | Manual: confirm `audioUrl` absent from Payload admin form AND console create form; confirm existing rows' `audioUrl` values untouched in DB/API response | A |
| AC11 | brief-asia-web typecheck green pre- and post-D8-merge | Fully-Automated | `npm run typecheck` (brief-asia-web) — run immediately after D8 merge (step 6), and again after all files land (step 14) | A |
| AC12 | Both repos' typecheck + lint pass | Fully-Automated | `npm run typecheck` and `npm run lint` in both `apcg-cms` and `brief-asia-web` | A |
| AC13 | Nav/sitemap correctly reference `/podcasts` | Agent-Probe | Manual: confirm footer/mobile-menu link + sitemap entries | A |
| Known-Gap | Future YouTube URL-shape change breaks parser silently | Known-Gap | — no automated regression test exists or is added by this plan | D — backlog note: `youtube-parser-regression-test_NOTE_15-09-26.md` (create at EXECUTE/UPDATE-PROCESS if not already tracked) |

**Note on Fully-Automated rows (AC11/AC12) — no per-scenario failing stub:** these two rows are
broad, pre-existing repo-wide gate commands (`npm run typecheck` / `npm run lint`), not narrow
single-scenario tests — there is no discrete test file/assertion to write a `test("should ...")`
TDD stub against (the "behavior" is "the whole diff compiles/lints clean", not one function's
output). No `.test.ts` fixture exists in either repo to scaffold one against (both repos have empty
automated-test landscapes per `tests/all-tests.md`). Stub generation is therefore not applicable to
these two rows; this is noted explicitly per V6 rather than silently omitted.

Legacy line form (retained for existing validate-contract consumers):
- apcg-cms schema/save-validation: Fully-automated: `npm run typecheck` / `npm run lint` | Agent-probe: admin save-blocking scenarios (AC1-AC3), console create flow (AC2a)
- Cross-repo API contract: Hybrid: `curl {CMS_URL}/api/public/podcasts` (needs running CMS + seeded tenant)
- brief-asia-web types merge: Fully-automated: `npm run typecheck` run twice (immediately post-merge, then post-all-files) — hard gate, ordering enforced by Implementation Checklist step 6
- brief-asia-web UI/embed behavior: Agent-probe: click-to-load, nocookie/no-autoplay, accessibility, thumbnail fallback, nav/sitemap (AC5-AC9, AC13)
- Known-gap: youtube URL-shape parser regression coverage — documented as NEW PLAN REQUIRED if it ever needs closing; not blocking this plan

Dimension findings:
- Infra fit: PASS — migration/console/hook patterns all directly precedented in this codebase
- Test coverage: PASS — no vacuous-green risk; Known-Gap is a single named residual, not the sole coverage for any developed behavior
- Breaking changes: PASS (post-correction) — API response additive-only, confirmed via source; all 3 CONCERNs found here were resolved via plan-text fixes this session
- Security surface: PASS — no new auth/secret/trust-boundary surface; access control unchanged

Open gaps: none unresolved. One documented Known-Gap (youtube URL-shape parser regression test) — not blocking, tracked per D-resolution above.

What this coverage does NOT prove:
- `npm run typecheck` / `npm run lint`: do not prove runtime correctness of the `beforeValidate` URL
  parser logic, the click-to-load iframe behavior, or the console's server-side required-field
  check — those are Agent-Probe scenarios (AC1-AC3, AC2a, AC5-AC9), not exercised by type/lint gates.
- `curl {CMS_URL}/api/public/podcasts` (Hybrid): cannot be run in this session — no database or
  live CMS is reachable (egress proxy blocks the domain, per task constraints). This gate is
  deferred to EXECUTE/EVL, where a running CMS + seeded tenant must exist.
- The Agent-Probe rows: prove the specific scenario walked, not exhaustive coverage of every
  malformed-URL variant beyond the five documented shapes, and not load/concurrency behavior.
- Neither repo has any automated E2E/integration harness — this is a pre-existing, documented gap
  in both repos' test maturity (confirmed via `tests/all-tests.md` routing in brief-asia-web; no
  test files found anywhere under apcg-cms's `src/` during this session's source inspection),
  not something this plan is expected to build.
- This VALIDATE pass did NOT run the migration and did NOT reach a live CMS or database, per this
  session's explicit constraints — the D2/D3 non-destructive-failure-mode claim was verified via
  static analysis of Payload 3.85's installed source code, not via an empirical database probe.

Gate: PASS (no FAILs, plan updated — 5 CONCERNs found, all 5 resolved via direct plan-text edits applied this session)


## Autonomous Goal Block

```
SESSION GOAL: YouTube-embedded podcasts — required youtubeUrl on apcg-cms Podcasts collection,
click-to-load nocookie embed + real /podcasts pages on brief-asia-web
Charter + umbrella plan: N/A — single COMPLEX plan (not a phase program)
Autonomy: standard /goal autonomous execution rules apply — CONDITIONAL findings auto-fix and
proceed; BLOCKED items go to backlog + continue; irreversible/outward-facing actions without
explicit contract instruction are a hard stop.
Hard stop conditions / safety constraints:
- Never run the migration in this session/EXECUTE without live DB access confirmed available —
  plan explicitly forbids running `src/migrations/{new}_add_podcast_youtube_fields.ts` here.
- Never add a `NOT NULL` DB constraint to `youtube_url`/`youtube_id` — nullable columns +
  app-level `required: true` only (D3, verified safe against Payload 3.85 source this session).
- Never wire a new `revalidateHooks(["podcasts:all"])` on `Podcasts.ts` as an unscoped addition —
  Podcasts intentionally has no on-demand revalidation hook, matching Newsletters/Corrections
  (finding 4). Any future change to that must be its own validated decision.
- Never touch `next.config.ts` — D7 confirms zero config change is required for this plan.
- D8 types-merge (brief-asia-web `Podcast`/`PodcastsSelect` blocks) MUST run and typecheck green
  BEFORE any brief-asia-web component/page code that imports `Podcast` is written (hard ordering,
  Implementation Checklist step 6).
- `youtubeUrl`/console-whitelist edit (step 2) and console-whitelist `audioUrl` removal (step 2a)
  MUST land in the same commit/EXECUTE pass — skipping breaks every console "Add podcast"
  submission for every tenant with `features.podcasts` on.
Next phase: EXECUTE: process/general-plans/active/podcast-youtube-embed_15-09-26/podcast-youtube-embed_PLAN_15-09-26.md
Validate contract: inline in plan (## Validate Contract section, this file)
Execute start: Fully-automated — `npm run typecheck` + `npm run lint` in both repos (apcg-cms
first, then brief-asia-web after the D8 merge gate). Agent-probe pack — Implementation Checklist
step 15, all 13 manual scenarios in the Test gates table. Hybrid — `curl {CMS_URL}/api/public/podcasts`
(deferred to EXECUTE/EVL; no live CMS reachable in VALIDATE session). High-risk pack: no (migration
is additive-only nullable columns, lowest-risk shape within the schema/migration class; no
auth/billing/deploy/secret surface touched).
```
