/**
 * Legacy-DB banner (gtp-launch P4, A12-N15c). `inspect()` of
 * scripts/lib/local-db-guard.ts is not exported and that file is not edited,
 * so this module does its own `pg-connection-string` parse with FIXED
 * messages. Output is `host:port/db` only: never credentials, never a query.
 */
import { parse } from "pg-connection-string";
import { legacyEnvNames } from "./network-profile";

export const BANNER_MESSAGES = {
  missing: "legacy-db: LEGACY_GTP_DB_URL is not set; refusing.",
  unparseable: "legacy-db: LEGACY_GTP_DB_URL could not be parsed; refusing.",
  badHost: "legacy-db: LEGACY_GTP_DB_URL has an empty, socket-path or multi-host host; refusing.",
} as const;

export class DbBannerError extends Error {
  override name = "DbBannerError";
}

export function legacyBanner(url: string | undefined): { banner: string; host: string; local: boolean } {
  const msg = (k: keyof typeof BANNER_MESSAGES) => BANNER_MESSAGES[k].replace("LEGACY_GTP_DB_URL", legacyEnvNames().url);
  if (typeof url !== "string" || url.trim() === "") throw new DbBannerError(msg("missing"));
  let c: ReturnType<typeof parse>;
  try {
    c = parse(url);
  } catch {
    throw new DbBannerError(msg("unparseable"));
  }
  const host = typeof c.host === "string" ? c.host : "";
  if (host === "" || host.startsWith("/") || host.includes(",")) throw new DbBannerError(msg("badHost"));
  const port = typeof c.port === "string" && c.port !== "" ? c.port : "5432";
  const db = typeof c.database === "string" ? c.database.replace(/[?].*$/, "") : "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  return { banner: `${host}:${port}/${db}`, host, local };
}

/** SSL option from LEGACY_GTP_DB_SSL (default require for non-local hosts). */
export function legacySsl(env: Record<string, string | undefined>, local: boolean): false | { rejectUnauthorized: boolean; ca?: string } {
  const n = legacyEnvNames();
  const mode = env[n.ssl] ?? (local ? "disable" : "require");
  if (mode === "disable") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true, ...(env[n.ca] ? { ca: env[n.ca] } : {}) };
  return { rejectUnauthorized: false };
}
