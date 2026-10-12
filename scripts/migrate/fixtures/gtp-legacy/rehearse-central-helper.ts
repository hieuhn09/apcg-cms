/**
 * LOCAL-ONLY Central helper for the gtp-launch P4 rehearsal (`rehearse-assert.ts`).
 * Refuses any non-local DATABASE_URL (assertLocalDb) before touching anything.
 * Each action prints one JSON line prefixed `RESULT ` on stdout.
 *
 *   node --import tsx scripts/migrate/fixtures/gtp-legacy/rehearse-central-helper.ts <action> [json-args]
 */
import "../../../lib/env";
import { runGuarded } from "../../lib/load-guard";
import { assertLocalDb } from "../../../lib/local-db-guard";

assertLocalDb(process.env.DATABASE_URL);
runGuarded("rehearse-helper", () => import("./rehearse-central-helper-main"));
