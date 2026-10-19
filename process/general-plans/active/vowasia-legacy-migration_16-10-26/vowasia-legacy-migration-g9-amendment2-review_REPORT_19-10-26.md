# G9 independent security review: Amendment 2 (pg_net allow-list + role-setting self-check)

Date: 19-10-26. Reviewer: vc-code-reviewer (read-only static review, no DB, no probe run).
Scope: `git diff 8c59f5c..HEAD` (e424446, 2ba3d96): `sql/02-create-readonly-role-views.sql.template`, `sql/01e-inspect-single-result.sql`, `sql/03e-drop-in-editor.sql.template`, `VOWASIA-LEGACY.md`, `lib/vowasia-sql.test.ts`, `fixtures/keyset-probe.ts`, plan and report.

## Verdict: APPROVE_WITH_CONCERNS

TL;DR: the SQL logic is sound and fails closed. No BLOCKER. One MAJOR that is a wording fix: the docs understate what the allow-list gives the role (reading is unconditional, and writing the queue table may mean outbound HTTP from the database host). Fix that text before the owner runs B3; everything else is optional hardening.

## Findings

### MAJOR-1: residual risk is understated (docs honesty)
- `02...template:52-61` says the role "về lý thuyết đọc/ghi được hai bảng đó nếu tự tắt default_transaction_read_only"; `VOWASIA-LEGACY.md:341` and plan Amendment 2 item 2 / Known-Gap K2 repeat that framing.
- Reading is NOT conditional. `default_transaction_read_only` does not restrict SELECT. The role can read `net._http_response` (response bodies of other webhook / edge-function / cron calls of the old site, about 28 rows seen) and `net.http_request_queue` immediately, with no `SET`. The probe itself does this (`keyset-probe.ts` G14a `SELECT count(*) FROM net._http_response`).
- The write path is worse than "writes 2 tables". By pg_net's design a background worker consumes `net.http_request_queue`; a role that turns read-only off can enqueue arbitrary outbound HTTP from the DB host (SSRF toward internal addresses), forge `_http_response` rows the old site may read back, or delete/truncate them (breaking old-site webhooks). I did not verify this against a live pg_net; treat as "by design, unverified here".
- Net effect: a leaked migrator password used to mean "VowAsia rows, read only". It now also means "other integrations' response data plus a possible outbound-request primitive". The owner approved "A" on the K2 wording, so the decision basis is incomplete.
- Fix (text only): state (a) reads are unconditional, (b) queue writes may cause outbound HTTP, (c) data in `_http_response` may be sensitive, (d) the mitigations are the 14-day expiry, owner-only password, removing the role at B6 (also: keep the password out of any machine that others can reach). Add to K2 and to B2 paragraph at `VOWASIA-LEGACY.md:341`.

