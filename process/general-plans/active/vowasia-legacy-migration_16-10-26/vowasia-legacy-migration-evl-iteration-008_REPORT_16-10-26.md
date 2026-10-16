# EVL iteration 008 — vowasia-legacy-migration (phase A, Amendment 1: SQL Editor route)

Date: 16-10-26. Loop driver: orchestrator.

## Context
Phase A loop closed green (iteration 007). The owner has no postgres password for the old Supabase project (name `globaltravelpost`) and forbids a reset, so Amendment 1 (owner "ok" to the recommended option) adds a Supabase SQL Editor route. Not re-validated by a full PVL round (stated in the plan); covered by independent EVL + G9 review.

## Fix/feature applied (vc-execute-agent) — commit 3d26fe5, local, not pushed
Claimed by the executor (to be confirmed independently):
- New sql/01e (single-result inspect), sql/02p (set password), sql/03e (drop without psql variable); banner accepts `vowasia_migrator.<20-char project ref>` and never prints it; doc "Cach B" B1-B6; probe part H.
- Gates reported: G1 54/54, G4 69/69, G5 267/267, G6 probe pass, G7/G7b/G7c/G8/G10a/G10c/G13 pass. 30 files, package.json unchanged.
- Literal G10b fails because it matches the required '__PASSWORD__' placeholder in 02p; the plan's command must be changed (suggested: exclude the placeholder). This is a gate-definition fix, to be proven by a mutation check that a real password literal still fails the gate.

## Known gaps stated by the executor
Never run in the real Supabase SQL Editor ("pasted as one string" simulated with node-pg on local PG16); trust auth locally so pooler password login is unproven; PG <= 14 makes 02 stop; Supabase SECURITY DEFINER functions outside public may make 02 stop.

## Next
Fresh vc-tester EVL; vc-code-reviewer G9 review of the delta; vc-plan-agent fixes the G10b command in the plan.
