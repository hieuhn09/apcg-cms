/**
 * ONE CLI contract for the GTP legacy migration tools (gtp-launch P4, A13-R02,
 * E9, E17, E19). Every script parses through `parseCommand()` and resolves the
 * safety-relevant switches through the pure helpers here, so the rules live in
 * one tested place:
 *   - `--require-final` is IMPLIED for a non-local Central target (import,
 *     rewrite-links), a non-local DB or public base (verify), and for the
 *     redirect builder unless `--rehearsal`; rollback NEVER enforces it.
 *   - `--rehearsal` is accepted only when the effective site filter is the
 *     committed fixture uuid, or (DB-target commands) the Central URL is local.
 *   - discover/export (and `--snapshot-dir`) REQUIRE a site filter source:
 *     `--site-id` or `--mapping-overlay` (equal when both), a uuid.
 *   - verify reads the token from GTP_READ_TOKEN; `--read-token` is accepted
 *     with a warning (argv is visible); argv wins.
 */
import { CliError, parseArgs, type FlagSpec, type ParsedArgs } from "./args";

export const FIXTURE_SITE_ID = "00000000-0000-0000-0000-00000000f001";
export const STRUCTURAL_MAPPING_PATH = "scripts/migrate/legacy-mapping.gtp-network.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Command = "discover" | "export" | "validate-mapping" | "import" | "rewrite-links" | "rollback" | "redirects" | "verify";

export const CLI_SPEC: Readonly<Record<Command, FlagSpec>> = {
  discover: { out: "value", sample: "value", "max-body-sniff": "value", schema: "value", "mapping-overlay": "value", "site-id": "value", "snapshot-dir": "value", mapping: "value" },
  export: { out: "value", "include-contact": "bool", "mapping-overlay": "value", "site-id": "value", mapping: "value" },
  "validate-mapping": { mapping: "value", "mapping-overlay": "value", "structural-only": "bool", "require-final": "bool" },
  import: {
    mapping: "value", "mapping-overlay": "value", entity: "value", apply: "bool", "dry-run": "bool", limit: "value", ids: "value",
    status: "value", since: "value", resume: "bool", "run-id": "value", batch: "value", "stop-after-failures": "value",
    "from-snapshot": "value", "snapshot-dir": "value", "confirm-host": "value", "require-final": "bool", rehearsal: "bool", out: "value",
  },
  "rewrite-links": { "run-id": "value", apply: "bool", "dry-run": "bool", "confirm-host": "value", "require-final": "bool", rehearsal: "bool", out: "value" },
  rollback: {
    "run-id": "value", apply: "bool", "dry-run": "bool", "confirm-host": "value", "include-edited": "bool", "list-orphans": "bool",
    "include-orphans": "bool", out: "value",
  },
  redirects: {
    "run-id": "value", "known-routes": "value", "emit-gtp-web": "value", "sitemap-urls": "value", "min-coverage": "value",
    "mapping-overlay": "value", "require-final": "bool", rehearsal: "bool", mapping: "value", out: "value",
  },
  verify: {
    "run-id": "value", mapping: "value", "mapping-overlay": "value", "public-base": "value", base: "value", "confirm-host": "value",
    "require-final": "bool", rehearsal: "bool", "read-token": "value", out: "value", "from-snapshot": "value", batch: "value",
  },
};

export const CLI_MESSAGES = {
  siteFilterMissing: "cli: a site filter source is required: pass --site-id <uuid> or --mapping-overlay <path>.",
  siteFilterMismatch: "cli: --site-id and the overlay source.siteFilter differ; refusing.",
  siteFilterNotUuid: "cli: the site filter is not a uuid; refusing.",
  rehearsalRefused: "cli: --rehearsal is accepted only for the fixture site id or a local Central database; refusing.",
  entityBad: "cli: --entity must be articles, events or all.",
  tokenMissing: "cli: --public-base needs a read token: set GTP_READ_TOKEN (preferred) or pass --read-token.",
  tokenArgvWarning: "cli: WARNING --read-token is visible in the process list; prefer the GTP_READ_TOKEN env var.",
} as const;

export function parseCommand(command: Command, argv: readonly string[]): ParsedArgs {
  return parseArgs(argv, CLI_SPEC[command]);
}

/** discover / export / --snapshot-dir: the site filter source is required (A13-R02, E19). */
export function resolveSiteFilter(a: ParsedArgs, overlaySiteFilter: string | undefined): string {
  const fromFlag = a.get("site-id");
  if (fromFlag === undefined && overlaySiteFilter === undefined) throw new CliError(CLI_MESSAGES.siteFilterMissing);
  if (fromFlag !== undefined && overlaySiteFilter !== undefined && fromFlag.toLowerCase() !== overlaySiteFilter.toLowerCase()) {
    throw new CliError(CLI_MESSAGES.siteFilterMismatch);
  }
  const v = (fromFlag ?? overlaySiteFilter) as string;
  if (!UUID.test(v)) throw new CliError(CLI_MESSAGES.siteFilterNotUuid);
  return v.toLowerCase();
}

