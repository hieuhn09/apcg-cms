/**
 * createTenantMedia — create ONE `media` document for a tenant from bytes the
 * server already validated (APCGHub P5.3, T3 / D5). Used by `POST /api/hub/media`.
 *
 * The original is ALWAYS re-encoded by `sharp` first (D5): `.rotate()` applies the
 * EXIF orientation, then the image is encoded again in the SAME format — this
 * drops EXIF / GPS / ICC-borne payloads and any polyglot tail. A file POSTed
 * straight at the hub route (skipping the browser's canvas) is therefore cleaned
 * here too. `limitInputPixels` = 16,800,000 matches the header cap (D2).
 *
 * Deliberately NOT shared with the intake's `uploadHero` (`/api/engine/**` is not
 * touched by P5.3 — gap `hub-p5-3-media-create-duplicates-intake`). Both seams are
 * injectable so `node:test` needs neither a DB nor ESM mocking.
 *
 * Direct-upload path (hub docx import phase A, `/api/hub/media/register`): the caller
 * passes `capBytes` (20 MiB), `maxPixels` and a `deadlineMs`; then a re-encoded result
 * over the cap walks the fixed ladder of `reencodeWithinCap` (PA-7) instead of failing,
 * and a GIF is decoded FIRST FRAME ONLY and stored as PNG (PA-8). Without `capBytes`
 * the behaviour is exactly the multipart route's (one re-encode, > 4,000,000 B ⇒ 413).
 */

import type { Payload } from "payload";
import sharp from "sharp";
import { scopedCreate } from "@/lib/scoped";
import { HUB_MEDIA_LIMITS, type DirectMediaMime, type HubMediaMime } from "@/lib/hub-media-validate";

/** PA-8: a GIF is decoded first frame only and stored as a still PNG (room for an `animated` mode later). */
export const HUB_MEDIA_GIF_MODE = "static-png" as const;

export type MediaCreateErrorCode = "media_type" | "media_dimensions" | "too_large";

/** A failure the route maps to its frozen body (415 / 422 / 413). */
export class MediaCreateError extends Error {
  readonly code: MediaCreateErrorCode;
  constructor(code: MediaCreateErrorCode) {
    super(code);
    this.name = "MediaCreateError";
    this.code = code;
  }
}

export interface ReencodedImage {
  data: Buffer;
  width: number;
  height: number;
  size: number;
  /** Mime of `data` (the input's, except GIF ⇒ PNG). Optional for injected fakes. */
  mime?: HubMediaMime;
}

/** One re-encode setting. Omitted keys ⇒ the multipart route's defaults (q 90, PNG default, no resize). */
export interface ReencodeOptions {
  /** `limitInputPixels` (default `HUB_MEDIA_LIMITS.maxPixels`). */
  maxPixels?: number;
  /** JPEG / WebP quality (default 90). */
  quality?: number;
  /** PNG `compressionLevel` (default: sharp's). */
  pngCompressionLevel?: number;
  /** Shrink so the LONGER edge is at most this many px (never enlarges). */
  maxEdge?: number;
}

/** The stored mime of an input mime (PA-8: GIF ⇒ PNG). */
export const storedMime = (mime: DirectMediaMime): HubMediaMime => (mime === "image/gif" ? "image/png" : mime);

/** sharp's message for the pixel guard (libvips 8.16 / sharp 0.34). */
const PIXEL_LIMIT_RE = /pixel limit/i;

export async function sharpReencode(data: Buffer, mime: DirectMediaMime, opts: ReencodeOptions = {}): Promise<ReencodedImage> {
  try {
    const gif = mime === "image/gif";
    // GIF: `animated: false` reads the first frame only (spike A4); the pixel cap then applies to that frame.
    let img = sharp(data, { limitInputPixels: opts.maxPixels ?? HUB_MEDIA_LIMITS.maxPixels, failOn: "error", ...(gif ? { animated: false } : {}) }).rotate();
    if (opts.maxEdge !== undefined) img = img.resize({ width: opts.maxEdge, height: opts.maxEdge, fit: "inside", withoutEnlargement: true });
    const out = storedMime(mime);
    const quality = opts.quality ?? 90;
    const encoded =
      out === "image/png"
        ? img.png(opts.pngCompressionLevel !== undefined ? { compressionLevel: opts.pngCompressionLevel } : {})
        : out === "image/webp"
          ? img.webp({ quality })
          : img.jpeg({ quality });
    const { data: buf, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data: buf, width: info.width, height: info.height, size: buf.length, mime: out };
  } catch (err) {
    if (err instanceof MediaCreateError) throw err;
    const message = (err as { message?: unknown } | null)?.message;
    throw new MediaCreateError(typeof message === "string" && PIXEL_LIMIT_RE.test(message) ? "media_dimensions" : "media_type");
  }
}

