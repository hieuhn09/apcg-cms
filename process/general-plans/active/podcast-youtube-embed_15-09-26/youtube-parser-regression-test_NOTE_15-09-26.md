---
name: note:youtube-parser-regression-test
description: "Backlog — no automated regression test protects extractYoutubeId against a future YouTube URL-shape change"
date: 15-09-26
metadata:
  node_type: memory
  type: report
  feature: general
---

# Backlog: YouTube URL-shape parser regression coverage

**Known-Gap carried from the `podcast-youtube-embed` plan's validate-contract (row: Known-Gap, resolution D).**

`apcg-cms/src/lib/youtube.ts` `extractYoutubeId()` is the single gate deciding what
counts as a valid YouTube link for the `podcasts` collection. It handles the five
documented shapes (`watch?v=`, `youtu.be/`, `/live/`, `/shorts/`, `/embed/`) plus
ignored query params.

**The gap:** if YouTube ships a new URL pattern, the parser starts rejecting valid
links and nothing fails loudly — the first signal is an editor unable to save.

**Why it is not closed here:** neither repo has an automated test runner
(`brief-asia-web/process/context/tests/all-tests.md`: gates are `tsc --noEmit` +
`next lint` only; apcg-cms has no test harness either). Closing this means
introducing a test runner, which is its own decision and its own plan.

**When a test harness lands in apcg-cms, retro-fit:** a table-driven unit test over
`extractYoutubeId` covering the five accepted shapes, the param-carrying variants,
and the rejection cases (empty, `https://vimeo.com/123`, wrong-length id).
