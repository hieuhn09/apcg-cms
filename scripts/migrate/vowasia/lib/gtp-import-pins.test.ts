import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GTP_IMPORT_PINS, pinMismatches } from "./gtp-import-pins";
import { repoRoot } from "./out-dir";
import { fetchImage, sniffMime, type FetchLike } from "../../lib/media-fetch";

const EXPECTED_FILES = [
  "scripts/migrate/lib/media-fetch.ts",
  "scripts/migrate/lib/lexical-body.ts",
  "scripts/migrate/lib/gtp-transform.ts",
  "scripts/migrate/lib/gtp-mapping.ts",
  "scripts/migrate/lib/run-dir.ts",
  "scripts/migrate/lib/out-dir.ts",
  "scripts/migrate/lib/failure-controls.ts",
  "scripts/migrate/lib/rollback-rules.ts",
  "scripts/migrate/lib/load-guard.ts",
  "scripts/migrate/lib/normalise-path.ts",
];

test("the pin file covers every GTP file imported read-only (E-B6)", () => {
  for (const f of EXPECTED_FILES) assert.ok(f in GTP_IMPORT_PINS, `${f} is not pinned`);
  for (const [f, h] of Object.entries(GTP_IMPORT_PINS)) {
    assert.match(f, /^scripts\/migrate\/lib\/[a-z-]+\.ts$/, `${f}: only GTP lib files are pinned`);
    assert.match(h, /^[0-9a-f]{64}$/);
  }
});

test("every pinned GTP file matches its sha256 in this checkout", () => {
  assert.deepEqual(pinMismatches(repoRoot()), []);
  for (const [f, h] of Object.entries(GTP_IMPORT_PINS)) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(repoRoot(), f))).digest("hex"), h, f);
  }
});

test("should fail when any imported GTP file changes by one byte", () => {
  // Copy the pinned files into a scratch tree, flip one byte in one file, expect exactly that file reported.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-pins-"));
  try {
    for (const f of Object.keys(GTP_IMPORT_PINS)) {
      mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      writeFileSync(path.join(tmp, f), readFileSync(path.join(repoRoot(), f)));
    }
    assert.deepEqual(pinMismatches(tmp), []);
    const victim = "scripts/migrate/lib/media-fetch.ts";
    const buf = readFileSync(path.join(tmp, victim));
    buf[buf.length - 1] = (buf[buf.length - 1] as number) ^ 1;
    writeFileSync(path.join(tmp, victim), buf);
    assert.deepEqual(pinMismatches(tmp), [victim]);
    rmSync(path.join(tmp, "scripts/migrate/lib/load-guard.ts"));
    assert.deepEqual(pinMismatches(tmp).sort(), [victim, "scripts/migrate/lib/load-guard.ts"].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* Behaviour pins for the imported security functions (red if GTP ever loosens them). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
function resp(body: Buffer | string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: init.status ?? 200, headers: init.headers ?? {} });
}
const BASE = { allow: ["img.example.invalid"], rewrite: {}, maxBytes: 20 * 1024 * 1024, timeoutMs: 2000 };

test("media-fetch behaviour: host allow-list, https only, off-list redirect refused", async () => {
  const ok: FetchLike = async () => resp(JPEG, { headers: { "content-type": "image/jpeg" } });
  assert.equal((await fetchImage("https://img.example.invalid/a.jpg", { ...BASE, fetchImpl: ok })).ok, true);
  assert.deepEqual(await fetchImage("https://other.example.invalid/a.jpg", { ...BASE, fetchImpl: ok }), { ok: false, reason: "hostNotAllowed", retryable: false });
  assert.deepEqual(await fetchImage("http://img.example.invalid/a.jpg", { ...BASE, fetchImpl: ok }), { ok: false, reason: "hostNotAllowed", retryable: false });
  const redirect: FetchLike = async () => resp("", { status: 302, headers: { location: "https://other.example.invalid/x.jpg" } });
  assert.deepEqual(await fetchImage("https://img.example.invalid/a.jpg", { ...BASE, fetchImpl: redirect }), { ok: false, reason: "mediaRedirectBlocked", retryable: false });
});

test("media-fetch behaviour: magic bytes, SVG and the size cap", async () => {
  const svg: FetchLike = async () => resp("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml" } });
  assert.equal((await fetchImage("https://img.example.invalid/a.svg", { ...BASE, fetchImpl: svg })).ok, false);
  const svgNoType: FetchLike = async () => resp("<svg xmlns='http://www.w3.org/2000/svg'/>");
  assert.deepEqual(await fetchImage("https://img.example.invalid/a.svg", { ...BASE, fetchImpl: svgNoType }), { ok: false, reason: "badMagic", retryable: false });
  const html: FetchLike = async () => resp("<html></html>", { headers: { "content-type": "image/jpeg" } });
  assert.deepEqual(await fetchImage("https://img.example.invalid/a.jpg", { ...BASE, fetchImpl: html }), { ok: false, reason: "badMagic", retryable: false });
  const big: FetchLike = async () => resp(JPEG, { headers: { "content-type": "image/jpeg", "content-length": String(20 * 1024 * 1024 + 1) } });
  assert.deepEqual(await fetchImage("https://img.example.invalid/a.jpg", { ...BASE, fetchImpl: big }), { ok: false, reason: "tooLarge", retryable: false });
  const streamedBig: FetchLike = async () => resp(Buffer.concat([JPEG, Buffer.alloc(64)]));
  assert.deepEqual(await fetchImage("https://img.example.invalid/a.jpg", { ...BASE, maxBytes: 32, fetchImpl: streamedBig }), { ok: false, reason: "tooLarge", retryable: false });
  assert.equal(sniffMime(Buffer.from("<svg")), null);
});