export type Reencoder = (data: Buffer, mime: DirectMediaMime, opts?: ReencodeOptions) => Promise<ReencodedImage>;

/**
 * The PA-7 ladder, run only AFTER the first (default) re-encode is over the cap, in
 * order, at most 3 steps. JPEG / WebP: the first re-encode already IS quality 90, so
 * the ladder continues with 80 then 70 (re-running 90 would give the same bytes).
 * PNG: `compressionLevel 9`, then long edge 4096, then 3072.
 */
export function reencodeLadder(mime: DirectMediaMime): ReencodeOptions[] {
  if (storedMime(mime) === "image/png") return [{ pngCompressionLevel: 9 }, { pngCompressionLevel: 9, maxEdge: 4096 }, { pngCompressionLevel: 9, maxEdge: 3072 }];
  return [{ quality: 80 }, { quality: 70 }];
}

export interface WithinCapOptions {
  capBytes: number;
  maxPixels: number;
  /** Epoch ms after which no further ladder step starts (PA-7: 45 s from the start of `register`). */
  deadlineMs?: number;
  now?: () => number;
}

/**
 * PA-7: re-encode once with the defaults; while the result is over `capBytes`, walk
 * `reencodeLadder` (JPEG/WebP quality 90 → 80 → 70; PNG level 9 → long edge 4096 →
 * 3072), always from the ORIGINAL bytes. Still over the cap, or past the deadline
 * before the next step ⇒ `MediaCreateError("too_large")`.
 */
export async function reencodeWithinCap(
  data: Buffer,
  mime: DirectMediaMime,
  o: WithinCapOptions,
  reencode: Reencoder = sharpReencode,
): Promise<ReencodedImage> {
  const now = o.now ?? Date.now;
  let out = await reencode(data, mime, { maxPixels: o.maxPixels });
  for (const step of reencodeLadder(mime)) {
    if (out.data.length <= o.capBytes) return out;
    if (o.deadlineMs !== undefined && now() > o.deadlineMs) throw new MediaCreateError("too_large");
    out = await reencode(data, mime, { ...step, maxPixels: o.maxPixels });
  }
  if (out.data.length > o.capBytes) throw new MediaCreateError("too_large");
  return out;
}

export interface CreateTenantMediaArgs {
  payload: Payload;
  tenantId: number | string;
  /** Storage prefix = the tenant slug, set by the server (never by the caller). */
  prefix: string;
  /**
   * `name` is server-generated: `hub-<uuid>.<ext>` (T4) on the multipart route, the
   * deterministic `hub-<sha256 32 hex>.<ext>` on the direct path (PA-9); `size` is
   * recomputed after re-encoding. `mimetype` is the INPUT mime (a GIF is stored as PNG).
   */
  file: { data: Buffer; mimetype: DirectMediaMime; name: string; size?: number };
  data: { alt: string; credit?: string; caption?: string };
  /** Direct path only: the byte cap after re-encoding, which turns on the PA-7 ladder. */
  capBytes?: number;
  /** Direct path only: `limitInputPixels` (default `HUB_MEDIA_LIMITS.maxPixels`). */
  maxPixels?: number;
  /** Direct path only: no ladder step starts after this epoch ms. */
  deadlineMs?: number;
}

export interface CreateTenantMediaDeps {
  create?: typeof scopedCreate;
  reencode?: Reencoder;
  now?: () => number;
}

export async function createTenantMedia(args: CreateTenantMediaArgs, deps: CreateTenantMediaDeps = {}): Promise<Record<string, unknown>> {
  const { payload, tenantId, prefix, file, data } = args;
  const reencode = deps.reencode ?? sharpReencode;
  let out: ReencodedImage;
  if (args.capBytes !== undefined) {
    out = await reencodeWithinCap(
      file.data,
      file.mimetype,
      { capBytes: args.capBytes, maxPixels: args.maxPixels ?? HUB_MEDIA_LIMITS.maxPixels, deadlineMs: args.deadlineMs, now: deps.now },
      reencode,
    );
  } else {
    out = await reencode(file.data, file.mimetype);
    if (out.data.length > HUB_MEDIA_LIMITS.fileBytes) throw new MediaCreateError("too_large");
  }
  const doc = await (deps.create ?? scopedCreate)({
    payload,
    collection: "media",
    tenantId,
    data: {
      alt: data.alt,
      ...(data.caption !== undefined ? { caption: data.caption } : {}),
      ...(data.credit !== undefined ? { credit: data.credit } : {}),
      prefix,
    },
    file: { data: out.data, mimetype: out.mime ?? storedMime(file.mimetype), name: file.name, size: out.data.length },
  });
  return doc as unknown as Record<string, unknown>;
}
