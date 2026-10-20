/**
 * Writes a VALID VowAsia snapshot directory (snapshot.ndjson, snapshot-meta.json,
 * manifest.json, images/<sha256>) for the phase-B unit tests, without any
 * database or network: the same formats `migrate:vowasia:snapshot` writes.
 * Image bytes are tiny synthetic buffers with a correct magic header.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FORMAT, SNAPSHOT_FORMAT, type ImageManifest, type SnapshotMeta } from "../../lib/snapshot-vowasia-main";
import { FIX_COLUMNS, FIX_ROLES, FIX_SITE_ID, fixtureImageUrls, fixtureRows } from "./fixture-rows";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

export function imageBytes(url: string): { bytes: Buffer; mime: string } {
  const png = /\.png$/i.test(url);
  // shared.jpg must yield the same bytes from any row; every other URL gets unique bytes
  return { bytes: Buffer.concat([png ? PNG_HEAD : JPEG_HEAD, Buffer.from(`fixture:${url}`)]), mime: png ? "image/png" : "image/jpeg" };
}

export interface SnapshotFixtureOptions {
  rows?: Record<string, unknown>[];
  /** URLs recorded as download failures in the manifest (store-level failure). */
  failUrls?: string[];
  /** URLs whose stored file is replaced by other bytes after the manifest is written (sha mismatch). */
  corruptUrls?: string[];
  /** URLs whose stored file is deleted (file missing). */
  missingUrls?: string[];
}

export interface SnapshotFixture {
  dir: string;
  rows: Record<string, unknown>[];
  manifestSha256: string;
  snapshotSha256: string;
  imageUrls: string[];
}

export function writeSnapshotFixture(dir: string, o: SnapshotFixtureOptions = {}): SnapshotFixture {
  const rows = o.rows ?? fixtureRows({ bulk: 20 });
  mkdirSync(path.join(dir, "images"), { recursive: true, mode: 0o700 });
  const lines = [JSON.stringify({ t: "site", row: { id: FIX_SITE_ID, slug: "vowasia", name: "VowAsia" } })];
  for (const r of rows) lines.push(JSON.stringify({ t: "article", row: Object.fromEntries(FIX_COLUMNS.map((c) => [c, r[c] ?? null])) }));
  const body = lines.join("\n") + "\n";
  writeFileSync(path.join(dir, "snapshot.ndjson"), body, { mode: 0o600 });
  const snapshotSha256 = sha(body);
  const meta: SnapshotMeta = {
    format: SNAPSHOT_FORMAT, takenAt: "2026-10-20T00:00:00.000Z", snapshotSha256, counts: { articles: rows.length, sites: 1 },
    rowCounts: { before: rows.length, after: rows.length }, columnRoles: { ...FIX_ROLES }, articleColumns: FIX_COLUMNS,
  };
  writeFileSync(path.join(dir, "snapshot-meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  const imageUrls = fixtureImageUrls(rows);
  const fail = new Set(o.failUrls ?? []);
  const entries: ImageManifest["entries"] = [];
  const failures: ImageManifest["failures"] = [];
  for (const u of imageUrls) {
    if (fail.has(u)) {
      failures.push({ url: u, reason: "http 404" });
      continue;
    }
    const { bytes, mime } = imageBytes(u);
    const h = sha(bytes);
    writeFileSync(path.join(dir, "images", h), bytes, { mode: 0o600 });
    entries.push({ url: u, sha256: h, bytes: bytes.length, mime });
  }
  const manifest: ImageManifest = { format: MANIFEST_FORMAT, createdAt: "2026-10-20T00:00:00.000Z", snapshotSha256, entries, failures, offAllowlistImageUrls: 0, relativeImageRefs: 0, protocolRelativeImageRefs: 0 };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(path.join(dir, "manifest.json"), text, { mode: 0o600 });
  for (const u of o.corruptUrls ?? []) {
    const e = entries.find((x) => x.url === u);
    if (e) {
      // same length, one byte changed: only the sha256 check can catch it
      const b = Buffer.from(imageBytes(u).bytes);
      b[b.length - 1] = (b[b.length - 1] as number) ^ 0xff;
      writeFileSync(path.join(dir, "images", e.sha256), b);
    }
  }
  for (const u of o.missingUrls ?? []) {
    const e = entries.find((x) => x.url === u);
    if (e) writeFileSync(path.join(dir, "images", e.sha256), "");
  }
  return { dir, rows, manifestSha256: sha(text), snapshotSha256, imageUrls };
}
