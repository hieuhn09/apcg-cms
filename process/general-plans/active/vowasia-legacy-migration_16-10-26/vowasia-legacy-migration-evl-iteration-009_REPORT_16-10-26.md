# EVL iteration 009 — vowasia-legacy-migration (phase A, Amendment 1)

Date: 16-10-26. Loop driver: orchestrator.

## Before
Amendment 1 (3d26fe5). Independent EVL: all gates green, CLEAN (G10b corrected command proven not blind against the single mutation the plan asked for).

## G9 independent review: REQUEST_CHANGES
No path found that damages the old GTP/VowAsia sites; every failure branch closes safely. 3 MAJOR, 10 MINOR, 1 NIT:
- #1 MAJOR 02p does not stop when `__PASSWORD__` is left unreplaced (role LOGIN with a guessable password for 14 days). Reviewer's better design: generate the password inside SQL (EXECUTE format), show it in the result cell, so the query text carries no secret.
- #2 MAJOR doc says Cmd+H for find/replace; on macOS that is "hide window" (Monaco's find-replace on Mac is Cmd+Option+F; verified in node_modules/monaco-editor findController).
- #3 MAJOR (usability; still closed-safe) 02 STOP paths have no exit in the doc: SECURITY DEFINER in `public` is a hard stop, PUBLIC-readable relations outside vowasia_ro, PUBLIC CREATE on a schema; 01e does not preview them; section 5d counts more than 02 does. Risk: the owner "fixes" a STOP with REVOKE ... FROM PUBLIC, the one action that could hurt the old sites.
- #4 redact() does not mask the pooler login name (project ref leaks to stderr in a driver error); doc claims it is never printed.
- #6 DB-name guard is meaningless on Supabase (every database is `postgres`); doc B1 should require checking the project name.
- #7 RAISE NOTICE not shown in the Editor (02b BEFORE state, 03e AFTER); ban 02b in route B.
- #8 01e is one statement, so one failure kills it; put section 6 (site rows) first, add a total-rows row, give a fallback query; 6b ordering interleaves tables.
- #10 01e does not list databases PUBLIC can CONNECT to.
- #12 the corrected password gate is blind to 4 variants (real password on the same line as the placeholder, E'...', $$...$$, PASSWORD then newline). Whitelist gate recommended.
- #5, #11, #13 recorded as known limits (regex tight; probe auth is trust and superuser; SSL require without CA; plan risk (c) says base64 but code uses hex).

## Decision
One fix cycle: password generated in SQL (no secret typed or replaced), Mac shortcut fixed, STOP guide + 01e additions, trigger-returning functions excluded from the DEFINER guard (they cannot be called directly), redact the login name, doc limits. Then the plan's password gate is rewritten for the final 02p shape. Then fresh EVL + delta G9 review. The owner runs nothing until the fixed files are pushed.
