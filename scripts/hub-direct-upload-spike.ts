/**
 * Spikes A1 / A2 / A4 of the hub direct-upload phase A (content-engine plan
 * process/features/apcg-hub/active/hub-docx-ai-import-pa-cms-media_PLAN_28-10-26.md).
 * DEV-ONLY: never run against production. No database is ever opened.
 *
 *   --a1-offline   Presign a PUT with FAKE credentials (no network) and print what the
 *                  URL signs: X-Amz-SignedHeaders, any x-amz-checksum-* / sdk-checksum
 *                  query key, for requestChecksumCalculation WHEN_SUPPORTED vs WHEN_REQUIRED.
 *   --a1           OWNER-RUN against a THROWAWAY staging bucket. Refuses unless
 *                  R2_STAGING_BUCKET is set AND differs from R2_BUCKET, and R2_ENDPOINT +
 *                  keys are set. PUTs (a) the exact signed size, (b) size + 1,
 *                  (c) a wrong Content-Type, under `_spike-a1/<uuid>`, prints each HTTP
 *                  status, HEADs what landed and DELETES every object it wrote.
 *   --a2           Memory / time of the register pipeline at 12/24/36/50 MP (~20 MiB
 *                  files, JPEG / PNG / WebP). Each run is a FRESH child process (peak RSS
 *                  = `process.resourceUsage().maxRSS`, which includes a sanitized Payload
 *                  config import as the runtime baseline). Pipeline per run: header read →
 *                  re-encode with the PA-7 ladder (q 90/80/70; PNG level 9 → 4096 → 3072
 *                  edge) → Payload's three imageSizes (400 / 800 / 1600 px wide, each a
 *                  fresh decode of the stored bytes, as the upload pipeline does).
 *                  Options: --levels 12,24,36,50 --formats jpeg,png,webp --runs 5 --dir <tmp>
 *   --a4           GIF: a 30-frame animated GIF → `sharp(gif, {animated:false})` → PNG.
 *                  Prints frames read, output size, time, peak RSS; then a 60 MP single
 *                  frame against limitInputPixels.
 *
 *   npx tsx scripts/hub-direct-upload-spike.ts --a1-offline
 *   npx tsx scripts/hub-direct-upload-spike.ts --a2 --runs 5
 *   npx tsx scripts/hub-direct-upload-spike.ts --a4
 *   R2_STAGING_BUCKET=… R2_ENDPOINT=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *     npx tsx scripts/hub-direct-upload-spike.ts --a1          # owner only
 *
 * Output never prints a key, a secret or a full signed URL (query VALUES are masked).
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MiB = 1024 * 1024;
const CAP_BYTES = 20 * MiB;
const SIZES = [400, 800, 1600];
const SELF = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const arg = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

type Fmt = "jpeg" | "png" | "webp";

// ── A1 offline ───────────────────────────────────────────────────────────────

async function signDemo(checksum: "WHEN_SUPPORTED" | "WHEN_REQUIRED"): Promise<string> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client({
    endpoint: "https://example-account.r2.cloudflarestorage.com",
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "fake/secret/for/offline/presign" },
    requestChecksumCalculation: checksum,
  });
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: "staging-example", Key: "gcv/123/uuid", ContentType: "image/jpeg", ContentLength: 12345 }),
    { expiresIn: 300, signableHeaders: new Set(["content-type", "content-length"]) },
  );
}

async function a1Offline(): Promise<void> {
  for (const mode of ["WHEN_SUPPORTED", "WHEN_REQUIRED"] as const) {
    const u = new URL(await signDemo(mode));
    const keys = [...u.searchParams.keys()].sort();
    console.log(`A1-offline ${mode}: path=${u.pathname} query-keys=[${keys.join(",")}]`);
    console.log(`   X-Amz-SignedHeaders=${u.searchParams.get("X-Amz-SignedHeaders")} X-Amz-Expires=${u.searchParams.get("X-Amz-Expires")}`);
    const ck = keys.filter((k) => /checksum/i.test(k));
    console.log(`   checksum query keys: ${ck.length ? ck.join(",") : "none"}`);
  }
}

// ── A1 live (owner) ──────────────────────────────────────────────────────────

async function a1Live(): Promise<void> {
  const staging = process.env.R2_STAGING_BUCKET;
  if (!staging || staging === process.env.R2_BUCKET) {
    console.error("A1 refused: R2_STAGING_BUCKET must be set and differ from R2_BUCKET (throwaway bucket only).");
    process.exit(2);
  }
  if (!process.env.R2_ENDPOINT || !(process.env.R2_STAGING_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID)) {
    console.error("A1 refused: R2_ENDPOINT and an access key are required.");
    process.exit(2);
  }
  const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const written: string[] = [];
  for (const mode of ["WHEN_REQUIRED", "WHEN_SUPPORTED"] as const) {
    const client = new S3Client({
      endpoint: process.env.R2_ENDPOINT,
      region: "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: (process.env.R2_STAGING_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID) as string,
        secretAccessKey: (process.env.R2_STAGING_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY) as string,
      },
      requestChecksumCalculation: mode,
    });
    const body = randomBytes(4096);
    const cases: { name: string; send: Buffer; type: string }[] = [
      { name: "(a) exact size + type", send: body, type: "image/jpeg" },
      { name: "(b) size + 1", send: Buffer.concat([body, Buffer.from([1])]), type: "image/jpeg" },
      { name: "(c) wrong Content-Type", send: body, type: "image/png" },
    ];
    for (const c of cases) {
      const key = `_spike-a1/${randomUUID()}`;
      written.push(key);
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: staging, Key: key, ContentType: "image/jpeg", ContentLength: body.length }),
        { expiresIn: 300, signableHeaders: new Set(["content-type", "content-length"]) },
      );
      let status = 0;
      try {
        const r = await fetch(url, { method: "PUT", body: new Uint8Array(c.send), headers: { "Content-Type": c.type } });
        status = r.status;
        await r.arrayBuffer();
      } catch (err) {
        status = -1;
        console.log(`   fetch error ${(err as Error).name}`);
      }
      let landed = "absent";
      try {
        const h = await client.send(new HeadObjectCommand({ Bucket: staging, Key: key }));
        landed = `present size=${h.ContentLength} type=${h.ContentType}`;
      } catch {
        /* absent */
      }
      console.log(`A1 ${mode} ${c.name}: PUT ${status}; object ${landed}`);
    }
    for (const key of written.splice(0)) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: staging, Key: key }));
      } catch (err) {
        console.log(`   cleanup failed for one object: ${(err as Error).name}`);
      }
    }
  }
  console.log("A1 pass rule: (a) 200 AND (b), (c) refused (403/400). Otherwise rely on HEAD + delete (PA-6 fallback, already built).");
}

