/**
 * Slug plan of the VowAsia legacy import (Amendment 4, B-5). Pure.
 *
 * The legacy slug is KEPT (C3: old /article/<slug> -> new /<pillar>/<slug>); it is never
 * renamed. Rejected (with a report line): an unsafe slug, the reserved second segment
 * `page` (the only `vowasia-web` route that clashes, Q4b), a duplicate inside the snapshot
 * (the later row by (created_at, id)), and a clash with an existing tenant-vowasia article
 * WITHOUT the import marker. An existing MARKER article with the slug is reported as
 * `existing` (created by an earlier run; skipped, never adopted). The plan order
 * (created_at, id) is deterministic, so `--limit N` always takes the same rows.
 */
import { orderKey } from "./vowasia-author-distribution";

export const RESERVED_SLUGS: readonly string[] = Object.freeze(["page"]);
export const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SlugItem {
  legacyId: string;
  slug: string;
  createdAt: string | null;
}
export interface ExistingArticle {
  id: number | string;
  slug: string;
  marker: boolean;
}
export interface SlugPlan {
  plan: SlugItem[];
  rejects: { legacyId: string; slug: string; reason: "slugUnsafe" | "slugReserved" | "slugDuplicate" | "slugClash" }[];
  existing: { legacyId: string; slug: string; articleId: number | string }[];
}

export function planSlugs(items: readonly SlugItem[], existing: readonly ExistingArticle[]): SlugPlan {
  const bySlug = new Map(existing.map((e) => [e.slug, e]));
  const out: SlugPlan = { plan: [], rejects: [], existing: [] };
  const seen = new Set<string>();
  for (const it of [...items].sort(orderKey)) {
    if (!SAFE_SLUG.test(it.slug)) out.rejects.push({ legacyId: it.legacyId, slug: it.slug, reason: "slugUnsafe" });
    else if (RESERVED_SLUGS.includes(it.slug)) out.rejects.push({ legacyId: it.legacyId, slug: it.slug, reason: "slugReserved" });
    else if (seen.has(it.slug)) out.rejects.push({ legacyId: it.legacyId, slug: it.slug, reason: "slugDuplicate" });
    else {
      seen.add(it.slug);
      const ex = bySlug.get(it.slug);
      if (ex && !ex.marker) out.rejects.push({ legacyId: it.legacyId, slug: it.slug, reason: "slugClash" });
      else if (ex) out.existing.push({ legacyId: it.legacyId, slug: it.slug, articleId: ex.id });
      else out.plan.push(it);
    }
  }
  return out;
}

/** The first N entries of an ordered plan (all when N is undefined). */
export function limitPlan<T>(plan: readonly T[], n: number | undefined): T[] {
  return n === undefined ? [...plan] : plan.slice(0, n);
}
