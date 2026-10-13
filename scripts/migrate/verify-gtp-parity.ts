/**
 * GTP parity / verification entry (gtp-launch P4, 7.9). Implementation:
 * ./lib/verify-main.ts, loaded through the load watchdog (lib/load-guard.ts).
 *
 *   npm run migrate:gtp:verify -- --run-id <id> --mapping-overlay <overlay> [--public-base <url>] [--base <url>] ...
 */
import { runGuarded } from "./lib/load-guard";

runGuarded("verify", () => import("./lib/verify-main"));
