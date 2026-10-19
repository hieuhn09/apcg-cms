/**
 * hub-media-validate — the PURE checks of `POST /api/hub/media` (APCGHub P5.3, T1 / T1b / T2).
 * No I/O, no decoder: every image decision is made from the file HEADER, before
 * `sharp` (in `media-create.ts`) ever sees the bytes.
 *
 * Check order inside the route (first failure wins), the part owned here:
 *   Content-Length (411 / 400 / 413) → multipart field set (400) → exactly one file →
 *   file.size > 4,000,000 (413) → declared mime ∈ allowlist (415) → magic bytes agree
 *   with the declared mime (415) → size from the header without decoding (415 when
 *   unreadable; JPEG: bounded segment walk + SOS counter ≤ 64) → edge ≤ 4096 AND
 *   pixels ≤ 16,800,000 (422 media_dimensions) → alt (422 alt_required / 400) → credit (400).
 *
 * Error bodies are FROZEN (T1b) — `HUB_MEDIA_ERROR_TABLE` lists the route's 12 rows,
 * counting the 401/403 bodies of `authenticateHubAuthorEngine` as one row. The
 * 404 / 403 / 422 not_editable bodies are the PATCH route's own (`hub-author-handlers.ts`).
 */

import { randomUUID } from "node:crypto";
import { json } from "@/lib/http";
import { ACTOR_ID_MAX, ACTOR_ROLES } from "@/lib/hub-author-limits";
import { checkStr } from "@/lib/hub-author-input";

export const HUB_MEDIA_LIMITS = {
  /** Largest accepted file (after the browser's compression). */
  fileBytes: 4_000_000,
  /** Largest accepted request: file + 64 KiB of multipart overhead. */
  requestBytes: 4_065_536,
  maxEdge: 4096,
  maxPixels: 16_800_000,
  /** Progressive libjpeg/mozjpeg files carry ~10 scans; thousands burn decoder CPU. */
  maxJpegScans: 64,
  /** Bound on segments walked before the first SOF (a header is a handful). */
  maxJpegSegments: 4096,
  altMax: 300,
  creditMax: 300,
} as const;

export const HUB_MEDIA_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type HubMediaMime = (typeof HUB_MEDIA_MIME)[number];

/** The closed multipart field set (T1). Every name at most once. */
export const HUB_MEDIA_FORM_FIELDS = ["file", "alt", "credit", "articleId", "actorRole", "actorId"] as const;
const REQUIRED_FIELDS = ["file", "alt", "articleId", "actorRole"] as const;

/** Route-owned error codes (T1b). */
export type HubMediaErrorCode =
  | "bad_request"
  | "length_required"
  | "too_large"
  | "media_type"
  | "alt_required"
  | "media_dimensions"
  | "internal_error";

const ROUTE_BODIES: Record<HubMediaErrorCode, { http: number; body: Record<string, unknown> }> = {
  bad_request: { http: 400, body: { ok: false, status: "bad_request", reason: "invalid media upload request" } },
  length_required: { http: 411, body: { ok: false, status: "length_required", reason: "Content-Length header is required" } },
  too_large: { http: 413, body: { ok: false, status: "too_large", reason: `request body exceeds ${HUB_MEDIA_LIMITS.requestBytes} bytes` } },
  media_type: { http: 415, body: { ok: false, status: "media_type", reason: "only JPEG, PNG or WebP images are accepted" } },
  alt_required: { http: 422, body: { ok: false, status: "alt_required", reason: "alt text is required" } },
  media_dimensions: {
    http: 422,
    body: {
      ok: false,
      status: "media_dimensions",
      reason: `image exceeds ${HUB_MEDIA_LIMITS.maxEdge} px per edge or ${HUB_MEDIA_LIMITS.maxPixels} pixels`,
    },
  },
  internal_error: { http: 500, body: { ok: false, status: "internal_error" } },
};

/** One frozen route error response. */
export function mediaError(code: HubMediaErrorCode): Response {
  const r = ROUTE_BODIES[code];
  return json(r.body, r.http);
}

