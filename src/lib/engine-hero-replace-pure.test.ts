/**
 * Unit tests for ./engine-hero-replace-pure and ./engine-hero-replace-switch
 * (media-gtp-vowasia phase 5, engine hero replace). Node's built-in runner, no DB.
 *
 *   npm run test:engine-hero
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HERO_BODY_MAX_BYTES,
  heroFilenameFor,
  heroGateReason,
  heroPostWriteCheck,
  heroToken,
  filenameHasHeroToken,
  isBlockedAddress,
  parseHeroReplaceBody,
  sniffImageType,
  validateHeroFetchUrl,
} from "./engine-hero-replace-pure";
import {
  heroReplaceAllowLocal,
  heroReplaceTenants,
  heroReplaceUrlHosts,
  isHeroReplaceTenant,
} from "./engine-hero-replace-switch";

const base = {
  engineDraftId: "content-engine:vowasia:42",
  expectedHeroMediaId: 7,
  heroImageUrl: "https://x.supabase.co/storage/v1/object/public/hero-images/a.jpg",
  replacementKey: "replace:42:1:2",
  reason: "rights complaint",
};

describe("parseHeroReplaceBody", () => {
  it("accepts a full body and normalises caption and credit", () => {
    const r = parseHeroReplaceBody({ ...base, publicationId: " vowasia ", imageCredit: "  Jo / Pexels ", imageCaption: " Illustrative\n image " });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.publicationId, "vowasia");
    assert.equal(r.value.imageCredit, "Jo / Pexels");
    assert.equal(r.value.imageCaption, "Illustrative image");
    assert.equal(r.value.dryRun, false);
    assert.equal(r.value.expectedHeroMediaId, 7);
  });
  it("caps the caption at 200 chars and treats an empty credit as null", () => {
    const r = parseHeroReplaceBody({ ...base, imageCaption: "a".repeat(300), imageCredit: "   " });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.imageCaption?.length, 200);
    assert.equal(r.value.imageCredit, null);
  });
  it("accepts expectedHeroMediaId null but requires the key", () => {
    assert.ok(parseHeroReplaceBody({ ...base, expectedHeroMediaId: null }).ok);
    const rest: Record<string, unknown> = { ...base };
    delete rest.expectedHeroMediaId;
    const r = parseHeroReplaceBody(rest);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.fields, ["expectedHeroMediaId"]);
  });
  it("names every missing or malformed field", () => {
    const r = parseHeroReplaceBody({ expectedHeroMediaId: "7", replacementKey: "x".repeat(121), reason: "", dryRun: "yes" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.fields.sort(), ["dryRun", "engineDraftId", "expectedHeroMediaId", "heroImageUrl", "reason", "replacementKey"].sort());
  });
  it("rejects a non-object body", () => {
    assert.equal(parseHeroReplaceBody(null).ok, false);
    assert.equal(parseHeroReplaceBody([1]).ok, false);
  });
  it("dryRun needs only engineDraftId and expectedHeroMediaId", () => {
    const r = parseHeroReplaceBody({ engineDraftId: "a", expectedHeroMediaId: null, dryRun: true });
    assert.ok(r.ok);
  });
  it("rejects a non-integer or negative media id", () => {
    assert.equal(parseHeroReplaceBody({ ...base, expectedHeroMediaId: 1.5 }).ok, false);
    assert.equal(parseHeroReplaceBody({ ...base, expectedHeroMediaId: 0 }).ok, false);
  });
  it("body cap is 16 KB", () => assert.equal(HERO_BODY_MAX_BYTES, 16 * 1024));
});

describe("validateHeroFetchUrl", () => {
  const off = { allowLocal: false, hosts: [] as string[] };
  const cases: Array<[string, boolean]> = [
    ["http://example.com/a.jpg", false],
    ["https://user@example.com/a.jpg", false],
    ["https://user:pw@example.com/a.jpg", false],
    ["https://127.0.0.1/a.jpg", false],
    ["https://169.254.169.254/latest/meta-data", false],
    ["https://[::1]/a.jpg", false],
    ["https://10.0.0.5/a.jpg", false],
    ["https://192.168.1.1/a.jpg", false],
    ["https://172.20.0.1/a.jpg", false],
    ["https://localhost/a.jpg", false],
    ["https://metadata.google.internal/x", false],
    ["https://[::ffff:127.0.0.1]/a.jpg", false],
    ["ftp://example.com/a.jpg", false],
    ["not a url", false],
    ["https://example.com/a.jpg", true],
    ["https://8.8.8.8/a.jpg", true],
  ];
  for (const [url, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${url}`, () => assert.equal(validateHeroFetchUrl(url, off).ok, ok));
  }
  it("allowLocal relaxes http and loopback", () => {
    const on = { allowLocal: true, hosts: [] as string[] };
    assert.equal(validateHeroFetchUrl("http://127.0.0.1:4555/a.jpg", on).ok, true);
    assert.equal(validateHeroFetchUrl("http://localhost:4555/a.jpg", on).ok, true);
    // userinfo is never relaxed
    assert.equal(validateHeroFetchUrl("http://u@127.0.0.1/a.jpg", on).ok, false);
  });
  it("honours an exact host allowlist (case-insensitive host)", () => {
    const hosts = ["x.supabase.co"];
    assert.equal(validateHeroFetchUrl("https://X.supabase.co/a.jpg", { allowLocal: false, hosts }).ok, true);
    assert.equal(validateHeroFetchUrl("https://evil.example/a.jpg", { allowLocal: false, hosts }).ok, false);
    assert.equal(validateHeroFetchUrl("https://a.x.supabase.co/a.jpg", { allowLocal: false, hosts }).ok, false);
  });
});

describe("isBlockedAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "ff02::1"]) {
    it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) {
    it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  }
  it("blocks a non-address string", () => assert.equal(isBlockedAddress("nope"), true));
});

describe("sniffImageType", () => {
  it("jpeg / png / webp / other", () => {
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), "image/jpeg");
    assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
    assert.equal(sniffImageType(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
    assert.equal(sniffImageType(Buffer.from("<html>")), null);
    assert.equal(sniffImageType(Buffer.from("GIF89a")), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

describe("heroFilenameFor / token", () => {
  it("is deterministic and embeds the 8-char sha256 token", () => {
    const t = heroToken("replace:42:1:2");
    assert.match(t, /^[0-9a-f]{8}$/);
    assert.equal(heroToken("replace:42:1:2"), t);
    assert.notEqual(heroToken("replace:42:1:3"), t);
    assert.equal(heroFilenameFor("my-slug", "replace:42:1:2", "jpeg"), `my-slug-r${t}.jpeg`);
  });
  it("detects the token, also after a Payload duplicate suffix, never on a near miss", () => {
    const key = "replace:42:1:2";
    const t = heroToken(key);
    assert.equal(filenameHasHeroToken(`s-r${t}.jpg`, key), true);
    assert.equal(filenameHasHeroToken(`s-r${t}-1.jpg`, key), true);
    assert.equal(filenameHasHeroToken(`s-r${t}0.jpg`, key), false);
    assert.equal(filenameHasHeroToken("s.jpg", key), false);
    assert.equal(filenameHasHeroToken(null, key), false);
  });
  it("falls back to a safe slug", () => {
    assert.match(heroFilenameFor("", "k", "png"), /^hero-r[0-9a-f]{8}\.png$/);
  });
});

describe("heroGateReason (P9/P17)", () => {
  const pub = (v: number) => ({ _status: "published", workflowStatus: "published", version: v });
  it("published main + published latest, equal versions: ok", () => assert.equal(heroGateReason(pub(3), pub(3)), null));
  it("published main + draft latest: diverged", () => assert.equal(heroGateReason(pub(3), { _status: "draft", version: 4 }), "draft_diverged"));
  it("published main + published latest, versions differ: diverged", () => assert.equal(heroGateReason(pub(3), pub(4)), "draft_diverged"));
  it("legacy shape (_status draft, workflowStatus published), equal versions: ok", () => {
    const legacy = { _status: "draft", workflowStatus: "published", version: 2 };
    assert.equal(heroGateReason(legacy, { ...legacy }), null);
  });
  it("legacy shape with a newer version: diverged", () =>
    assert.equal(heroGateReason({ _status: "draft", workflowStatus: "published", version: 2 }, { _status: "draft", version: 3 }), "draft_diverged"));
  it("pending_review equal versions ok, unequal diverged", () => {
    const p = { _status: "draft", workflowStatus: "pending_review", version: 1 };
    assert.equal(heroGateReason(p, { ...p }), null);
    assert.equal(heroGateReason(p, { ...p, version: 2 }), "draft_diverged");
  });
  it("missing latest is read as the main row", () => assert.equal(heroGateReason(pub(1), null), null));
});

describe("heroPostWriteCheck (P17)", () => {
  const pre = {
    id: 1,
    heroImage: 7,
    _status: "published",
    workflowStatus: "published",
    version: 5,
    publishedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    title: { en: "T", vi: "TV" },
    editedByHuman: false,
  };
  const post = { ...pre, heroImage: 9, updatedAt: "2026-11-10T00:00:00.000Z" };
  const latestAfter = { _status: "published", version: 5 };
  it("passes when only heroImage and updatedAt moved", () => assert.deepEqual(heroPostWriteCheck({ pre, post, latestAfter }), { ok: true }));
  const legs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["extra changed key", { ...post, editedByHuman: true }, latestAfter],
    ["localized key moved", { ...post, title: { en: "T2", vi: "TV" } }, latestAfter],
    ["version moved", { ...post, version: 6 }, { _status: "published", version: 6 }],
    ["_status moved", { ...post, _status: "draft" }, { _status: "draft", version: 5 }],
    ["workflowStatus moved", { ...post, workflowStatus: "hidden" }, latestAfter],
    ["publishedAt moved", { ...post, publishedAt: "2026-11-10T00:00:00.000Z" }, latestAfter],
    ["latest no longer equal to post", post, { _status: "draft", version: 5 }],
  ];
  for (const [name, p, l] of legs) {
    it(`fails: ${name}`, () => assert.equal(heroPostWriteCheck({ pre, post: p, latestAfter: l }).ok, false));
  }
  it("fails when post or latestAfter is missing", () => {
    assert.equal(heroPostWriteCheck({ pre, post: null, latestAfter }).ok, false);
    assert.equal(heroPostWriteCheck({ pre, post, latestAfter: null }).ok, false);
  });
  it("legacy shape passes when nothing but the hero moved", () => {
    const lp = { ...pre, _status: "draft" };
    assert.deepEqual(heroPostWriteCheck({ pre: lp, post: { ...lp, heroImage: 9 }, latestAfter: { _status: "draft", version: 5 } }), { ok: true });
  });
});

describe("engine-hero-replace-switch", () => {
  it("unset or empty = off", () => {
    assert.deepEqual(heroReplaceTenants({}), []);
    assert.deepEqual(heroReplaceTenants({ ENGINE_HERO_REPLACE_TENANTS: " , " }), []);
    assert.equal(isHeroReplaceTenant("vowasia", {}), false);
  });
  it("CSV exact match, trimmed items, case-sensitive", () => {
    const env = { ENGINE_HERO_REPLACE_TENANTS: " vowasia , gtp" };
    assert.equal(isHeroReplaceTenant("vowasia", env), true);
    assert.equal(isHeroReplaceTenant("gtp", env), true);
    assert.equal(isHeroReplaceTenant("VowAsia", env), false);
    assert.equal(isHeroReplaceTenant("vow", env), false);
    assert.equal(isHeroReplaceTenant("vowasia", { ENGINE_HERO_REPLACE_TENANTS: "*" }), false);
  });
  it("URL hosts lowercased, empty = no restriction", () => {
    assert.deepEqual(heroReplaceUrlHosts({}), []);
    assert.deepEqual(heroReplaceUrlHosts({ ENGINE_HERO_REPLACE_URL_HOSTS: "A.supabase.co, b.example " }), ["a.supabase.co", "b.example"]);
  });
  it("ALLOW_LOCAL only when exactly true and not production / Vercel", () => {
    assert.equal(heroReplaceAllowLocal({ ENGINE_HERO_REPLACE_ALLOW_LOCAL: "true" }), true);
    assert.equal(heroReplaceAllowLocal({ ENGINE_HERO_REPLACE_ALLOW_LOCAL: "1" }), false);
    assert.equal(heroReplaceAllowLocal({ ENGINE_HERO_REPLACE_ALLOW_LOCAL: "true", NODE_ENV: "production" }), false);
    assert.equal(heroReplaceAllowLocal({ ENGINE_HERO_REPLACE_ALLOW_LOCAL: "true", VERCEL_ENV: "preview" }), false);
    assert.equal(heroReplaceAllowLocal({}), false);
  });
});
