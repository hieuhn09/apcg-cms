/**
 * Unit tests for ./media-create (APCGHub P5.3 — T3 / D5). Node's built-in runner.
 * The Payload write is INJECTED (`deps.create`), so no DB is needed; the sharp
 * re-encode runs for real on images built here at run time (no fixture files).
 *
 *   npm run test:hub-media
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { MediaCreateError, createTenantMedia, sharpReencode } from "./media-create";

type CreateArgs = { collection: string; tenantId: number | string; data: Record<string, unknown>; file?: { data: Buffer; mimetype: string; name: string; size: number } };

function recorder() {
  const calls: CreateArgs[] = [];
  const create = async (a: CreateArgs) => {
    calls.push(a);
    return { id: 77, ...a.data };
  };
  return { calls, create };
}

const jpegWithExif = () =>
  sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Copyright: "secret owner", ImageDescription: "GPS 10.77,106.70" }, IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
const pngAlpha = () =>
  sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
const webp = () => sharp({ create: { width: 50, height: 40, channels: 3, background: "#00ff00" } }).webp().toBuffer();

const payload = {} as never;
const NAME = "hub-00000000-0000-4000-8000-000000000000.jpg";

describe("sharpReencode (D5)", () => {
  it("JPEG: EXIF/GPS removed, mime kept, orientation 6 applied (width/height swap)", async () => {
    const src = await jpegWithExif();
    const before = await sharp(src).metadata();
    assert.ok(before.exif, "fixture must carry EXIF");
    assert.equal(before.orientation, 6);
    const out = await sharpReencode(src, "image/jpeg");
    const m = await sharp(out.data).metadata();
    assert.equal(m.format, "jpeg");
    assert.equal(m.exif, undefined);
    assert.equal(m.orientation, undefined);
    assert.deepEqual([out.width, out.height], [100, 200]);
    assert.equal(out.size, out.data.length);
  });
  it("PNG with alpha keeps alpha and stays PNG", async () => {
    const out = await sharpReencode(await pngAlpha(), "image/png");
    const m = await sharp(out.data).metadata();
    assert.equal(m.format, "png");
    assert.equal(m.hasAlpha, true);
    assert.deepEqual([out.width, out.height], [64, 32]);
  });
  it("WebP stays WebP", async () => {
    const out = await sharpReencode(await webp(), "image/webp");
    assert.equal((await sharp(out.data).metadata()).format, "webp");
  });
  it("undecodable bytes ⇒ MediaCreateError media_type (never a raw sharp error)", async () => {
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    await assert.rejects(sharpReencode(junk, "image/jpeg"), (e: unknown) => e instanceof MediaCreateError && e.code === "media_type");
  });
  it("more pixels than limitInputPixels ⇒ MediaCreateError media_dimensions", async () => {
    const big = await sharp({ create: { width: 4200, height: 4100, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    await assert.rejects(sharpReencode(big, "image/png"), (e: unknown) => e instanceof MediaCreateError && e.code === "media_dimensions");
  });
});

describe("createTenantMedia (T3)", () => {
  it("re-encodes, then calls scopedCreate with collection media, tenantId, server prefix and the generated name", async () => {
    const r = recorder();
    const src = await jpegWithExif();
    const doc = await createTenantMedia(
      { payload, tenantId: 5, prefix: "dtw", file: { data: src, mimetype: "image/jpeg", name: NAME }, data: { alt: "An alt", credit: "Cr" } },
      { create: r.create as never },
    );
    assert.equal((doc as { id: number }).id, 77);
    assert.equal(r.calls.length, 1);
    const c = r.calls[0]!;
    assert.equal(c.collection, "media");
    assert.equal(c.tenantId, 5);
    assert.deepEqual(c.data, { alt: "An alt", credit: "Cr", prefix: "dtw" });
    assert.equal(c.file?.name, NAME);
    assert.equal(c.file?.mimetype, "image/jpeg");
    assert.equal(c.file?.size, c.file?.data.length);
    assert.notDeepEqual(c.file?.data, src);
    assert.equal((await sharp(c.file!.data).metadata()).exif, undefined);
  });
  it("credit absent ⇒ no credit key", async () => {
    const r = recorder();
    await createTenantMedia(
      { payload, tenantId: 5, prefix: "dtw", file: { data: await webp(), mimetype: "image/webp", name: "hub-x.webp" }, data: { alt: "a" } },
      { create: r.create as never },
    );
    assert.deepEqual(r.calls[0]!.data, { alt: "a", prefix: "dtw" });
  });
  it("a re-encoded result over 4,000,000 B ⇒ MediaCreateError too_large, no create call", async () => {
    const r = recorder();
    const reencode = async () => ({ data: Buffer.alloc(4_000_001), width: 10, height: 10, size: 4_000_001 });
    await assert.rejects(
      createTenantMedia({ payload, tenantId: 5, prefix: "dtw", file: { data: Buffer.alloc(10), mimetype: "image/png", name: "hub-x.png" }, data: { alt: "a" } }, { create: r.create as never, reencode }),
      (e: unknown) => e instanceof MediaCreateError && e.code === "too_large",
    );
    assert.equal(r.calls.length, 0);
  });
  it("a decode failure propagates as MediaCreateError, no create call", async () => {
    const r = recorder();
    await assert.rejects(
      createTenantMedia({ payload, tenantId: 5, prefix: "dtw", file: { data: Buffer.from("not an image"), mimetype: "image/png", name: "hub-x.png" }, data: { alt: "a" } }, { create: r.create as never }),
      (e: unknown) => e instanceof MediaCreateError && e.code === "media_type",
    );
    assert.equal(r.calls.length, 0);
  });
});