/** The ONE 413 body of the media route (Content-Length, file.size, re-encoded result). */
export const mediaTooLarge = (): Response => mediaError("too_large");

/**
 * The frozen table, as documentation AND as the thing the unit test pins (T1b).
 * `body` is the exact JSON; shared bodies are written out so a drift in the PATCH
 * helpers is caught here too. `not_editable` carries its reason placeholder.
 */
export const HUB_MEDIA_ERROR_TABLE: readonly { http: string; status: string; body: string | null }[] = [
  { http: "400", status: "bad_request", body: JSON.stringify(ROUTE_BODIES.bad_request.body) },
  { http: "401/403", status: "authenticateHubAuthorEngine", body: null },
  { http: "403", status: "forbidden", body: JSON.stringify({ ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: "<slugs>" }) },
  { http: "403", status: "feature_disabled", body: JSON.stringify({ ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }) },
  { http: "404", status: "not_found", body: JSON.stringify({ ok: false, status: "not_found", reason: "article not found for tenant" }) },
  { http: "422", status: "not_editable", body: JSON.stringify({ ok: false, status: "not_editable", reason: "<origin|status|not_hub_authored>" }) },
  { http: "411", status: "length_required", body: JSON.stringify(ROUTE_BODIES.length_required.body) },
  { http: "413", status: "too_large", body: JSON.stringify(ROUTE_BODIES.too_large.body) },
  { http: "415", status: "media_type", body: JSON.stringify(ROUTE_BODIES.media_type.body) },
  { http: "422", status: "alt_required", body: JSON.stringify(ROUTE_BODIES.alt_required.body) },
  { http: "422", status: "media_dimensions", body: JSON.stringify(ROUTE_BODIES.media_dimensions.body) },
  { http: "500", status: "internal_error", body: JSON.stringify(ROUTE_BODIES.internal_error.body) },
];

// ── Content-Length ───────────────────────────────────────────────────────────

export function checkContentLength(
  header: string | null,
): { ok: true; length: number } | { ok: false; code: "length_required" | "bad_request" | "too_large" } {
  if (header == null || header === "") return { ok: false, code: "length_required" };
  if (!/^[0-9]{1,16}$/.test(header)) return { ok: false, code: "bad_request" };
  const n = Number(header);
  if (n > HUB_MEDIA_LIMITS.requestBytes) return { ok: false, code: "too_large" };
  return { ok: true, length: n };
}

// ── Multipart field set ──────────────────────────────────────────────────────

/** What `File` / `Blob` give us — enough for the checks, nothing more. */
export interface FileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HubMediaForm {
  file: FileLike;
  alt: string;
  credit?: string;
  /** Raw string; its SHAPE is checked later (`isHubArticleId` ⇒ 404, like PATCH). */
  articleId: string;
  actorRole: (typeof ACTOR_ROLES)[number];
  actorId?: string;
}

function isFileLike(v: unknown): v is FileLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FileLike).size === "number" &&
    typeof (v as FileLike).type === "string" &&
    typeof (v as FileLike).arrayBuffer === "function"
  );
}

/**
 * Closed field set: unknown name, any name twice, a missing required name, or a
 * value of the wrong kind (text where a file belongs, or the reverse) ⇒ 400.
 * `actorRole` ∈ admin/editor/marketer; `actorId` the same shape as `actor.id` (D1).
 */
