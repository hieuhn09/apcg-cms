/**
 * Tenant profile for the shared legacy migration tools (network-legacy bundle).
 * Every value the GTP tools used to hard-code lives here. The DEFAULT profile is
 * GTP with the exact old values, so the GTP entry points (`*-gtp*.ts`) behave
 * byte-for-byte as before. The network bundle (`scripts/migrate/network/`)
 * calls `setProfile()` before loading a command implementation.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export interface NetworkProfile {
  /** Short id used in logs and media filenames. */
  id: string;
  /** Central tenant slug. */
  tenant: string;
  /** Accepted legacy `sites.slug` values; empty = accept the row the site id points at (id still required to match). */
  legacySiteSlugs: readonly string[];
  /** Import marker `engineSourceName` (origin is always "import"). */
  markerSourceName: string;
  /** Env var holding the legacy DB URL; `<prefix>_SSL` / `<prefix>_CA` derive from it. */
  legacyDbEnv: string;
  /** Env var holding the Central public read token (verify --public-base). */
  readTokenEnv: string;
  /** Default structural mapping path (repo-relative). */
  mappingPath: string;
  /** Synthetic fixture site uuid (only one accepted by --rehearsal besides a local Central). */
  fixtureSiteId: string;
  /** Pillars of the tenant (mapping targets must be one of these; preflight requires them). */
  pillarSlugs: readonly string[];
  /** Single-home pillars (never a sub-section; verify check 10). */
  singleHomePillars: readonly string[];
  /** Extra owner-decision keys that may sit in `_provisional`. */
  extraOwnerDecisionKeys: Readonly<Record<string, string>>;
  /** Slugs that can never be article slugs (route names). */
  reservedSlugs?: readonly string[];
  /** Media filename prefix. */
  mediaPrefix: string;
  /** Redirect a non-pillar old section to the pillar its rows were mapped to (AER). Absent/false = keep the old section slug (GTP behaviour). */
  redirectNonPillarSectionsToMappedPillar?: boolean;
  /** Legacy image hosts the effective media.hostAllowlist MUST contain (validate-mapping / import --apply refuse otherwise). Absent = no check (GTP). */
  requiredImageHosts?: readonly string[];
}

export const GTP_PROFILE: NetworkProfile = Object.freeze({
  id: "gtp",
  tenant: "gtp",
  legacySiteSlugs: ["gtp"],
  markerSourceName: "legacy:globaltravelpost",
  legacyDbEnv: "LEGACY_GTP_DB_URL",
  readTokenEnv: "GTP_READ_TOKEN",
  mappingPath: "scripts/migrate/legacy-mapping.gtp-network.json",
  fixtureSiteId: "00000000-0000-0000-0000-00000000f001",
  pillarSlugs: ["news", "destinations", "business-of-travel", "experiences-luxury", "press-room", "events-awards"],
  singleHomePillars: ["press-room"],
  extraOwnerDecisionKeys: {},
  mediaPrefix: "gtp",
});

let active: NetworkProfile = GTP_PROFILE;
export function profile(): NetworkProfile {
  return active;
}
export function setProfile(p: NetworkProfile): void {
  active = p;
}
export function isGtp(): boolean {
  return active === GTP_PROFILE;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ProfileSchema = z
  .object({
    id: z.string().regex(SLUG),
    tenant: z.string().regex(SLUG),
    legacySiteSlugs: z.array(z.string().min(1)),
    markerSourceName: z.string().regex(/^legacy:[a-z0-9.-]+$/),
    legacyDbEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_URL$/),
    readTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    mappingPath: z.string().min(1),
    fixtureSiteId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    pillarSlugs: z.array(z.string().regex(SLUG)).min(1),
    singleHomePillars: z.array(z.string().regex(SLUG)),
    extraOwnerDecisionKeys: z.record(z.string(), z.string()).default({}),
    reservedSlugs: z.array(z.string().regex(SLUG)).optional(),
    mediaPrefix: z.string().regex(SLUG),
    redirectNonPillarSectionsToMappedPillar: z.boolean().optional(),
    requiredImageHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
  })
  .strict();

export class ProfileError extends Error {
  override name = "ProfileError";
}

export function parseProfile(raw: unknown): NetworkProfile {
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) throw new ProfileError(`cli: tenant profile invalid at ${(r.error.issues[0]?.path ?? []).join(".") || "(root)"}.`);
  const p = r.data;
  if (p.tenant === GTP_PROFILE.tenant) throw new ProfileError("cli: the gtp tenant uses the migrate:gtp:* tools, not the network bundle.");
  for (const s of p.singleHomePillars) if (!p.pillarSlugs.includes(s)) throw new ProfileError("cli: tenant profile singleHomePillars must be pillars.");
  return Object.freeze(p);
}

export function loadProfileFile(file: string): NetworkProfile {
  return parseProfile(JSON.parse(readFileSync(file, "utf8")));
}

/** Env-derived names for the legacy DB (`LEGACY_GTP_DB_URL` -> `LEGACY_GTP_DB_SSL`). */
export function legacyEnvNames(p: NetworkProfile = active): { url: string; ssl: string; ca: string } {
  const base = p.legacyDbEnv.replace(/_URL$/, "");
  return { url: p.legacyDbEnv, ssl: `${base}_SSL`, ca: `${base}_CA` };
}

/** Required image hosts missing from an effective hostAllowlist (empty = OK). */
export function missingRequiredImageHosts(allow: readonly string[] | undefined, p: NetworkProfile = active): string[] {
  const have = new Set((allow ?? []).map((h) => h.toLowerCase()));
  return (p.requiredImageHosts ?? []).filter((h) => !have.has(h.toLowerCase()));
}
