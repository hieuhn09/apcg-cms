/**
 * Media of the VowAsia legacy import (Amendment 4, B-6). NO network code path:
 * every image comes from the local snapshot store (`<snapshot>/images/<sha256>`)
 * through the manifest (`url -> sha256, bytes, mime`) written by the snapshot
 * step, which already did the hardened download.
 *
 * Two kinds of failure, kept apart on purpose (Q12):
 *  - `MediaStore.check()` -> `{ ok: false }` = STORE-level failure (manifest
 *    failure entry, URL not in the manifest, file missing, size / sha256 /
 *    magic-bytes mismatch). C6: the article becomes draft and the body section
 *    with that image is dropped; the run continues (stops above 2%).
 *  - `ensureMedia()` throws `UploadError` = the Media create/upload failed (R2
 *    credentials, R2 outage, network). Q12 "Dừng ngay": the importer stops before
 *    creating that article.
 *
 * Media rows are created with `tenant` set; Central's upload hook sets
 * `prefix = vowasia` (the R2 key prefix). The created row's prefix is asserted,
 * the key is never built by hand. An existing tenant-vowasia Media with the same
 * stable filename (`vowasia-` prefix, Payload `-<n>` rename allowed) is REUSED.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TENANT_SLUG } from "./vowasia-constants";
import { WRITE_CTX, type CentralPort, type Doc, type Id } from "./vowasia-port";
import { vowasiaStableFilename, vowasiaStoredFilenameMatches } from "./vowasia-stable-filename";
import type { ImageManifest } from "./snapshot-vowasia-main";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class UploadError extends Error {
  override name = "UploadError";
}

export type StoreFailureReason = "manifestFailure" | "notInManifest" | "fileMissing" | "size" | "sha256" | "magic";
export type StoreCheck =
  | { ok: true; url: string; sha256: string; bytes: Buffer; mime: string; filename: string }
  | { ok: false; url: string; reason: StoreFailureReason };

/** Magic-byte sniff (a local copy of the snapshot step's check, so this module imports nothing network-related). */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp" && /^avi[fs]/.test(String.fromCharCode(...b.slice(8, 12)))) return "image/avif";
  return null;
}

export class MediaStore {
  private readonly byUrl = new Map<string, ImageManifest["entries"][number]>();
  private readonly failed = new Set<string>();
  private readonly cache = new Map<string, StoreCheck>();
  constructor(readonly snapshotDir: string, manifest: ImageManifest) {
    for (const e of manifest.entries) this.byUrl.set(e.url, e);
    for (const f of manifest.failures) this.failed.add(f.url);
  }

  check(url: string): StoreCheck {
    const hit = this.cache.get(url);
    if (hit) return hit;
    const r = this.checkUncached(url);
    this.cache.set(url, r);
    return r;
  }

  private checkUncached(url: string): StoreCheck {
    const fail = (reason: StoreFailureReason): StoreCheck => ({ ok: false, url, reason });
    if (this.failed.has(url)) return fail("manifestFailure");
    const e = this.byUrl.get(url);
    if (!e) return fail("notInManifest");
    const file = path.join(this.snapshotDir, "images", e.sha256);
    if (!existsSync(file)) return fail("fileMissing");
    const size = statSync(file).size;
    if (size > MAX_IMAGE_BYTES || size !== e.bytes) return fail("size");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== e.sha256) return fail("sha256");
    const mime = sniffImageMime(bytes);
    if (!mime || mime !== e.mime) return fail("magic");
    return { ok: true, url, sha256: e.sha256, bytes, mime, filename: vowasiaStableFilename(url) };
  }

  /** Every distinct host of the manifest URLs (the old image hosts; none may remain in a body). */
  hosts(): string[] {
    const out = new Set<string>();
    for (const u of [...this.byUrl.keys(), ...this.failed]) {
      try {
        out.add(new URL(u).host.toLowerCase());
      } catch {
        /* skip */
      }
    }
    return [...out];
  }
}

/** Tenant Media with this stable filename (Payload's `-<n>` rename allowed), lowest id first. */
export async function findMediaByStable(port: CentralPort, tenantId: Id, stable: string): Promise<Doc | undefined> {
  const stem = stable.slice(0, stable.lastIndexOf("."));
  const r = await port.find("media", { and: [{ tenant: { equals: tenantId } }, { filename: { like: stem } }] }, { limit: 50, sort: "id" });
  return r.docs.find((d) => vowasiaStoredFilenameMatches(String(d.filename), stable));
}

export interface MediaResult {
  id: Id;
  origin: "created" | "reused";
  filename: string;
}

/** Reuse or create the Media for one stored image. Throws UploadError when the create/upload fails. */
export async function ensureMedia(port: CentralPort, tenantId: Id, img: Extract<StoreCheck, { ok: true }>, meta: { alt: string; credit: string }, onBeforeCreate?: () => void): Promise<MediaResult> {
  const existing = await findMediaByStable(port, tenantId, img.filename);
  if (existing) return { id: existing.id as Id, origin: "reused", filename: String(existing.filename) };
  onBeforeCreate?.();
  let created: Doc;
  try {
    created = await port.create(
      "media",
      { tenant: tenantId, alt: meta.alt || img.filename, ...(meta.credit ? { credit: meta.credit } : {}) },
      { file: { data: img.bytes, mimetype: img.mime, name: img.filename, size: img.bytes.length }, context: { ...WRITE_CTX } },
    );
  } catch (err) {
    throw new UploadError(`media: upload failed for ${img.filename}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  if (created.prefix !== TENANT_SLUG) throw new UploadError(`media: created Media ${String(created.id)} has prefix ${JSON.stringify(created.prefix ?? null)}, expected "${TENANT_SLUG}"; stopping.`);
  return { id: created.id as Id, origin: "created", filename: String(created.filename) };
}
