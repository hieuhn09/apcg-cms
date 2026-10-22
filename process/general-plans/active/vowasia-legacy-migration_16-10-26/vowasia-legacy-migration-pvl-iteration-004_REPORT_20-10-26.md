# PVL iteration 004 (B-beta supplement cycle 1), 20-10-26

**Result: all 14 gaps from the B-beta PVL pass 1 (F1, C1-C13) addressed in the plan; re-validation from V1 next.**

- Input: `vowasia-legacy-migration-pvl-b-beta_REPORT_20-10-26.md` (Gate BLOCKED, 1 FAIL + 13 CONCERN).
- F1: owner rule C3/Q1/Q9 restored; the orchestrator default "every non-public row redirects to its pillar" is withdrawn. Map = 349 (12 x 410 + 337 x 308); 21 old drafts listed in the report only.
- C7: owner answered 20-10-26 "Dừng ngay", recorded as Q12: a store-level upload error stops the run before the article is created; C6 still covers bad/missing images in the snapshot.
- C1-C6, C8-C13: fixed as requested (dates on both bases, URL classification + OB5 stop, body as escaped text, lock scope + stale-lock procedure, rehearsal bootstrap, fixture file, required `--runs-dir`, rollback reference scan, G19/G11 at EVL only, pinned imports only, taxonomy STOP).
- G7/G7b base pinned to `9d9e5a4`.
- New open owner items, no default: O-B5 (the 4 off-allow-list links, answered at OB5), O-B12 (redirect for a published row that becomes draft from a broken stored image; expected count 0).
- Residual noted by the planner: §3.4 step 8 keeps the historical `--min-coverage` sentence; CF1 is fixed in §4.4 item 8 and G28.
- Plan validator: 0 failures, 0 warnings.

Next: re-spawn vc-validate-agent from V1 (B-beta pass 2).
