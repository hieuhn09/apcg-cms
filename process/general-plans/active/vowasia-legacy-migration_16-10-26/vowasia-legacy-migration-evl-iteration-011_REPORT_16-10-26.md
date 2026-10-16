# EVL iteration 011 — vowasia-legacy-migration (phase A, Amendment 1, doc fixes)

Date: 16-10-26. Loop driver: orchestrator.

## Before
Fix cycle b0f5b89 applied. Independent EVL (fresh vc-tester): all gates green (G1 56/56, G4 69/69, G5 267/267, G6 probe exit 0 with clean-up, password gate not blind: 6/6 mutations red), 0 BLOCKER/MAJOR, 1 MINOR (the doc still contains the words "Cmd+H" in a warning sentence) and 1 NIT.

## G9 delta review: APPROVE_WITH_CONCERNS
0 BLOCKER, 0 MAJOR; 13/13 earlier findings fixed (#13 only partly: plan says base64, doc/code use hex). Reviewer read Supabase's open-source pg-meta: the Editor sends the pasted text with one pool.query on a shared pool, no wrapping transaction, and shows the last result with rows, which supports the one-query assumption (still not tried on the real Editor). No path found that damages the old sites. New MINOR (documentation): MIN-1 searching `__` always finds one hit (comment in 03e); MIN-2 the stop table lacks "role already exists" (second run of B3); MIN-3 B2 stop forecast lists only in_public=yes; MIN-4 "password still in the clipboard" is wrong in the documented order (copying the connection string overwrites it); MIN-5 trigger-returning SECURITY DEFINER functions are no longer blocked and could in theory be fired through a temp table by the role (needs default_transaction_read_only off, which the tool cannot do) -> one honest sentence; MIN-6 route B lacks the 14-day expiry warning and the warning that the views lock the columns of articles/sites. NITs: md5 password_encryption, copy-button fallback, clearing the clipboard, site-id sharing hint, G10a wording, plan base64 vs hex.

## Decision
Doc/comment-only fix cycle (no SQL logic change), then a lightweight independent EVL re-run (no full G9 round). The plan gets the base64 -> hex and G10a wording fixes.
