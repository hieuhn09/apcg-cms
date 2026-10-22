/**
 * Mapping of the VowAsia legacy import (Amendment 3, B-1). Owner decisions
 * are HARD-CODED here (not a TODO template), validated with zod strict:
 *
 *  - C8 taxonomy: pillar = legacy `section` slug, one of 5; sub-section = the
 *    same slug as the legacy `subsection`, except the 6 renames below; an
 *    empty sub-section maps to the pillar only; the target sub-section must
 *    exist UNDER that pillar in scripts/lib/vowasia-taxonomy.ts. Any other
 *    (section, subsection) pair is REJECTED with a reason, never guessed.
 *  - C3 URLs: old `https://vowasia.com/article/{slug}` -> new `/{pillar}/{slug}`
 *    (the slug is kept). These values are fixed: the schema only accepts them.
 *  - media.hostAllowlist comes from the owner overlay (outside the repo);
 *    host names only.
 *  - `_provisional` may list only C3 keys; `requireFinal` refuses a mapping
 *    that still has provisional values.
 */
import { z } from "zod";
import { VOWASIA_SUBSECTIONS } from "../../../lib/vowasia-taxonomy";

export const MAPPING_MESSAGES = {
  invalid: "mapping: the VowAsia mapping is invalid; refusing.",
  todo: "mapping: a value still contains TODO; refusing.",
  provisional: "mapping: _provisional is not empty and final values are required; refusing.",
  badSlug: "mapping: slug or pillar is not a safe lower-case slug; refusing.",
} as const;

export class MappingError extends Error {
  override name = "MappingError";
}

/** C8: the 5 legacy sections, each kept as the pillar of the same slug. */
export const C8_PILLARS = Object.freeze(["wedding-business", "venues", "style", "destination-weddings", "planning"] as const);

/** C8: the 6 legacy sub-section renames; every other sub-section keeps its slug. */
export const C8_SUBSECTION_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  people: "people-planners",
  "rings-jewelry": "rings-jewellery",
  trends: "trend-reports",
  guides: "destination-guides",
  "budgets-costs": "budgets-real-costs",
  checklists: "checklists-timelines",
});

/**
 * C8: the approved LEGACY sub-sections under each legacy section (owner table, Amendment 3, 3.3; inferred from
 * the per-column totals of discover, the cross table is measured by B-0b, KB-2). Only these legacy names are
 * accepted as input: a new taxonomy slug (for example `people-planners`) is NOT a legacy sub-section and is
 * rejected. An empty sub-section is accepted under every pillar (pillar only).
 */
export const C8_LEGACY_PAIRS: Readonly<Record<(typeof C8_PILLARS)[number], readonly string[]>> = Object.freeze({
  "wedding-business": Object.freeze(["industry-news", "people", "data-insights"]),
  venues: Object.freeze(["hotels-resorts", "by-destination"]),
  style: Object.freeze(["rings-jewelry", "flowers-decor", "trends", "beauty", "gowns-attire"]),
  "destination-weddings": Object.freeze(["honeymoons", "guides", "pre-wedding-shoots"]),
  planning: Object.freeze(["budgets-costs", "expert-advice", "checklists", "etiquette-traditions"]),
});

export const PROVISIONAL_KEYS = ["urls.oldOrigin", "urls.articlePathTemplate", "urls.targetPathTemplate"] as const;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const mappingSchema = z
  .object({
    _note: z.string().max(2000).optional(),
    _provisional: z.array(z.enum(PROVISIONAL_KEYS)).max(PROVISIONAL_KEYS.length).default([]),
    urls: z
      .object({
        oldOrigin: z.literal("https://vowasia.com").default("https://vowasia.com"),
        articlePathTemplate: z.literal("/article/{slug}").default("/article/{slug}"),
        targetPathTemplate: z.literal("/{pillar}/{slug}").default("/{pillar}/{slug}"),
      })
      .strict()
      .prefault({}),
    media: z
      .object({ hostAllowlist: z.array(z.string().transform((h) => h.toLowerCase()).pipe(z.string().regex(HOST_RE))).max(50).default([]) })
      .strict()
      .prefault({}),
  })
  .strict();

export type VowasiaMapping = z.infer<typeof mappingSchema>;

function containsTodo(v: unknown): boolean {
  if (typeof v === "string") return /todo/i.test(v);
  if (Array.isArray(v)) return v.some(containsTodo);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => /todo/i.test(k) || containsTodo(x));
  return false;
}

export function parseVowasiaMapping(raw: unknown, opts: { requireFinal?: boolean } = {}): VowasiaMapping {
  if (containsTodo(raw)) throw new MappingError(MAPPING_MESSAGES.todo);
  const r = mappingSchema.safeParse(raw ?? {});
  if (!r.success) throw new MappingError(MAPPING_MESSAGES.invalid);
  if (opts.requireFinal && r.data._provisional.length > 0) throw new MappingError(MAPPING_MESSAGES.provisional);
  return r.data;
}

/** The committed defaults (no media host: that comes from the overlay). */
export function defaultVowasiaMapping(): VowasiaMapping {
  return parseVowasiaMapping({});
}

export type TaxonomyResult = { ok: true; pillar: string; subSection: string | null } | { ok: false; reason: string };

/** C8: (legacy section, legacy subsection) -> (pillar, sub-section) or a reject reason. Exact match only. */
export function mapTaxonomy(section: unknown, subsection: unknown): TaxonomyResult {
  if (typeof section !== "string" || !(C8_PILLARS as readonly string[]).includes(section)) {
    return { ok: false, reason: "C8: legacy section is not one of the 5 mapped sections" };
  }
  if (subsection === null || subsection === undefined || subsection === "") return { ok: true, pillar: section, subSection: null };
  if (typeof subsection !== "string") return { ok: false, reason: "C8: legacy subsection is not a string" };
  if (!(C8_LEGACY_PAIRS[section as (typeof C8_PILLARS)[number]] ?? []).includes(subsection)) {
    return { ok: false, reason: "C8: (section, subsection) pair is not in the mapping table" };
  }
  const target = Object.prototype.hasOwnProperty.call(C8_SUBSECTION_RENAMES, subsection) ? (C8_SUBSECTION_RENAMES[subsection] as string) : subsection;
  if (!VOWASIA_SUBSECTIONS.some((s) => s.pillarSlug === section && s.slug === target)) {
    return { ok: false, reason: "C8: (section, subsection) pair is not in the mapping table" };
  }
  return { ok: true, pillar: section, subSection: target };
}

function safeSlug(s: string): string {
  if (!SLUG_RE.test(s)) throw new MappingError(MAPPING_MESSAGES.badSlug);
  return s;
}

/** Old public URL of an article (C3). */
export function oldArticleUrl(m: VowasiaMapping, slug: string): string {
  return m.urls.oldOrigin + m.urls.articlePathTemplate.replace("{slug}", safeSlug(slug));
}

/** New site path of an article (C3, route `/[pillar]/[article]`). */
export function newArticlePath(m: VowasiaMapping, pillar: string, slug: string): string {
  return m.urls.targetPathTemplate.replace("{pillar}", safeSlug(pillar)).replace("{slug}", safeSlug(slug));
}

/** https + exact allow-listed host (case-insensitive); anything else (http, other host, bad URL) is refused. */
export function isAllowedMediaUrl(m: VowasiaMapping, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && m.media.hostAllowlist.includes(u.host.toLowerCase());
}
