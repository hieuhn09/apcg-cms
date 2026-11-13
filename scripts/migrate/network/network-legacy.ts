/**
 * network-legacy: ONE entry for every title of the shared legacy network DB
 * (Supabase project "globaltravelpost"). Runs the same pipeline as the GTP
 * tools, parameterised by a committed tenant profile (profiles/<tenant>.json):
 *
 *   npm run migrate:network -- <command> --tenant <central-slug> --site <legacy-site-slug|site-uuid> [command flags]
 *
 * Commands: discover | export | validate-mapping | import | rewrite-links |
 * timestamps-fix | rollback | redirects | verify. Command flags are exactly those
 * of the GTP tools (scripts/migrate/lib/cli-spec.ts); see NETWORK-LEGACY.md.
 *
 * Safety (inherited, enforced in code): dry run unless --apply; Central
 * DATABASE_URL non-local needs --confirm-host=<host>, a TTY for --apply, AND
 * database name /neondb (central-db-name-guard); legacy reads only through the
 * closed, site-filtered, BEGIN READ ONLY builders; out dir git-ignored 700/600.
 * Legacy URL: env LEGACY_DB_URL only (never argv).
 *
 * The Payload-booting commands can stall while loading (lib/load-guard.ts, exit
 * 75 before any work). This entry re-runs the SAME command up to 3 times on 75.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOAD_STALL_EXIT, runGuarded } from "../lib/load-guard";
import { parseProfile, setProfile, type NetworkProfile } from "../lib/network-profile";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

const COMMANDS = {
  discover: { load: () => import("../discover-legacy-pg"), legacy: true, guarded: false },
  export: { load: () => import("./export-network"), legacy: true, guarded: false },
  "validate-mapping": { load: () => import("../validate-gtp-mapping"), legacy: false, guarded: false },
  import: { load: () => import("../lib/import-gtp-main"), legacy: true, guarded: true },
  "rewrite-links": { load: () => import("../lib/rewrite-links-main"), legacy: false, guarded: true },
  "timestamps-fix": { load: () => import("./timestamps-fix-network"), legacy: false, guarded: false },
  rollback: { load: () => import("../lib/rollback-main"), legacy: false, guarded: true },
  redirects: { load: () => import("../build-gtp-redirects"), legacy: false, guarded: false },
  verify: { load: () => import("../lib/verify-main"), legacy: true, guarded: true },
} as const;
type Cmd = keyof typeof COMMANDS;

export class EntryError extends Error {}

export interface EntryPlan {
  command: Cmd;
  profile: NetworkProfile;
  argv: string[];
}

/** Pure: parse the entry flags, build the effective profile and the argv the command sees. */
export function planEntry(argv: readonly string[], readFile: (p: string) => string = (p) => readFileSync(p, "utf8"), profilesDir = path.join(HERE, "profiles")): EntryPlan {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMANDS)) throw new EntryError(`network: first argument must be one of ${Object.keys(COMMANDS).join(", ")}.`);
  const out: string[] = [];
  let tenant: string | undefined;
  let site: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    const take = (name: string): string | undefined => {
      if (a === `--${name}`) {
        i++;
        return rest[i];
      }
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
      return undefined;
    };
    const t = take("tenant");
    if (t !== undefined || a === "--tenant") {
      tenant = t;
      continue;
    }
    const s = take("site");
    if (s !== undefined || a === "--site") {
      site = s;
      continue;
    }
    out.push(a);
  }
  if (!tenant || !SLUG.test(tenant)) throw new EntryError("network: --tenant <central-slug> is required.");
  if (tenant === "gtp") throw new EntryError("network: gtp uses npm run migrate:gtp:* (its own pre-cutover tools).");
  const file = path.join(profilesDir, `${tenant}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(file));
  } catch {
    throw new EntryError(`network: no tenant profile for ${tenant} (expected scripts/migrate/network/profiles/${tenant}.json).`);
  }
  const base = parseProfile(raw);
  if (base.tenant !== tenant) throw new EntryError("network: profile tenant does not match --tenant; refusing.");
  const spec = COMMANDS[command as Cmd];
  if (spec.legacy && !site) throw new EntryError(`network: --site <legacy-site-slug|site-uuid> is required for this command (find it with scripts/migrate/network/sql/01-discover-${tenant}.sql).`);
  let legacySiteSlugs = base.legacySiteSlugs;
  if (site) {
    if (UUID.test(site)) {
      legacySiteSlugs = [];
      const ovIdx = out.findIndex((x) => x === "--mapping-overlay" || x.startsWith("--mapping-overlay="));
      if (ovIdx >= 0) {
        const ovPath = out[ovIdx]?.includes("=") ? (out[ovIdx] as string).split("=").slice(1).join("=") : out[ovIdx + 1];
        let sf: unknown;
        try {
          sf = (JSON.parse(readFile(path.resolve(String(ovPath)))) as { source?: { siteFilter?: unknown } }).source?.siteFilter;
        } catch {
          throw new EntryError("network: --mapping-overlay could not be read.");
        }
        if (String(sf).toLowerCase() !== site.toLowerCase()) throw new EntryError("network: --site uuid and the overlay source.siteFilter differ; refusing.");
      } else if ((command === "discover" || command === "export") && !out.some((x) => x.startsWith("--site-id"))) out.push("--site-id", site.toLowerCase());
    } else if (SLUG.test(site)) legacySiteSlugs = [site];
    else throw new EntryError("network: --site must be a legacy site slug or a site uuid.");
  }
  const p = parseProfile({ ...base, legacySiteSlugs: [...legacySiteSlugs] });
  if (command === "validate-mapping" && !out.some((x) => x === "--mapping" || x.startsWith("--mapping="))) out.push("--mapping", p.mappingPath);
  return { command: command as Cmd, profile: p, argv: out };
}

function main(): void {
  const args = process.argv.slice(2);
  if (process.env.NETWORK_LEGACY_CHILD !== "1") {
    // Parent: validate first (fast fail), then run the command in a child, retrying a load stall.
    try {
      planEntry(args);
    } catch (e) {
      console.error(`[network] ${(e as Error).message}`);
      process.exit(2);
    }
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: "inherit", env: { ...process.env, NETWORK_LEGACY_CHILD: "1" } });
      const code = r.status ?? 1;
      if (code === LOAD_STALL_EXIT && attempt < 3) {
        console.error(`[network] load stall (exit 75), re-running the same command (attempt ${attempt + 1} of 3).`);
        continue;
      }
      process.exit(code);
    }
  }
  let plan: EntryPlan;
  try {
    plan = planEntry(args);
  } catch (e) {
    console.error(`[network] ${(e as Error).message}`);
    process.exit(2);
  }
  setProfile(plan.profile);
  process.argv = [process.argv[0] as string, process.argv[1] as string, ...plan.argv];
  console.log(`[network] tenant ${plan.profile.tenant}; legacy site ${plan.profile.legacySiteSlugs.length ? `slug ${plan.profile.legacySiteSlugs.join("/")}` : "by id"}; command ${plan.command}`);
  const spec = COMMANDS[plan.command];
  if (spec.guarded) runGuarded(plan.command, spec.load);
  else void spec.load();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