// ── A2 fixtures ──────────────────────────────────────────────────────────────

function dims(mp: number): { width: number; height: number } {
  const width = Math.round(Math.sqrt((mp * 1e6 * 3) / 2));
  return { width, height: Math.round((mp * 1e6) / width) };
}

/** Noise in a top band of `frac` of the height, flat grey below (to steer the file size). */
async function encodeAt(width: number, height: number, fmt: Fmt, frac: number, quality: number): Promise<Buffer> {
  const noiseH = Math.max(1, Math.min(height, Math.round(height * frac)));
  const noise = randomBytes(width * noiseH * 3);
  const base = sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).composite([
    { input: noise, raw: { width, height: noiseH, channels: 3 }, top: 0, left: 0 },
  ]);
  const raw = await base.raw().toBuffer();
  const img = sharp(raw, { raw: { width, height, channels: 3 }, limitInputPixels: false });
  if (fmt === "jpeg") return img.jpeg({ quality }).toBuffer();
  if (fmt === "webp") return img.webp({ quality }).toBuffer();
  return img.png({ compressionLevel: 6 }).toBuffer();
}

/** Largest file ≤ 20 MiB found by bisecting the noise fraction (quality 92 / png level 6). */
async function makeFixture(mp: number, fmt: Fmt, dir: string): Promise<{ file: string; bytes: number; width: number; height: number }> {
  const { width, height } = dims(mp);
  let lo = 0.0;
  let hi = 1.0;
  let best: Buffer | null = null;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const b = await encodeAt(width, height, fmt, mid, 92);
    if (b.length <= CAP_BYTES) {
      best = b;
      lo = mid;
    } else hi = mid;
  }
  if (!best) best = await encodeAt(width, height, fmt, 0.001, 92);
  const file = path.join(dir, `a2-${mp}mp.${fmt}`);
  writeFileSync(file, best);
  return { file, bytes: best.length, width, height };
}

