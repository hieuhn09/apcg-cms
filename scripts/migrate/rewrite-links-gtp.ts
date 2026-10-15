/**
 * GTP second pass (`rewrite-links`) entry (gtp-launch P4, A11-S03). Implementation:
 * ./lib/rewrite-links-main.ts, loaded through the load watchdog. Dry run by default.
 *
 *   npm run migrate:gtp:rewrite-links -- --run-id <id> [--apply] [--confirm-host=<host>] [--require-final] [--rehearsal]
 */
import { runGuarded } from "./lib/load-guard";

runGuarded("rewrite-links", () => import("./lib/rewrite-links-main"));
