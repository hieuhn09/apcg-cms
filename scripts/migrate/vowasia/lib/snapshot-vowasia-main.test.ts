import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_HOST, ARTICLE_COLUMNS, BODY_MARK, FAKE_SITE_ID, FakeLegacyClient, TITLE_MARK,
} from "../fixtures/vowasia-legacy/fake-legacy";
import { JPEG, PNG, startImageServer } from "../fixtures/vowasia-legacy/image-server";
import { OUTSIDE_REPO_MESSAGES } from "./assert-outside-repo";
import { repoRoot } from "./out-dir";
import {
  SNAPSHOT_MESSAGES, SNAPSHOT_REQUIRED_ROLES, collectImageUrls, runSnapshot, verifySnapshotInput, type SnapshotDeps,
} from "./snapshot-vowasia-main";
import { LiveVowasiaReader } from "./vowasia-reader";
import { VowasiaReadOnlyDb } from "./vowasia-sql";

const FAKE_URL = "postgresql://vowasia_migrator:fixture-pass@localhost:5432/legacy";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "vowasia-snap-"));
}

function overlay(dir: string, media?: Record<string, unknown>): string {
  const f = path.join(dir, "overlay.json");
  writeFileSync(f, JSON.stringify({ source: { siteFilter: FAKE_SITE_ID }, ...(media ? { media } : {}) }));
  return f;
}

function deps(fake: FakeLegacyClient, out: string[] = []): SnapshotDeps {
  return {
    env: { LEGACY_VOWASIA_DB_URL: FAKE_URL },
    log: (l) => out.push(l),
    openReader: (_url, _ssl, reg, site) => new LiveVowasiaReader(new VowasiaReadOnlyDb(reg, () => fake), site),
    retries: 0,
  };
}

test("the 13 required column roles are the U1 list", () => {
  assert.deepEqual([...SNAPSHOT_REQUIRED_ROLES].sort(), ["body", "createdAt", "excerpt", "image", "imageCredit", "publishedAt", "section", "slug", "status", "subsection", "tags", "title", "updatedAt"].sort());
});

