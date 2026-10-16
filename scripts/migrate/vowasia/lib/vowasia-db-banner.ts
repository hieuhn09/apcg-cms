/**
 * Legacy-DB banner for the VowAsia tools (own copy of the GTP banner, reading
 * LEGACY_VOWASIA_DB_URL / _SSL / _CA). The URL is read from the environment
 * only, never from argv. Output is `host:port/db` only: never credentials,
 * never a query; every message is fixed and never echoes the URL.
 */
import { parse } from "pg-connection-string";
import { LEGACY_CA_ENV, LEGACY_ROLE, LEGACY_SSL_ENV, LEGACY_URL_ENV } from "./vowasia-constants";

export const BANNER_MESSAGES = {
  missing: `legacy-db: ${LEGACY_URL_ENV} is not set; refusing.`,
  unparseable: `legacy-db: ${LEGACY_URL_ENV} could not be parsed; refusing.`,
  badHost: `legacy-db: ${LEGACY_URL_ENV} has an empty, socket-path or multi-host host; refusing.`,
  badSsl: `legacy-db: ${LEGACY_SSL_ENV} must be disable, require or verify-full; refusing.`,
  badUser: `legacy-db: ${LEGACY_URL_ENV} must log in as vowasia_migrator (the read-only role); refusing.`,
  sslInUrl: `legacy-db: ${LEGACY_URL_ENV} must not carry ssl settings (sslmode, ssl, sslrootcert...); use ${LEGACY_SSL_ENV}; refusing.`,
} as const;

/**
 * Accepted login names: the role itself, or the Supabase pooler form
 * `vowasia_migrator.<project ref>` (exactly 20 lowercase letters/digits).
 * The ref is never printed: the banner carries host:port/db only, and a
 * direct host db.<ref>.supabase.co is shown as db.<ref>.supabase.co.
 */
const POOLER_USER = new RegExp(`^${LEGACY_ROLE}\\.[a-z0-9]{20}$`);
export function isAcceptedLegacyUser(user: unknown): boolean {
  return typeof user === "string" && (user === LEGACY_ROLE || POOLER_USER.test(user));
}

export class DbBannerError extends Error {
  override name = "DbBannerError";
}

export function legacyBanner(url: string | undefined): { banner: string; host: string; local: boolean } {
  if (typeof url !== "string" || url.trim() === "") throw new DbBannerError(BANNER_MESSAGES.missing);
  const q = url.indexOf("?");
  if (q >= 0 && /(^|&)ssl[a-z]*=/i.test(url.slice(q + 1))) throw new DbBannerError(BANNER_MESSAGES.sslInUrl);
  let c: ReturnType<typeof parse>;
  try {
    c = parse(url);
  } catch {
    throw new DbBannerError(BANNER_MESSAGES.unparseable);
  }
  if (!isAcceptedLegacyUser(c.user)) throw new DbBannerError(BANNER_MESSAGES.badUser);
  const host = typeof c.host === "string" ? c.host : "";
  if (host === "" || host.startsWith("/") || host.includes(",")) throw new DbBannerError(BANNER_MESSAGES.badHost);
  const port = typeof c.port === "string" && c.port !== "" ? c.port : "5432";
  const db = typeof c.database === "string" ? c.database.replace(/[?].*$/, "") : "";
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  // A Supabase direct host carries the project ref: mask it in the printed banner.
  const shown = host.replace(/^db\.[a-z0-9]{20}\.supabase\.co$/i, "db.<ref>.supabase.co");
  return { banner: `${shown}:${port}/${db}`, host, local };
}

/** SSL option from LEGACY_VOWASIA_DB_SSL (default require for non-local hosts). */
export function legacySsl(env: Record<string, string | undefined>, local: boolean): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = env[LEGACY_SSL_ENV] ?? (local ? "disable" : "require");
  if (mode === "disable") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true, ...(env[LEGACY_CA_ENV] ? { ca: env[LEGACY_CA_ENV] } : {}) };
  if (mode === "require") return { rejectUnauthorized: false };
  throw new DbBannerError(BANNER_MESSAGES.badSsl);
}

/** Human-readable effective SSL mode for the banner (never the CA content). */
export function sslLabel(ssl: false | { rejectUnauthorized: boolean; ca?: string }): string {
  if (ssl === false) return "ssl off";
  if (!ssl.rejectUnauthorized) return "ssl require (certificate not verified)";
  return ssl.ca ? "ssl verify-full (custom CA)" : "ssl verify-full";
}
