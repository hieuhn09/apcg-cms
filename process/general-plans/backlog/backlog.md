# Backlog

Actionable follow-up items surfaced during EXECUTE/UPDATE PROCESS sessions but not
in scope for the plan that found them. Each entry: Priority, Problem, Root cause /
context, Fix options.

---

## 1. Manual verification checklist — article-video-support (11 of 18 criteria unproven)

**Priority:** HIGH — feature is merged to `main` in both `apcg-cms` and `brief-asia-web`
and is code-complete, but was never run against a live DB/admin/browser. Do this
before enabling `Tenants.features.video` for BriefAsia in production.

**Problem:** 11 of the 18 SPEC acceptance criteria for article video support
(`process/general-plans/completed/article-video-support_10-09-26/article-video-support_SPEC_10-09-26.md`)
have zero automated proof — both repos have no test runner beyond `tsc --noEmit` +
`next lint`. All 11 are Agent-Probe-only (manual admin/browser/API walkthroughs),
and none were executed during EXECUTE/EVL because the session had no DB, no
running admin, and no browser.

**Root cause:** neither `apcg-cms` nor `brief-asia-web` has an e2e/integration test
harness; this is a structural property of both repos (see Test Infra Gaps Found in
the archived phase report), not a defect introduced by this feature.

**Outstanding manual checks** (from
`article-video-support_REPORT_10-09-26.md` §Outstanding — needs a human):

1. **[HIGHEST] Hero-required validation** — save a BriefAsia article with a video
   and NO hero image; expect a block. If it saves, apply the documented
   `beforeValidate` fallback (the field-level `validate` primary path is
   UNTESTED). *(Criteria 6, 12)*
2. **Description-required** — same test with `videoDescription` blank; expect a
   block. *(Criterion 8)*
3. **Migration applies** — run `20260910_000000_add_video_support.ts` against a
   real dev DB (hand-written, never executed — see item 2 below), then load the
   Payload Tenants list AND the console per-tenant settings page; expect no SQL
   error. *(Risk 4)*
4. **Upload round-trip** — upload a <20MB video with hero present, save, reload,
   confirm persistence; then a >20MB file, expect the same rejection UX as an
   oversized image. *(Criteria 1, 10)*
5. **Cross-tenant UI** — open the article editor on a non-BriefAsia tenant;
   inspect the DOM (not just visually) for the 4 video fields; expect absent.
   *(Criterion 2, UI half)*
6. **Cross-tenant API** — local-API `update` setting `video` on a non-enabled
   tenant's article; expect the value discarded. *(Criterion 2, API half)*
7. **List JSON** — raw `/api/public/articles` for a video-bearing article; expect
   no `video`/`videoCaption`/`videoCredit`/`videoDescription` keys at all.
   *(Criterion 4)*
8. **Listing surfaces** — homepage, pillar front, related row, tag, author,
   search, RSS, OG image: `<img>` only, never `<video>`. *(Criterion 4)*
9. **No prefetch** — network tab on a video article: zero video byte-range
   requests before pressing play; full controls after. *(Criterion 5)*
10. **Article page** — video article shows the player with hero as poster;
    non-video article's hero slot is unchanged. *(Criteria 3, 6)*
11. **Second-tenant adoption** — flip another tenant's `video` flag with zero
    source edits; confirm the field appears and the resolved object reaches that
    tenant's API. *(Criterion 14)*
12. **Resolved object** — fetch a video article via
    `/api/public/articles/[slug]`; confirm all six fields present, `posterUrl` a
    real usable URL. *(Criterion 16)*
13. **Caption/credit optional** — save a video with caption/credit filled in,
    save another with both blank; both save successfully. *(Criterion 7)*

**Fix options:**
- (a) Run all 13 checks manually against a local/staging deploy before enabling
  the feature flag for BriefAsia — cheapest, matches the plan's own Phase
  Completion Rules ("code-complete and VERIFIED are not the same status").
