/** Pure rollback discriminator (gtp-launch P4, A11-S04, A12-N09). */
import type { SlugMapEntry } from "./run-dir";

/** Untouched since import: version == baselineVersion AND updatedAt == baselineUpdatedAt or the timestamps-baseline value. */
export function untouched(doc: { version?: unknown; updatedAt?: unknown }, e: Pick<SlugMapEntry, "baselineVersion" | "baselineUpdatedAt" | "slug">, timestampsBaseline: Record<string, string>): boolean {
  if (Number(doc.version) !== Number(e.baselineVersion)) return false;
  const norm = (x: unknown) => {
    const d = new Date(String(x ?? ""));
    return Number.isFinite(d.getTime()) ? d.toISOString() : "";
  };
  const u = norm(doc.updatedAt);
  if (!u) return false;
  return u === norm(e.baselineUpdatedAt) || (timestampsBaseline[e.slug] !== undefined && u === norm(timestampsBaseline[e.slug]));
}
