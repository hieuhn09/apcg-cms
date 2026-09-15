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
swap work, which defeats the point of using it. **Touchpoint:** `next.config.ts` needs
`images.remotePatterns` to include `img.youtube.com` even for a plain `<img>` tag IF any other part
of the reader ever wraps it in `next/image` later — for this plan, since we use plain `<img>`, no
`next.config.ts` change is strictly required, but note it in Test Infra Improvement Notes as a
watch-item if a future pass switches to `next/image` for LCP reasons.

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
missing fields to the console; add only `youtubeUrl`.

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
  `MANAGED_COLLECTIONS.podcasts.fields`. **HARD-COUPLED to the item above (D9) — must land in the
  same commit/EXECUTE pass**, not as a follow-up; skipping this breaks every console "Add podcast"
  submission for every tenant with `features.podcasts` on the moment `youtubeUrl` becomes required.
- `src/migrations/{new}_add_podcast_youtube_fields.ts` (+ matching `.json` snapshot per the repo's
  migration convention — see `20260910_000000_add_video_support.ts` pair) — adds `youtube_url`,
  `youtube_id` nullable columns to `podcasts`.
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
  `podcasts:all` — mirrors `getNewsletters`/`getCorrections` exactly so the existing
  `afterChange`/`afterDelete` revalidation hook wiring in apcg-cms (which already busts by tag
  name, confirmed via `cms/all-cms.md` routing) requires no new hook — it already fires on any
  `podcasts` collection write. **Confirm at EXECUTE time** that the existing revalidate hook covers
  the `podcasts` collection by tag name (`podcasts:all`) — do not add a redundant hook if it does.
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
   `MANAGED_COLLECTIONS.podcasts.fields`. Do not land step 2 without this step in the same pass —
   skipping it breaks every console "Add podcast" submission the moment `youtubeUrl` is required.
3. **apcg-cms — migration.** Write `src/migrations/{timestamp}_add_podcast_youtube_fields.ts` (+
   `.json` snapshot) adding nullable `youtube_url`/`youtube_id` columns to `podcasts`, following the
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
10. `audioUrl` remains in the schema/types, unrequired, hidden from the admin UI — no data loss, no
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

(placeholder — vc-validate-agent writes this section before EXECUTE)
