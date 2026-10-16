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
 */

import type { Payload } from "payload";
import sharp from "sharp";
import { scopedCreate } from "@/lib/scoped";
import { HUB_MEDIA_LIMITS, type HubMediaMime } from "@/lib/hub-media-validate";

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
}

/** sharp's message for the pixel guard (libvips 8.16 / sharp 0.34). */
const PIXEL_LIMIT_RE = /pixel limit/i;

export async function sharpReencode(data: Buffer, mime: HubMediaMime): Promise<ReencodedImage> {
  try {
    const img = sharp(data, { limitInputPixels: HUB_MEDIA_LIMITS.maxPixels, failOn: "error" }).rotate();
    const encoded =
      mime === "image/png" ? img.png() : mime === "image/webp" ? img.webp({ quality: 90 }) : img.jpeg({ quality: 90 });
    const { data: out, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data: out, width: info.width, height: info.height, size: out.length };
  } catch (err) {
    if (err instanceof MediaCreateError) throw err;
    const message = (err as { message?: unknown } | null)?.message;
    throw new MediaCreateError(typeof message === "string" && PIXEL_LIMIT_RE.test(message) ? "media_dimensions" : "media_type");
  }
}

export interface CreateTenantMediaArgs {
  payload: Payload;
  tenantId: number | string;
  /** Storage prefix = the tenant slug, set by the server (never by the caller). */
  prefix: string;
  /** `name` is the server-generated `hub-<uuid>.<ext>` (T4); `size` is recomputed after re-encoding. */
  file: { data: Buffer; mimetype: HubMediaMime; name: string; size?: number };
  data: { alt: string; credit?: string };
}

export interface CreateTenantMediaDeps {
  create?: typeof scopedCreate;
  reencode?: (data: Buffer, mime: HubMediaMime) => Promise<ReencodedImage>;
}

export async function createTenantMedia(args: CreateTenantMediaArgs, deps: CreateTenantMediaDeps = {}): Promise<Record<string, unknown>> {
  const { payload, tenantId, prefix, file, data } = args;
  const out = await (deps.reencode ?? sharpReencode)(file.data, file.mimetype);
  if (out.data.length > HUB_MEDIA_LIMITS.fileBytes) throw new MediaCreateError("too_large");
  const doc = await (deps.create ?? scopedCreate)({
    payload,
    collection: "media",
    tenantId,
    data: { alt: data.alt, ...(data.credit !== undefined ? { credit: data.credit } : {}), prefix },
    file: { data: out.data, mimetype: file.mimetype, name: file.name, size: out.data.length },
  });
  return doc as unknown as Record<string, unknown>;
}
