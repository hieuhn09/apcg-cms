# EVL iteration 010 — vowasia-legacy-migration (phase A, Amendment 1 fix cycle)

Date: 16-10-26. Loop driver: orchestrator.

## Before
G9 REQUEST_CHANGES on Amendment 1 (3 MAJOR, 10 MINOR, 1 NIT) — see evl-iteration-009.

## Fix applied (vc-execute-agent) — commit b0f5b89, local, not pushed
Claimed by the executor (to be confirmed independently):
- 02p rewritten: no placeholder; a DO block guards (role, schema, 02's views/grants present; role not superuser/BYPASSRLS/member of another role) and generates a 64-hex password from gen_random_uuid(), sets it via EXECUTE format, and shows it only in the last result cell (`NOT SHOWN` when run statement by statement). Probe turns SCRAM on for this role briefly: wrong password refused, generated one logs in, re-run rotates, value absent from logs/output.
- Mac shortcut fixed (Cmd+Option+F / Ctrl+H, Replace All, search `__`). Doc table of the 11 places 02 can stop, REVOKE ... FROM PUBLIC forbidden. 01e gained 5f, 5g, 5c flag, corrected 5d (counts like 02, in_public marker). Trigger-returning SECURITY DEFINER functions no longer stop 02/02b; ordinary DEFINER functions still do.
- redact() masks pooler login names and direct hosts; B1 asks to check the project name; route B forbids 02b; 03e reports state in a result row; 01e puts the site row first, ends with a total-rows row, sorts 6b by table, survives missing site columns, adds password_encryption and PUBLIC-connectable databases rows; limits section expanded.
- Gates (executor): G1 56/56, G4 69/69, G5 267/267, G6 probe pass, G7/G7b/G7c/G8/G10/G13 green; 30 files.
- Proposed password gate (whitelist, mutation-proven on 6 variants by the executor): see the plan update.

## Still unproven (executor)
Nothing run in the real Supabase SQL Editor; 02p assumes the Editor sends the whole file as one query (otherwise a safe `NOT SHOWN`); password sits in a result cell that Supabase may log; pooler login unconfirmed; 02p/03e only tested as superuser on PG16.

## Next
vc-plan-agent rewrites the plan's password gate; fresh vc-tester EVL; delta G9 review. Then push.