export function parseMediaFormEntries(
  entries: Iterable<[string, unknown]>,
): { ok: true; value: HubMediaForm } | { ok: false; code: "bad_request" } {
  const bad = { ok: false as const, code: "bad_request" as const };
  const seen = new Map<string, unknown>();
  for (const [name, value] of entries) {
    if (!(HUB_MEDIA_FORM_FIELDS as readonly string[]).includes(name)) return bad;
    if (seen.has(name)) return bad;
    seen.set(name, value);
  }
  for (const k of REQUIRED_FIELDS) if (!seen.has(k)) return bad;
  const file = seen.get("file");
  if (!isFileLike(file)) return bad;
  const text = (k: string): string | undefined | null => {
    if (!seen.has(k)) return undefined;
    const v = seen.get(k);
    return typeof v === "string" ? v : null;
  };
  const alt = text("alt");
  const credit = text("credit");
  const articleId = text("articleId");
  const actorRole = text("actorRole");
  const actorId = text("actorId");
  if (alt == null || articleId == null || actorRole == null || credit === null || actorId === null) return bad;
  if (!(ACTOR_ROLES as readonly string[]).includes(actorRole)) return bad;
  if (actorId !== undefined) {
    const r = checkStr(actorId, { max: ACTOR_ID_MAX, nonEmpty: true });
    if (!r.ok) return bad;
  }
  const value: HubMediaForm = { file, alt, articleId, actorRole: actorRole as HubMediaForm["actorRole"] };
  if (credit !== undefined) value.credit = credit;
  if (actorId !== undefined) value.actorId = actorId;
  return { ok: true, value };
}

// ── alt / credit ─────────────────────────────────────────────────────────────

const hasLineBreak = (s: string) => s.includes("\n") || s.includes("\r");

/** alt: CR/LF, `]`, C0, lone surrogate, bidi, > 300 ⇒ bad_request; blank ⇒ alt_required. */
export function checkMediaAlt(raw: string): { ok: true; value: string } | { ok: false; code: "alt_required" | "bad_request" } {
  if (hasLineBreak(raw) || raw.includes("]")) return { ok: false, code: "bad_request" };
  const r = checkStr(raw, { bidi: true, trim: true, nonEmpty: true, max: HUB_MEDIA_LIMITS.altMax });
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, code: r.code === "required" ? "alt_required" : "bad_request" };
}

/** credit (optional): CR/LF, C0, lone surrogate, bidi, > 300 ⇒ bad_request; blank ⇒ absent. */
export function checkMediaCredit(raw: string | undefined): { ok: true; value: string | undefined } | { ok: false; code: "bad_request" } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (hasLineBreak(raw)) return { ok: false, code: "bad_request" };
  const r = checkStr(raw, { bidi: true, trim: true, max: HUB_MEDIA_LIMITS.creditMax });
  if (!r.ok) return { ok: false, code: "bad_request" };
  return { ok: true, value: r.value === "" ? undefined : r.value };
}

// ── Magic bytes ──────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (b: Uint8Array, at: number, s: string) => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** JPEG `FF D8 FF`; PNG signature; WebP `RIFF....WEBP`. Anything else ⇒ null. */
export function sniffImageMime(b: Uint8Array): HubMediaMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return "image/png";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  return null;
}

// ── Header size readers (never decode) ───────────────────────────────────────

type Size = { ok: true; width: number; height: number } | { ok: false };
const NO: Size = { ok: false };
const size = (width: number, height: number): Size => (width > 0 && height > 0 ? { ok: true, width, height } : NO);

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** PNG: the FIRST chunk must be IHDR (13 bytes). Apple's CgBI chunk comes first ⇒ unreadable. */
function pngSize(b: Uint8Array): Size {
  if (b.length < 33) return NO;
  if (be32(b, 8) !== 13 || !ascii(b, 12, "IHDR")) return NO;
  return size(be32(b, 16), be32(b, 20));
}

/** WebP: VP8 (lossy), VP8L (lossless), VP8X (extended) — the chunk right after `WEBP`. */
function webpSize(b: Uint8Array): Size {
  if (ascii(b, 12, "VP8X")) return b.length < 30 ? NO : size(le24(b, 24) + 1, le24(b, 27) + 1);
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return NO;
    const b1 = b[21]!, b2 = b[22]!, b3 = b[23]!, b4 = b[24]!;
    const w = 1 + (((b2 & 0x3f) << 8) | b1);
    const h = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return size(w, h);
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return NO;
    return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  return NO;
}

/** SOFn = C0–CF except C4 (DHT), C8 (JPG), CC (DAC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Markers with no length field: RSTn, SOI, EOI, TEM. */
const isStandalone = (m: number) => (m >= 0xd0 && m <= 0xd9) || m === 0x01;

