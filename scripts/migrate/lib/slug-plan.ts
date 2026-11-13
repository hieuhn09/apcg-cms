/**
 * Deterministic slug plan over the WHOLE GTP population (gtp-launch P4,
 * A11-S09/S-17, A12-N05/N-15a). Computed before any filter (`--limit`,
 * `--ids`, `--status`, `--since`, `--resume`) and persisted as `slug-plan.json`,
 * so every run of the same source assigns the same slug to the same legacy id.
 *
 * Rules: order by (created_at, id) ascending (null created_at = epoch); rows
 * whose status maps to SKIP/reject are excluded from the order; the first row
 * keeps the bare slug, later ones get -2, -3...; preserved slugs are never
 * truncated; a slug that cannot be kept (not [a-z0-9-] after light
 * normalisation, or reserved) is derived/suffixed and reported `slugChanged`.
 * Events are planned AFTER all articles (`legacyId = "event:<id>"`).
 */
import { slugify } from "../../../src/lib/http";
import type { Mapping } from "./gtp-mapping";
import { enText, mapStatus, str } from "./gtp-transform";
import { profile } from "./network-profile";

export const DEFAULT_RESERVED_SLUGS = [
  "news", "destinations", "business-of-travel", "experiences-luxury", "press-room", "events-awards", "about", "team", "contact",
  "advertise", "licensing", "privacy", "terms", "newsletters", "editorial-standards", "press-room-submit", "search", "sitemap",
  "robots", "preview", "api", "article",
];

export interface PlanRow {
  [k: string]: unknown;
  id?: unknown;
  created_at?: unknown;
  status?: unknown;
  slug?: unknown;
  title?: unknown;
  section?: unknown;
  subsection?: unknown;
}

export interface SlugPlanEntry {
  legacyId: string;
  kind: "article" | "event";
  slug: string;
  duplicateOf?: string;
  slugChanged?: { from: string; to: string; reason: string };
}

const SAFE = /^[a-z0-9][a-z0-9-]*$/;

export function sortKey(createdAt: unknown, id: unknown): string {
  const c = createdAt instanceof Date ? createdAt.toISOString() : typeof createdAt === "string" && createdAt ? new Date(createdAt).toISOString() : "1970-01-01T00:00:00.000Z";
  return `${c}\u0000${String(id)}`;
}

/** Light normalisation of a preserved slug (7.3). */
export function normaliseSlug(raw: string): string {
  let s = raw.trim().toLowerCase();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  return s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export function baseSlugFor(row: PlanRow): { slug: string; changed?: { from: string; to: string; reason: string } } {
  const raw = str(row.slug);
  if (raw) {
    const n = normaliseSlug(raw);
    if (SAFE.test(n)) return { slug: n, ...(n !== raw ? { changed: { from: raw, to: n, reason: "normalised" } } : {}) };
    const d = slugify(n, 10_000);
    const to = d || `article-${String(row.id).slice(0, 8)}`;
    return { slug: to, changed: { from: raw, to, reason: "not-url-safe" } };
  }
  const derived = slugify(enText(row.title));
  return { slug: derived || `article-${String(row.id).slice(0, 8)}` };
}

export function buildSlugPlan(rows: readonly PlanRow[], m: Pick<Mapping, "status" | "slug">, reservedExtra: readonly string[] = []): SlugPlanEntry[] {
  const reserved = new Set([...(profile().reservedSlugs ?? DEFAULT_RESERVED_SLUGS), ...m.slug.reservedSlugs, ...reservedExtra]);
  const eligible = rows.filter((r) => mapStatus(r.status, m).kind === "import");
  const ordered = [...eligible].sort((a, b) => (sortKey(a.created_at, a.id) < sortKey(b.created_at, b.id) ? -1 : 1));
  const used = new Map<string, string>(); // slug -> legacyId that owns it
  const out: SlugPlanEntry[] = [];
  for (const r of ordered) {
    const legacyId = String(r.id);
    const base = baseSlugFor(r);
    let slug = base.slug;
    let changed = base.changed;
    let duplicateOf: string | undefined;
    if (reserved.has(slug) || used.has(slug)) {
      duplicateOf = used.get(slug);
      let n = 2;
      while (reserved.has(`${base.slug}-${n}`) || used.has(`${base.slug}-${n}`)) n++;
      const to = `${base.slug}-${n}`;
      if (reserved.has(slug) && !duplicateOf) changed = { from: str(r.slug) || base.slug, to, reason: "reserved" };
      slug = to;
    }
    used.set(slug, legacyId);
    out.push({ legacyId, kind: "article", slug, ...(duplicateOf ? { duplicateOf } : {}), ...(changed ? { slugChanged: changed } : {}) });
  }
  return out;
}

export interface EventPlanInput {
  id: string;
  title: string;
  dateStart: string | null;
}

/** Event slugs after article slugs; collision -> -<yyyy>, then -2, -3. */
export function planEventSlugs(events: readonly EventPlanInput[], taken: Iterable<string>): SlugPlanEntry[] {
  const used = new Set(taken);
  const out: SlugPlanEntry[] = [];
  for (const e of [...events].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const base = slugify(e.title) || `event-${e.id}`;
    let slug = base;
    if (used.has(slug)) {
      const yyyy = e.dateStart ? e.dateStart.slice(0, 4) : "";
      if (yyyy && !used.has(`${base}-${yyyy}`)) slug = `${base}-${yyyy}`;
      else {
        const stem = yyyy ? `${base}-${yyyy}` : base;
        let n = 2;
        while (used.has(`${stem}-${n}`)) n++;
        slug = `${stem}-${n}`;
      }
    }
    used.add(slug);
    out.push({ legacyId: `event:${e.id}`, kind: "event", slug });
  }
  return out;
}

/**
 * Second run (Amendment 5): items an EARLIER run already created keep the slug
 * they really have in Central (`prior`: legacyId -> Central slug), so they are
 * recognised as existing and skipped instead of being re-planned (events would
 * otherwise collide with their own earlier copy, get a -<yyyy> suffix and be
 * created twice). A NEW item whose planned slug is held by such an existing item
 * is moved to -2, -3... (reported as slugChanged). Empty `prior` = identity, so
 * a first run is unchanged. Foreign (non-import) slugs are not handled here: they
 * stay a reported conflict as before.
 */
export function pinPriorSlugs(plan: readonly SlugPlanEntry[], prior: ReadonlyMap<string, string>): SlugPlanEntry[] {
  if (!prior.size) return [...plan];
  const pinned = new Set(prior.values());
  const used = new Set([...pinned, ...plan.filter((e) => !prior.has(e.legacyId) && !pinned.has(e.slug)).map((e) => e.slug)]);
  return plan.map((e) => {
    const p = prior.get(e.legacyId);
    if (p !== undefined) return p === e.slug ? e : { ...e, slug: p };
    if (!pinned.has(e.slug)) return e;
    let n = 2;
    while (used.has(`${e.slug}-${n}`)) n++;
    const to = `${e.slug}-${n}`;
    used.add(to);
    return { ...e, slug: to, slugChanged: { from: e.slug, to, reason: "taken-by-earlier-run" } };
  });
}
