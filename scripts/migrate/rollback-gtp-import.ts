/**
 * GTP import rollback entry (gtp-launch P4). Implementation: ./lib/rollback-main.ts,
 * loaded through the load watchdog (lib/load-guard.ts). Dry run by default.
 *
 *   npm run migrate:gtp:rollback -- --run-id <id> [--apply] [--confirm-host=<host>] [--include-edited] [--list-orphans] [--include-orphans]
 */
import { runGuarded } from "./lib/load-guard";

runGuarded("rollback", () => import("./lib/rollback-main"));
