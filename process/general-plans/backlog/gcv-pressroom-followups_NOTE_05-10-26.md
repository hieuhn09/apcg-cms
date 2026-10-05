---
name: note:gcv-pressroom-followups
description: "Open follow-ups after GCV Pressroom parity shipped (apcg-cms#29, gcv-web#10)"
date: 05-10-26
feature: general
---

# GCV Pressroom follow-ups (05-10-26)

Source plan: `process/general-plans/completed/gcv-pressroom_05-10-26/gcv-pressroom_PLAN_05-10-26.md`.

1. **gcv-web footer link when the pillar is absent (F1).** Hide the "Press room" footer link (data-driven, like the nav link) so it does not 404 before the CMS row is visible.
2. **Press media contact (F2).** The media-enquiries chip/email died with the static `/press` page; decide where it lives (footer, /contact, or the Pressroom page).
3. **Author/tag/search pages (F3).** Optionally exclude single-home pillars from author pages; Pressroom items with an author show a bare "N min" there.
4. **Localise / brand the "Distributed by Global Chic Voyage" string.** English-only today; JSON-LD author name is "The Global Chic Voyage".
5. **gcv-web test coverage (F4).** Only a scoped `test:single-home` helper test exists; `BylineWired` `distributed` prop and most-read are untested.
6. **Engine translation route ungated.** `POST /api/engine/translation` can still write translated text onto an existing Pressroom article (owner decision: keep).
7. **Engine 4xx handling of the new gcv 422** (`pillar not writable by engine: pressroom`) is unverified (client lives in content-engine).
8. **/admin Save Draft** shows only a generic "field is invalid" toast for a rule violation (Console shows the full text).
9. **Owner action:** `login.json` is tracked in the apcg-cms repo with a credential-shaped token; `git rm` it and consider rotating (never open or quote the file).
