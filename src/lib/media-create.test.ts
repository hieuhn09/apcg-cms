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

// ── Direct-upload path (hub docx import phase A — PA-7 / PA-8 / PA-10) ────────
// Appended only: every test above is unchanged and still pins the multipart route.

describe("createTenantMedia direct path: caption, ladder, GIF", () => {
  it("caption goes into the create data (multipart path unchanged when absent)", async () => {
    const r = recorder();
    await createTenantMedia(
      { payload, tenantId: 5, prefix: "gcv", file: { data: await webp(), mimetype: "image/webp", name: "hub-x.webp" }, data: { alt: "a", caption: "Cap", credit: "Cr" } },
      { create: r.create as never },
    );
    assert.deepEqual(r.calls[0]!.data, { alt: "a", caption: "Cap", credit: "Cr", prefix: "gcv" });
  });
  it("GIF (5 frames) ⇒ ONE-frame PNG, stored mime image/png, limitInputPixels on the first frame", async () => {
    const frames = await Promise.all([0, 1, 2, 3, 4].map((i) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: i * 50, g: 0, b: 0 } } }).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
    assert.equal((await sharp(gif).metadata()).pages, 5);
    const r = recorder();
    await createTenantMedia(
      { payload, tenantId: 5, prefix: "gcv", file: { data: gif, mimetype: "image/gif", name: "hub-y.png" }, data: { alt: "a" }, capBytes: 20 * 1024 * 1024, maxPixels: 12_000_000 },
      { create: r.create as never },
    );
    const c = r.calls[0]!;
    assert.equal(c.file?.mimetype, "image/png");
    const m = await sharp(c.file!.data).metadata();
    assert.deepEqual([m.format, m.pages ?? 1, m.width, m.height], ["png", 1, 40, 30]);
  });
  it("ladder: JPEG over the cap ⇒ quality 80 then 70; the first result under the cap wins", async () => {
    const seen: unknown[] = [];
    const reencode = async (_d: Buffer, _m: string, o?: { quality?: number }) => {
      seen.push(o?.quality ?? "default");
      const size = o?.quality === 70 ? 900 : 2000;
      return { data: Buffer.alloc(size), width: 1, height: 1, size, mime: "image/jpeg" as const };
    };
    const r = recorder();
    await createTenantMedia(
      { payload, tenantId: 5, prefix: "gcv", file: { data: Buffer.alloc(1), mimetype: "image/jpeg", name: "hub-z.jpg" }, data: { alt: "a" }, capBytes: 1000, maxPixels: 100 },
      { create: r.create as never, reencode: reencode as never },
    );
    assert.deepEqual(seen, ["default", 80, 70]);
    assert.equal(r.calls[0]!.file?.data.length, 900);
  });
  it("ladder: PNG ⇒ level 9, then long edge 4096, then 3072; still over ⇒ too_large, no create", async () => {
    const seen: unknown[] = [];
    const reencode = async (_d: Buffer, _m: string, o?: { pngCompressionLevel?: number; maxEdge?: number }) => {
      seen.push(o?.pngCompressionLevel === undefined ? "default" : `${o.pngCompressionLevel}/${o.maxEdge ?? "-"}`);
      return { data: Buffer.alloc(2000), width: 1, height: 1, size: 2000, mime: "image/png" as const };
    };
    const r = recorder();
    await assert.rejects(
      createTenantMedia(
        { payload, tenantId: 5, prefix: "gcv", file: { data: Buffer.alloc(1), mimetype: "image/png", name: "hub-z.png" }, data: { alt: "a" }, capBytes: 1000, maxPixels: 100 },
        { create: r.create as never, reencode: reencode as never },
      ),
      (e: unknown) => e instanceof MediaCreateError && e.code === "too_large",
    );
    assert.deepEqual(seen, ["default", "9/-", "9/4096", "9/3072"]);
    assert.equal(r.calls.length, 0);
  });
  it("ladder: past the deadline no further step starts ⇒ too_large", async () => {
    let calls = 0;
    const reencode = async () => {
      calls++;
      return { data: Buffer.alloc(2000), width: 1, height: 1, size: 2000 };
    };
    let t = 0;
    await assert.rejects(
      createTenantMedia(
        { payload, tenantId: 5, prefix: "gcv", file: { data: Buffer.alloc(1), mimetype: "image/jpeg", name: "x.jpg" }, data: { alt: "a" }, capBytes: 1000, maxPixels: 100, deadlineMs: 10 },
        { create: recorder().create as never, reencode: reencode as never, now: () => (t += 20) },
      ),
      (e: unknown) => e instanceof MediaCreateError && e.code === "too_large",
    );
    assert.equal(calls, 1);
  });
  it("real sharp: a resize step shrinks the long edge (PNG 5000x100 ⇒ 4096 wide)", async () => {
    const big = await sharp({ create: { width: 5000, height: 100, channels: 3, background: "#123" } }).png().toBuffer();
    const out = await sharpReencode(big, "image/png", { maxPixels: 12_000_000, pngCompressionLevel: 9, maxEdge: 4096 });
    assert.deepEqual([out.width, out.height, out.mime], [4096, 82, "image/png"]);
  });
});
