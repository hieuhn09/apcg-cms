/**
 * Unit tests for ./hub-direct-upload-pure (hub docx import phase A — PA-2/3/4/9/10,
 * frozen error table). Node's built-in runner; no DB, no network, no R2.
 *
 *   npm run test:hub-direct-upload
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  DEFAULT_STAGING_PREFIX,
  DIRECT_MIME,
  HUB_DIRECT_ERROR_TABLE,
  HUB_DIRECT_UPLOAD_LIMITS,
  HUB_REGISTER_KEYS,
  HUB_SIGN_KEYS,
  deterministicMediaName,
  directError,
  directUploadTenants,
  isDirectUploadTenant,
  newNonce,
  parseRegisterBody,
  parseSignBody,
  registerResponse,
  signResponse,
  signUploadId,
  stagingConfig,
  stagingKey,
  stagingKeyStem,
  uploadIdKey,
  verifyUploadId,
  type UploadClaims,
} from "./hub-direct-upload-pure";
import { HUB_MEDIA_CAPTION_MAX, checkMediaCaption } from "./hub-media-validate";

const SECRET = "unit-payload-secret-0123456789";
const NOW = 1_800_000_000;
const CLAIMS: UploadClaims = { t: 3, a: 42, k: "gcv/42/0b8f6a1e-1111-4222-8333-444455556666", m: "image/jpeg", s: 123_456, e: NOW + 900, n: "AAAAAAAAAAAAAAAAAAAAAA" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
/** Re-sign arbitrary JSON with the REAL derived key (so only the shape check can refuse it). */
function forge(obj: unknown, secret = SECRET, version = "v1"): string {
  const body = b64(obj);
  const mac = createHmac("sha256", uploadIdKey(secret)).update(`${version}.${body}`, "utf8").digest("base64url");
  return `${version}.${body}.${mac}`;
}

