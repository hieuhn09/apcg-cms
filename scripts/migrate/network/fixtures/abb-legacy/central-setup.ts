/**
 * LOCAL-ONLY rehearsal helper: creates the `abb` tenant fixture (6 pillars, the
 * sub-sections the fixture uses, 5 authors) in the LOCAL Central DB, and prints read-back counts.
 * Refuses any non-local DATABASE_URL before loading Payload.
 *
 *   node --import tsx scripts/migrate/network/fixtures/abb-legacy/central-setup.ts setup|counts
 */
import "../../../../lib/env";
import { assertLocalDb } from "../../../../lib/local-db-guard";
import { runGuarded } from "../../../lib/load-guard";

assertLocalDb(process.env.DATABASE_URL);
runGuarded("abb-central-setup", () => import("./central-setup-main"));
