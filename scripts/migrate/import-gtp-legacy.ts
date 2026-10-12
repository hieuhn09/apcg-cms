/**
 * GTP legacy importer entry (gtp-launch P4). The implementation lives in
 * `./lib/import-gtp-main.ts`; it is loaded through the load watchdog because
 * the Payload module graph can stall under the tsx loader (see lib/load-guard.ts).
 *
 *   npm run migrate:gtp:import -- --mapping-overlay <overlay.json> [--apply] ...  (flags: lib/cli-spec.ts)
 */
import { runGuarded } from "./lib/load-guard";

runGuarded("import", () => import("./lib/import-gtp-main"));