- (b) Build a minimal e2e harness (Playwright against a local Payload admin) that
  can at least assert Criteria 2, 4, 5, 9, 16 (the DOM/network/API-shape ones) —
  this is the "Test Infra Gaps Found" fix, bigger scope than this feature alone.

---

## 2. Deferred: hero image required on every article, all 12 tenants (Requirement B)

**Priority:** MEDIUM — was in-scope in an earlier SPEC revision, then explicitly
descoped by the user (see the SPEC's revision note) because it was bundled in only
via a poster-image connection, not an inherent dependency. The conditional
(video-only) hero requirement shipped instead; this is a separate, larger,
independently-scoped change.

**Problem:** make `Articles.heroImage` required for ALL tenants and ALL paths that
create an article, including engine intake — not just the video-conditional rule
already shipped.

**Context preserved from the descoped analysis** (do not re-derive):
- Confirmed via `docs/06-architecture-and-decisions.md` §Payload gotchas learned:
  Payload's `required: true` is application-layer only, never a DB `NOT NULL` —
  so this change is one line in `Articles.ts` and fully reversible; no migration
  needed for the field itself (though existing null-hero articles will start
  failing re-saves once required, so a backfill/audit pass is still needed first).
- Three engine gates were verified as the enforcement points for engine-created
  articles (content-engine repo, read-only reference during the video work):
  - `content-engine/src/jobs/editorial-job.ts:279`
  - `content-engine/src/jobs/editorial-job.ts:557`
  - `content-engine/src/jobs/editorial-job.ts:913`
- **Gating pre-condition (not yet run):** count `heroImage IS NULL` across all 12
  tenants (published, draft, AND `_articles_v` version rows) before enabling this
  requirement anywhere. Nobody in the article-video-support session had database
  access to run this count — it must happen before this item is picked up.

**Fix options:**
- (a) Run the null-hero count first (needs DB access); if the count is
  near-zero, ship as a straightforward conditional-to-blanket `validate` change
  + engine-side enforcement update at the three gates above.
- (b) If the count is large, this becomes a backfill project (assign placeholder
  heroes or exempt legacy articles by publish date) before the requirement can be
  turned on — scope it as its own plan once (a) is known.

---

## 3. `payload-types.ts` cross-repo drift (apcg-cms → reader repos)

**Priority:** LOW-MEDIUM — real, pre-existing, and multiplies across 8+ reader
repos (brief-asia-web, dtw-web, wad-web, gcv-web, wtb-web, asia-awards-web,
dailytechwire-web, APCG-web).

**Problem:** there is no script or automation in either repo that syncs
`apcg-cms`'s generated `payload-types.ts` into a reader repo's own copy. During
the article-video-support work, a "wholesale copy" step in the plan (see D1 in
`article-video-support_REPORT_10-09-26.md` §Plan Deviations) turned out to be
wrong: `brief-asia-web`'s `payload-types.ts` is NOT a byte-identical mirror of
apcg-cms's — a full overwrite produced +1387/-331 lines and broke reader
typecheck in ~10 unrelated places (newsletters, market-ticker, corrections,
`article-view.ts` authors). All of that drift was pre-existing and unrelated to
video; a surgical merge of only the new video types was used instead as the
fallback.

**Root cause:** no sync tooling exists in either repo; each reader repo's copy of
`payload-types.ts` has drifted independently since it was first copied.

**Fix options:**
- (a) Build a small script (in `apcg-cms` or a shared tooling location) that
  diffs the CMS-generated types against a target reader repo's copy and reports
  (or applies) only the additive changes — avoids the "wholesale overwrite breaks
  unrelated code" failure mode discovered here.
- (b) At minimum, document the surgical-merge pattern (already done — see
  `article-video-support_ADOPTION-NOTE_10-09-26.md` §2) as the standing
  recommendation until (a) exists, and flag this backlog item to whoever next
  touches types in any reader repo.
