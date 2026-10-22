/**
 * Entry of `npm run migrate:vowasia:verify` (VowAsia phase B). The implementation is
 * `./lib/verify-vowasia-main.ts`; it is loaded through the GTP load watchdog (`runGuarded`,
 * pinned) because the Payload module graph can stall under the tsx loader
 * (exit 75 = nothing was done, re-run the same command). The run itself starts
 * after the modules have loaded. Flags and safety rules: see the lib file.
 */
import "../../lib/env";
import { runGuarded } from "../lib/load-guard";

runGuarded("verify", async () => {
  const [main, cli, port] = await Promise.all([import("./lib/verify-vowasia-main"), import("./lib/vowasia-phase-b-cli"), import("./lib/vowasia-payload-port")]);
  void cli.runPhaseB("verify", () =>
    main.runVerify(process.argv.slice(2), {
      env: process.env,
      log: (line: string) => console.log(line),
      isTty: Boolean(process.stdin.isTTY),
      openPort: port.openPayloadPort,
    }),
  );
});
