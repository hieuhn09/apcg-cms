/**
 * OWNER-RUN snapshot of the VowAsia legacy source (Amendment 3, B-0).
 *
 *   # step 1 (role from sql/02 + 02p alive; URL only in the environment):
 *   read -s LEGACY_VOWASIA_DB_URL; export LEGACY_VOWASIA_DB_URL
 *   npm run migrate:vowasia:snapshot -- --mapping-overlay ~/vowasia-private/overlay.json --out ~/vowasia-private/snapshot-<date>
 *   # then remove the role (sql/03e) and: unset LEGACY_VOWASIA_DB_URL
 *   # step 2 (no database):
 *   npm run migrate:vowasia:snapshot -- --download-images --snapshot ~/vowasia-private/snapshot-<date> --mapping-overlay ~/vowasia-private/overlay.json
 *
 * Read-only on the legacy database; writes only outside the repo. See
 * lib/snapshot-vowasia-main.ts for the full contract.
 */
import { runMain } from "./lib/vowasia-cli";
import { runSnapshot } from "./lib/snapshot-vowasia-main";

void runMain("snapshot", () => runSnapshot(process.argv.slice(2), { env: process.env, log: (l) => console.log(l) }));