/**
 * JPEG: bounded segment walk from SOI. Fill `FF` bytes skipped; standalone markers
 * skipped; APPn (incl. an EXIF thumbnail with its own SOF) jumped over by its
 * length; length < 2 ⇒ unreadable; the pointer always advances; stops at the first
 * real SOF (size) — SOS / EOI before it ⇒ unreadable.
 */
function jpegSize(b: Uint8Array): Size {
  let p = 2;
  for (let n = 0; n < HUB_MEDIA_LIMITS.maxJpegSegments; n++) {
    if (p >= b.length || b[p] !== 0xff) return NO;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) return NO;
    const m = b[p]!;
    p++;
    if (m === 0x00) return NO;
    if (isStandalone(m)) {
      if (m === 0xd9) return NO;
      continue;
    }
    if (m === 0xda) return NO;
    if (p + 2 > b.length) return NO;
    const len = be16(b, p);
    if (len < 2) return NO;
    if (isSof(m)) {
      if (len < 7 || p + 7 > b.length) return NO;
      return size(be16(b, p + 5), be16(b, p + 3));
    }
    p += len;
  }
  return NO;
}

/**
 * Linear count of SOS markers over the WHOLE file (E6): at each `FF`, skip any
 * further `FF` fill; a following `DA` counts. Stuffed `FF 00` and RSTn are not SOS.
 */
export function countJpegScans(b: Uint8Array): number {
  let count = 0;
  let i = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < b.length && b[j] === 0xff) j++;
    if (j < b.length && b[j] === 0xda) count++;
    i = j;
  }
  return count;
}

/** Width × height from the header of an image of the given (already sniffed) type. */
export function readImageSize(b: Uint8Array, mime: HubMediaMime): Size {
  try {
    if (mime === "image/png") return pngSize(b);
    if (mime === "image/webp") return webpSize(b);
    return jpegSize(b);
  } catch {
    return NO;
  }
}

export const withinPixelCap = (w: number, h: number) =>
  w <= HUB_MEDIA_LIMITS.maxEdge && h <= HUB_MEDIA_LIMITS.maxEdge && w * h <= HUB_MEDIA_LIMITS.maxPixels;

// ── The file + text checks, in contract order ────────────────────────────────

export type HubMediaFileResult =
  | { ok: true; mime: HubMediaMime; bytes: Buffer; width: number; height: number; alt: string; credit: string | undefined }
  | { ok: false; code: "too_large" | "media_type" | "media_dimensions" | "alt_required" | "bad_request" };

export async function validateMediaFile(file: FileLike, rawAlt: string, rawCredit: string | undefined): Promise<HubMediaFileResult> {
  if (file.size > HUB_MEDIA_LIMITS.fileBytes) return { ok: false, code: "too_large" };
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  if (!(HUB_MEDIA_MIME as readonly string[]).includes(declared)) return { ok: false, code: "media_type" };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > HUB_MEDIA_LIMITS.fileBytes) return { ok: false, code: "too_large" };
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== declared) return { ok: false, code: "media_type" };
  const s = readImageSize(bytes, sniffed);
  if (!s.ok) return { ok: false, code: "media_type" };
  if (sniffed === "image/jpeg" && countJpegScans(bytes) > HUB_MEDIA_LIMITS.maxJpegScans) return { ok: false, code: "media_type" };
  if (!withinPixelCap(s.width, s.height)) return { ok: false, code: "media_dimensions" };
  const alt = checkMediaAlt(rawAlt);
  if (!alt.ok) return alt;
  const credit = checkMediaCredit(rawCredit);
  if (!credit.ok) return credit;
  return { ok: true, mime: sniffed, bytes, width: s.width, height: s.height, alt: alt.value, credit: credit.value };
}

const EXT: Record<HubMediaMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** T4: `hub-<uuid v4>.<ext by mime>` — never the uploader's file name. */
export function hubMediaFileName(mime: HubMediaMime): string {
  return `hub-${randomUUID()}.${EXT[mime]}`;
}
