/**
 * Stable media filename for the VowAsia import (Amendment 3, U4): a COPY of
 * the GTP `stableFilename` / `storedFilenameMatches` (gtp-transform.ts) with
 * the `vowasia-` prefix. The GTP helpers are NOT imported because they bake in
 * the `gtp-` prefix; a VowAsia Media row must never look like a GTP one.
 */
import { createHash } from "node:crypto";

export const VOWASIA_MEDIA_PREFIX = "vowasia-";

export function vowasiaStableFilename(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  let base = "image";
  try {
    base = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean).pop() || "image";
  } catch {
    /* keep default */
  }
  base = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  let ext = "jpg";
  const m = /\.(jpe?g|png|webp|gif|avif)$/.exec(base);
  if (m) {
    ext = m[1] as string;
    base = base.slice(0, -m[0].length);
  }
  base = base.replace(/\./g, "-").slice(-60).replace(/^-+|-+$/g, "") || "image";
  if (/[0-9]$/.test(base)) base += "-img";
  return `${VOWASIA_MEDIA_PREFIX}${hash}-${base}.${ext}`;
}

/** Does a stored media filename match the stable one, allowing Payload's `-<n>` rename? */
export function vowasiaStoredFilenameMatches(stored: string, stable: string): boolean {
  const dot = stable.lastIndexOf(".");
  const stem = stable.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ext = stable.slice(dot + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${stem}(-\\d+)?\\.${ext}$`).test(stored);
}