// ── A2 child: the pipeline ───────────────────────────────────────────────────

async function a2Child(file: string, fmt: Fmt, maxPixels: number): Promise<void> {
  process.env.DATABASE_URL ??= "postgres://a2-spike@127.0.0.1:1/a2_no_db";
  process.env.PAYLOAD_SECRET ??= "a2-spike-placeholder";
  await import("../payload.config").then((m) => m.default);
  const baselineRss = process.memoryUsage().rss;
  const t0 = performance.now();
  const original = readFileSync(file);
  const meta = await sharp(original, { limitInputPixels: maxPixels }).metadata();
  const steps: string[] = [];
  const enc = async (input: Buffer, q: number | null, edge: number | null): Promise<Buffer> => {
    let img = sharp(input, { limitInputPixels: maxPixels, failOn: "error" }).rotate();
    if (edge) img = img.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    if (fmt === "png") return img.png(q === null ? {} : { compressionLevel: 9 }).toBuffer();
    if (fmt === "webp") return img.webp({ quality: q ?? 90 }).toBuffer();
    return img.jpeg({ quality: q ?? 90 }).toBuffer();
  };
  let out = await enc(original, null, null);
  steps.push(`base:${out.length}`);
  const ladder: { q: number | null; edge: number | null }[] =
    fmt === "png" ? [{ q: 9, edge: null }, { q: 9, edge: 4096 }, { q: 9, edge: 3072 }] : [{ q: 90, edge: null }, { q: 80, edge: null }, { q: 70, edge: null }];
  for (const step of ladder) {
    if (out.length <= CAP_BYTES) break;
    out = await enc(original, step.q, step.edge);
    steps.push(`${step.q ?? ""}/${step.edge ?? ""}:${out.length}`);
  }
  for (const w of SIZES) {
    await sharp(out, { limitInputPixels: maxPixels }).resize({ width: w, withoutEnlargement: true }).toBuffer();
  }
  const ms = Math.round(performance.now() - t0);
  const maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(
    JSON.stringify({ ms, maxRssMB, baselineMB: Math.round(baselineRss / MiB), outBytes: out.length, withinCap: out.length <= CAP_BYTES, steps, w: meta.width, h: meta.height }),
  );
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

async function a2(): Promise<void> {
  const levels = (arg("--levels") ?? "12,24,36,50").split(",").map(Number);
  const formats = (arg("--formats") ?? "jpeg,png,webp").split(",") as Fmt[];
  const runs = Number(arg("--runs") ?? "5");
  const dir = arg("--dir") ?? mkdtempSync(path.join(tmpdir(), "hub-a2-"));
  console.log(`A2 sharp ${sharp.versions.sharp} vips ${sharp.versions.vips} node ${process.version} concurrency=${sharp.concurrency()} dir=${dir}`);
  for (const mp of levels) {
    for (const fmt of formats) {
      const fx = await makeFixture(mp, fmt, dir);
      const res: { ms: number; maxRssMB: number; baselineMB: number; outBytes: number; withinCap: boolean; steps: string[] }[] = [];
      for (let i = 0; i < runs; i++) {
        const r = spawnSync(process.execPath, ["--import", "tsx", SELF, "--a2-child", fx.file, fmt, String(Math.ceil(mp * 1e6) + 1_000_000)], {
          encoding: "utf8",
          maxBuffer: 1 << 20,
        });
        const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
        try {
          res.push(JSON.parse(line));
        } catch {
          console.log(`  child failed: status=${r.status} ${String(r.stderr ?? "").split("\n").slice(-3).join(" | ")}`);
        }
      }
      if (!res.length) continue;
      const ms = res.map((r) => r.ms);
      const rss = res.map((r) => r.maxRssMB);
      console.log(
        `A2 ${mp}MP ${fmt} ${fx.width}x${fx.height} file=${(fx.bytes / MiB).toFixed(2)}MiB runs=${res.length} ` +
          `ms p50=${pct(ms, 50)} p95=${pct(ms, 95)} max=${Math.max(...ms)} | peakRSS MB p50=${pct(rss, 50)} max=${Math.max(...rss)} ` +
          `baseline=${res[0]!.baselineMB} | out=${(res[0]!.outBytes / MiB).toFixed(2)}MiB withinCap=${res.every((r) => r.withinCap)} steps=${res[0]!.steps.join(">")}`,
      );
    }
  }
  if (!arg("--dir")) rmSync(dir, { recursive: true, force: true });
}

// ── A4 GIF ───────────────────────────────────────────────────────────────────

async function a4(): Promise<void> {
  const { width, height } = { width: 1200, height: 800 };
  const frames = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      sharp({ create: { width, height, channels: 3, background: { r: (i * 8) % 255, g: 60, b: 200 - i } } })
        .composite([{ input: randomBytes(200 * 200 * 3), raw: { width: 200, height: 200, channels: 3 }, top: (i * 20) % 600, left: (i * 30) % 1000 }])
        .png()
        .toBuffer(),
    ),
  );
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const meta = await sharp(gif).metadata();
  const t0 = performance.now();
  const r0 = process.memoryUsage().rss;
  const { data, info } = await sharp(gif, { animated: false, limitInputPixels: 12_000_000, failOn: "error" }).png().toBuffer({ resolveWithObject: true });
  const ms = Math.round(performance.now() - t0);
  const outMeta = await sharp(data).metadata();
  console.log(
    `A4 30-frame GIF ${width}x${height} pages=${meta.pages} file=${(gif.length / 1024).toFixed(0)}KiB → PNG ${info.width}x${info.height} pages=${outMeta.pages ?? 1} ` +
      `${(data.length / 1024).toFixed(0)}KiB in ${ms} ms, rss +${Math.round((process.memoryUsage().rss - r0) / MiB)} MB, maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`,
  );
  // limitInputPixels on a GIF: one 8000x7500 frame (60 MP) against a 50 MP cap.
  const bigFrame = await sharp({ create: { width: 8000, height: 7500, channels: 3, background: "#123456" } }).png().toBuffer();
  const bigGif = await sharp(bigFrame, { limitInputPixels: false }).gif().toBuffer();
  try {
    await sharp(bigGif, { animated: false, limitInputPixels: 50_000_000 }).png().toBuffer();
    console.log("A4 limitInputPixels: NOT enforced on a 60 MP GIF (FAIL)");
  } catch (err) {
    console.log(`A4 limitInputPixels: enforced on a 60 MP GIF (${/pixel limit/i.test((err as Error).message) ? "pixel limit error" : (err as Error).name})`);
  }
  // A tall animated GIF: does the cap apply to ONE frame or to all frames stacked?
  const tallFrames = await Promise.all(Array.from({ length: 30 }, () => sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#808080" } }).png().toBuffer()));
  const tallGif = await sharp(tallFrames, { join: { animated: true } }).gif().toBuffer();
  try {
    const one = await sharp(tallGif, { animated: false, limitInputPixels: 12_000_000 }).png().toBuffer({ resolveWithObject: true });
    console.log(`A4 30 x 3 MP frames, cap 12 MP, animated:false ⇒ accepted, ${one.info.width}x${one.info.height} (cap applies to the first frame only)`);
  } catch (err) {
    console.log(`A4 30 x 3 MP frames, cap 12 MP, animated:false ⇒ refused (${(err as Error).name})`);
  }
}

async function main(): Promise<void> {
  if (has("--a2-child")) {
    const i = argv.indexOf("--a2-child");
    return a2Child(argv[i + 1]!, argv[i + 2] as Fmt, Number(argv[i + 3]));
  }
  if (has("--a1-offline")) return a1Offline();
  if (has("--a1")) return a1Live();
  if (has("--a2")) return a2();
  if (has("--a4")) return a4();
  console.log("usage: --a1-offline | --a1 (owner, staging bucket) | --a2 [--levels] [--formats] [--runs] | --a4");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`spike crashed: ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
    process.exit(1);
  },
);
