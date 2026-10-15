/**
 * Mapping config v1 for the GTP legacy importer (gtp-launch P4, 6.2 as
 * superseded by A12-N01/N02/N11 and A13). Two layers:
 *   (a) the committed STRUCTURAL mapping `scripts/migrate/legacy-mapping.gtp-network.json`
 *       (columns, status/taxonomy/author rules, provisional owner-decision
 *       values; NO site id, NO image host);
 *   (b) an OVERLAY (`--mapping-overlay <path>`) carrying exactly
 *       `source.siteFilter`, `media.hostAllowlist`, `media.hostRewrite`.
 * Effective mapping = structural deep-merged with the overlay.
 *
 * Validation rules: unknown keys rejected (zod strict); a literal "TODO"
 * anywhere fails; `_provisional` may list only owner-decision keys and
 * `--require-final` fails while it is non-empty; `hostRewrite` targets must be
 * 127.0.0.1 or localhost; pillars are the 6 gtp slugs; press-room never has a
 * sub-section; author targets must be staff (createMissing is always false).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ALLOWED_TABLE_NAMES, effectiveAllowList } from "./legacy-sql";

export const GTP_PILLAR_SLUGS = ["news", "destinations", "business-of-travel", "experiences-luxury", "press-room", "events-awards"] as const;

/** Owner-decision keys that may carry a provisional value (A12-N01). */
export const OWNER_DECISION_KEYS = {
  "urls.oldOrigin": "OD-24",
  "urls.articlePathTemplate": "OD-24",
  "urls.sectionPaths": "OD-24",
  "urls.extraLegacyPaths": "OD-24",
  "urls.gonePaths": "OD-24",
  archivedAs: "OD-8",
  "formatTags.enabled": "OD-format-tags",
  pin: "OD-pin",
  "countries.match": "OD-countries",
} as const;

/** The 5 web authors (Amendment 3 pool, fixed order). */
export const WEB_AUTHORS = ["Daniel Cheong", "Priya Nair", "Marcus Tan", "Natalie Ong", "Yuki Hamada"] as const;

export const OVERLAY_KEYS = ["source.siteFilter", "media.hostAllowlist", "media.hostRewrite"] as const;

export const MAPPING_MESSAGES = {
  todo: 'mapping: a literal "TODO" remains; fill every value before running.',
  provisionalForeign: "mapping: _provisional names a key outside the owner-decision set.",
  requireFinal: "mapping: --require-final is set and provisional owner-decision values remain; refusing.",
  overlayForeign: "mapping overlay: only source.siteFilter, media.hostAllowlist and media.hostRewrite are allowed.",
  rewriteNotLocal: "mapping overlay: media.hostRewrite targets must be 127.0.0.1 or localhost.",
  structuralHasOverlayKey: "mapping: the structural mapping must not carry source.siteFilter, media.hostAllowlist or media.hostRewrite.",
  overlayRequired: "mapping: overlay required (source.siteFilter and media.hostAllowlist are missing).",
  pillar: (p: string) => `mapping: pillar "${p}" is not one of the 6 gtp pillars.`,
  pressRoomSub: "mapping: press-room targets never carry a sub-section (single-home).",
  author: (n: string) => `mapping: author target "${n}" is not in authors.staff.`,
  createMissing: "mapping: authors.createMissing must be false (the importer never creates authors).",
  fallbackName: "mapping: authors.fallbackName is retired (Amendment 3); every item gets an author from authors.distribute.pool.",
  newsroom: 'mapping: "GTP Newsroom" must not appear in authors (Amendment 3: no article is credited to the newsroom).',
  gonePath: (p: string) => `mapping: urls.gonePaths entry "${p}" must start with "/".`,
  goneOverlap: (p: string) => `mapping: "${p}" is listed in both urls.gonePaths and urls.extraLegacyPaths.`,
  pool: "mapping: authors.distribute.pool must be non-empty, unique and a subset of authors.staff.",
} as const;

export class MappingError extends Error {
  override name = "MappingError";
}

const STATUS_TARGET = z.enum(["published", "draft", "archived", "hidden", "SKIP"]);
const TARGET = z.object({ pillar: z.string(), subSection: z.string().optional(), addTags: z.array(z.string()).optional() }).strict();
const DEFAULT_ALLOWED_TAGS = ["p", "br", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "b", "i", "a", "blockquote", "figure", "figcaption", "img", "table", "thead", "tbody", "tr", "th", "td", "hr", "sup", "sub", "code", "pre"];
export const DEFAULT_REDACT = ["email", "phone", "password", "passwd", "token", "secret", "ip", "address", "dob", "user_agent", "contact"];

