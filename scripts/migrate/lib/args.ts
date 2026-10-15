/**
 * Pure argv parser for the GTP legacy migration tools (gtp-launch P4, A11-S02,
 * A13-R02). Default is a DRY RUN: `apply` is true only with `--apply`.
 * `DRY_RUN` from `scripts/lib/env.ts` (which means "write unless --dry-run")
 * is deliberately never imported by these tools.
 */
export class CliError extends Error {
  override name = "CliError";
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

export const ARG_MESSAGES = {
  applyAndDry: "args: --apply and --dry-run are mutually exclusive; refusing.",
  unknown: (f: string) => `args: unknown flag ${f}; refusing.`,
  missingValue: (f: string) => `args: flag ${f} needs a value.`,
  unexpectedValue: (f: string) => `args: flag ${f} takes no value.`,
  positional: "args: positional arguments are not accepted.",
} as const;

export type FlagKind = "bool" | "value";
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  apply: boolean;
  dryRun: boolean;
  get(name: string): string | undefined;
  has(name: string): boolean;
}

/** Parse `argv` (without node/script) against a flag spec; `--x=v` and `--x v` both work. */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    if (!raw.startsWith("--")) throw new CliError(ARG_MESSAGES.positional);
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const kind = spec[name];
    if (!kind) throw new CliError(ARG_MESSAGES.unknown(`--${name}`));
    if (kind === "bool") {
      if (eq >= 0) throw new CliError(ARG_MESSAGES.unexpectedValue(`--${name}`));
      flags[name] = true;
    } else {
      let v: string | undefined;
      if (eq >= 0) v = raw.slice(eq + 1);
      else {
        v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new CliError(ARG_MESSAGES.missingValue(`--${name}`));
        i++;
      }
      if (v === "") throw new CliError(ARG_MESSAGES.missingValue(`--${name}`));
      flags[name] = v;
    }
  }
  const apply = flags.apply === true;
  const dryRun = flags["dry-run"] === true;
  if (apply && dryRun) throw new CliError(ARG_MESSAGES.applyAndDry);
  return {
    flags,
    apply,
    dryRun: !apply,
    get: (n) => (typeof flags[n] === "string" ? (flags[n] as string) : undefined),
    has: (n) => flags[n] !== undefined,
  };
}

export function intFlag(a: ParsedArgs, name: string, def?: number): number | undefined {
  const v = a.get(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`args: --${name} must be a positive integer.`);
  return n;
}
