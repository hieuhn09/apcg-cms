# G22 review, stage B-beta (20-10-26)

**Verdict: APPROVE_WITH_CONCERNS. 0 BLOCKER, 0 MAJOR, 5 MINOR, 5 NIT.** Static review of 68b048f..7390d6c (53 files); no tests or DB run by the reviewer. Saved by the orchestrator from the reviewer's hand-back (the reviewer agent may not write report files). Evidence pack: `harness/review-decision.json` written; `validate-risk-artifacts.mjs` exits 0 (0 failures, 0 warnings). Note: `decision` is `approved-with-concerns` (the form `validate-risk-artifacts.mjs` accepts); `validate-evidence-pack.mjs` wants APPROVE|REJECT and is not the contract's validator.

## Confirmed
- Create-only: creates are articles + media only; the only update is rewrite-links on same-run, marker, same-tenant, untouched, `rewrite`-answered rows; deletes only in rollback; missing taxonomy/author raises `TaxonomyStop` before any write, dry-run included.
- Guards: `centralTarget` first in all 5 tools (DB name printed, host guard with TTY on --apply, /neondb name guard); import needs --runs-dir, new --run-id, no --resume, --expect-sha256 on apply, R2 names preflight (names only). `assertOutsideRepo` on --runs-dir, --snapshot, redirects --out, and the answer file's real folder (E17). Lock `O_EXCL`, only --apply of import/rollback/rewrite-links, no override flag.
- Rollback: only run slug-map rows still marker/vowasia/untouched; 5 dangling-intent conditions; dry-run writes nothing; media deleted only if unreferenced (full article scan); delete error report-only.
- Sha chain via `verifySnapshotInput` (snapshot↔meta, manifest snapshotSha256, --expect-sha256 on manifest bytes, image re-hash + magic sniff).
- Q12 vs C6: store failure → draft + drop section, 2% before any write; upload exception → `UploadError`, break before `port.create("articles")`.
- Redirects per §4.2.7 (old drafts excluded, rejected 410, O-B12 exit 3 no write); CF1 counts published rows only. vowasia-web consumer not re-checked (relied on PVL pass 3).
- O-B5 answer file: no default, whole-snapshot "extra" scope (V-W3), refusals, target `/<pillar>/<slug>` only for same-run slug-map rows live `published`.
- Local test hooks: `importHooks()` throws unless `target.local`; same driver-based host parse as the guards and as payload.config's DATABASE_URL; read only by import. Residual: a localhost tunnel to production (see F-6).
- Secrets/pins: only `.invalid` hosts and 127.0.0.1 fixtures; SQL + pins unchanged at 9d9e5a4; GTP unchanged at fe88bc4; only pinned GTP files imported.

## Findings
- **F-1 MINOR** createError after commit (Neon reset/timeout) leaves a marker article in no journal; rollback cannot remove it and the import preflight then blocks with wrong advice ("use the rollback of their run"). `import-vowasia-main.ts:290-301`, `:186-189`; `rollback-vowasia-main.ts:107-134`. Fix: on createError re-query the slug and journal a found marker row as created; fix preflight text.
- **F-2 MINOR** rehearsal `unset R2_*` but `scripts/lib/env` loads `.env.local`/`.env`, so a host with `.env.local` could reach real R2 (preflight skipped for local DB). `rehearse-vowasia.sh:60`, `rehearse-assert.ts`. Fix: export the 4 names as empty strings; assert they are empty.
- **F-3 MINOR** `report.stop` and `failed[].reason` store up to 200 chars of S3/pg error text unredacted; `redact()` knows only legacy URL secrets. `import-vowasia-main.ts:271-276`, `:336-341`, `vowasia-cli.ts`. Fix: redact those strings; add Central DATABASE_URL password + R2 values to `redact()`.
- **F-4 MINOR** rollback iterates only the slug map; an outcome `created` line without a slug-map line is skipped. Fix: also iterate created outcome lines with an id.
- **F-5 MINOR** media reference scan covers article drafts only (not authors/pillars/newsletters or the live version behind a newer draft). Document or extend.
- **F-6 NIT** runbook must say no SSH tunnel/port-forward to production may be open (host would look local; TTY/confirm-host/neondb/R2 preflight skipped).
- **F-7 NIT** runbook should say cross-run links are not rewritten (50/rest split).
- **F-8 NIT** `rehearse-assert.ts` header lists a mutant not in code; runbook should say a Q12-stopped run leaves orphan Media removed only by that run's rollback.
- **F-9 NIT** Ctrl-C leaves the lock (documented); `snapshot-meta.json` not in the sha chain; `findAll()` has no explicit sort but Payload ordering is stable. No defect.
- **F-10 NIT** fixture seeder drops `public.articles`/`public.sites` on hard-coded 127.0.0.1:54346/vowasia_legacy (local only, but could hit an unrelated local DB with that port+name).

## Recommended
1. Before OB6 (first --apply): fix F-1, F-3; add F-6 line to part B.
2. Before G19 on any host with `.env.local`: fix F-2.
3. Rest to backlog unless cheap.
