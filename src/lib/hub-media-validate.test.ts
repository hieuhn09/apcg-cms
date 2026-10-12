/**
 * Unit tests for ./hub-media-validate (APCGHub P5.3 — hub image upload, CMS side).
 * Node's built-in runner; no test framework, no DB, no network.
 *
 *   npm run test:hub-media
 *
 * Every image here is a HAND-BUILT header (a few hundred bytes at most): the
 * validator must decide from the header alone, before any decoder runs.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  HUB_MEDIA_ERROR_TABLE,
  HUB_MEDIA_FORM_FIELDS,
  HUB_MEDIA_LIMITS,
  checkContentLength,
  checkMediaAlt,
  checkMediaCredit,
  countJpegScans,
  hubMediaFileName,
  mediaError,
  mediaTooLarge,
  parseMediaFormEntries,
  readImageSize,
  sniffImageMime,
  validateMediaFile,
  type FileLike,
} from "./hub-media-validate";

// ── Fixture builders ─────────────────────────────────────────────────────────

const u16be = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function pngChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32be(data.length), Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(w: number, h: number, opts: { cgbi?: boolean } = {}): Buffer {
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    PNG_SIG,
    ...(opts.cgbi ? [pngChunk("CgBI", Buffer.from([0x50, 0x00, 0x20, 0x06]))] : []),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function seg(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
}
function sof(w: number, h: number, marker = 0xc0): Buffer {
  return seg(marker, Buffer.concat([Buffer.from([8]), u16be(h), u16be(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]));
}
const SOS_PAYLOAD = Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
function jpeg(o: { w?: number; h?: number; scans?: number; fill?: boolean; fill1?: boolean; thumb?: boolean; pre?: Buffer[] } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")));
  if (o.thumb) {
    // APP1 EXIF with an embedded thumbnail whose own SOF says 160×120.
    const thumb = Buffer.concat([Buffer.from([0xff, 0xd8]), sof(160, 120), Buffer.from([0xff, 0xd9])]);
    parts.push(seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), thumb])));
  }
  for (const p of o.pre ?? []) parts.push(p);
  parts.push(seg(0xc4, Buffer.from([0x00, ...new Array(16).fill(0)])));
  parts.push(sof(o.w ?? 640, o.h ?? 480));
  const scans = o.scans ?? 1;
  for (let i = 0; i < scans; i++) {
    if (o.fill) parts.push(Buffer.from([0xff, 0xff]));
    if (o.fill1) parts.push(Buffer.from([0xff])); // one fill byte ⇒ FF FF DA (EVL N2)
    parts.push(seg(0xda, SOS_PAYLOAD));
    parts.push(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]));
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function riff(chunk: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), Buffer.from(chunk, "latin1"), Buffer.from([data.length & 0xff, (data.length >> 8) & 0xff, 0, 0]), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), len, body]);
}
function webpVp8x(w: number, h: number): Buffer {
  const d = Buffer.alloc(10);
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return riff("VP8X", d);
}
function webpVp8l(w: number, h: number): Buffer {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  d.writeUInt32LE(bits >>> 0, 1);
  return riff("VP8L", d);
}
function webpVp8(w: number, h: number): Buffer {
  const d = Buffer.alloc(10);
  d[3] = 0x9d;
  d[4] = 0x01;
  d[5] = 0x2a;
  d.writeUInt16LE(w & 0x3fff, 6);
  d.writeUInt16LE(h & 0x3fff, 8);
  return riff("VP8 ", d);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
const GIF = Buffer.from("GIF89a\x0a\x00\x0a\x00\x00\x00\x00;", "latin1");

function fileLike(buf: Buffer, type: string, size = buf.length): FileLike {
  return { size, type, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
}

const okForm = (extra: [string, unknown][] = []): [string, unknown][] => [
  ["file", fileLike(png(10, 10), "image/png")],
  ["alt", "An alt"],
  ["articleId", "12"],
  ["actorRole", "editor"],
  ...extra,
];

// ── Failing-stub names from the plan (now real tests) ────────────────────────

test("rejects SVG even when declared image/jpeg", async () => {
  const r = await validateMediaFile(fileLike(SVG, "image/jpeg"), "alt", undefined);
  assert.deepEqual(r, { ok: false, code: "media_type" });
});

test("rejects PNG header 4097x100 and 20000x20000 before decoding", async () => {
  // These buffers hold no pixel data at all: a decoder would fail, so a 422 proves the header decided.
  assert.deepEqual(await validateMediaFile(fileLike(png(4097, 100), "image/png"), "alt", undefined), { ok: false, code: "media_dimensions" });
  assert.deepEqual(await validateMediaFile(fileLike(png(20000, 20000), "image/png"), "alt", undefined), { ok: false, code: "media_dimensions" });
});

test("JPEG with 65 SOS markers each preceded by FF fill bytes is rejected 415; SOF with a zero edge is rejected at header", async () => {
  const many = jpeg({ scans: 65, fill: true });
  assert.equal(countJpegScans(many), 65);
  assert.deepEqual(await validateMediaFile(fileLike(many, "image/jpeg"), "alt", undefined), { ok: false, code: "media_type" });
  assert.deepEqual(readImageSize(jpeg({ w: 0, h: 480 }), "image/jpeg"), { ok: false });
  assert.deepEqual(await validateMediaFile(fileLike(jpeg({ w: 640, h: 0 }), "image/jpeg"), "alt", undefined), { ok: false, code: "media_type" });
});

test("(EVL N2) JPEG with 65 SOS markers each preceded by ONE FF fill byte (FF FF DA) is counted 65 and rejected 415", async () => {
  const many = jpeg({ scans: 65, fill1: true });
  assert.ok(many.includes(Buffer.from([0x56, 0xff, 0xff, 0xda])));
  assert.equal(countJpegScans(many), 65);
  assert.equal(countJpegScans(jpeg({ scans: 64, fill1: true })), 64);
  assert.deepEqual(await validateMediaFile(fileLike(many, "image/jpeg"), "alt", undefined), { ok: false, code: "media_type" });
});

// ── Magic bytes / mime ───────────────────────────────────────────────────────

describe("sniffImageMime + declared mime", () => {
  it("recognises the three allowed formats", () => {
    assert.equal(sniffImageMime(png(1, 1)), "image/png");
    assert.equal(sniffImageMime(jpeg()), "image/jpeg");
    assert.equal(sniffImageMime(webpVp8x(5, 5)), "image/webp");
    assert.equal(sniffImageMime(SVG), null);
    assert.equal(sniffImageMime(GIF), null);
    assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  });
  it("GIF ⇒ 415 whether declared image/gif or image/png", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(GIF, "image/gif"), "a", undefined), { ok: false, code: "media_type" });
    assert.deepEqual(await validateMediaFile(fileLike(GIF, "image/png"), "a", undefined), { ok: false, code: "media_type" });
  });
  it("PNG bytes declared image/jpeg ⇒ 415 (declared and sniffed must agree)", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(png(10, 10), "image/jpeg"), "a", undefined), { ok: false, code: "media_type" });
  });
  it("SVG declared image/svg+xml ⇒ 415", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(SVG, "image/svg+xml"), "a", undefined), { ok: false, code: "media_type" });
  });
  it("PNG CgBI (Apple) ⇒ 415", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(png(10, 10, { cgbi: true }), "image/png"), "a", undefined), { ok: false, code: "media_type" });
  });
  it("valid files pass with their header size", async () => {
    const r = await validateMediaFile(fileLike(jpeg({ w: 1600, h: 900 }), "image/jpeg"), " An alt ", " Credit ");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual([r.mime, r.width, r.height, r.alt, r.credit], ["image/jpeg", 1600, 900, "An alt", "Credit"]);
      assert.ok(Buffer.isBuffer(r.bytes));
    }
    const w = await validateMediaFile(fileLike(webpVp8l(300, 200), "image/webp"), "a", undefined);
    assert.deepEqual(w.ok && [w.width, w.height], [300, 200]);
  });
});

// ── Size / Content-Length ────────────────────────────────────────────────────

describe("byte limits", () => {
  it("constants are the plan's (T1/K-SIZE)", () => {
    assert.equal(HUB_MEDIA_LIMITS.fileBytes, 4_000_000);
    assert.equal(HUB_MEDIA_LIMITS.requestBytes, 4_065_536);
    assert.equal(HUB_MEDIA_LIMITS.maxEdge, 4096);
    assert.equal(HUB_MEDIA_LIMITS.maxPixels, 16_800_000);
    assert.equal(HUB_MEDIA_LIMITS.maxJpegScans, 64);
  });
  it("file of 4,000,001 B ⇒ too_large; exactly 4,000,000 passes the size step", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(png(10, 10), "image/png", 4_000_001), "a", undefined), { ok: false, code: "too_large" });
    const r = await validateMediaFile(fileLike(png(10, 10), "image/png", 4_000_000), "a", undefined);
    assert.equal(r.ok, true);
  });
  it("Content-Length: missing ⇒ length_required; non-digits ⇒ bad_request; > 4,065,536 ⇒ too_large", () => {
    assert.deepEqual(checkContentLength(null), { ok: false, code: "length_required" });
    assert.deepEqual(checkContentLength(""), { ok: false, code: "length_required" });
    assert.deepEqual(checkContentLength("12a"), { ok: false, code: "bad_request" });
    assert.deepEqual(checkContentLength("4065537"), { ok: false, code: "too_large" });
    assert.deepEqual(checkContentLength("4065536"), { ok: true, length: 4_065_536 });
  });
});

// ── Pixel caps (D2) ──────────────────────────────────────────────────────────

describe("pixel caps from the header", () => {
  const dims = async (b: Buffer, mime: string) => validateMediaFile(fileLike(b, mime), "a", undefined);
  it("4096×4100 (edge > 4096) ⇒ media_dimensions", async () => {
    assert.deepEqual(await dims(png(4096, 4100), "image/png"), { ok: false, code: "media_dimensions" });
  });
  it("4096×4096 (16.78 MP) passes", async () => {
    const r = await dims(png(4096, 4096), "image/png");
    assert.equal(r.ok, true);
  });
  it("4100×4100 ⇒ media_dimensions", async () => {
    assert.deepEqual(await dims(png(4100, 4100), "image/png"), { ok: false, code: "media_dimensions" });
  });
  it("4000×4300 (edge > 4096) and 4096×4102 ⇒ media_dimensions", async () => {
    assert.deepEqual(await dims(webpVp8x(4000, 4300), "image/webp"), { ok: false, code: "media_dimensions" });
    assert.deepEqual(await dims(jpeg({ w: 4096, h: 4102 }), "image/jpeg"), { ok: false, code: "media_dimensions" });
  });
  it("WebP VP8 / VP8L / VP8X headers are read", () => {
    assert.deepEqual(readImageSize(webpVp8(320, 240), "image/webp"), { ok: true, width: 320, height: 240 });
    assert.deepEqual(readImageSize(webpVp8l(16383, 2), "image/webp"), { ok: true, width: 16383, height: 2 });
    assert.deepEqual(readImageSize(webpVp8x(20000, 20000), "image/webp"), { ok: true, width: 20000, height: 20000 });
  });
  it("truncated headers are unreadable (⇒ media_type), never a throw", async () => {
    assert.deepEqual(readImageSize(png(10, 10).subarray(0, 20), "image/png"), { ok: false });
    assert.deepEqual(readImageSize(webpVp8x(10, 10).subarray(0, 25), "image/webp"), { ok: false });
    assert.deepEqual(readImageSize(jpeg().subarray(0, 30), "image/jpeg"), { ok: false });
    assert.deepEqual(await dims(png(10, 10).subarray(0, 20), "image/png"), { ok: false, code: "media_type" });
  });
});

// ── JPEG segment walker ──────────────────────────────────────────────────────

describe("JPEG header walker (T2 / E6)", () => {
  it("segment length 0 or 1 ends in finite time with media_type", async () => {
    for (const bad of [0, 1]) {
      const b = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16be(bad), Buffer.alloc(64)]);
      const t0 = Date.now();
      assert.deepEqual(readImageSize(b, "image/jpeg"), { ok: false });
      assert.deepEqual(await validateMediaFile(fileLike(b, "image/jpeg"), "a", undefined), { ok: false, code: "media_type" });
      assert.ok(Date.now() - t0 < 1000);
    }
  });
  it("an EXIF thumbnail's SOF does not replace the real SOF", () => {
    assert.deepEqual(readImageSize(jpeg({ w: 5000, h: 5000, thumb: true }), "image/jpeg"), { ok: true, width: 5000, height: 5000 });
  });
  it("EXIF thumbnail 160×120 + real 5000×5000 ⇒ media_dimensions", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(jpeg({ w: 5000, h: 5000, thumb: true }), "image/jpeg"), "a", undefined), { ok: false, code: "media_dimensions" });
  });
  it("DHT (C4), JPG (C8), DAC (CC) are not SOF; C2 progressive is", () => {
    const dac = seg(0xcc, Buffer.from([0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]));
    assert.deepEqual(readImageSize(jpeg({ w: 800, h: 600, pre: [dac] }), "image/jpeg"), { ok: true, width: 800, height: 600 });
    const prog = Buffer.concat([Buffer.from([0xff, 0xd8]), sof(1200, 700, 0xc2), seg(0xda, SOS_PAYLOAD), Buffer.from([0xff, 0xd9])]);
    assert.deepEqual(readImageSize(prog, "image/jpeg"), { ok: true, width: 1200, height: 700 });
  });
  it("standalone markers (RST, TEM) and FF fill between segments are skipped", () => {
    const pre = [Buffer.from([0xff, 0x01]), Buffer.from([0xff, 0xff, 0xff])];
    assert.deepEqual(readImageSize(jpeg({ w: 321, h: 123, pre }), "image/jpeg"), { ok: true, width: 321, height: 123 });
  });
  it("SOS before any SOF ⇒ unreadable", () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xda, SOS_PAYLOAD), Buffer.from([0xff, 0xd9])]);
    assert.deepEqual(readImageSize(b, "image/jpeg"), { ok: false });
  });
  it("SOS counter: 64 passes, 65 rejected; stuffed FF 00 and RST are not counted", async () => {
    const ok64 = jpeg({ scans: 64 });
    assert.equal(countJpegScans(ok64), 64);
    assert.equal((await validateMediaFile(fileLike(ok64, "image/jpeg"), "a", undefined)).ok, true);
    const bad = jpeg({ scans: 65 });
    assert.equal(countJpegScans(bad), 65);
    assert.deepEqual(await validateMediaFile(fileLike(bad, "image/jpeg"), "a", undefined), { ok: false, code: "media_type" });
    assert.equal(countJpegScans(jpeg({ scans: 10 })), 10);
  });
});

// ── alt / credit ─────────────────────────────────────────────────────────────

describe("alt and credit (T1)", () => {
  it("alt: trimmed; empty ⇒ alt_required; CR/LF/]/C0/bidi/lone surrogate/>300 ⇒ bad_request", () => {
    assert.deepEqual(checkMediaAlt("  Mô tả ảnh  "), { ok: true, value: "Mô tả ảnh" });
    assert.deepEqual(checkMediaAlt("   "), { ok: false, code: "alt_required" });
    assert.deepEqual(checkMediaAlt(""), { ok: false, code: "alt_required" });
    for (const bad of ["a\nb", "a\rb", "a](https://x.test/i.png)", "a\u0001b", "a‮b", "a\ud800b", "x".repeat(301)]) {
      assert.deepEqual(checkMediaAlt(bad), { ok: false, code: "bad_request" }, JSON.stringify(bad));
    }
    assert.deepEqual(checkMediaAlt("x".repeat(300)), { ok: true, value: "x".repeat(300) });
  });
  it("credit: optional; `]` allowed; CR/LF/C0/bidi/>300 ⇒ bad_request; blank ⇒ undefined", () => {
    assert.deepEqual(checkMediaCredit(undefined), { ok: true, value: undefined });
    assert.deepEqual(checkMediaCredit("  "), { ok: true, value: undefined });
    assert.deepEqual(checkMediaCredit(" [Reuters] "), { ok: true, value: "[Reuters]" });
    for (const bad of ["a\nb", "a\u0002", "a⁦b", "y".repeat(301)]) {
      assert.deepEqual(checkMediaCredit(bad), { ok: false, code: "bad_request" });
    }
  });
  it("alt failure is checked after the image (first failure wins: file before alt)", async () => {
    assert.deepEqual(await validateMediaFile(fileLike(SVG, "image/jpeg"), "", undefined), { ok: false, code: "media_type" });
    assert.deepEqual(await validateMediaFile(fileLike(png(10, 10), "image/png"), "", undefined), { ok: false, code: "alt_required" });
    assert.deepEqual(await validateMediaFile(fileLike(png(10, 10), "image/png"), "a\nb", undefined), { ok: false, code: "bad_request" });
  });
});

// ── multipart field set ──────────────────────────────────────────────────────

describe("parseMediaFormEntries (closed field set, each at most once)", () => {
  it("field list is closed", () => {
    assert.deepEqual([...HUB_MEDIA_FORM_FIELDS], ["file", "alt", "credit", "articleId", "actorRole", "actorId"]);
  });
  it("accepts the minimal form and the full form", () => {
    const r = parseMediaFormEntries(okForm());
    assert.equal(r.ok, true);
    const f = parseMediaFormEntries(okForm([["credit", "c"], ["actorId", "u-1"]]));
    assert.equal(f.ok, true);
    if (f.ok) assert.deepEqual([f.value.articleId, f.value.actorRole, f.value.actorId, f.value.credit], ["12", "editor", "u-1", "c"]);
  });
  const bad = (entries: [string, unknown][], why: string) =>
    assert.deepEqual(parseMediaFormEntries(entries), { ok: false, code: "bad_request" }, why);
  it("unknown field (incl. email, caption) ⇒ bad_request", () => {
    bad(okForm([["email", "a@b.c"]]), "email");
    bad(okForm([["caption", "x"]]), "caption");
    bad(okForm([["tenant", "dtw"]]), "tenant");
  });
  it("any field twice ⇒ bad_request (incl. alt twice, two files)", () => {
    bad(okForm([["alt", "again"]]), "alt twice");
    bad(okForm([["file", fileLike(png(1, 1), "image/png")]]), "two files");
    bad(okForm([["credit", "a"], ["credit", "b"]]), "credit twice");
  });
  it("missing file / alt / articleId / actorRole ⇒ bad_request", () => {
    for (const k of ["file", "alt", "articleId", "actorRole"]) bad(okForm().filter(([n]) => n !== k), `missing ${k}`);
  });
  it("wrong value kinds ⇒ bad_request", () => {
    bad(okForm().map(([n, v]) => (n === "file" ? [n, "not a file"] : [n, v])), "file as string");
    bad(okForm().map(([n, v]) => (n === "alt" ? [n, fileLike(png(1, 1), "image/png")] : [n, v])), "alt as file");
  });
  it("actorRole outside admin/editor/marketer ⇒ bad_request; actorId too long / C0 ⇒ bad_request", () => {
    bad(okForm().map(([n, v]) => (n === "actorRole" ? [n, "viewer"] : [n, v])), "viewer");
    bad(okForm([["actorId", "x".repeat(65)]]), "actorId 65");
    bad(okForm([["actorId", "a\u0001"]]), "actorId c0");
  });
  it("articleId of any shape is passed through (shape ⇒ 404 later, not 400)", () => {
    for (const id of ["abc", "0", "9".repeat(20), "9".repeat(400)]) {
      const r = parseMediaFormEntries(okForm().map(([n, v]) => (n === "articleId" ? [n, id] : [n, v])));
      assert.equal(r.ok, true, id.slice(0, 10));
    }
  });
});

// ── frozen error table (T1b) ─────────────────────────────────────────────────

describe("frozen route error table (T1b — 12 rows; the 401/403 auth bodies count as ONE row)", () => {
  it("has exactly 12 rows in this order", () => {
    assert.deepEqual(
      HUB_MEDIA_ERROR_TABLE.map((r) => `${r.http} ${r.status}`),
      [
        "400 bad_request",
        "401/403 authenticateHubAuthorEngine",
        "403 forbidden",
        "403 feature_disabled",
        "404 not_found",
        "422 not_editable",
        "411 length_required",
        "413 too_large",
        "415 media_type",
        "422 alt_required",
        "422 media_dimensions",
        "500 internal_error",
      ],
    );
  });
  it("route-owned bodies are byte-for-byte frozen", async () => {
    const body = async (r: Response) => [r.status, await r.text()];
    assert.deepEqual(await body(mediaError("bad_request")), [400, JSON.stringify({ ok: false, status: "bad_request", reason: "invalid media upload request" })]);
    assert.deepEqual(await body(mediaError("length_required")), [411, JSON.stringify({ ok: false, status: "length_required", reason: "Content-Length header is required" })]);
    assert.deepEqual(await body(mediaTooLarge()), [413, JSON.stringify({ ok: false, status: "too_large", reason: "request body exceeds 4065536 bytes" })]);
    assert.deepEqual(await body(mediaError("too_large")), [413, JSON.stringify({ ok: false, status: "too_large", reason: "request body exceeds 4065536 bytes" })]);
    assert.deepEqual(await body(mediaError("media_type")), [415, JSON.stringify({ ok: false, status: "media_type", reason: "only JPEG, PNG or WebP images are accepted" })]);
    assert.deepEqual(await body(mediaError("alt_required")), [422, JSON.stringify({ ok: false, status: "alt_required", reason: "alt text is required" })]);
    assert.deepEqual(await body(mediaError("media_dimensions")), [422, JSON.stringify({ ok: false, status: "media_dimensions", reason: "image exceeds 4096 px per edge or 16800000 pixels" })]);
    assert.deepEqual(await body(mediaError("internal_error")), [500, JSON.stringify({ ok: false, status: "internal_error" })]);
  });
  it("shared bodies (404 / 422 not_editable / 403) are the PATCH ones", async () => {
    const t = (s: string) => HUB_MEDIA_ERROR_TABLE.find((r) => r.status === s)?.body;
    assert.equal(t("not_found"), JSON.stringify({ ok: false, status: "not_found", reason: "article not found for tenant" }));
    assert.equal(t("feature_disabled"), JSON.stringify({ ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }));
    assert.equal(t("not_editable"), JSON.stringify({ ok: false, status: "not_editable", reason: "<origin|status|not_hub_authored>" }));
  });
});

describe("stored file name (T4)", () => {
  it("hub-<uuid v4>.<ext by mime>, never the user's name", () => {
    const re = /^hub-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;
    assert.match(hubMediaFileName("image/jpeg"), re);
    assert.ok(hubMediaFileName("image/jpeg").endsWith(".jpg"));
    assert.ok(hubMediaFileName("image/png").endsWith(".png"));
    assert.ok(hubMediaFileName("image/webp").endsWith(".webp"));
    assert.notEqual(hubMediaFileName("image/png"), hubMediaFileName("image/png"));
  });
});
