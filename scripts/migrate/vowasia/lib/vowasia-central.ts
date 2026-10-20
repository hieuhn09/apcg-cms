/**
 * Central target guards shared by the VowAsia phase-B tools (Amendment 4 §4.3).
 *
 * Order, in EVERY mode (dry-run included), before anything else:
 *   1. print the database NAME (`new URL(DATABASE_URL).pathname`);
 *   2. host guard `assertLocalOrConfirmed`: a non-local host needs
 *      `--confirm-host=<exact host>`, and `--apply` also needs a TTY;
 *   3. name guard `assertCentralDbName`: a non-local database must be exactly
 *      `/neondb` (a wrong database on the same server is refused).
 * The banner is `host:port/db` only (never credentials).
 *
 * R2 preflight (`--apply` against a non-local Central, E2): the four R2
 * variables must be present AND non-empty, otherwise Payload silently falls
 * back to local-disk media; names are printed, never values.
 */
import { assertLocalOrConfirmed } from "../../../lib/local-db-guard";
import { assertCentralDbName, databaseNameBanner } from "../../../lib/central-db-name-guard";
import { CliError } from "./args";

export const R2_VARS = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

export interface CentralTarget {
  banner: string;
  local: boolean;
}

export function centralTarget(env: Record<string, string | undefined>, o: { confirmHost?: string; apply: boolean; isTty: boolean; log: (l: string) => void; tool: string }): CentralTarget {
  const url = env.DATABASE_URL;
  o.log(`[${o.tool}] ${databaseNameBanner(url)}`);
  const t = assertLocalOrConfirmed(url, o.confirmHost, o.isTty, o.apply);
  assertCentralDbName(url, t);
  o.log(`[${o.tool}] Central target: ${t.banner} (${t.local ? "LOCAL" : "NON-LOCAL"})${o.apply ? " [APPLY]" : " [dry run]"}`);
  return { banner: t.banner, local: t.local };
}

export function r2Preflight(env: Record<string, string | undefined>, target: CentralTarget, apply: boolean, log: (l: string) => void, tool: string): void {
  if (!apply || target.local) return;
  const missing = R2_VARS.filter((k) => typeof env[k] !== "string" || (env[k] as string).trim() === "");
  if (missing.length) throw new CliError(`${tool}: R2 preflight failed: ${missing.join(", ")} missing or empty (without them Payload stores media on this machine's disk); refusing.`);
  log(`[${tool}] R2 preflight OK: ${R2_VARS.join(", ")} present (values not printed)`);
}