test("should refuse to snapshot when a required column role is not in the view catalog", async () => {
  const d = tmp();
  try {
    const fake = new FakeLegacyClient({ articleColumns: ARTICLE_COLUMNS.filter((c) => c !== "featured_image_credit") });
    await assert.rejects(runSnapshot(["--mapping-overlay", overlay(d), "--out", path.join(d, "snap")], deps(fake)), { message: SNAPSHOT_MESSAGES.missingColumn });
    assert.equal(fake.keysetCalls, 0, "refused BEFORE reading any article row");
    assert.equal(existsSync(path.join(d, "snap", "snapshot.ndjson")), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("snapshot reads only the 15 columns through SELECT builders, writes outside the repo (600/700) and prints no secret", async () => {
  const d = tmp();
  const out: string[] = [];
  try {
    const fake = new FakeLegacyClient();
    const snap = path.join(d, "snap");
    assert.equal(await runSnapshot(["--mapping-overlay", overlay(d), "--out", snap], deps(fake, out)), 0);
    assert.deepEqual(readdirSync(snap).sort(), ["query-log.json", "snapshot-meta.json", "snapshot.ndjson"]);
    assert.equal(statSync(snap).mode & 0o777, 0o700);
    for (const f of readdirSync(snap)) assert.equal(statSync(path.join(snap, f)).mode & 0o777, 0o600, f);
    const lines = readFileSync(path.join(snap, "snapshot.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const arts = lines.filter((l) => l.t === "article");
    assert.equal(arts.length, 8);
    assert.deepEqual(lines.filter((l) => l.t === "site").map((l) => Object.keys(l.row).sort()), [["id", "name", "slug"]]);
    for (const a of arts) assert.deepEqual(Object.keys(a.row).sort(), ARTICLE_COLUMNS.filter((c) => c !== "author_email").sort());
    const meta = JSON.parse(readFileSync(path.join(snap, "snapshot-meta.json"), "utf8"));
    assert.equal(meta.snapshotSha256, sha(readFileSync(path.join(snap, "snapshot.ndjson"))));
    assert.equal(meta.counts.articles, 8);
    assert.equal(meta.columnRoles.imageCredit, "featured_image_credit");
    const qlog = JSON.parse(readFileSync(path.join(snap, "query-log.json"), "utf8")) as { id: string; text: string }[];
    assert.ok(qlog.length >= 3);
    for (const e of qlog) {
      assert.deepEqual(Object.keys(e).sort(), ["id", "text"]);
      assert.ok(e.text.startsWith("SELECT "), e.text);
      if (!e.id.startsWith("catalog")) assert.match(e.text, / WHERE "(site_id|id)" = \$1\) AS t/);
      assert.ok(!e.text.includes("author_email"));
    }
    for (const s of fake.statements) assert.ok(/^(SELECT |SET |BEGIN READ ONLY$|COMMIT$)/.test(s), s);
    const printed = out.join("\n");
    assert.match(printed, new RegExp(meta.snapshotSha256));
    for (const needle of [FAKE_SITE_ID, TITLE_MARK, BODY_MARK, "fixture-pass", ALLOWED_HOST, "author1@example.invalid"]) assert.ok(!printed.includes(needle), needle);
    // a second snapshot into the same directory is refused (never overwrite)
    await assert.rejects(runSnapshot(["--mapping-overlay", overlay(d), "--out", snap], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.exists });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("snapshot refuses a site filter that is not the vowasia site", async () => {
  const d = tmp();
  try {
    const fake = new FakeLegacyClient({ sites: [{ id: FAKE_SITE_ID, slug: "globaltravelpost", name: "x" }] });
    await assert.rejects(runSnapshot(["--mapping-overlay", overlay(d), "--out", path.join(d, "s")], deps(fake)), /expected vowasia slug/);
    assert.equal(fake.keysetCalls, 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("snapshot --out inside the repo (git-ignored) is refused before the DB is touched", async () => {
  const fake = new FakeLegacyClient();
  const d = tmp();
  try {
    const inRepo = path.join(repoRoot(), "scripts", "migrate", "out", "vowasia-snap-probe");
    await assert.rejects(runSnapshot(["--mapping-overlay", overlay(d), "--out", inRepo], deps(fake)), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.equal(fake.statements.length, 0);
    assert.equal(existsSync(inRepo), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("should collect an allow-listed image URL found under an unknown JSON key", () => {
  const rows = [
    { body_sections: [{ kind: "gallery", pic: { src: `https://${ALLOWED_HOST}/a/deep.png` } }], featured_image: null },
    { body_sections: JSON.stringify([{ weird: { x: [`https://${ALLOWED_HOST}/b/in-json-string.jpg`] } }]) },
    { body_sections: `<p><img src="https://${ALLOWED_HOST}/c/in-html.webp?w=1"></p> https://other.example.invalid/z.png` },
    { featured_image: `https://${ALLOWED_HOST}/a/deep.png` },
  ];
  const r = collectImageUrls(rows, (u) => new URL(u).host === ALLOWED_HOST);
  assert.deepEqual(r.urls, [`https://${ALLOWED_HOST}/a/deep.png`, `https://${ALLOWED_HOST}/b/in-json-string.jpg`, `https://${ALLOWED_HOST}/c/in-html.webp?w=1`]);
  assert.equal(r.offAllowlistImageUrls, 1);
});

async function snapshotDir(d: string): Promise<string> {
  const snap = path.join(d, "snap");
  await runSnapshot(["--mapping-overlay", overlay(d), "--out", snap], deps(new FakeLegacyClient()));
  return snap;
}

test("should refuse hostRewrite outside explicit rehearsal mode", async () => {
  const d = tmp();
  try {
    const snap = await snapshotDir(d);
    const ov = overlay(d, { hostAllowlist: [ALLOWED_HOST], hostRewrite: { [ALLOWED_HOST]: "127.0.0.1:9" } });
    const base = ["--download-images", "--snapshot", snap, "--mapping-overlay", ov];
    await assert.rejects(runSnapshot(base, deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.rewriteNeedsRehearsal });
    const ov2 = overlay(d, { hostAllowlist: [ALLOWED_HOST], hostRewrite: { [ALLOWED_HOST]: "evil.example.invalid" } });
    await assert.rejects(runSnapshot(["--download-images", "--snapshot", snap, "--mapping-overlay", ov2, "--rehearsal"], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.rewriteNotLocal });
    assert.equal(existsSync(path.join(snap, "manifest.json")), false);
    // --rehearsal is a flag of the download step only, and never read from the environment
    await assert.rejects(runSnapshot(["--mapping-overlay", ov, "--out", path.join(d, "x"), "--rehearsal"], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.rehearsalOnlyDownload });
    const e = deps(new FakeLegacyClient());
    e.env = { ...e.env, VOWASIA_REHEARSAL: "1", REHEARSAL: "1" };
    await assert.rejects(runSnapshot(base, e), { message: SNAPSHOT_MESSAGES.rewriteNeedsRehearsal });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("should reject SVG, wrong magic bytes, over 20 MB, non-https and off-allowlist redirects", async () => {
  const d = tmp();
  const srv = await startImageServer();
  const out: string[] = [];
  try {
    const snap = await snapshotDir(d);
    const ov = overlay(d, { hostAllowlist: [ALLOWED_HOST], hostRewrite: { [ALLOWED_HOST]: `127.0.0.1:${srv.port}` } });
    const dp = deps(new FakeLegacyClient(), out);
    delete dp.env.LEGACY_VOWASIA_DB_URL; // the download step never needs the database
    assert.equal(await runSnapshot(["--download-images", "--snapshot", snap, "--mapping-overlay", ov, "--rehearsal"], dp), 0);
    const manifestRaw = readFileSync(path.join(snap, "manifest.json"));
    const m = JSON.parse(manifestRaw.toString("utf8"));
    const u = (p: string) => `https://${ALLOWED_HOST}/storage/v1/object/public/media/${p}`;
    const okUrls = m.entries.map((e: { url: string }) => e.url).sort();
    assert.deepEqual(okUrls, [u("dup.jpg"), u("nested/deep.png"), u("ok.jpg"), u("ok2.png")].sort());
    const fail = Object.fromEntries(m.failures.map((f: { url: string; reason: string }) => [f.url, f.reason]));
    assert.equal(fail[u("svg.svg")], "svgRejected");
    assert.equal(fail[u("bad.jpg")], "badMagic");
    assert.equal(fail[u("big.jpg")], "tooLarge");
    assert.equal(fail[`http://${ALLOWED_HOST}/storage/v1/object/public/media/http.jpg`], "hostNotAllowed");
    assert.equal(fail[u("redir-off.jpg")], "mediaRedirectBlocked");
    assert.equal(fail[u("missing.jpg")], "http 404");
    assert.equal(m.offAllowlistImageUrls, 1);
    assert.equal(m.snapshotSha256, JSON.parse(readFileSync(path.join(snap, "snapshot-meta.json"), "utf8")).snapshotSha256);
    // store files are named by the sha256 of their content (U16b), never by a manifest string
    const store = path.join(snap, "images");
    assert.equal(statSync(store).mode & 0o777, 0o700);
    const files = readdirSync(store).sort();
    assert.deepEqual(files, [...new Set(m.entries.map((e: { sha256: string }) => e.sha256))].sort());
    for (const f of files) {
      assert.match(f, /^[0-9a-f]{64}$/);
      assert.equal(sha(readFileSync(path.join(store, f))), f);
      assert.equal(statSync(path.join(store, f)).mode & 0o777, 0o600);
    }
    const jpeg = m.entries.find((e: { url: string }) => e.url === u("ok.jpg"));
    assert.deepEqual({ sha256: jpeg.sha256, bytes: jpeg.bytes, mime: jpeg.mime }, { sha256: sha(JPEG), bytes: JPEG.length, mime: "image/jpeg" });
    assert.equal(m.entries.find((e: { url: string }) => e.url === u("ok2.png")).sha256, sha(PNG));
    // the manifest digest is printed for the owner; no URL / host is printed
    const printed = out.join("\n");
    assert.match(printed, new RegExp(sha(manifestRaw)));
    assert.ok(!printed.includes(ALLOWED_HOST) && !printed.includes("other.example.invalid"));
    assert.ok(!srv.hits.some((h) => h.includes("other")), "never fetched an off-allow-list host");
    assert.deepEqual(verifySnapshotInput(snap, { expectManifestSha256: sha(manifestRaw), checkImages: true }).snapshotSha256, m.snapshotSha256);
  } finally {
    await srv.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("should refuse import input when snapshot.ndjson sha256 differs from the manifest", async () => {
  const d = tmp();
  const srv = await startImageServer();
  try {
    const snap = await snapshotDir(d);
    const ov = overlay(d, { hostAllowlist: [ALLOWED_HOST], hostRewrite: { [ALLOWED_HOST]: `127.0.0.1:${srv.port}` } });
    await runSnapshot(["--download-images", "--snapshot", snap, "--mapping-overlay", ov, "--rehearsal"], deps(new FakeLegacyClient()));
    const mf = path.join(snap, "manifest.json");
    const good = readFileSync(mf);
    const digest = sha(good);
    assert.doesNotThrow(() => verifySnapshotInput(snap, { expectManifestSha256: digest, checkImages: true }));
    // (1) wrong --expect-sha256
    assert.throws(() => verifySnapshotInput(snap, { expectManifestSha256: "0".repeat(64) }), { message: SNAPSHOT_MESSAGES.manifestDigest });
    assert.throws(() => verifySnapshotInput(snap, { expectManifestSha256: "nothex" }), { message: SNAPSHOT_MESSAGES.manifestDigest });
    // (2) manifest anchors a different snapshot digest (U23)
    const m = JSON.parse(good.toString("utf8"));
    writeFileSync(mf, JSON.stringify({ ...m, snapshotSha256: "f".repeat(64) }));
    assert.throws(() => verifySnapshotInput(snap), { message: SNAPSHOT_MESSAGES.manifestSnapshotMismatch });
    writeFileSync(mf, good);
    // (3) snapshot.ndjson edited after the fact
    const sn = path.join(snap, "snapshot.ndjson");
    const orig = readFileSync(sn);
    writeFileSync(sn, Buffer.concat([orig, Buffer.from("\n")]));
    assert.throws(() => verifySnapshotInput(snap), { message: SNAPSHOT_MESSAGES.snapshotDigest });
    writeFileSync(sn, orig);
    // (4) a store file changed
    const f = path.join(snap, "images", m.entries[0].sha256);
    const keep = readFileSync(f);
    writeFileSync(f, Buffer.concat([keep, Buffer.from([0])]));
    assert.throws(() => verifySnapshotInput(snap, { checkImages: true }), { message: SNAPSHOT_MESSAGES.imageDigest });
    writeFileSync(f, keep);
    // (5) a manifest is required for import input
    rmSync(mf);
    assert.throws(() => verifySnapshotInput(snap, { requireManifest: true }), { message: SNAPSHOT_MESSAGES.noManifest });
    assert.doesNotThrow(() => verifySnapshotInput(snap));
  } finally {
    await srv.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("download refuses a second manifest and a snapshot whose digest does not match its meta", async () => {
  const d = tmp();
  const srv = await startImageServer();
  try {
    const snap = await snapshotDir(d);
    const ov = overlay(d, { hostAllowlist: [ALLOWED_HOST], hostRewrite: { [ALLOWED_HOST]: `127.0.0.1:${srv.port}` } });
    const args = ["--download-images", "--snapshot", snap, "--mapping-overlay", ov, "--rehearsal"];
    const sn = path.join(snap, "snapshot.ndjson");
    const orig = readFileSync(sn);
    writeFileSync(sn, Buffer.concat([orig, Buffer.from(" ")]));
    await assert.rejects(runSnapshot(args, deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.snapshotDigest });
    writeFileSync(sn, orig);
    await runSnapshot(args, deps(new FakeLegacyClient()));
    await assert.rejects(runSnapshot(args, deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.manifestExists });
  } finally {
    await srv.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("flag combinations are refused with fixed messages", async () => {
  const d = tmp();
  try {
    const ov = overlay(d);
    await assert.rejects(runSnapshot(["--out", path.join(d, "x")], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.needOverlay });
    await assert.rejects(runSnapshot(["--mapping-overlay", ov], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.needOut });
    await assert.rejects(runSnapshot(["--mapping-overlay", ov, "--out", path.join(d, "x"), "--snapshot", d], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.snapshotOnlyDownload });
    await assert.rejects(runSnapshot(["--download-images", "--mapping-overlay", ov], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.needSnapshot });
    await assert.rejects(runSnapshot(["--download-images", "--snapshot", d, "--mapping-overlay", ov, "--out", d], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.outOnlyRead });
    await assert.rejects(runSnapshot(["--mapping-overlay", ov, "--out", path.join(d, "x"), "--apply"], deps(new FakeLegacyClient())), /unknown flag --apply/);
    const noAllow = overlay(d, {});
    const snap = await snapshotDir(d);
    await assert.rejects(runSnapshot(["--download-images", "--snapshot", snap, "--mapping-overlay", noAllow], deps(new FakeLegacyClient())), { message: SNAPSHOT_MESSAGES.noAllowlist });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
