/**
 * LOCAL-ONLY rehearsal helper: creates the `aer` tenant fixture (6 pillars, a few
 * sub-sections, 4 authors) in the LOCAL Central DB, and prints read-back counts.
 * Refuses any non-local DATABASE_URL before loading Payload.
 *
 *   node --import tsx scripts/migrate/network/fixtures/aer-legacy/central-setup.ts setup|counts
 */
import "../../../../lib/env";
import { assertLocalDb } from "../../../../lib/local-db-guard";
import { runGuarded } from "../../../lib/load-guard";

assertLocalDb(process.env.DATABASE_URL);
runGuarded("aer-central-setup", () => import("./central-setup-main"));