### MINOR-1: allow-list is name-only; add cheap defense in depth
- `02:162` and `02:167` match `nspname || '.' || relname` + `relkind 'r'`. Name decomposition is unambiguous (the string has exactly one dot, so only schema `net` + rel `_http_response` / `http_request_queue` matches), quoting/case tricks and lookalikes just fail to match and therefore STOP. Good.
- Not covered: a hostile or unrelated local object that happens to be called `net.http_request_queue`; a child table that INHERITS from an allowed table (selecting the parent reads child rows with only the parent's ACL checked); triggers or rules on the allowed tables (the file already admits SECURITY DEFINER trigger functions are not blocked, and these tables are now a writable surface that fires them).
- Suggested extra checks inside the exemption (all cheap): table is a member of extension `pg_net` (`pg_depend.deptype = 'e'`), no `pg_inherits` rows, no `pg_trigger` with `NOT tgisinternal`, no rewrite rules. Not exploitable without a local hostile object, so MINOR.

### MINOR-2: SQL Editor error path has no cleanup instruction (unverified, K1)
- `VOWASIA-LEGACY.md:363-368` says that after an error "cả giao dịch đã huỷ". That is true for psql with ON_ERROR_STOP. In a hosted editor that sends the script as one message, an error inside an explicit `BEGIN` can leave the session in an aborted transaction until `ROLLBACK`. Locks taken by `CREATE VIEW` (AccessShare on `public.articles` / `public.sites`) are then held, and a queued `ALTER TABLE` on the old site would stall behind them.
- Fix: add one line to B3 and the STOP table: after any error run `ROLLBACK;` in the same tab, then close the tab. Harmless if nothing is open.

### MINOR-3: final status SELECT is weaker than the checks before it
- `02:197-204` only proves that role, schema, views and SELECT exist. Case: a leftover `vowasia_migrator` exists, `CREATE ROLE` (`02:96`) fails, psql runs without ON_ERROR_STOP, `COMMIT` becomes ROLLBACK, and the final SELECT prints `SELF-CHECK OK` from the old state. Header lines 27-28 promise `FAILED` in the "no ON_ERROR_STOP" case; that only holds when nothing pre-existed. In the Editor an error aborts the whole script, so the case is not reachable there.
- Because the Editor hides NOTICE (`02:171` is invisible there), also make the final SELECT report `default_transaction_read_only=on` (pg_db_role_setting), `rolvaliduntil`, and the allow-listed relations the role can reach, as extra columns (03e already does this style).

### MINOR-4: probe runs PG16, target is PG17
- The observed ACL on the net tables contains MAINTAIN (PG17-only, plan Amendment 2 "Sự kiện quan sát"). `keyset-probe.sh` starts PG16, so `GRANT ALL ... TO PUBLIC` there has no MAINTAIN, and G14a ("write refused in the default read-only session") says nothing about MAINTAIN-class commands (VACUUM, REINDEX, CLUSTER, LOCK TABLE; some of these may be allowed in a read-only session, unverified). `02:160-161` privilege lists omit MAINTAIN (adding it would error on PG<17).
- Fix: say so in the Known-Gaps (K1 mentions the Editor, not the PG16/17 difference), or run G14 once on PG17 if a binary exists.

### NIT-1: 01e/02 consistency (checked, consistent, one cosmetic gap)
- Allow rule is textually identical: `01e:152` vs `02:162`. Section title is identical at `01e:149` and `01e:223`, so the "(none)" row logic still works. Filters (schemas excluded, relkinds, PUBLIC USAGE, table and column ACL) match; 01e uses "any PUBLIC ACL entry", 02 uses a fixed privilege list, so 01e can list a row (for example MAINTAIN-only) that 02 would not stop on. Direction is conservative.
- Because allowed rows now always appear in 5f, the owner must count rows without the label. Add one row "rows 02 would stop on = N" to 01e to remove that judgement.

### NIT-2: other relkinds (pre-existing)
- Sequences (relkind `S`), large objects, and ordinary SECURITY INVOKER functions executable by PUBLIC are not examined by 02 or 01e. Not introduced by this diff.

### NIT-3: test gap already declared
- Mutation M4 (setting self-check disabled) is caught only by the probe, not by the unit test. Acknowledged in the report.

## Checked and found sound (answers to the review questions)
1. Allow-list bypass: dots/quotes/case, relkind p/v/m/f (all stay blocked; the probe covers a view with an allowed name), column-level grants (`has_any_column_privilege`), same name in another schema (G14c). Residuals are in MINOR-1.
2. Setting check: the row `(setdatabase 0, setrole role)` is exactly what `ALTER ROLE ... SET` writes; the role is brand new, so no `IN DATABASE` override can exist yet; `DROP ROLE` removes the settings; stricter spellings (`true`, other casing) fail closed with a STOP. It proves a default only; the role can still `SET` it off or pass it as a connection option (stated as K2).
3. Abort: every failure is `RAISE EXCEPTION` in one DO block, with no handler that swallows it; psql with ON_ERROR_STOP exits, without it COMMIT becomes ROLLBACK. Caveat in MINOR-3.
4. Editor: ARRAY constant, `text[]` comparison, `||` vs `=` precedence, and `%` in messages are valid; I found no new `__` strings (the "search `__` must find 0" instruction still works); an unfilled `__ARTICLE_COLUMNS__` fails at CREATE VIEW. NOTICE invisibility and ROLLBACK: MINOR-2 and MINOR-3.
6. Docs: K1 (not tried in the real Editor), K2 (SET can turn off read-only) and K3 (other projects need a new amendment) are present; no instruction to REVOKE/GRANT in `net` (explicitly forbidden); the new Notes "Recently Deleted" step improves secret handling; no password or URL is logged by the new probe code. Honesty gap: MAJOR-1.
7. 03 / 03e: `DROP SCHEMA`, `DROP OWNED BY`, `DROP ROLE` do not depend on the role's read-only default and the PUBLIC grants on `net` are untouched, so cleanup still works.

PLAN UPDATE REQUEST:
- Section: Amendment 2 Known-Gap | Issue: K2 says "reads/writes only if read-only is turned off" | Recommended addition: reword K2 to say reads are unconditional and queue writes may trigger outbound HTTP, then re-confirm the owner's "A" decision with that wording.
- Section: Amendment 2 Known-Gap | Issue: probe is PG16, target PG17 (MAINTAIN) | Recommended addition: add K4 "G14 not run on PG17; MAINTAIN-class commands not tested".
- Section: Cách B (B3 error handling) | Issue: no ROLLBACK guidance | Recommended addition: after any B3 error run `ROLLBACK;` and close the tab.

**Status:** DONE_WITH_CONCERNS
**Summary:** Amendment 2 SQL is sound and fails closed; no blocker. Verdict APPROVE_WITH_CONCERNS.
**Concerns/Blockers:** MAJOR-1 (risk wording) should be fixed before the owner runs B3; MINOR-1..4 optional hardening.
