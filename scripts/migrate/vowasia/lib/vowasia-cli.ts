/**
 * Shared CLI plumbing for the VowAsia legacy migration tools (phase A).
 * Fixed messages, banners without credentials, exit codes:
 *   0 success, 2 deliberate refusal (fixed message), 1 any other failure.
 * An unexpected error is printed only after redaction: anything that looks
 * like a connection URL, the legacy URL / its password from the environment,
 * and a Supabase project ref (pooler login name, db.<ref>.supabase.co host)
 * are replaced, so a driver error can never leak a credential or the ref.
 */
import path from "node:path";
import { CliError, parseArgs, type FlagSpec, type ParsedArgs } from "./args";
import { DbBannerError } from "./vowasia-db-banner";
import { ConfigError } from "./vowasia-config";
import { LEGACY_URL_ENV } from "./vowasia-constants";
import { OutDirError, repoRoot } from "./out-dir";
import { VowasiaReaderError } from "./vowasia-reader";
import { VowasiaSqlError } from "./vowasia-sql";

export { CliError };

/** Flags of `migrate:vowasia:discover`. The URL and the site id are never flags (site id: overlay only). */
export const DISCOVER_FLAGS: FlagSpec = { "mapping-overlay": "value", out: "value", sample: "value", schema: "value" };

export const DEFAULT_SOURCE = path.join(repoRoot(), "scripts", "migrate", "vowasia", "legacy-source.vowasia.json");
export const DEFAULT_OUT = path.join(repoRoot(), "scripts", "migrate", "out", "vowasia");

export function parseDiscover(argv: readonly string[]): ParsedArgs {
  const a = parseArgs(argv, DISCOVER_FLAGS);
  return a;
}

export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

const KNOWN = [CliError, ConfigError, VowasiaSqlError, VowasiaReaderError, OutDirError, DbBannerError];

/** Replace URL-like text and known secret values (legacy URL, Central DATABASE_URL, their passwords, the four R2 values) in a message. */
export function redact(message: string, env: Record<string, string | undefined> = process.env): string {
  let out = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
  const secrets: string[] = [];
  // legacy URL and the Central DATABASE_URL: the whole value and its password
  for (const url of [env[LEGACY_URL_ENV], env.DATABASE_URL]) {
    if (!url) continue;
    secrets.push(url);
    try {
      const u = new URL(url);
      if (u.password) secrets.push(u.password, decodeURIComponent(u.password));
    } catch {
      /* unparseable: the whole value is already in the list */
    }
  }
  // the four R2 values (and the endpoint host) when set
  for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    const v = env[k];
    if (!v) continue;
    secrets.push(v);
    if (k === "R2_ENDPOINT") {
      try {
        secrets.push(new URL(v).hostname);
      } catch {
        /* not a URL: the raw value is in the list */
      }
    }
  }
  secrets.sort((x, y) => y.length - x.length);
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join("<redacted>");
  // Supabase project ref: pooler login name (vowasia_migrator.<ref>) and direct host (db.<ref>.supabase.co).
  out = out.replace(/\bvowasia_migrator\.[a-z0-9]{20}\b/g, "vowasia_migrator.<ref>");
  out = out.replace(/\bdb\.[a-z0-9]{20}\.supabase\.co\b/gi, "db.<ref>.supabase.co");
  return out;
}

/** Map an error to (exit code, printed line). Pure, for tests. */
export function failureOf(name: string, err: unknown, env: Record<string, string | undefined> = process.env): { code: number; line: string } {
  const e = err as Error;
  const msg = typeof e?.message === "string" ? e.message : String(err);
  if (KNOWN.some((K) => err instanceof K) || /^(legacy|legacy-sql guard|legacy-db|config|cli|args|discover|out-dir guard):/.test(msg)) {
    return { code: err instanceof CliError ? err.exitCode : 2, line: `[${name}] ${redact(msg, env)}` };
  }
  return { code: 1, line: `[${name}] failed: ${redact(msg, env)}` };
}

export interface RunDeps {
  exit: (code: number) => void;
  error: (line: string) => void;
  env: Record<string, string | undefined>;
}

/** Run a CLI body; exit 0 on success (or the returned code), 2 for refusals, 1 otherwise. */
export async function runMain(name: string, fn: () => Promise<number | void>, deps: RunDeps = { exit: (c) => process.exit(c), error: (l) => console.error(l), env: process.env }): Promise<void> {
  try {
    const code = await fn();
    deps.exit(typeof code === "number" ? code : 0);
  } catch (err) {
    const f = failureOf(name, err, deps.env);
    deps.error(f.line);
    deps.exit(f.code);
  }
}
