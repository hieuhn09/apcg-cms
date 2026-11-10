/**
 * Unit tests for ./engine-hero-upload (shared hero upload helper, media-gtp-vowasia
 * phase 5). Fake fetch, fake DNS, fake Payload; no network, no DB.
 *
 *   npm run test:engine-hero
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Payload } from "payload";

import { uploadHeroLenient, uploadHeroMedia, type HeroUploadDeps } from "./engine-hero-upload";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

function fakePayload(opts: { createThrows?: boolean } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const payload = {
    create: async (a: Record<string, unknown>) => {
      if (opts.createThrows) throw new Error("db down");
      creates.push(a);
      return { id: 55 };
    },
    logger: { warn: (m: string) => warns.push(m), info: () => {}, error: () => {} },
  } as unknown as Payload;
  return { payload, creates, warns };
}

function res(body: Uint8Array | string, init: { status?: number; type?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === "string" ? body : (body as unknown as BodyInit), {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "image/jpeg", ...(init.headers ?? {}) },
  });
}

const strictOpts = { maxBytes: 1000, allowedTypes: ["image/jpeg", "image/png", "image/webp"], timeoutMs: 1000, sniff: true, allowLocal: false, filenameFor: (ext: string) => `s-rabcd1234.${ext}` };

describe("uploadHeroMedia (strict path)", () => {
  it("returns {ok:true,id} on 200 and creates Media with alt/credit/caption and the given filename", async () => {
    const { payload, creates } = fakePayload();
    const calls: Array<[string, RequestInit | undefined]> = [];
    const deps: HeroUploadDeps = {
      fetch: (async (u: string, i?: RequestInit) => (calls.push([u, i]), res(JPEG))) as never,
      resolveHost: async () => ["93.184.216.34"],
    };
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "Title", slug: "s", credit: "C", caption: "Illustrative image" }, strictOpts, deps);
    assert.deepEqual(r, { ok: true, id: 55, filename: "s-rabcd1234.jpeg" });
    assert.equal(calls[0]?.[1]?.redirect, "manual");
    const c = creates[0] as { data: Record<string, unknown>; file: { name: string; mimetype: string } };
    assert.deepEqual(c.data, { alt: "Title", credit: "C", caption: "Illustrative image", tenant: 3 });
    assert.equal(c.file.name, "s-rabcd1234.jpeg");
    assert.equal(c.file.mimetype, "image/jpeg");
  });
  it("fetch 404 -> {ok:false, code:fetch_failed}", async () => {
    const { payload, creates } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => res("nope", { status: 404 })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "fetch_failed");
    assert.equal(creates.length, 0);
  });
  it("redirect (3xx) -> invalid_hero_url", async () => {
    const { payload } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "invalid_hero_url");
  });
  it("host resolving to a private address -> invalid_hero_url, no fetch", async () => {
    const { payload } = fakePayload();
    let fetched = false;
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://evil.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => ((fetched = true), res(JPEG))) as never,
      resolveHost: async () => ["93.184.216.34", "10.0.0.7"],
    });
    assert.ok(!r.ok && r.code === "invalid_hero_url");
    assert.equal(fetched, false);
  });
  it("allowLocal relaxes the DNS check", async () => {
    const { payload } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "http://127.0.0.1:9/a.jpg", title: "T", slug: "s", credit: null, caption: null }, { ...strictOpts, allowLocal: true }, {
      fetch: (async () => res(JPEG)) as never,
      resolveHost: async () => ["127.0.0.1"],
    });
    assert.equal(r.ok, true);
  });
  it("wrong type header -> hero_not_an_image", async () => {
    const { payload } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => res("<html>", { type: "text/html" })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "hero_not_an_image");
  });
  it("wrong magic bytes behind image/jpeg -> hero_not_an_image", async () => {
    const { payload, creates } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => res("<svg onload=x>", { type: "image/jpeg" })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "hero_not_an_image");
    assert.equal(creates.length, 0);
  });
  it("oversize body (stream, lying content-length) -> hero_too_large without buffering past the cap", async () => {
    const { payload, creates } = fakePayload();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += 1;
        if (pulled > 50) return ctrl.close();
        ctrl.enqueue(pulled === 1 ? JPEG : new Uint8Array(200));
      },
    });
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => new Response(stream, { headers: { "content-type": "image/jpeg", "content-length": "10" } })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "hero_too_large");
    assert.ok(pulled < 20, `stopped early (pulled ${pulled})`);
    assert.equal(creates.length, 0);
  });
  it("declared content-length over the cap -> hero_too_large", async () => {
    const { payload } = fakePayload();
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => res(JPEG, { headers: { "content-length": "99999" } })) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "hero_too_large");
  });
  it("Media create failure -> upload_failed", async () => {
    const { payload } = fakePayload({ createThrows: true });
    const r = await uploadHeroMedia(payload, { tenantId: 3, url: "https://img.example/a.jpg", title: "T", slug: "s", credit: null, caption: null }, strictOpts, {
      fetch: (async () => res(JPEG)) as never,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(!r.ok && r.code === "upload_failed");
  });
});

describe("uploadHeroLenient (intake create path, unchanged behaviour)", () => {
  it("fetch 404 -> undefined and the exact warn text; fetch called with the URL only", async () => {
    const { payload, warns, creates } = fakePayload();
    const calls: unknown[][] = [];
    const id = await uploadHeroLenient(payload, 3, "https://img.example/a.jpg", "T", "slug", null, null, {
      fetch: (async (...a: unknown[]) => (calls.push(a), res("x", { status: 404 }))) as never,
    });
    assert.equal(id, undefined);
    assert.deepEqual(warns, ["[intake] hero upload failed (hero fetch 404) — publishing without hero"]);
    assert.deepEqual(calls, [["https://img.example/a.jpg"]]);
    assert.equal(creates.length, 0);
  });
  it("200 -> id, name `${slug}.${ext}`, header type trusted, default image/jpeg when absent", async () => {
    const { payload, creates } = fakePayload();
    const id = await uploadHeroLenient(payload, 3, "https://img.example/a", "T", "slug", "C", null, {
      fetch: (async () => new Response("not-even-an-image", { status: 200 })) as never,
    });
    assert.equal(id, 55);
    const c = creates[0] as { data: Record<string, unknown>; file: { name: string; mimetype: string; size: number } };
    // Response with a string body defaults to text/plain; the lenient path keeps that (no sniff).
    assert.equal(c.file.mimetype, "text/plain");
    assert.equal(c.file.name, "slug.plain");
    assert.deepEqual(c.data, { alt: "T", credit: "C", tenant: 3 });
  });
  it("no content-type header at all -> image/jpeg / .jpeg", async () => {
    const { payload, creates } = fakePayload();
    const r = new Response(JPEG);
    r.headers.delete("content-type");
    await uploadHeroLenient(payload, 3, "https://img.example/a", "T", "slug", null, "Cap", { fetch: (async () => r) as never });
    const c = creates[0] as { data: Record<string, unknown>; file: { name: string; mimetype: string } };
    assert.equal(c.file.mimetype, "image/jpeg");
    assert.equal(c.file.name, "slug.jpeg");
    assert.deepEqual(c.data, { alt: "T", credit: undefined, caption: "Cap", tenant: 3 });
  });
  it("create throws -> undefined + warn with the error message", async () => {
    const { payload, warns } = fakePayload({ createThrows: true });
    const id = await uploadHeroLenient(payload, 3, "https://img.example/a.jpg", "T", "slug", null, null, { fetch: (async () => res(JPEG)) as never });
    assert.equal(id, undefined);
    assert.deepEqual(warns, ["[intake] hero upload failed (db down) — publishing without hero"]);
  });
});
