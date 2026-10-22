/**
 * Pure mirror of the Phase 3 `check:redirects` rules (gtp-launch P4,
 * A11-S14(g), Phase 3 A2.1/A2.2 and section 9). Run on the files emitted by
 * `build-gtp-redirects.ts --emit-gtp-web`.
 */
import { normaliseKey } from "./normalise-path";
import { profile } from "./network-profile";

export interface KnownRoutes {
  static: string[];
  sections: string[];
  subsections: Record<string, string[]>;
  articlePrefix: string;
}
export type MapValue = string | { status: 410 };
export interface PatternRule {
  source: string;
  destination: string;
  permanent: boolean;
}

export const MAX_FILE_BYTES = 600_000;
export const MAX_PATTERNS = 200;
const ARTICLE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function isKnownDestination(dest: string, kr: KnownRoutes): boolean {
  if (!dest.startsWith("/")) return false;
  if (dest.startsWith(kr.articlePrefix)) return ARTICLE_SLUG.test(dest.slice(kr.articlePrefix.length));
  if (kr.static.includes(dest)) return true;
  // Section pages live under the tenant profile's sectionPathPrefix (ABB: /section/<pillar>[/<sub>]); "" = /<pillar> (GTP/AER).
  const pre = profile().sectionPathPrefix ?? "";
  if (pre && !dest.startsWith(`${pre}/`)) return false;
  const parts = dest.slice(pre.length).split("/").filter(Boolean);
  if (parts.length === 1) return kr.sections.includes(parts[0] as string);
  if (parts.length === 2) return (kr.subsections[parts[0] as string] ?? []).includes(parts[1] as string);
  return false;
}

export function validateGtpWebRedirectFiles(map: unknown, rules: unknown, kr: KnownRoutes): string[] {
  const errors: string[] = [];
  if (!map || typeof map !== "object" || Array.isArray(map)) return ["redirect-map.json must be an object"];
  if (!Array.isArray(rules)) return ["redirect-rules.json must be an array"];
  const size = Buffer.byteLength(JSON.stringify(map)) + Buffer.byteLength(JSON.stringify(rules));
  if (size > MAX_FILE_BYTES) errors.push(`files exceed ${MAX_FILE_BYTES} bytes (${size})`);
  if (rules.length > MAX_PATTERNS) errors.push(`more than ${MAX_PATTERNS} pattern rules`);
  const m = map as Record<string, unknown>;
  for (const [key, val] of Object.entries(m)) {
    if (normaliseKey(key) !== key) errors.push(`key not in normalised form: ${key}`);
    if (/[?#]/.test(key)) errors.push(`key contains ? or #: ${key}`);
    if (typeof val === "string") {
      if (val === key) errors.push(`source equals destination: ${key}`);
      if (!isKnownDestination(val, kr)) errors.push(`unknown destination: ${key} -> ${val}`);
      if (Object.prototype.hasOwnProperty.call(m, normaliseKey(val) ?? val)) errors.push(`chain: ${key} -> ${val}`);
    } else if (!(val && typeof val === "object" && (val as { status?: unknown }).status === 410 && Object.keys(val).length === 1)) {
      errors.push(`bad value shape: ${key}`);
    }
  }
  for (const r of rules as unknown[]) {
    const rr = r as Partial<PatternRule>;
    if (typeof rr?.source !== "string" || typeof rr.destination !== "string" || rr.permanent !== true) errors.push("bad pattern rule shape");
    else if (rr.source === rr.destination) errors.push(`pattern source equals destination: ${rr.source}`);
  }
  return errors;
}