export const MappingSchema = z
  .object({
    version: z.literal(1),
    _provisional: z.array(z.string()).optional(),
    _evidence: z.unknown().optional(),
    source: z
      .object({
        schema: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("public"),
        siteFilter: z.string().optional(),
        tableAllowList: z.array(z.string()).default([...ALLOWED_TABLE_NAMES]),
        columns: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .prefault({}),
    body: z
      .object({
        format: z.enum(["sections", "auto", "html", "markdown", "lexical-json", "text"]).default("sections"),
        converter: z.enum(["html-to-lexical", "markdown-to-lexical", "passthrough-lexical", "plain-paragraphs"]).default("html-to-lexical"),
        lineBreaks: z.enum(["space", "br"]).default("space"),
        sanitize: z.boolean().default(true),
        stripEmbeds: z.boolean().default(true),
        allowedTags: z.array(z.string()).default(DEFAULT_ALLOWED_TAGS),
        maxBytes: z.number().int().positive().default(1_048_576),
      })
      .strict()
      .prefault({}),
    status: z
      .object({
        map: z.record(z.string(), STATUS_TARGET).default({ published: "published", archived: "archived", draft: "draft", rejected: "SKIP" }),
        unknown: z.enum(["reject", "draft", "SKIP"]).default("reject"),
      })
      .strict()
      .prefault({}),
    categories: z
      .object({
        map: z.record(z.string(), TARGET).default({}),
        fallback: TARGET.nullable().default(null),
        unmapped: z.enum(["reject", "fallback"]).default("reject"),
      })
      .strict()
      .prefault({}),
    routing: z
      .object({
        pressRelease: z.object({ detect: z.array(z.unknown()).default([]) }).strict().prefault({}),
        events: z.object({ detect: z.array(z.unknown()).default([]) }).strict().prefault({}),
      })
      .strict()
      .prefault({}),
    authors: z
      .object({
        resolve: z.enum(["byColumn", "byJoin", "fixed"]).default("byColumn"),
        map: z.record(z.string(), z.string()).default({}),
        staff: z.array(z.string()).default([...WEB_AUTHORS]),
        // Amendment 3: bylines are distributed evenly over the pool (not by pillar).
        distribute: z
          .object({
            pool: z.array(z.string()).default([...WEB_AUTHORS]),
            keepLegacy: z.boolean().default(false),
            groupBy: z.enum(["country", "none"]).default("country"),
            maxSpread: z.number().int().min(1).default(1),
          })
          .strict()
          .prefault({}),
        createMissing: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    tags: z
      .object({
        normalize: z.enum(["lowercase-trim-dedupe"]).default("lowercase-trim-dedupe"),
        maxPerArticle: z.number().int().positive().default(12),
        drop: z.array(z.string()).default([]),
        renames: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .prefault({}),
    formatTags: z
      .object({
        enabled: z.boolean().default(true),
        include: z.array(z.string()).default(["guide", "analysis", "review", "interview"]),
      })
      .strict()
      .prefault({}),
    countries: z.object({ match: z.enum(["code", "name", "either"]).default("either") }).strict().prefault({}),
    readMin: z.object({ wpm: z.number().int().positive().default(230) }).strict().prefault({}),
    pin: z.object({ fromFlags: z.boolean().default(false), maxPinned: z.number().int().min(0).default(0) }).strict().prefault({}),
    archivedAs: z.enum(["section", "410"]).default("section"),
    events: z
      .object({
        enabled: z.boolean().default(true),
        nearMatchThreshold: z.number().min(0).max(1).default(0.9),
        inactive: z.enum(["archived"]).default("archived"),
      })
      .strict()
      .prefault({}),
    dates: z
      .object({ fallback: z.enum(["createdAt", "now"]).default("createdAt"), timezone: z.literal("UTC").default("UTC") })
      .strict()
      .prefault({}),
    slug: z
      .object({
        preserve: z.boolean().default(true),
        dedupe: z.literal("numeric-suffix").default("numeric-suffix"),
        reservedSlugs: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    flags: z.object({ breaking: z.boolean().default(false) }).strict().prefault({}),
    urls: z
      .object({
        oldOrigin: z.string().default("https://www.globaltravelpost.com"),
        articlePathTemplate: z.string().default("/{section}/{slug}"),
        sectionPaths: z.record(z.string(), z.string()).default({}),
        extraLegacyPaths: z.array(z.string()).default([]),
        // Amendment 4: old paths of sections dropped on the new site; each answers 410 Gone.
        gonePaths: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    media: z
      .object({
        hostAllowlist: z.array(z.string()).optional(),
        hostRewrite: z.record(z.string(), z.string()).optional(),
        maxBytes: z.number().int().positive().default(20_971_520),
        failureBudgetPercent: z.number().min(0).max(100).default(2),
        fetchTimeoutMs: z.number().int().positive().default(30_000),
        concurrency: z.number().int().positive().default(3),
        hotlinkPolicy: z.enum(["download", "skip"]).default("download"),
      })
      .strict()
      .prefault({}),
    redact: z.array(z.string()).default(DEFAULT_REDACT),
  })
  .strict();

export type Mapping = z.infer<typeof MappingSchema>;

/** The authoritative v1 key table (A12-N11) as dotted top-level + second-level keys. */
export const KEY_TABLE: readonly string[] = [
  "version", "_provisional", "_evidence",
  "source.schema", "source.siteFilter", "source.tableAllowList", "source.columns",
  "body.format", "body.converter", "body.lineBreaks", "body.sanitize", "body.stripEmbeds", "body.allowedTags", "body.maxBytes",
  "status.map", "status.unknown",
  "categories.map", "categories.fallback", "categories.unmapped",
  "routing.pressRelease", "routing.events",
  "authors.resolve", "authors.map", "authors.staff", "authors.distribute", "authors.createMissing",
  "tags.normalize", "tags.maxPerArticle", "tags.drop", "tags.renames",
  "formatTags.enabled", "formatTags.include",
  "countries.match", "readMin.wpm", "pin.fromFlags", "pin.maxPinned", "archivedAs",
  "events.enabled", "events.nearMatchThreshold", "events.inactive",
  "dates.fallback", "dates.timezone", "slug.preserve", "slug.dedupe", "slug.reservedSlugs", "flags.breaking",
  "urls.oldOrigin", "urls.articlePathTemplate", "urls.sectionPaths", "urls.extraLegacyPaths", "urls.gonePaths",
  "media.hostAllowlist", "media.hostRewrite", "media.maxBytes", "media.failureBudgetPercent", "media.fetchTimeoutMs",
  "media.concurrency", "media.hotlinkPolicy",
  "redact",
];

/** Keys of the zod schema in the KEY_TABLE form (for G47). */
export function schemaKeys(): string[] {
  const out: string[] = [];
  const shape = MappingSchema.shape as Record<string, z.ZodType>;
  const objectShape = (t: z.ZodType): Record<string, z.ZodType> | undefined => {
    let cur: unknown = t;
    for (let i = 0; i < 6 && cur; i++) {
      const def = (cur as { def?: { type?: string; innerType?: unknown; shape?: unknown } }).def;
      if (def?.type === "object") return (cur as z.ZodObject).shape as Record<string, z.ZodType>;
      cur = def?.innerType;
    }
    return undefined;
  };
  for (const [k, v] of Object.entries(shape)) {
    const inner = objectShape(v);
    if (inner && k !== "_evidence") for (const k2 of Object.keys(inner)) out.push(`${k}.${k2}`);
    else out.push(k);
  }
  return out;
}

const OverlaySchema = z
  .object({
    source: z.object({ siteFilter: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict(),
    media: z.object({ hostAllowlist: z.array(z.string().min(1)).min(1), hostRewrite: z.record(z.string(), z.string()).default({}) }).strict(),
  })
  .strict();
export type Overlay = z.infer<typeof OverlaySchema>;

function containsTodo(v: unknown): boolean {
  if (typeof v === "string") return /\bTODO\b/.test(v);
  if (Array.isArray(v)) return v.some(containsTodo);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => /\bTODO\b/.test(k) || containsTodo(x));
  return false;
}

function isLocalRewriteTarget(target: string): boolean {
  const host = target.replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost";
}

export function parseOverlay(raw: unknown): Overlay {
  const r = OverlaySchema.safeParse(raw);
  if (!r.success) throw new MappingError(MAPPING_MESSAGES.overlayForeign);
  for (const target of Object.values(r.data.media.hostRewrite)) {
    if (!isLocalRewriteTarget(target)) throw new MappingError(MAPPING_MESSAGES.rewriteNotLocal);
  }
  return r.data;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return b;
}

export interface ValidationResult {
  mapping: Mapping;
  provisional: { key: string; value: unknown; decision: string }[];
  structuralOnly: boolean;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/**
 * Validate structural (+ optional overlay). Throws MappingError with a fixed
 * message on the first problem. `requireFinal` makes provisional markers fatal.
 */
export function validateMapping(structuralRaw: unknown, overlayRaw: unknown | undefined, opts: { requireFinal?: boolean; structuralOnly?: boolean } = {}): ValidationResult {
  if (containsTodo(structuralRaw) || (overlayRaw !== undefined && containsTodo(overlayRaw))) throw new MappingError(MAPPING_MESSAGES.todo);
  const s = structuralRaw as Record<string, unknown>;
  for (const key of OVERLAY_KEYS) if (getPath(s, key) !== undefined) throw new MappingError(MAPPING_MESSAGES.structuralHasOverlayKey);
  const overlay = overlayRaw === undefined ? undefined : parseOverlay(overlayRaw);
  const merged = overlay ? deepMerge(structuralRaw, overlay) : structuralRaw;
  const rawAuthors = (merged as { authors?: Record<string, unknown> } | undefined)?.authors;
  if (rawAuthors && typeof rawAuthors === "object") {
    if ("fallbackName" in rawAuthors) throw new MappingError(MAPPING_MESSAGES.fallbackName);
    if (JSON.stringify(rawAuthors).includes("GTP Newsroom")) throw new MappingError(MAPPING_MESSAGES.newsroom);
  }
  const parsed = MappingSchema.safeParse(merged);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MappingError(`mapping: schema error at ${(first?.path ?? []).join(".") || "(root)"}: ${first?.code ?? "invalid"}.`);
  }
  const m = parsed.data;
  effectiveAllowList(m.source.tableAllowList); // narrowing rule; throws LegacySqlError with a fixed message
  const prov = m._provisional ?? [];
  for (const k of prov) if (!(k in OWNER_DECISION_KEYS)) throw new MappingError(MAPPING_MESSAGES.provisionalForeign);
  if (m.authors.createMissing) throw new MappingError(MAPPING_MESSAGES.createMissing);
  const pillars = new Set<string>(GTP_PILLAR_SLUGS);
  const targets = [...Object.values(m.categories.map), ...(m.categories.fallback ? [m.categories.fallback] : [])];
  for (const t of targets) {
    if (!pillars.has(t.pillar)) throw new MappingError(MAPPING_MESSAGES.pillar(t.pillar));
    if (t.pillar === "press-room" && t.subSection) throw new MappingError(MAPPING_MESSAGES.pressRoomSub);
  }
  for (const target of Object.values(m.authors.map)) {
    if (!m.authors.staff.includes(target)) throw new MappingError(MAPPING_MESSAGES.author(target));
  }
  const pool = m.authors.distribute.pool;
  if (!pool.length || new Set(pool).size !== pool.length || pool.some((n) => !m.authors.staff.includes(n))) throw new MappingError(MAPPING_MESSAGES.pool);
  for (const p of m.urls.gonePaths) {
    if (!p.startsWith("/")) throw new MappingError(MAPPING_MESSAGES.gonePath(p));
    if (m.urls.extraLegacyPaths.includes(p)) throw new MappingError(MAPPING_MESSAGES.goneOverlap(p));
  }
  const structuralOnly = opts.structuralOnly === true;
  if (!structuralOnly && (!m.source.siteFilter || !m.media.hostAllowlist?.length)) throw new MappingError(MAPPING_MESSAGES.overlayRequired);
  if (opts.requireFinal && prov.length > 0) throw new MappingError(MAPPING_MESSAGES.requireFinal);
  return {
    mapping: m,
    provisional: prov.map((key) => ({ key, value: getPath(m, key), decision: OWNER_DECISION_KEYS[key as keyof typeof OWNER_DECISION_KEYS] })),
    structuralOnly,
  };
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadMapping(structuralPath: string, overlayPath: string | undefined, opts: { requireFinal?: boolean; structuralOnly?: boolean } = {}): ValidationResult {
  return validateMapping(readJson(structuralPath), overlayPath ? readJson(overlayPath) : undefined, opts);
}

/** Stable sha256 of the effective mapping (canonical key order). */
export function mappingFingerprint(m: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(m))).digest("hex");
}

/** Check that mapped source columns exist in the discovered catalog (A4 validateAgainstCatalog). */
export function validateAgainstCatalog(m: Mapping, catalog: Map<string, Set<string>>): string[] {
  const missing: string[] = [];
  const cols = catalog.get("articles");
  if (!cols) return ["articles (table not found)"];
  for (const [logical, column] of Object.entries(m.source.columns)) if (!cols.has(column)) missing.push(`articles.${column} (${logical})`);
  return missing;
}

/** Print-friendly PROVISIONAL list. */
export function formatProvisional(p: ValidationResult["provisional"]): string {
  if (!p.length) return "PROVISIONAL: none";
  return ["PROVISIONAL owner-decision values (pass --require-final to make them fatal):", ...p.map((x) => `  - ${x.key} = ${JSON.stringify(x.value)} (${x.decision})`)].join("\n");
}
