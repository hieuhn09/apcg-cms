/**
 * Legacy-DB banner for the VowAsia tools (own copy of the GTP banner, reading
 * LEGACY_VOWASIA_DB_URL / _SSL / _CA). The URL is read from the environment
 * only, never from argv. Output is `host:port/db` only: never credentials,
 * never a query; every message is fixed and never echoes the URL.
 */
import { parse } from "pg-connection-string";
import { LEGACY_CA_ENV, LEGACY_SSL_ENV, LEGACY_URL_ENV } from "./vowasia-constants";

export const BANNER_MESSAGES = {
  missing: `legacy-db: ${LEGACY_URL_ENV} is not set; refusing.`,
  unparseable: `legacy-db: ${LEGACY_URL_ENV} could not be parsed; refusing.`,
  badHost: `legacy-db: ${LEGACY_URL_ENV} has an empty, socket-path or multi-host host; refusing.`,
  badSsl: `legacy-db: ${LEGACY_SSL_ENV} must be disable, require or verify-full; refusing.`,
} as const;

export class DbBannerError extends Error {
  override name = "DbBannerError";
}

export function legacyBanner(url: string | undefined): { banner: string; host: string; local: boolean } {
  if (typeof url !== "string" || url.trim() === "") throw new DbBannerError(BANNER_MESSAGES.missing);
  let c: ReturnType<typeof parse>;
  try {
    c = parse(url);
  } catch {
    throw new DbBannerError(BANNER_MESSAGES.unparseable);
  }
  const host = typeof c.host === "string" ? c.host : "";
  if (host === "" || host.startsWith("/") || host.includes(",")) throw new DbBannerError(BANNER_MESSAGES.badHost);
  const port = typeof c.port === "string" && c.port !== "" ? c.port : "5432";
  const db = typeof c.database === "string" ? c.database.replace(/[?].*$/, "") : "";
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  return { banner: `${host}:${port}/${db}`, host, local };
}

/** SSL option from LEGACY_VOWASIA_DB_SSL (default require for non-local hosts). */
export function legacySsl(env: Record<string, string | undefined>, local: boolean): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = env[LEGACY_SSL_ENV] ?? (local ? "disable" : "require");
  if (mode === "disable") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true, ...(env[LEGACY_CA_ENV] ? { ca: env[LEGACY_CA_ENV] } : {}) };
  if (mode === "require") return { rejectUnauthorized: false };
  throw new DbBannerError(BANNER_MESSAGES.badSsl);
}
