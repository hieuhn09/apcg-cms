/**
 * Hub AUTHOR limits (APCGHub P5.1 — draft authoring through `/api/hub/articles`).
 *
 * ONE source for every number the two write routes enforce (POST create draft,
 * PATCH update draft) and for the closed list of `fields.<name>` reason codes a
 * 422 may carry. The hub repo keeps a hand-checked copy (plan 4.1 / 6.5) — change
 * a value here only through a plan supplement + re-validation.
 *
 * Pure: no I/O, no Payload import. `currentConvertTimeoutMs()` is the only place
 * in this repo that reads `HUB_BODY_CONVERT_TIMEOUT_MS` (a smoke-test switch —
 * NEVER set it on Vercel: a tiny value makes every save answer `too_slow`).
 */

/** Request body cap (bytes, measured on the raw text before JSON.parse) ⇒ 413. */
export const MAX_REQUEST_BYTES = 1_000_000;

/** Field size limits (C2). String lengths are UTF-16 `.length` (an emoji = 2). */
export const HUB_AUTHOR_LIMITS = {
  title: 300,
  dek: 600,
  body: 200_000,
  takeawaysLines: 5,
  takeawayChars: 300,
  tags: 20,
  coAuthors: 10,
  secondary: 5,
  countries: 10,
  cities: 10,
  slug: 96,
  sponsor: 120,
} as const;

export const READ_MIN_MIN = 1;
export const READ_MIN_MAX = 120;
/** Words per minute for the server-computed `readMin` (same formula as the console). */
export const READ_WORDS_PER_MINUTE = 220;

export const ACTOR_EMAIL_MAX = 254;
export const ACTOR_ID_MAX = 64;
export const ACTOR_ROLES = ["admin", "editor", "marketer"] as const;

/** Slug shape (lowercase kebab, ASCII). Length checked separately (≤ `HUB_AUTHOR_LIMITS.slug`). */
export const HUB_SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A 400 `unknown field(s)` reason lists at most this many keys, each cut to this many chars. */
export const UNKNOWN_KEYS_MAX = 20;
export const UNKNOWN_KEY_CHARS = 64;

/** `requested` logged on `engine_tenant_denied` is cut to this many chars (E15). */
export const TENANT_LOG_CHARS = 64;

/** Longest allowed run of W characters (JS `\s` ∪ C0) inside a body ⇒ above: `ws_run`. */
export const WS_RUN_MAX = 256;

// ── 1b linear pre-check thresholds (D23; Public Contracts "Kiểm thân bài — PLAN-SUPPLEMENT 4") ──
export const BODY_MAX_LINES = 1000;
export const BODY_MAX_MARK_CHARS = 5000;
export const BODY_MAX_MARK_RUNS = 2500;
export const BODY_MAX_LINK_OPENERS = 500;
export const BODY_PARA_MAX_MARK_RUNS = 30;
export const BODY_PARA_MAX_LINK_OPENERS = 20;
export const BODY_MAX_INDENT = 16;

// ── Tree caps after conversion (D24) ──
export const BODY_MAX_NODES = 9000;
export const BODY_MAX_JSON_CHARS = 1_200_000;

/**
 * T — the hard time guard for the conversion (D24): default AND ceiling. It is used
 * ONLY inside `resolveConvertTimeoutMs` below (E29); every caller takes
 * `currentConvertTimeoutMs()` instead, so there is exactly one definition.
 */
export const HUB_BODY_CONVERT_TIMEOUT_MS = 1500;

/**
 * Resolve the conversion timeout from a raw env string (OQ45 / E29).
 * Only a 1–4 digit positive integer string is used; it is clamped to T. Anything
 * else (absent, empty, `1e3`, `0x10`, ` 5 `, `-1`, `NaN`, `Infinity`, `0`, `99999`)
 * falls back to T. Digits are accumulated by hand — never `parseInt` / raw
 * `Number` on an unchecked string (`parseInt("1e3")` is 1).
 */
export function resolveConvertTimeoutMs(raw: string | undefined): number {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,3}$/.test(raw)) return HUB_BODY_CONVERT_TIMEOUT_MS;
  let v = 0;
  for (let i = 0; i < raw.length; i++) v = v * 10 + (raw.charCodeAt(i) - 48);
  return Math.min(v, HUB_BODY_CONVERT_TIMEOUT_MS);
}

/** The timeout in force NOW (read at call time, not at module load). The only env read. */
export const currentConvertTimeoutMs = (): number =>
  resolveConvertTimeoutMs(process.env.HUB_BODY_CONVERT_TIMEOUT_MS);

/**
 * The CLOSED list of `fields.<name>` reason codes (23 = 15 common + 8 body-only).
 * A 422 `invalid` response carries exactly one of these per field; never free text.
 */
export const HUB_FIELD_CODES_COMMON = [
  "required",
  "type",
  "too_long",
  "too_many",
  "out_of_range",
  "format",
  "duplicate",
  "unknown_ref",
  "not_enabled",
  "blocked_pillar",
  "c0",
  "bidi",
  "surrogate",
  "newline",
  "invalid",
] as const;

export const HUB_FIELD_CODES_BODY = [
  "too_large",
  "ws_run",
  "image",
  "link",
  "url",
  "node",
  "unstable",
  "too_slow",
] as const;

export const HUB_FIELD_CODES = [...HUB_FIELD_CODES_COMMON, ...HUB_FIELD_CODES_BODY] as const;

export type HubFieldCode = (typeof HUB_FIELD_CODES)[number];
export type HubBodyCode = (typeof HUB_FIELD_CODES_BODY)[number];

/** `fields` map of a 422 `invalid` response: field path → one closed code. */
export type HubFieldErrors = Record<string, HubFieldCode>;
