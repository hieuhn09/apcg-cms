/**
 * Pure query-parameter parsing for the read-only `/api/hub/*` routes
 * (APCGHub P4 / CMS-2). No Payload import, no I/O — every function here maps a
 * raw query-string value to either a normalised value or a 400 reason.
 *
 * Empty/absent `pillar` / `kinds` means "no filter" (the widest scope), the same
 * rule `narrowHubTenants` applies to `tenants`. Callers (the hub) must never send
 * an empty scope by accident — Hub-1 lesson D0.
 */

/**
 * Public sort key → the order-by list actually sent to Postgres AND used by the
 * in-memory merge in `scopedFindMultiTenant`. Every list ends in `id` (the
 * primary key), so the order is total: two consecutive offset pages can neither
 * repeat nor skip a row. Payload silently appends `-createdAt` after these
 * (`@payloadcms/drizzle` buildOrderBy); harmless once `id` is present.
 */
export const HUB_SORTS = {
  "-publishedAt": ["-publishedAt", "-id"],
  publishedAt: ["publishedAt", "id"],
  "-views": ["-views", "-publishedAt", "-id"],
  views: ["views", "publishedAt", "id"],
} as const satisfies Record<string, readonly string[]>;

export type HubSortKey = keyof typeof HUB_SORTS;

export const HUB_DEFAULT_SORT: HubSortKey = "-publishedAt";

/** Unknown values fall back to the default SILENTLY — the CMS-1 contract that
 *  Hub-1 already depends on; only the two `views` keys are new. */
export function parseHubSort(raw: string | null): { public: HubSortKey; keys: string[] } {
  const key: HubSortKey = raw != null && Object.prototype.hasOwnProperty.call(HUB_SORTS, raw) ? (raw as HubSortKey) : HUB_DEFAULT_SORT;
  return { public: key, keys: [...HUB_SORTS[key]] };
}

/**
 * Escape a user string for a Postgres LIKE/ILIKE pattern.
 *
 * Payload's `contains` operator wraps the value as `%value%` WITHOUT escaping
 * (`@payloadcms/drizzle` sanitizeQueryValue), so a raw `%` or `_` from the user
 * would act as a wildcard (`q=%` would match everything). Postgres uses `\` as
 * the default LIKE escape character when no ESCAPE clause is given. The value
 * travels as a bound parameter, so this is about wildcards, not SQL injection.
 * Order matters: the backslash itself must be escaped first.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export const HUB_Q_MIN = 2;
export const HUB_Q_MAX = 200;

const CONTROL_CHARS = /[\u0000-\u001f]/;

export type HubQResult =
  | { ok: true; q: null; escaped: null }
  | { ok: true; q: string; escaped: string }
  | { ok: false; reason: string };

/** `q`: trimmed; absent/blank ⇒ no filter; 2..200 chars; no control characters. */
export function parseHubQ(raw: string | null): HubQResult {
  if (raw == null) return { ok: true, q: null, escaped: null };
  const q = raw.trim();
  if (q === "") return { ok: true, q: null, escaped: null };
  if (CONTROL_CHARS.test(q)) return { ok: false, reason: "q contains control characters" };
  if (q.length < HUB_Q_MIN || q.length > HUB_Q_MAX) {
    return { ok: false, reason: `q must be ${HUB_Q_MIN}-${HUB_Q_MAX} characters` };
  }
  return { ok: true, q, escaped: escapeLike(q) };
}

/** `Pillars.slug` has no format constraint in the schema, so this is a sanity
 *  bound (not a wildcard guard — the pillar lookup is an equality `in`). */
export const HUB_PILLAR_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
export const HUB_MAX_PILLAR_SLUGS = 20;

export type HubPillarResult = { ok: true; slugs: string[] } | { ok: false; reason: string; values?: string[] };

/** `pillar`: CSV, trimmed, blanks dropped, de-duplicated in order. `[]` = no filter. */
export function parsePillarSlugs(raw: string | null): HubPillarResult {
  if (raw == null) return { ok: true, slugs: [] };
  const slugs: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (s && !slugs.includes(s)) slugs.push(s);
  }
  const bad = slugs.filter((s) => !HUB_PILLAR_SLUG.test(s));
  if (bad.length) return { ok: false, reason: "invalid pillar slug", values: bad };
  if (slugs.length > HUB_MAX_PILLAR_SLUGS) {
    return { ok: false, reason: `too many pillar slugs (max ${HUB_MAX_PILLAR_SLUGS})` };
  }
  return { ok: true, slugs };
}

export const HUB_KINDS = ["pillars", "authors"] as const;
export type HubKind = (typeof HUB_KINDS)[number];

export type HubKindsResult = { ok: true; kinds: HubKind[] } | { ok: false; reason: string; values: string[] };

/** `kinds`: CSV ⊆ {pillars, authors}; absent/blank ⇒ both. */
export function parseKinds(raw: string | null): HubKindsResult {
  const wanted = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) return { ok: true, kinds: [...HUB_KINDS] };
  const bad = wanted.filter((k) => !(HUB_KINDS as readonly string[]).includes(k));
  if (bad.length) return { ok: false, reason: "unknown kind", values: bad };
  return { ok: true, kinds: HUB_KINDS.filter((k) => wanted.includes(k)) };
}