describe("uploadId (PA-4)", () => {
  it("round-trips; format v1.<b64url>.<b64url>", () => {
    const id = signUploadId(CLAIMS, SECRET);
    assert.match(id, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(verifyUploadId(id, SECRET, NOW), { ok: true, claims: CLAIMS });
  });
  it("the HMAC key is HMAC(PAYLOAD_SECRET, 'hub-direct-upload-v1'), not the secret itself", () => {
    assert.deepEqual(uploadIdKey(SECRET), createHmac("sha256", SECRET).update("hub-direct-upload-v1").digest());
    const body = b64(CLAIMS);
    const rawKeyMac = createHmac("sha256", SECRET).update(`v1.${body}`).digest("base64url");
    assert.deepEqual(verifyUploadId(`v1.${body}.${rawKeyMac}`, SECRET, NOW), { ok: false, code: "upload_invalid" });
  });
  it("changing ANY claim (t, a, k, m, s, e, n) without the key ⇒ upload_invalid", () => {
    const id = signUploadId(CLAIMS, SECRET);
    const [v, , mac] = id.split(".");
    const changes: Partial<Record<keyof UploadClaims, unknown>> = {
      t: 4, a: 43, k: "gcv/42/other", m: "image/png", s: 123_457, e: NOW + 9_999, n: "BBBBBBBBBBBBBBBBBBBBBB",
    };
    for (const [k, val] of Object.entries(changes)) {
      const tampered = `${v}.${b64({ ...CLAIMS, [k]: val })}.${mac}`;
      assert.deepEqual(verifyUploadId(tampered, SECRET, NOW), { ok: false, code: "upload_invalid" }, `claim ${k}`);
    }
  });
  it("one flipped MAC byte, a truncated MAC, an empty MAC ⇒ upload_invalid", () => {
    const id = signUploadId(CLAIMS, SECRET);
    const [v, body, mac] = id.split(".") as [string, string, string];
    const macBytes = Buffer.from(mac, "base64url");
    macBytes[0] = macBytes[0]! ^ 1;
    for (const m of [macBytes.toString("base64url"), mac.slice(0, -4), ""]) {
      assert.deepEqual(verifyUploadId(`${v}.${body}.${m}`, SECRET, NOW), { ok: false, code: "upload_invalid" });
    }
  });
  it("another PAYLOAD_SECRET ⇒ upload_invalid", () => {
    assert.deepEqual(verifyUploadId(signUploadId(CLAIMS, SECRET), "other-secret", NOW), { ok: false, code: "upload_invalid" });
  });
  it("expired ⇒ upload_expired (after the MAC passed); exactly at e still valid", () => {
    const id = signUploadId(CLAIMS, SECRET);
    assert.equal(verifyUploadId(id, SECRET, NOW + 900).ok, true);
    assert.deepEqual(verifyUploadId(id, SECRET, NOW + 901), { ok: false, code: "upload_expired" });
    // a forged expiry never reaches the expiry check
    const [v, , mac] = id.split(".");
    assert.deepEqual(verifyUploadId(`${v}.${b64({ ...CLAIMS, e: NOW - 1 })}.${mac}`, SECRET, NOW), { ok: false, code: "upload_invalid" });
  });
  it("unknown version, wrong part count, non-string, oversize string ⇒ upload_invalid", () => {
    const id = signUploadId(CLAIMS, SECRET);
    for (const bad of [id.replace(/^v1/, "v2"), forge(CLAIMS, SECRET, "v2"), `${id}.x`, id.split(".").slice(0, 2).join("."), "", 42, null, "v1." + "A".repeat(3000) + ".x"]) {
      assert.deepEqual(verifyUploadId(bad, SECRET, NOW), { ok: false, code: "upload_invalid" });
    }
  });
  it("decoded JSON > 1 KiB ⇒ upload_invalid even with a valid MAC", () => {
    const big = forge({ ...CLAIMS, k: "x".repeat(1100) });
    assert.ok(big.length < HUB_DIRECT_UPLOAD_LIMITS.uploadIdMaxChars);
    assert.deepEqual(verifyUploadId(big, SECRET, NOW), { ok: false, code: "upload_invalid" });
  });
  it("validly signed but wrong shape (extra key, missing key, bad types) ⇒ upload_invalid", () => {
    const missing: Partial<UploadClaims> = { ...CLAIMS };
    delete missing.n;
    for (const bad of [
      { ...CLAIMS, x: 1 },
      missing,
      { ...CLAIMS, a: "42" },
      { ...CLAIMS, a: 0 },
      { ...CLAIMS, m: "image/svg+xml" },
      { ...CLAIMS, s: HUB_DIRECT_UPLOAD_LIMITS.fileBytes + 1 },
      { ...CLAIMS, s: 1.5 },
      { ...CLAIMS, t: null },
      [CLAIMS],
      "string",
    ]) {
      assert.deepEqual(verifyUploadId(forge(bad), SECRET, NOW), { ok: false, code: "upload_invalid" }, JSON.stringify(bad).slice(0, 60));
    }
  });
  it("nonce: 16 random bytes, base64url, different each call", () => {
    const a = newNonce();
    assert.equal(Buffer.from(a, "base64url").length, 16);
    assert.notEqual(a, newNonce());
  });
});

describe("switch HUB_DIRECT_UPLOAD_TENANTS (PA-2)", () => {
  it("absent / empty / whitespace ⇒ OFF", () => {
    for (const env of [{}, { HUB_DIRECT_UPLOAD_TENANTS: "" }, { HUB_DIRECT_UPLOAD_TENANTS: "  , ," }]) {
      assert.deepEqual(directUploadTenants(env), []);
      assert.equal(isDirectUploadTenant("gcv", directUploadTenants(env)), false);
    }
  });
  it("CSV trimmed, exact case-sensitive match; `*`, other case, inner spaces never match", () => {
    const list = directUploadTenants({ HUB_DIRECT_UPLOAD_TENANTS: " gcv , world-travel-brief ,*,DTW, b a" });
    assert.deepEqual(list, ["gcv", "world-travel-brief", "*", "DTW", "b a"]);
    assert.equal(isDirectUploadTenant("gcv", list), true);
    assert.equal(isDirectUploadTenant("world-travel-brief", list), true);
    assert.equal(isDirectUploadTenant("dtw", list), false);
    assert.equal(isDirectUploadTenant("wad", list), false);
    assert.equal(isDirectUploadTenant("ba", list), false);
  });
  it("read from the env it is given (default process.env), never cached", () => {
    const prev = process.env.HUB_DIRECT_UPLOAD_TENANTS;
    try {
      process.env.HUB_DIRECT_UPLOAD_TENANTS = "gcv";
      assert.deepEqual(directUploadTenants(), ["gcv"]);
      delete process.env.HUB_DIRECT_UPLOAD_TENANTS;
      assert.deepEqual(directUploadTenants(), []);
    } finally {
      if (prev === undefined) delete process.env.HUB_DIRECT_UPLOAD_TENANTS;
      else process.env.HUB_DIRECT_UPLOAD_TENANTS = prev;
    }
  });
});

describe("staging (PA-3)", () => {
  const base = { R2_ENDPOINT: "https://acc.r2.example", R2_ACCESS_KEY_ID: "main-id", R2_SECRET_ACCESS_KEY: "main-secret", R2_BUCKET: "main" };
  it("dedicated bucket: no prefix; own key pair used only when BOTH are set", () => {
    const c = stagingConfig({ ...base, R2_STAGING_BUCKET: "stage" });
    assert.deepEqual([c?.bucket, c?.prefix, c?.dedicated, c?.accessKeyId], ["stage", "", true, "main-id"]);
    const own = stagingConfig({ ...base, R2_STAGING_BUCKET: "stage", R2_STAGING_ACCESS_KEY_ID: "s-id", R2_STAGING_SECRET_ACCESS_KEY: "s-secret" });
    assert.deepEqual([own?.accessKeyId, own?.secretAccessKey], ["s-id", "s-secret"]);
    const half = stagingConfig({ ...base, R2_STAGING_BUCKET: "stage", R2_STAGING_ACCESS_KEY_ID: "s-id" });
    assert.equal(half?.accessKeyId, "main-id");
  });
  it("fallback: prefix in the main bucket, default `_hub-staging/`; R2_STAGING_BUCKET = R2_BUCKET counts as fallback", () => {
    assert.deepEqual([stagingConfig(base)?.bucket, stagingConfig(base)?.prefix], ["main", DEFAULT_STAGING_PREFIX]);
    assert.equal(DEFAULT_STAGING_PREFIX, "_hub-staging/");
    const same = stagingConfig({ ...base, R2_STAGING_BUCKET: "main" });
    assert.deepEqual([same?.bucket, same?.prefix, same?.dedicated], ["main", "_hub-staging/", false]);
    assert.equal(stagingConfig({ ...base, R2_STAGING_PREFIX: "tmp/hub/" })?.prefix, "tmp/hub/");
  });
  it("bad prefix, missing endpoint / keys, nothing configured ⇒ null", () => {
    for (const p of ["no-slash", "/lead/", "a//b/", "../x/", "sp ace/"]) assert.equal(stagingConfig({ ...base, R2_STAGING_PREFIX: p }), null, p);
    assert.equal(stagingConfig({ ...base, R2_ENDPOINT: "" }), null);
    assert.equal(stagingConfig({ ...base, R2_ACCESS_KEY_ID: undefined }), null);
    assert.equal(stagingConfig({}), null);
    assert.equal(stagingConfig({ R2_ENDPOINT: "e", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s" }), null);
  });
  it("key = <prefix><tenant>/<articleId>/<uuid>; stem is its fixed part", () => {
    assert.equal(stagingKey("", "gcv", 42, "u-1"), "gcv/42/u-1");
    assert.equal(stagingKey("_hub-staging/", "gcv", 42, "u-1"), "_hub-staging/gcv/42/u-1");
    assert.ok(stagingKey("_hub-staging/", "gcv", 42, "u").startsWith(stagingKeyStem("_hub-staging/", "gcv", 42)));
    assert.ok(!stagingKey("", "gcv", 420, "u").startsWith(stagingKeyStem("", "gcv", 42)));
  });
});

describe("deterministic name (PA-9)", () => {
  const bytes = Buffer.from("same bytes");
  it("hub-<sha256(articleId + ':' + bytes)[:32]>.<stored ext>", () => {
    const h = createHash("sha256").update("42:").update(bytes).digest("hex").slice(0, 32);
    assert.equal(deterministicMediaName(42, bytes, "image/jpeg"), `hub-${h}.jpg`);
    assert.match(deterministicMediaName(42, bytes, "image/webp"), /^hub-[0-9a-f]{32}\.webp$/);
    assert.match(deterministicMediaName(42, bytes, "image/png"), /^hub-[0-9a-f]{32}\.png$/);
    assert.match(deterministicMediaName(42, bytes, "image/gif"), /^hub-[0-9a-f]{32}\.png$/, "GIF is stored as PNG");
  });
  it("same (article, bytes) ⇒ same name; other article or other bytes ⇒ other name", () => {
    assert.equal(deterministicMediaName(42, bytes, "image/jpeg"), deterministicMediaName(42, Buffer.from("same bytes"), "image/jpeg"));
    assert.notEqual(deterministicMediaName(42, bytes, "image/jpeg"), deterministicMediaName(43, bytes, "image/jpeg"));
    assert.notEqual(deterministicMediaName(42, bytes, "image/jpeg"), deterministicMediaName(42, Buffer.from("other"), "image/jpeg"));
    assert.notEqual(deterministicMediaName(4, Buffer.from("2:x"), "image/jpeg"), deterministicMediaName(42, Buffer.from("x"), "image/jpeg"), "the ':' separator");
  });
});

describe("caption (PA-10)", () => {
  it("optional; trimmed; blank ⇒ absent; `]` allowed; ≤ 500", () => {
    assert.equal(HUB_MEDIA_CAPTION_MAX, 500);
    assert.deepEqual(checkMediaCaption(undefined), { ok: true, value: undefined });
    assert.deepEqual(checkMediaCaption("   "), { ok: true, value: undefined });
    assert.deepEqual(checkMediaCaption(" A [boat] at dawn "), { ok: true, value: "A [boat] at dawn" });
    assert.deepEqual(checkMediaCaption("x".repeat(500)), { ok: true, value: "x".repeat(500) });
  });
  it("CR / LF / C0 / bidi / lone surrogate / > 500 ⇒ bad_request", () => {
    for (const bad of ["a\nb", "a\rb", "a\u0001b", "a‮b", "a\ud800b", "x".repeat(501)]) {
      assert.deepEqual(checkMediaCaption(bad), { ok: false, code: "bad_request" }, JSON.stringify(bad).slice(0, 20));
    }
  });
});

describe("closed bodies", () => {
  it("sign: exactly the 5 keys; required articleId/mime/size/actorRole", () => {
    assert.deepEqual([...HUB_SIGN_KEYS], ["articleId", "mime", "size", "actorRole", "actorId"]);
    const ok = parseSignBody({ articleId: "12", mime: "image/gif", size: 10, actorRole: "editor", actorId: "u-1" });
    assert.deepEqual(ok, { ok: true, value: { articleId: "12", mime: "image/gif", size: 10, actorRole: "editor", actorId: "u-1" } });
    assert.equal(parseSignBody({ articleId: "12", mime: "text/plain", size: 99_999_999, actorRole: "admin" }).ok, true, "mime/size caps are checked later (415/413)");
    for (const bad of [
      null, [], "x",
      { mime: "image/png", size: 1, actorRole: "editor" },
      { articleId: 12, mime: "image/png", size: 1, actorRole: "editor" },
      { articleId: "1", mime: "image/png", size: 0, actorRole: "editor" },
      { articleId: "1", mime: "image/png", size: 1.5, actorRole: "editor" },
      { articleId: "1", mime: "image/png", size: "1", actorRole: "editor" },
      { articleId: "1", mime: "image/png", size: 1, actorRole: "viewer" },
      { articleId: "1", mime: "image/png", size: 1, actorRole: "editor", actorId: "" },
      { articleId: "1", mime: "image/png", size: 1, actorRole: "editor", actorId: "x".repeat(65) },
      { articleId: "1", mime: "image/png", size: 1, actorRole: "editor", email: "a@b.c" },
      { articleId: "1", mime: "image/png", size: 1, actorRole: "editor", tenant: "gcv" },
    ]) {
      assert.deepEqual(parseSignBody(bad), { ok: false }, JSON.stringify(bad));
    }
  });
  it("register: exactly the 6 keys; caption/credit optional strings", () => {
    assert.deepEqual([...HUB_REGISTER_KEYS], ["uploadId", "alt", "caption", "credit", "actorRole", "actorId"]);
    assert.deepEqual(parseRegisterBody({ uploadId: "u", alt: "a", actorRole: "marketer" }), { ok: true, value: { uploadId: "u", alt: "a", actorRole: "marketer" } });
    assert.deepEqual(parseRegisterBody({ uploadId: "u", alt: "a", caption: "c", credit: "cr", actorRole: "admin", actorId: "i" }), {
      ok: true,
      value: { uploadId: "u", alt: "a", caption: "c", credit: "cr", actorRole: "admin", actorId: "i" },
    });
    for (const bad of [
      { alt: "a", actorRole: "editor" },
      { uploadId: "u", actorRole: "editor" },
      { uploadId: "u", alt: "a" },
      { uploadId: "u", alt: "a", actorRole: "editor", caption: 1 },
      { uploadId: "u", alt: "a", actorRole: "editor", credit: null },
      { uploadId: "u", alt: "a", actorRole: "editor", articleId: "1" },
      { uploadId: "u", alt: 3, actorRole: "editor" },
    ]) {
      assert.deepEqual(parseRegisterBody(bad), { ok: false }, JSON.stringify(bad));
    }
  });
});

describe("frozen error table", () => {
  it("lists every status the two routes can return, in this order", () => {
    assert.deepEqual(
      HUB_DIRECT_ERROR_TABLE.map((r) => `${r.http} ${r.status}`),
      [
        "401/403 authenticateHubAuthorEngine",
        "400 bad_request",
        "400 bad_request (JSON)",
        "403 forbidden",
        "403 feature_disabled",
        "403 feature_disabled (switch)",
        "404 not_found",
        "409 object_missing",
        "410 upload_expired",
        "411 length_required",
        "413 too_large (body)",
        "413 too_large",
        "415 media_type",
        "422 not_editable",
        "422 upload_invalid",
        "422 media_dimensions",
        "422 alt_required",
        "500 internal_error",
        "503 staging_unavailable",
      ],
    );
  });
  it("route-owned bodies are byte-for-byte the table's, with Cache-Control: no-store", async () => {
    const pairs: [Parameters<typeof directError>[0], string, number][] = [
      ["bad_request", "400 bad_request", 400],
      ["switch_disabled", "403 feature_disabled (switch)", 403],
      ["object_missing", "409 object_missing", 409],
      ["upload_expired", "410 upload_expired", 410],
      ["length_required", "411 length_required", 411],
      ["too_large", "413 too_large", 413],
      ["media_type", "415 media_type", 415],
      ["upload_invalid", "422 upload_invalid", 422],
      ["media_dimensions", "422 media_dimensions", 422],
      ["alt_required", "422 alt_required", 422],
      ["internal_error", "500 internal_error", 500],
      ["staging_unavailable", "503 staging_unavailable", 503],
    ];
    for (const [code, row, http] of pairs) {
      const res = directError(code);
      assert.equal(res.status, http, code);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), HUB_DIRECT_ERROR_TABLE.find((r) => `${r.http} ${r.status}` === row)?.body, code);
    }
  });
  it("the mime list is the four of PA-8 and the limits are PA-5's", () => {
    assert.deepEqual([...DIRECT_MIME], ["image/jpeg", "image/png", "image/webp", "image/gif"]);
    assert.equal(HUB_DIRECT_UPLOAD_LIMITS.fileBytes, 20 * 1024 * 1024);
    assert.equal(HUB_DIRECT_UPLOAD_LIMITS.maxEdge, 12_000);
    assert.ok(HUB_DIRECT_UPLOAD_LIMITS.maxPixels >= 12_000_000 && HUB_DIRECT_UPLOAD_LIMITS.maxPixels <= 50_000_000);
    assert.equal(HUB_DIRECT_UPLOAD_LIMITS.putTtlSeconds, 300);
    assert.equal(HUB_DIRECT_UPLOAD_LIMITS.uploadIdTtlSeconds, 900);
  });
});

describe("success bodies", () => {
  it("sign: exactly {ok, uploadId, put, limits, expiresAt}; no-store", async () => {
    const res = signResponse({ uploadId: "v1.a.b", url: "https://r2.example/x?sig", mime: "image/png", expiresAtSeconds: NOW + 900 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const b = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(b), ["ok", "uploadId", "put", "limits", "expiresAt"]);
    assert.deepEqual(b.put, { url: "https://r2.example/x?sig", method: "PUT", headers: { "Content-Type": "image/png" }, expiresInSec: 300 });
    assert.deepEqual(Object.keys(b.limits as object), ["maxBytes", "maxPixels", "maxEdge"]);
    assert.equal(b.expiresAt, new Date((NOW + 900) * 1000).toISOString());
  });
  it("register: the multipart allowlist + caption + deduped; 201 vs 200; never a spread of the doc", async () => {
    const doc = { id: 9, alt: "A", credit: null, caption: "Cap", mimeType: "image/png", width: 10, height: 5, filesize: 99, url: "/u", filename: "hub-x.png", tenant: 3, prefix: "gcv", secret: "no" };
    const created = registerResponse(doc, false);
    assert.equal(created.status, 201);
    const b = (await created.json()) as { ok: boolean; deduped: boolean; media: Record<string, unknown> };
    assert.deepEqual(Object.keys(b), ["ok", "deduped", "media"]);
    assert.equal(b.deduped, false);
    assert.deepEqual(Object.keys(b.media).sort(), ["alt", "caption", "credit", "filesize", "height", "id", "mimeType", "url", "width"]);
    assert.equal(b.media.caption, "Cap");
    assert.equal(registerResponse({ ...doc, caption: undefined }, true).status, 200);
    assert.equal(((await registerResponse({ ...doc, caption: undefined }, true).json()) as { media: { caption: unknown } }).media.caption, null);
  });
});
