/**
 * Shared CLI plumbing for the GTP legacy migration scripts (gtp-launch P4).
 * Fixed messages, banners without credentials, exit code 2 for refusals.
 */
import path from "node:path";
import { assertLocalDb, assertLocalOrConfirmed, LocalDbGuardError } from "../../lib/local-db-guard";
import { assertCentralDbName, CentralDbNameError } from "../../lib/central-db-name-guard";
import { CliError } from "./args";
import type { ParsedArgs } from "./args";
import { legacyBanner, legacySsl } from "./db-banner";
import { loadMapping, MappingError, type ValidationResult } from "./gtp-mapping";
import { LiveLegacyReader, SnapshotLegacyReader, assertGtpSite, type LegacyReader } from "./legacy-reader";
import { effectiveAllowList, LegacySqlError } from "./legacy-sql";
import { assertOutDirSafe, OutDirError, repoRoot } from "./out-dir";
import { RunDirError } from "./run-dir";
import { DbBannerError } from "./db-banner";
import { TimestampsError } from "./gtp-timestamps";
import { ProfileError, legacyEnvNames, profile } from "./network-profile";

export const DEFAULT_OUT = path.join(repoRoot(), "scripts/migrate/out");

export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export function outDir(a: ParsedArgs): string {
  return assertOutDirSafe(resolvePath(a.get("out") ?? DEFAULT_OUT));
}

export function loadEffectiveMapping(a: ParsedArgs, defaultMapping: string | undefined, opts: { requireFinal?: boolean; structuralOnly?: boolean } = {}): ValidationResult {
  const m = a.get("mapping") ?? defaultMapping;
  if (!m) throw new CliError("cli: --mapping is required.");
  const overlay = a.get("mapping-overlay");
  return loadMapping(resolvePath(m), overlay ? resolvePath(overlay) : undefined, { ...opts, structuralOnly: opts.structuralOnly ?? overlay === undefined });
}

export interface CentralTarget {
  url: string;
  banner: string;
  local: boolean;
}

/** Central DATABASE_URL guard in EVERY mode (A11-S18): non-local needs --confirm-host (+TTY for --apply). */
export function centralTarget(a: ParsedArgs, apply: boolean): CentralTarget {
  const url = process.env.DATABASE_URL;
  const t = assertLocalOrConfirmed(url, a.get("confirm-host"), Boolean(process.stdin.isTTY), apply);
  // Network bundle: also the database NAME (non-local must be exactly /neondb). GTP keeps its original guard set.
  if (profile().id !== "gtp") assertCentralDbName(url, t);
  let local = true;
  try {
    assertLocalDb(url);
  } catch {
    local = false;
  }
  console.log(`[${profile().id}] Central target: ${t.banner} (${local ? "LOCAL" : "NON-LOCAL"})${apply ? "" : " [dry run]"}`);
  return { url: url as string, banner: t.banner, local };
}

export const IMPORT_TENANT = "gtp";
export function assertImportTenant(): string {
  const want = profile().tenant;
  const t = process.env.IMPORT_TENANT_SLUG ?? want;
  if (t !== want) throw new CliError(`cli: IMPORT_TENANT_SLUG other than ${want} is refused.`);
  return t;
}

/** Open the legacy source: --from-snapshot dir, else LEGACY_GTP_DB_URL (env only, never argv). */
export async function openLegacy(a: ParsedArgs, v: ValidationResult, siteId: string): Promise<LegacyReader> {
  const snap = a.get("from-snapshot");
  let reader: LegacyReader;
  if (snap) {
    reader = SnapshotLegacyReader.open(resolvePath(snap), siteId);
    console.log(`[${profile().id}] legacy source: snapshot ${path.basename(resolvePath(snap))}`);
  } else {
    const url = process.env[legacyEnvNames().url];
    const b = legacyBanner(url);
    console.log(`[${profile().id}] legacy source: ${b.banner} (read-only, site-filtered)`);
    reader = await LiveLegacyReader.open(url as string, legacySsl(process.env, b.local), v.mapping.source.schema, siteId, effectiveAllowList(v.mapping.source.tableAllowList));
  }
  await assertGtpSite(reader);
  return reader;
}

const KNOWN = [CliError, MappingError, LocalDbGuardError, LegacySqlError, OutDirError, RunDirError, DbBannerError, TimestampsError, ProfileError, CentralDbNameError];

/** Uniform failure handler: fixed messages, exit 2 for refusals, 1 otherwise. */
export function runMain(name: string, fn: () => Promise<number | void>): void {
  fn()
    .then((code) => process.exit(typeof code === "number" ? code : 0))
    .catch((err: unknown) => {
      const e = err as Error;
      if (KNOWN.some((K) => e instanceof K) || /^(legacy|cli|args|mapping|import|run|rollback|redirects|verify|export|discover):/.test(e?.message ?? "")) {
        console.error(`[${name}] ${e.message}`);
        process.exit(err instanceof CliError ? err.exitCode : 2);
      }
      console.error(`[${name}] failed: ${e?.message ?? String(err)}`);
      process.exit(1);
    });
}
