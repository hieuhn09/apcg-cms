/**
 * Body-text parity helper (gtp-launch P4, parity check in verify-main.ts).
 * Pass 2 (rewrite-links) may have replaced old-site URLs with /article/<slug>;
 * apply the same mapping to the legacy source text before comparing, but only
 * for links Central actually rewrote. Pure: no I/O, so it is unit-testable.
 */
import { normaliseKey } from "./normalise-path";

export function applyRewrittenLinks(srcText: string, centralText: string, links: readonly string[], oldToNew: ReadonlyMap<string, string>): string {
  let out = srcText;
  for (const u of links) {
    try {
      const to = oldToNew.get(normaliseKey(new URL(u).pathname) ?? "");
      // When old and new paths coincide, `to` is a substring of the absolute `u`:
      // only treat the link as rewritten once Central no longer holds `u` itself.
      if (to && centralText.includes(to) && !centralText.includes(u)) out = out.split(u).join(to);
    } catch {
      /* keep */
    }
  }
  return out;
}
