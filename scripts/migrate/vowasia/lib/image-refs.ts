/**
 * Image / URL reference patterns shared by the VowAsia snapshot collector and
 * the offline measure (chặng B-α, G22 fix cycle 1, M6).
 *
 * - `URL_IN_TEXT`: absolute http(s) URLs; balanced parentheses are part of the
 *   URL (`photo(1).jpg`), an unbalanced `)` ends it.
 * - relative references (`/media/a.jpg` as an HTML attribute value or as a
 *   whole string value) and protocol-relative references (`//host/...`) are
 *   only COUNTED: the snapshot never fetches them (it downloads allow-listed
 *   absolute https URLs only), the measure reports how many there are.
 */

/** Absolute http(s) URL in free text; balanced `( )` allowed inside. Global regex: use with matchAll. */
export const URL_IN_TEXT = /https?:\/\/(?:[^\s"'<>()\\]|\([^\s"'<>()\\]*\))+/gi;

/** `//host.tld/...` not preceded by a scheme colon, a word character or another slash. */
const PROTOCOL_RELATIVE = /(?<![\w:/])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:\/[^\s"'<>\\]*)?/gi;

/** A root-relative path as the value of an HTML attribute that loads or links a resource. */
const RELATIVE_ATTR = /\b(?:src|srcset|href|data-src|poster)\s*=\s*["']?(\/(?!\/)[^"'\s>]*)/gi;

/** A whole string value that is a root-relative path (`/x`, `/uploads/a.jpg`). */
const RELATIVE_WHOLE = /^\/(?!\/)[^\s"'<>\\]*$/;

/** Every relative and protocol-relative reference in one string (values, for distinct counting). */
export function nonAbsoluteRefs(s: string): { relative: string[]; protocolRelative: string[] } {
  const relative: string[] = [];
  const t = s.trim();
  if (RELATIVE_WHOLE.test(t)) relative.push(t);
  else for (const m of s.matchAll(RELATIVE_ATTR)) relative.push(m[1] as string);
  const protocolRelative = [...s.matchAll(PROTOCOL_RELATIVE)].map((m) => m[0]);
  return { relative, protocolRelative };
}

/** Kind of a single image-field value: absolute URL, root-relative path, protocol-relative, or other text. */
export function refKind(v: string): "absolute" | "relative" | "protocolRelative" | "other" {
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return "absolute";
  if (t.startsWith("//")) return "protocolRelative";
  if (RELATIVE_WHOLE.test(t)) return "relative";
  return "other";
}
