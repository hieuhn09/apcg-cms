/**
 * Central-database NAME guard for owner-run scripts that write to production
 * (first user: `scripts/audit/add-vowasia-taxonomy.ts`).
 *
 * Why: the Neon server behind Central holds TWO databases, `neondb` (the real
 * Central CMS) and `gcv_payload_disabled` (old, empty). `scripts/lib/local-db-guard.ts`
 * checks only the HOST (`--confirm-host`), so it cannot catch a DATABASE_URL that
 * points at the right server but the wrong database (incident 13-10-26, see
 * `docs/11-operations.md`). This guard is an ADDITIONAL check, run after
 * `assertLocalOrConfirmed`; it does not change or weaken that guard.
 *
 * Rules:
 *   - a LOCAL target (the local-db guard's allowance: localhost / 127.0.0.1 /
 *     [::1] / host.docker.internal) is allowed with any database name, so local
 *     disposable databases keep working for tests and rehearsals;
 *   - a NON-local target is allowed only when BOTH the URL pathname
 *     (`new URL(DATABASE_URL).pathname`, what the owner prints by hand) is
 *     exactly `/neondb` AND the database the Postgres driver will actually use
 *     (`DbTarget.db`, parsed by `pg-connection-string`) is exactly `neondb`
 *     (case-sensitive, no decoding: `/neon%64b` or `/NEONDB` are refused).
 *
 * Messages never contain the URL, the host or credentials; only the pathname,
 * which is the database name and carries no secret.
 */
import type { DbTarget } from "./local-db-guard";

export const CENTRAL_DB_NAME = "neondb";
export const CENTRAL_DB_PATHNAME = `/${CENTRAL_DB_NAME}`;

export class CentralDbNameError extends Error {
  override name = "CentralDbNameError";
}

export const DB_NAME_MESSAGES = {
  unparseable: `central-db guard: DATABASE_URL has no readable database name; refusing (expected ${CENTRAL_DB_PATHNAME}).`,
  wrongName: (pathname: string) =>
    `central-db guard: database name is ${JSON.stringify(pathname)}, not ${JSON.stringify(CENTRAL_DB_PATHNAME)}; refusing. ` +
    `The Neon server also holds other databases (e.g. an empty gcv_payload_disabled): fix DATABASE_URL so it ends in ${CENTRAL_DB_PATHNAME}.`,
  driverMismatch: `central-db guard: the Postgres driver would connect to a different database than the URL path shows (query-string override?); refusing.`,
} as const;

/**
 * `new URL(url).pathname`, or null when DATABASE_URL is unset / unparseable.
 * Never throws (a `new URL` error message can carry the DSN, password included).
 */
export function databasePathname(url: string | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** One line for the operator, printed BEFORE anything else happens. */
export function databaseNameBanner(url: string | undefined): string {
  const p = databasePathname(url);
  return `database name (new URL(DATABASE_URL).pathname): ${p === null ? "(unreadable)" : JSON.stringify(p)}`;
}

/**
 * Throws CentralDbNameError unless the target is local, or the database is
 * exactly the Central `neondb` by BOTH the URL pathname and the driver's parse.
 * Returns the pathname that was checked (null only for a local target whose
 * URL `new URL` cannot read).
 */
export function assertCentralDbName(url: string | undefined, target: Pick<DbTarget, "local" | "db">): string | null {
  const pathname = databasePathname(url);
  if (target.local) return pathname;
  if (pathname === null || pathname === "" || pathname === "/") throw new CentralDbNameError(DB_NAME_MESSAGES.unparseable);
  if (pathname !== CENTRAL_DB_PATHNAME) throw new CentralDbNameError(DB_NAME_MESSAGES.wrongName(pathname));
  if (target.db !== CENTRAL_DB_NAME) throw new CentralDbNameError(DB_NAME_MESSAGES.driverMismatch);
  return pathname;
}
