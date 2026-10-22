/**
 * OWNER-RUN, OFFLINE measure of a VowAsia snapshot (Amendment 3, B-0b).
 *
 *   npm run migrate:vowasia:measure -- --snapshot ~/vowasia-private/snapshot-<date> [--mapping-overlay ~/vowasia-private/overlay.json] [--out DIR]
 *
 * No database. Counts and shapes only. See lib/measure-vowasia-main.ts.
 */
import { runMain } from "./lib/vowasia-cli";
import { runMeasure } from "./lib/measure-vowasia-main";

void runMain("measure", () => runMeasure(process.argv.slice(2), { env: process.env, log: (l) => console.log(l) }));
