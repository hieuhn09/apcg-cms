/**
 * Local-DB guard shared by every script that WRITES test/ops data:
 * `scripts/audit/add-pressroom-pillar.ts`, the Pressroom fixture in
 * `scripts/seed.ts`, and `scripts/single-home-probe.ts`.
 *
 * Host/port/db come from the Postgres DRIVER's own parser (`pg-connection-string`,
 * the parser `pg` uses), not `new URL().hostname`: the driver folds `?host=` /
 * `?port=` overrides into the effective host, returns `[::1]` bracketed, and
 * `new URL` throws on multi-host / `@/db` forms with the DSN (password included)
 * in the error. Rules:
 *   - allow ONLY an effective host that is exactly `localhost`, `127.0.0.1`,
 *     `[::1]` or `host.docker.internal` (case-sensitive);
 *   - refuse the `hostaddr` / `service` keys, an empty, `/`-prefixed (socket) or
 *     multi-host value, and any parse failure — always with a FIXED message
 *     (never the parser error, never the URL, never credentials).
 * Banner = `host:port/db` only.
 *
 * Residual (accepted): a tunnelled production DB exposed on localhost looks
 * local to ANY hostname guard; never run these scripts with a tunnel open.
 *
 * Do NOT reuse `isLocalDb` from ./env (an unanchored substring regex).
 * `pg-connection-string` is a transitive dependency of `pg` (via
 * @payloadcms/db-postgres), not declared in package.json on purpose.
 */
import { parse } from "pg-connection-string";

export const ALLOWED_LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];

export const GUARD_MESSAGES = {
  missing: "local-db guard: DATABASE_URL is not set; refusing.",
  unparseable: "local-db guard: DATABASE_URL could not be parsed; refusing.",
  extraKeys: "local-db guard: DATABASE_URL carries a hostaddr/service key; refusing.",
  badHost: "local-db guard: DATABASE_URL has an empty, socket-path or multi-host host; refusing.",
  notLocal: "local-db guard: DATABASE_URL is not a local database; refusing.",
  confirm: "local-db guard: non-local DATABASE_URL; pass --confirm-host=<exact DB hostname> to proceed.",
  confirmMismatch: "local-db guard: --confirm-host does not match the DATABASE_URL host; refusing.",
  needTty: "local-db guard: --apply against a non-local database needs an interactive terminal (TTY); refusing.",
} as const;

export class LocalDbGuardError extends Error {
  override name = "LocalDbGuardError";
}

export interface DbTarget {
  host: string;
  port: string;
  db: string;
  /** `host:port/db` — no credentials, no query string. */
  banner: string;
  local: boolean;
}

/** Structural parse; throws LocalDbGuardError with a fixed message on anything unsafe. */
function inspect(url: string | undefined): DbTarget {
  if (typeof url !== "string" || url.trim() === "") throw new LocalDbGuardError(GUARD_MESSAGES.missing);

  let c: ReturnType<typeof parse>;
  try {
    c = parse(url);
  } catch {
    throw new LocalDbGuardError(GUARD_MESSAGES.unparseable); // never surface the parser error (it may carry the DSN)
  }

  const rec = c as unknown as Record<string, unknown>;
  const qIndex = url.indexOf("?");
  let rawQuery: URLSearchParams;
  try {
    rawQuery = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : "");
  } catch {
    throw new LocalDbGuardError(GUARD_MESSAGES.unparseable);
  }
  if ("hostaddr" in rec || "service" in rec || rawQuery.has("hostaddr") || rawQuery.has("service")) {
    throw new LocalDbGuardError(GUARD_MESSAGES.extraKeys);
  }

  const host = typeof c.host === "string" ? c.host : "";
  if (host === "" || host.startsWith("/") || host.includes(",")) throw new LocalDbGuardError(GUARD_MESSAGES.badHost);

  const port = typeof c.port === "string" && c.port !== "" ? c.port : "5432";
  const db = typeof c.database === "string" ? c.database : "";
  return { host, port, db, banner: `${host}:${port}/${db}`, local: ALLOWED_LOCAL_HOSTS.includes(host) };
}

/** Hard refusal of any non-local database (probe, seed fixture). No override. */
export function assertLocalDb(url: string | undefined): DbTarget {
  const t = inspect(url);
  if (!t.local) throw new LocalDbGuardError(GUARD_MESSAGES.notLocal);
  return t;
}

/**
 * Owner-script variant: a non-local host is allowed only when `confirmHost`
 * equals the parsed host exactly AND, for `--apply`, stdin is a TTY.
 * `--confirm-host` is a typo guard, not an authorisation.
 */
export function assertLocalOrConfirmed(url: string | undefined, confirmHost: string | undefined, isTty: boolean, apply = true): DbTarget {
  const t = inspect(url);
  if (t.local) return t;
  if (confirmHost === undefined || confirmHost === "") throw new LocalDbGuardError(GUARD_MESSAGES.confirm);
  if (confirmHost !== t.host) throw new LocalDbGuardError(GUARD_MESSAGES.confirmMismatch);
  if (apply && !isTty) throw new LocalDbGuardError(GUARD_MESSAGES.needTty);
  return t;
}
