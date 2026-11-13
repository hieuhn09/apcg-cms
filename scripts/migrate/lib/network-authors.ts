/**
 * Byline rules of the network bundle (beyond the GTP "even" distribution):
 *   - slugHash: author = pool[sha1(slug) mod pool.length] (D7, stable per slug,
 *     independent of order, of resume and of later delta runs);
 *   - bySection: author = bySection[old section] (what readers saw on the old
 *     site); a section without an entry falls back to slugHash.
 * Items in `fixed` (already in Central from an earlier run) keep their author.
 * Pure. Never returns a name outside the pool / map targets.
 */
import { createHash } from "node:crypto";
import type { AuthorItem } from "./gtp-author-distribution";

export function slugHashAuthor(slug: string, pool: readonly string[]): string {
  if (!pool.length) throw new Error("authors.distribute: pool is empty.");
  const n = parseInt(createHash("sha1").update(slug).digest("hex").slice(0, 8), 16);
  return pool[n % pool.length] as string;
}

export function assignByRule(
  items: readonly AuthorItem[],
  mode: "bySection" | "slugHash",
  pool: readonly string[],
  bySection: Readonly<Record<string, string>> = {},
  fixed: ReadonlyMap<string, string> = new Map(),
): { assign: Map<string, string>; sectionFallbacks: number } {
  const assign = new Map<string, string>();
  let sectionFallbacks = 0;
  for (const it of items) {
    const f = fixed.get(it.legacyId);
    if (f !== undefined) {
      assign.set(it.legacyId, f);
      continue;
    }
    if (mode === "bySection") {
      const hit = bySection[(it.section ?? "").toLowerCase()];
      if (hit) {
        assign.set(it.legacyId, hit);
        continue;
      }
      sectionFallbacks++;
    }
    assign.set(it.legacyId, slugHashAuthor(it.slug, pool));
  }
  return { assign, sectionFallbacks };
}

/** Count `body_sections[].image` entries that carry a URL (the body converter never imports them). */
export function bodyImageUrls(raw: unknown): string[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    const img = (s as Record<string, unknown> | null)?.image;
    const url = typeof img === "string" ? img : img && typeof img === "object" ? (img as Record<string, unknown>).url ?? (img as Record<string, unknown>).src : undefined;
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) out.push(url.trim());
  }
  return out;
}
