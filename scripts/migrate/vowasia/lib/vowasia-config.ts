/**
 * Source configuration of the VowAsia legacy reader (phase A). Nothing about
 * the legacy schema is hard-coded: table names, columns, keys, the site id kind
 * and the site filter come from
 *   (1) the committed HYPOTHESIS `scripts/migrate/vowasia/legacy-source.vowasia.json`
 *       (no site id, no image host, no URL), and
 *   (2) an OVERLAY kept by the owner OUTSIDE the repo (built from the discover
 *       report): `source.siteFilter`, `source.siteIdKind`, `source.schema`,
 *       `source.tables.*`, `source.columnRoles.*`, optional `media.*`.
 * Validation is zod strict: unknown keys, any "TODO", identifiers outside
 * lower snake_case and more than 6 tables are refused with fixed messages.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { LEGACY_SITE_SLUG } from "./vowasia-constants";

export const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
export const MAX_TABLES = 6;

export const CONFIG_MESSAGES = {
  ident: "legacy: identifier not supported by closed builder; amendment required.",
  todo: "config: a value still contains TODO; refusing.",
  invalid: "config: source configuration is invalid; refusing.",
  unreadable: "config: source configuration file could not be read or parsed; refusing.",
  noSiteFilter: "config: source.siteFilter is missing (set it in the overlay kept outside the repo); refusing.",
  badSiteId: "config: source.siteFilter does not match source.siteIdKind; refusing.",
  noSites: "config: source.tables must contain a sites table; refusing.",
  noArticles: "config: source.tables must contain an articles table; refusing.",
  badSlug: "config: source.expectedSiteSlug must be vowasia; refusing.",
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const SITE_ID_KINDS = ["uuid", "integer", "text-safe"] as const;
export type SiteIdKind = (typeof SITE_ID_KINDS)[number];

export const SITE_ID_PATTERNS: Readonly<Record<SiteIdKind, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  integer: /^[0-9]{1,18}$/,
  "text-safe": /^[A-Za-z0-9_-]{1,64}$/,
};

export function isValidSiteId(kind: SiteIdKind, v: unknown): v is string {
  return typeof v === "string" && SITE_ID_PATTERNS[kind].test(v);
}

const ident = z.string().regex(IDENT_RE, CONFIG_MESSAGES.ident);

/** One legacy table (or view) under a logical name. */
const tableSchema = z
  .object({
    /** Real table/view name in the legacy schema. */
    name: ident,
    /** Column that carries the site id (for `sites`: its primary key). */
    siteColumn: ident,
    /** Stable ordering key, after the created-at column when present. */
    keyColumns: z.array(ident).min(1).max(3),
    /** Created-at column for keyset ordering, or null when the table has none. */
    createdAtColumn: ident.nullable(),
  })
  .strict();

export const ROLE_NAMES = ["createdAt", "publishedAt", "status", "category", "section", "subsection", "slug", "title", "body", "image", "name", "bio", "beats", "excerpt", "imageCredit", "tags", "updatedAt"] as const;
export type ColumnRole = (typeof ROLE_NAMES)[number];

const rolesSchema = z.object(Object.fromEntries(ROLE_NAMES.map((r) => [r, ident.optional()])) as Record<ColumnRole, z.ZodOptional<typeof ident>>).strict();

const mediaSchema = z
  .object({
    hostAllowlist: z.array(z.string().min(1).max(253)).max(50).optional(),
    hostRewrite: z.record(z.string().min(1).max(253), z.string().min(1).max(253)).optional(),
  })
  .strict();

const sitesTableSchema = tableSchema.extend({ slugColumn: ident, nameColumn: ident }).strict();

export const sourceConfigSchema = z
  .object({
    _hypothesis: z.boolean().optional(),
    _note: z.string().max(2000).optional(),
    source: z
      .object({
        schema: ident,
        siteIdKind: z.enum(SITE_ID_KINDS),
        siteFilter: z.string().min(1).max(64).optional(),
        expectedSiteSlug: z.string().refine((v) => v === LEGACY_SITE_SLUG, { message: CONFIG_MESSAGES.badSlug }).default(LEGACY_SITE_SLUG),
        tables: z
          .object({ articles: tableSchema, sites: sitesTableSchema })
          .catchall(tableSchema)
          .refine((t) => Object.keys(t).length <= MAX_TABLES, `config: at most ${MAX_TABLES} tables; refusing.`)
          .refine((t) => Object.keys(t).every((k) => IDENT_RE.test(k)), CONFIG_MESSAGES.ident),
        columnRoles: rolesSchema,
      })
      .strict(),
    media: mediaSchema.optional(),
  })
  .strict();

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type TableConfig = z.infer<typeof tableSchema>;

function containsTodo(v: unknown): boolean {
  if (typeof v === "string") return /todo/i.test(v);
  if (Array.isArray(v)) return v.some(containsTodo);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => /todo/i.test(k) || containsTodo(x));
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays and scalars of the overlay replace the base. */
export function mergeOverlay(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay === undefined ? base : overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = k in base ? mergeOverlay(base[k], v) : v;
  return out;
}

export interface ParseOptions {
  /** Require `source.siteFilter` (discover/read need it; the committed hypothesis must NOT have it). */
  requireSiteFilter?: boolean;
}

/** Validate an already-merged object. Fixed messages only (never echoes values). */
export function parseSourceConfig(raw: unknown, opts: ParseOptions = {}): SourceConfig {
  if (containsTodo(raw)) throw new ConfigError(CONFIG_MESSAGES.todo);
  const r = sourceConfigSchema.safeParse(raw);
  if (!r.success) {
    const msgs = r.error.issues.map((i) => i.message);
    if (msgs.includes(CONFIG_MESSAGES.ident)) throw new ConfigError(CONFIG_MESSAGES.ident);
    const fixed = msgs.find((m) => m.startsWith("config: "));
    throw new ConfigError(fixed ?? CONFIG_MESSAGES.invalid);
  }
  const cfg = r.data;
  if (cfg.source.siteFilter !== undefined && !isValidSiteId(cfg.source.siteIdKind, cfg.source.siteFilter)) throw new ConfigError(CONFIG_MESSAGES.badSiteId);
  if (opts.requireSiteFilter && cfg.source.siteFilter === undefined) throw new ConfigError(CONFIG_MESSAGES.noSiteFilter);
  return cfg;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(CONFIG_MESSAGES.unreadable);
  }
}

/** Load the committed hypothesis, apply the overlay (if any) and validate. */
export function loadSourceConfig(basePath: string, overlayPath: string | undefined, opts: ParseOptions = {}): SourceConfig {
  const base = readJson(basePath);
  const merged = overlayPath === undefined ? base : mergeOverlay(base, readJson(overlayPath));
  return parseSourceConfig(merged, opts);
}

/** Override the site filter (e.g. from a flag) and re-validate its kind. */
export function withSiteFilter(cfg: SourceConfig, siteFilter: string | undefined): SourceConfig {
  if (siteFilter === undefined) return cfg;
  if (!isValidSiteId(cfg.source.siteIdKind, siteFilter)) throw new ConfigError(CONFIG_MESSAGES.badSiteId);
  return { ...cfg, source: { ...cfg.source, siteFilter } };
}