export interface TargetInfo {
  /** Central DATABASE_URL is local (assertLocalDb accepts it). undefined = command has no Central DB target. */
  centralLocal?: boolean;
  /** verify --public-base is a local URL. undefined = not given. */
  publicBaseLocal?: boolean;
  /** Effective site filter (from overlay / --site-id), when the command has one. */
  siteFilter?: string;
}

/** --rehearsal acceptance (A13-R02). */
export function resolveRehearsal(command: Command, a: ParsedArgs, t: TargetInfo): boolean {
  if (!a.has("rehearsal")) return false;
  if (!(command in { import: 1, "rewrite-links": 1, redirects: 1, verify: 1 })) throw new CliError(CLI_MESSAGES.rehearsalRefused);
  const fixtureSite = t.siteFilter !== undefined && t.siteFilter.toLowerCase() === FIXTURE_SITE_ID;
  const localDb = t.centralLocal === true;
  if (fixtureSite || localDb) return true;
  throw new CliError(CLI_MESSAGES.rehearsalRefused);
}

export interface RequireFinal {
  requireFinal: boolean;
  implied: boolean;
}

/** Implied / opt-in `--require-final` per command (A13-R02 table). */
export function resolveRequireFinal(command: Command, a: ParsedArgs, t: TargetInfo): RequireFinal {
  const optIn = a.has("require-final");
  const rehearsal = resolveRehearsal(command, a, t);
  let implied = false;
  switch (command) {
    case "import":
    case "rewrite-links":
      implied = t.centralLocal === false;
      break;
    case "verify":
      implied = t.centralLocal === false || t.publicBaseLocal === false;
      break;
    case "redirects":
      implied = !rehearsal;
      break;
    case "rollback":
      return { requireFinal: false, implied: false };
    default:
      implied = false;
  }
  return { requireFinal: implied || optIn, implied };
}

export type Entity = "articles" | "events" | "all";
export function resolveEntity(a: ParsedArgs): Entity {
  const v = a.get("entity") ?? "all";
  if (v !== "articles" && v !== "events" && v !== "all") throw new CliError(CLI_MESSAGES.entityBad);
  return v;
}

/** verify read token: env GTP_READ_TOKEN preferred; argv accepted with a warning and wins when both are present. */
export function resolveReadToken(a: ParsedArgs, env: Record<string, string | undefined>): { token?: string; warning?: string } {
  const argv = a.get("read-token");
  const fromEnv = env.GTP_READ_TOKEN && env.GTP_READ_TOKEN !== "" ? env.GTP_READ_TOKEN : undefined;
  if (a.has("public-base") && argv === undefined && fromEnv === undefined) throw new CliError(CLI_MESSAGES.tokenMissing);
  if (argv !== undefined) return { token: argv, warning: CLI_MESSAGES.tokenArgvWarning };
  return { token: fromEnv };
}

/** Mapping path default (E17): the committed structural file for discover, redirects and verify. */
export function resolveMappingPath(command: Command, a: ParsedArgs): string | undefined {
  const m = a.get("mapping");
  if (m) return m;
  if (command === "discover" || command === "redirects" || command === "verify" || command === "export") return STRUCTURAL_MAPPING_PATH;
  return undefined;
}

export const HOOK_MESSAGE = "test hooks: MIGRATE_TEST_KILL_* are honoured only against a LOCAL Central database; refusing.";
/** A13-R08: MIGRATE_TEST_KILL_* only when the Central target is local. Returns the parsed hooks. */
export function resolveTestHooks(env: Record<string, string | undefined>, centralLocal: boolean): { killAfter?: number; killBeforeJournal?: number; killAfterMediaUpload?: number } {
  const ka = env.MIGRATE_TEST_KILL_AFTER;
  const kb = env.MIGRATE_TEST_KILL_BEFORE_JOURNAL;
  const km = env.MIGRATE_TEST_KILL_AFTER_MEDIA_UPLOAD; // N-12 rehearsal: crash between media upload and its resolution line
  if (!ka && !kb && !km) return {};
  if (!centralLocal) throw new CliError(HOOK_MESSAGE);
  const n = (v: string | undefined) => (v ? Number(v) : undefined);
  return { ...(ka ? { killAfter: n(ka) } : {}), ...(kb ? { killBeforeJournal: n(kb) } : {}), ...(km ? { killAfterMediaUpload: n(km) } : {}) };
}
