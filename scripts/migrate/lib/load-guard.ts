/**
 * Module-load watchdog for the Payload-booting migration scripts (gtp-launch P4).
 *
 * Measured in this environment (Node 22.22, tsx, Payload 3.85): loading the
 * Payload + richtext-lexical module graph through the tsx loader stalls
 * intermittently (roughly 3 runs in 10, the pre-existing import-gcv-legacy.ts
 * shows the same). Without a pending handle the process then exits with code 0
 * having done NOTHING, which a caller would read as success. The thin entry
 * files therefore load the real module through `runGuarded()`: a timer keeps
 * the event loop alive and, if loading does not finish in time, the process
 * exits with code 75 and a fixed message. A stall happens before any work, so
 * re-running the same command is safe (the rehearsal script retries).
 */
export const LOAD_STALL_EXIT = 75;

export function runGuarded(name: string, load: () => Promise<unknown>, timeoutMs = Number(process.env.MIGRATE_LOAD_TIMEOUT_MS ?? 90_000)): void {
  const t = setTimeout(() => {
    console.error(`[${name}] module load did not finish within ${Math.round(timeoutMs / 1000)} s (known loader stall); nothing was done. Re-run the same command.`);
    process.exit(LOAD_STALL_EXIT);
  }, timeoutMs);
  load().then(
    () => clearTimeout(t),
    (err: unknown) => {
      clearTimeout(t);
      console.error(`[${name}] failed to load: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    },
  );
}
