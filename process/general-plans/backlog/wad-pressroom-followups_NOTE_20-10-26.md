---
name: note:wad-pressroom-followups
description: "Open follow-ups after WAD Pressroom parity shipped (apcg-cms#44, wad-web#13)"
date: 20-10-26
feature: general
---

# WAD Pressroom follow-ups (20-10-26)

Source plan: `process/general-plans/completed/wad-pressroom_20-10-26/wad-pressroom_PLAN_20-10-26.md`.

1. **Owner check (first Pressroom article).** Confirm "Distributed by / World Archi Design" on worldarchidesign.com (article byline, OG tags, JSON-LD author, tag/search result row) and that an ordinary article still shows "By <author>". Until then wad-web Stream B is CODE DONE, not VERIFIED (production has 0 WAD Pressroom articles; pillar id 38).
2. **wad-web byline has no render test.** Only the `isDistributedPillar` helper is tested (`test:single-home`, 10 tests); the JSX is verified by build only.
3. **Pressroom still in the WAD home pool, RSS and most-read.** Out of scope by owner decision; GCV and BriefAsia exclude it. Revisit if the owner wants parity.
4. **Credit string is English-only** ("Distributed by" / "World Archi Design"); not localised.
5. **Engine translation route ungated.** `POST /api/engine/translation` can still write translated text onto an existing WAD Pressroom article (owner decision: keep, same as BriefAsia and GCV).
6. **Engine 4xx handling of the new wad 422** (`pillar not writable by engine: pressroom`) is unverified (the client lives in content-engine).
7. **Hub authoring into WAD Pressroom is now refused** (`blocked_pillar`) by design; editors create Pressroom articles in /admin or the Console.
8. **FE constant duplicates the CMS constant.** wad-web `src/lib/single-home-pillars.ts` must be kept in sync with `SINGLE_HOME_PILLARS.wad`.
9. **/admin Save Draft** shows only a generic "field is invalid" toast for a rule violation (the Console shows the full text). Same as GCV.
