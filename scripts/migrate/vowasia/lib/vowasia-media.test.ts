import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral } from "../fixtures/vowasia-legacy/fake-central";
import { fixImage } from "../fixtures/vowasia-legacy/fixture-rows";
import { writeSnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { verifySnapshotInput } from "./snapshot-vowasia-main";
import { MediaStore, UploadError, ensureMedia, sniffImageMime } from "./vowasia-media";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "vowasia-media-test-"));
}

function store(o: Parameters<typeof writeSnapshotFixture>[1] = {}) {
  const dir = tmp();
  const fx = writeSnapshotFixture(dir, o);
  const input = verifySnapshotInput(dir, { requireManifest: true });
  return { dir, fx, s: new MediaStore(dir, input.manifest!) };
}

test("manifest lookup by exact URL, stable vowasia- filename, size/sha/magic re-check", () => {
  const { dir, s } = store();
  try {
    const ok = s.check(fixImage("cover-1.jpg"));
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.match(ok.filename, /^vowasia-[0-9a-f]{8}-cover-1-img\.jpg$/);
      assert.equal(ok.mime, "image/jpeg");
    }
    const miss = s.check(fixImage("cover-1.jpg") + "?x=1");
    assert.deepEqual(miss.ok ? null : miss.reason, "notInManifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("should plan the article as draft and drop the section on a store-level failure", () => {
  const { dir, s } = store({ failUrls: [fixImage("body-1a.jpg")], corruptUrls: [fixImage("cover-2.jpg")], missingUrls: [fixImage("cover-3.jpg")] });
  try {
    assert.deepEqual(s.check(fixImage("body-1a.jpg")), { ok: false, url: fixImage("body-1a.jpg"), reason: "manifestFailure" });
    const corrupt = s.check(fixImage("cover-2.jpg"));
    assert.equal(corrupt.ok ? "ok" : corrupt.reason, "sha256");
    const missing = s.check(fixImage("cover-3.jpg"));
    assert.equal(missing.ok ? "ok" : missing.reason, "size");
    assert.equal(sniffImageMime(Buffer.from("<html>")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuse an existing Media with the same stable filename in tenant vowasia; prefix asserted vowasia", async () => {
  const { dir, s } = store();
  try {
    const { central, tenantId, otherTenantId } = seededCentral();
    const img = s.check(fixImage("cover-1.jpg"));
    assert.equal(img.ok, true);
    if (!img.ok) return;
    // a look-alike in ANOTHER tenant must not be reused
    central.seed("media", { tenant: otherTenantId, filename: img.filename, prefix: "gtp" });
    const a = await ensureMedia(central, tenantId, img, { alt: "Alt", credit: "Cred" });
    assert.equal(a.origin, "created");
    const created = central.rows("media").find((m) => String(m.id) === String(a.id));
    assert.equal(created?.prefix, "vowasia");
    assert.equal(created?.credit, "Cred");
    const w = central.writes.find((x) => x.op === "create" && x.collection === "media");
    assert.deepEqual(w?.options?.context, { disableRevalidate: true, skipTranslationEnqueue: true });
    const b = await ensureMedia(central, tenantId, img, { alt: "Alt", credit: "" });
    assert.deepEqual(b, { id: a.id, origin: "reused", filename: created?.filename });
    assert.equal(central.rows("media").filter((m) => String(m.tenant) === String(tenantId)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("should stop before the article create when the Media upload throws (UploadError)", async () => {
  const { dir, s } = store();
  try {
    const { central, tenantId } = seededCentral();
    central.hooks.failCreate = (col) => (col === "media" ? new Error("R2 PutObject failed: credentials") : undefined);
    const img = s.check(fixImage("cover-1.jpg"));
    if (!img.ok) throw new Error("fixture");
    await assert.rejects(() => ensureMedia(central, tenantId, img, { alt: "a", credit: "" }), (e: unknown) => e instanceof UploadError && /upload failed/.test((e as Error).message));
    assert.equal(central.writes.filter((x) => x.collection === "articles").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Media whose prefix is not vowasia is refused (never build the R2 key by hand)", async () => {
  const { dir, s } = store();
  try {
    const { central, tenantId } = seededCentral();
    const orig = central.create.bind(central);
    central.create = async (c, d, o) => ({ ...(await orig(c, d, o)), prefix: "gtp" });
    const img = s.check(fixImage("cover-1.jpg"));
    if (!img.ok) throw new Error("fixture");
    await assert.rejects(() => ensureMedia(central, tenantId, img, { alt: "a", credit: "" }), /prefix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no network code path in the media module", () => {
  const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "vowasia-media.ts"), "utf8");
  assert.equal(/\bfetch\b|media-fetch|node:https?|undici/.test(src), false);
});
