---
phase: article-video-support
date: 2026-09-10
status: COMPLETE_WITH_GAPS
feature: article-video-support
plan: process/general-plans/active/article-video-support_10-09-26/article-video-support_PLAN_10-09-26.md
---

# EXECUTE report — Video support for articles

All 4 automated gates green in both repos. Checklist steps 1–24 complete.
Code-complete, NOT verified: every Agent-Probe criterion needs a human.

## What Was Done

### apcg-cms (12 files)
| File | Change |
|---|---|
| `src/lib/upload-integrity.ts` (NEW) | The 5 upload-integrity functions, extracted verbatim from `Media.ts` (JSDoc incl. all 4 "11-08-2026" incident notes preserved; `verifyClientUpload`'s in-transaction `APIError` throw unchanged). |
| `src/collections/Media.ts` | Import swap only — diff is imports and nothing else. Config/fields/mimeTypes byte-identical. |
| `src/collections/VideoMedia.ts` (NEW) | `videoMedia`, `featureGatedAccess("video", tenantManagedAccess)`, `mimeTypes:["video/*"]`, no `imageSizes` key, shared hooks, `prefix` field. |
| `src/lib/tenant.ts` | `tenantHasFeature()` = `featureEnabled(await findTenantById(...))`. Fails closed. |
| `src/lib/constants.ts` | `"video"` in `FEATURE_KEYS`; `video: ["videoMedia"]` in `FEATURE_COLLECTIONS` (Step 4a — without it typecheck fails). |
| `src/collections/Tenants.ts` | `features.video` checkbox, default false. |
| `src/console/data/schema.ts` | `featuresVideo: boolean("features_video")`. |
| `src/console/data/tenants.ts` | `video: Boolean(r.featuresVideo)` — keeps `Record<FeatureKey, boolean>` exhaustive. |
| `src/collections/Articles.ts` | `canSetVideo` (inline, next to `canFlagExclusive`); 4 new fields on the Media tab; conditional `validate` on `heroImage` and `videoDescription`. |
| `src/components/admin/VideoFieldGate.tsx` (NEW) | Client field gate — `useTenantSelection()` → REST `features.video` → render or `null`. Fails closed (hidden while loading). |
| `payload.config.ts` | `VideoMedia` imported + in `collections[]` + multi-tenant map + s3Storage map. `fileSize` untouched. |
| `src/migrations/20260910_000000_add_video_support.ts` (NEW) + `index.ts` | Idempotent DDL, 20260904 style. |
| `src/app/api/public/articles/route.ts` | `LIST_SELECT` excludes the 4 video fields individually. |
| `src/lib/article-video.ts` (NEW) + `articles/[slug]/route.ts` | Server-side `resolveArticleVideo(doc)`; route returns the resolved object or `null`. |

### brief-asia-web (5 files)
`payload-types.ts` (video types merged in — see Deviation D1), `src/lib/article-video-view.ts` (NEW), `src/components/article/video-player.tsx` (NEW), `article-content.tsx` (new `video` prop + hero branch), `article/[slug]/page.tsx` (computes + threads `video`).

`ArticleView` gained NO video field. No card/listing/RSS/OG file was touched.

## Test Gate Outcomes
| Gate | Result |
|---|---|
| `apcg-cms npm run typecheck` | PASS (exit 0, no output) |
| `apcg-cms npm run lint` | PASS (0 errors; pre-existing warnings in old migrations only, none in touched files) |
| `brief-asia-web npm run typecheck` | PASS (exit 0) |
| `brief-asia-web npm run lint` | PASS (0 errors; pre-existing `_locale` warnings only) |
| tenant-slug grep | PASS — 3 hits, all pre-existing prose comments in untouched regions; 0 in video code |
| `git diff payload.config.ts \| grep fileSize` | PASS (no output) |
| shared upload-integrity | PASS — both collections import; neither defines locally |
| naming (`videoMedia`/`video-player`/`video`) | PASS |
| adoption note 3 sections | PASS |
| engine intake untouched | PASS (`git status` clean for `src/app/api/engine/`) |
| `Media.mimeTypes` still `["image/*"]` | PASS |

## Plan Deviations
- **D1 (material) — Step 18 wholesale type copy was wrong as written.** The plan asserts brief-asia-web's `payload-types.ts` "is already a full-file mirror". It is not: overwriting it wholesale produced 1387 insertions / 331 deletions and **broke reader typecheck in ~10 unrelated places** (newsletters, market-ticker, corrections, `article-view.ts` authors) — all pre-existing drift, none video-related. Baseline confirmed green pre-copy. I reverted and did a **surgical merge** of exactly the video types (`VideoMedia` interface, `Article.video*` ×4, both select maps). This satisfies the touchpoint row's stated purpose verbatim; only the word "wholesale" was based on a false premise. The reader's type file also has no `Tenant` interface, so `VideoMedia.tenant` was dropped (reader never reads it).
- **D2 — component path syntax.** Plan said `"@/components/admin/VideoFieldGate#default"`. Payload's importmap generator resolves paths relative to `baseDir` and does **not** resolve `@/` tsconfig aliases (verified in `payload/dist/bin/generateImportMap`). Used `"./src/components/admin/VideoFieldGate#..."`. The plan itself instructed me to confirm this rather than assume.
- **D3 — two gate exports, not one `default`.** Payload's default renderer differs by field type, so a single component cannot render both an upload and a text field. Exported `VideoUploadFieldGate` (wraps `UploadField`) and `VideoTextFieldGate` (wraps `TextField`).
- **D4 — Step 19's typing premise wrong.** `payload-types.ts` is generated from collection config and types `Article.video` as the raw relation; it cannot know the route post-resolves it. `toArticleVideoView` therefore narrows at **runtime** instead of leaning on the generated type. Still a pure pass-through — no lookups, no re-derivation (Criterion 16 intact).
- **D5 — migration additions beyond Step 13a's DDL.** Step 13a's fallback column list omitted `payload_locked_documents_rels.video_media_id` (+FK +index), which every added collection needs (the `cities` precedent, `20260714_add_wtb_schema`). Added. Also: Payload snake-cases the slug, so the table is **`video_media`**, not `"videoMedia"`.
- **D6 — `VideoPlayer` renders the figcaption too.** Step 20 says the component renders caption/credit in a figcaption; Step 22 says swap it in for the ternary. Doing both literally would nest two figcaptions in one figure. The video branch now replaces the whole figure body; the non-video branch is byte-identical to before.

## Fallbacks Taken
1. **siblingData (Gaps 6a/6b): primary path shipped, UNTESTED.** Field-level `validate` is what shipped. The load-bearing test (save video with no hero → expect block) requires a live admin + DB, which this environment has neither of. **The `beforeValidate` fallback has NOT been applied** — it is still the correct next move if the manual test fails. This is the single most important outstanding item.
2. **`videoMedia` table (Step 13): fallback taken — hand-written DDL.** No `.env`/DB, so `payload migrate:create` cannot run. Wrote the table by hand per Step 13a, mirroring `media` minus `sizes_*`/`alt`/`caption`/`credit`, plus `prefix`.
3. **Admin component (Step 9): primary path shipped.** `useTenantSelection` confirmed exported by `@payloadcms/plugin-multi-tenant@3.85.1`'s `/client` entry (read from installed `node_modules`), returning `selectedTenantID`. The cookie-parse fallback is wired in defensively as the plan mandates.

## Test Infra Gaps Found
Neither repo has a test runner beyond `tsc --noEmit` + `next lint` — pre-existing and out of scope. **11 of 18 acceptance criteria have no automated proof.** A future refactor could silently reintroduce a video leak on a listing surface with no gate to catch it.

## Outstanding — needs a human (Agent-Probe)
None of these were faked; none can run here (no DB, no browser, no admin session).

1. **[HIGHEST] Hero-required validation** — save a BriefAsia article with a video and NO hero image. Expect a block. If it saves, apply the documented `beforeValidate` fallback. *(Criterion 6/12, Risk 2)*
2. **Description-required** — same, with `videoDescription` blank. Expect a block. *(Criterion 8)*
3. **Migration applies** — run it against a dev DB, then load the Payload Tenants screen AND the console per-tenant settings page. Expect no 500. *(Risk 4)*
4. **Upload round-trip** — upload a <20MB video with hero present; save; reload; confirm persistence. Then a >20MB file: expect the same rejection UX as an oversized image. *(Criteria 1, 10)*
5. **Cross-tenant UI** — open an article editor on a non-BriefAsia tenant; **inspect the DOM** (not just visually) for the 4 video fields. Expect absent. *(Criterion 2 UI half)*
6. **Cross-tenant API** — local-API `update` setting `video` on a non-enabled tenant's article; expect the value discarded. *(Criterion 2 API half)*
7. **List JSON** — raw `/api/public/articles` for a video-bearing article: expect no `video`/`videoCaption`/`videoCredit`/`videoDescription` keys at all. *(Criterion 4)*
8. **Listing surfaces** — homepage, pillar front, related row, tag, author, search, RSS, OG image: `<img>` only, never `<video>`. *(Criterion 4)*
9. **No prefetch** — network tab on a video article: zero video byte-range requests before pressing play; full controls after. *(Criterion 5)*
10. **Article page** — video article shows the player with hero as poster; non-video article's hero slot is unchanged. *(Criteria 3, 6)*
11. **Second-tenant adoption** — flip another tenant's `video` flag with zero source edits; confirm field appears and the resolved object reaches that tenant's API. *(Criterion 14)*
12. **Resolved object** — fetch a video article via `/api/public/articles/[slug]`; all six fields present, `posterUrl` a real usable URL. *(Criterion 16)*

## Observations (not deviations)
- `VideoMedia.access` has no `read: () => true` override (plan-specified). `Media` needed one because `<img src>` cannot carry a Bearer token. `<video src>` has the same constraint. It is fine while `R2_PUBLIC_BASE_URL` is set (bytes come from the R2 CDN, `disablePayloadAccessControl: true`), but if that env var is ever unset, `/api/videoMedia/file/...` will 403 for anonymous readers — exactly the failure `Media` documents. Worth a follow-up decision.
- `verifyClientUpload`'s error text says "the image did not reach storage" and its log line is prefixed `media:`. Kept verbatim (pure move, no behaviour change) — a video upload failure will therefore say "image". Cosmetic; flagging rather than silently changing shared code.

## Closeout Packet
- **Plan:** `process/general-plans/active/article-video-support_10-09-26/article-video-support_PLAN_10-09-26.md`
- **Finished:** checklist 1–24 incl. 4a/5a/6a/6b/13a. Both repos' automated gates green.
- **Verified:** type + lint soundness, and every static/grep structural gate. **Unverified:** all runtime behaviour — migration application, upload round-trip, validate firing, admin gate mounting, reader rendering.
- **Remaining:** the 12 manual checks above; then context capture.
- **Classification: Keep in active/testing.** Code-complete but not VERIFIED; per the plan's own Phase Completion Rules this must not be marked verified without explicit user confirmation of the manual checks.

## Forward Preview
- **Test infra found:** none beyond `tsc --noEmit` + `next lint` per repo.
- **Blast radius changes:** +1 file vs plan in apcg-cms (`src/components/admin/VideoFieldGate.tsx` was anticipated; no unplanned files). Reader stayed at the planned 5.
- **Commands to stay green:** `cd apcg-cms && npm run typecheck && npm run lint`; `cd brief-asia-web && npm run typecheck && npm run lint`.
- **Dependency changes:** none. No package added to either repo.
