import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchImage, sniffMime, type FetchLike } from "./media-fetch";
import { FailureControls, FAILURE_MESSAGES } from "./failure-controls";
import { BANNER_MESSAGES, legacyBanner } from "./db-banner";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const opts = (f: FetchLike, maxBytes = 1000) => ({ allow: ["img.example.com"], rewrite: {}, maxBytes, timeoutMs: 1000, fetchImpl: f });
const resp = (body: BodyInit | null, init: ResponseInit) => new Response(body, init);

test("C4/G36: 302 to a disallowed host is refused (mediaRedirectBlocked); allowed hop followed", async () => {
  let calls = 0;
  const f: FetchLike = async (url) => {
    calls++;
    if (url.endsWith("/a.jpg")) return resp(null, { status: 302, headers: { location: "https://evil.example.net/x.jpg" } });
    if (url.endsWith("/b.jpg")) return resp(null, { status: 301, headers: { location: "/c.jpg" } });
    return resp(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  assert.deepEqual(await fetchImage("https://img.example.com/a.jpg", opts(f)), { ok: false, reason: "mediaRedirectBlocked", retryable: false });
  const ok = await fetchImage("https://img.example.com/b.jpg", opts(f));
  assert.ok(ok.ok && ok.finalUrl === "https://img.example.com/c.jpg");
  assert.equal(calls, 3);
  assert.deepEqual(await fetchImage("http://img.example.com/a.jpg", opts(f)), { ok: false, reason: "hostNotAllowed", retryable: false });
  assert.deepEqual(await fetchImage("https://other.example.com/a.jpg", opts(f)), { ok: false, reason: "hostNotAllowed", retryable: false });
});

test("C4/G36: content-length over the cap refused; lying content-length stopped by the streamed cap", async () => {
  const big: FetchLike = async () => resp(Buffer.alloc(10), { status: 200, headers: { "content-length": "26214400", "content-type": "image/jpeg" } });
  assert.equal((await fetchImage("https://img.example.com/x.jpg", opts(big))).ok, false);
  let pulled = 0;
  const lying: FetchLike = async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 100) c.close();
        else c.enqueue(new Uint8Array(400));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": "10", "content-type": "image/jpeg" } });
  };
  assert.deepEqual(await fetchImage("https://img.example.com/x.jpg", opts(lying)), { ok: false, reason: "tooLarge", retryable: false });
  assert.ok(pulled < 10, `stream aborted early (pulled ${pulled})`);
});

test("C4/G36: wrong magic bytes, MIME mismatch and SVG refused; http errors classified", async () => {
  const txt: FetchLike = async () => resp("<html>", { status: 200, headers: { "content-type": "image/jpeg" } });
  assert.equal((await fetchImage("https://img.example.com/x.jpg", opts(txt))).ok === false && "badMagic", "badMagic");
  const mism: FetchLike = async () => resp(PNG, { status: 200, headers: { "content-type": "image/jpeg" } });
  assert.deepEqual(await fetchImage("https://img.example.com/x.jpg", opts(mism)), { ok: false, reason: "mimeMismatch", retryable: false });
  const svg: FetchLike = async () => resp("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  assert.deepEqual(await fetchImage("https://img.example.com/x.svg", opts(svg)), { ok: false, reason: "svgRejected", retryable: false });
  const e404: FetchLike = async () => resp("", { status: 404 });
  assert.deepEqual(await fetchImage("https://img.example.com/x.jpg", opts(e404)), { ok: false, reason: "http 404", retryable: false });
  const e503: FetchLike = async () => resp("", { status: 503 });
  assert.deepEqual(await fetchImage("https://img.example.com/x.jpg", opts(e503)), { ok: false, reason: "http 503", retryable: true });
  assert.equal(sniffMime(Buffer.from("RIFF0000WEBPxxxx")), "image/webp");
});

test("C4/G36: hostRewrite fetches the local target over http while checks stay in logical space", async () => {
  const seen: string[] = [];
  const f: FetchLike = async (url) => {
    seen.push(url);
    return resp(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const r = await fetchImage("https://img.example.com/p/a.jpg?x=1", { ...opts(f), rewrite: { "img.example.com": "127.0.0.1:54328" } });
  assert.ok(r.ok);
  assert.deepEqual(seen, ["http://127.0.0.1:54328/p/a.jpg?x=1"]);
});

test("C3/C4/G51: --stop-after-failures and the media failure budget stop the run", () => {
  const c = new FailureControls(3, 2, 10);
  c.recordArticle(false);
  c.recordArticle(false);
  assert.equal(c.stopReason(), null);
  c.recordArticle(true);
  c.recordArticle(false);
  c.recordArticle(false);
  c.recordArticle(false);
  assert.equal(c.stopReason(), FAILURE_MESSAGES.consecutive(3));
  const m = new FailureControls(100, 2, 10);
  for (let i = 0; i < 9; i++) m.recordMedia(i !== 0);
  assert.equal(m.stopReason(), null); // below the minimum sample
  m.recordMedia(true);
  assert.equal(m.stopReason(), FAILURE_MESSAGES.mediaBudget(2, 1, 10));
  const ok = new FailureControls(100, 2, 10);
  for (let i = 0; i < 100; i++) ok.recordMedia(i !== 0);
  assert.equal(ok.stopReason(), null); // 1% < 2%
});

test("C3/G48: the legacy banner never prints credentials or the query string", () => {
  const b = legacyBanner("postgres://gtp_migrator:s3cr3t-pw@db.example.supabase.co:5432/postgres?sslmode=require&password=x");
  assert.equal(b.banner, "db.example.supabase.co:5432/postgres");
  assert.doesNotMatch(JSON.stringify(b), /s3cr3t|sslmode|password|gtp_migrator/);
  assert.throws(() => legacyBanner(undefined), { message: BANNER_MESSAGES.missing });
  assert.throws(() => legacyBanner("postgres://u:p@/db?host=/tmp"), (e: unknown) => !String((e as Error).message).includes("p@"));
  assert.equal(legacyBanner("postgres://u:p@localhost:54327/gtp_legacy").local, true);
});
