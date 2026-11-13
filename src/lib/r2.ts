/**
 * Direct R2 (S3) access for the few server-side object operations Payload's
 * storage plugin does not cover — relocating a client-uploaded original into its
 * tenant prefix (see hooks/relocate-stranded-upload), and the hub direct-upload
 * staging area (bottom of this file).
 *
 * Env-gated exactly like the s3Storage plugin in payload.config: when the R2_*
 * vars are absent (local disk dev), `r2` is null and callers must no-op.
 */
import {
  S3Client,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const configured = Boolean(
  process.env.R2_BUCKET &&
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY,
);

let client: S3Client | null = null;

export const r2 = configured
  ? {
      bucket: process.env.R2_BUCKET as string,
      get client(): S3Client {
        client ??= new S3Client({
          endpoint: process.env.R2_ENDPOINT,
          region: "auto",
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
          },
          forcePathStyle: true,
        });
        return client;
      },
    }
  : null;

export async function r2ObjectExists(key: string): Promise<boolean> {
  if (!r2) return false;
  try {
    await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * CopySource is a URL path, so the key must be percent-encoded — but per
 * SEGMENT: encoding the whole key would turn the "/" of a tenant prefix into
 * %2F, which is not reliably decoded back into a path separator.
 */
const encodeCopySourceKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

/** Server-side copy then delete (R2 has no atomic rename). */
export async function r2MoveObject(fromKey: string, toKey: string): Promise<void> {
  if (!r2) return;
  await r2.client.send(
    new CopyObjectCommand({
      Bucket: r2.bucket,
      Key: toKey,
      CopySource: `/${r2.bucket}/${encodeCopySourceKey(fromKey)}`,
    }),
  );
  await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: fromKey }));
}

// ── Hub direct-upload staging (hub docx import phase A, PA-3 / PA-6) ─────────
//
// A SEPARATE client from the one above: it may use the staging key pair, and it is
// built with `requestChecksumCalculation: "WHEN_REQUIRED"` — with the SDK default
// (WHEN_SUPPORTED) a presigned PutObject URL carries `x-amz-checksum-crc32` of an
// EMPTY body in its query (measured offline, spike A1), which a real upload cannot
// match. The main client above is untouched. Nothing here logs a key, a URL or bytes.

/**
 * Where staging objects live (built by `stagingConfig` in hub-direct-upload-pure.ts;
 * declared structurally here so this module, which the Media collection imports,
 * never imports hub code).
 */
export interface StagingConfig {
  bucket: string;
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StagingHead {
  size: number;
  contentType: string | null;
}

export type StagingBytes = { ok: true; bytes: Buffer } | { ok: false; reason: "missing" | "too_large" };

/** What the direct-upload routes need from staging storage (a fake stands in for unit checks). */
export interface StagingStore {
  readonly bucket: string;
  readonly prefix: string;
  presignPut(key: string, mime: string, size: number, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<StagingHead | null>;
  getBytes(key: string, maxBytes: number): Promise<StagingBytes>;
  delete(key: string): Promise<void>;
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

let stagingClient: { sig: string; client: S3Client } | null = null;

function clientFor(c: StagingConfig): S3Client {
  const sig = `${c.endpoint}\u0000${c.accessKeyId}`;
  if (stagingClient?.sig !== sig) {
    stagingClient = {
      sig,
      client: new S3Client({
        endpoint: c.endpoint,
        region: "auto",
        credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    };
  }
  return stagingClient.client;
}

/**
 * Presigned PUT: `Content-Type` AND `Content-Length` are SIGNED headers
 * (`signableHeaders`; the presigner otherwise leaves content-type unsigned). Whether
 * R2 actually refuses a PUT whose length / type differ is spike A1 (owner-run); the
 * routes never rely on it: `register` HEADs, reads with a hard cap and re-checks.
 */
export async function r2PresignPut(c: StagingConfig, key: string, mime: string, size: number, ttlSeconds: number): Promise<string> {
  return getSignedUrl(clientFor(c), new PutObjectCommand({ Bucket: c.bucket, Key: key, ContentType: mime, ContentLength: size }), {
    expiresIn: ttlSeconds,
    signableHeaders: new Set(["content-type", "content-length"]),
  });
}

/** HEAD a staging object: null when absent; any other failure throws. */
export async function r2HeadStaging(c: StagingConfig, key: string): Promise<StagingHead | null> {
  try {
    const h = await clientFor(c).send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
    return { size: typeof h.ContentLength === "number" ? h.ContentLength : -1, contentType: h.ContentType ?? null };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read a staging object into memory, STOPPING as soon as more than `maxBytes` arrived
 * (the stream is destroyed; at most one chunk past the cap is ever held).
 */
export async function r2GetStagingBytes(c: StagingConfig, key: string, maxBytes: number): Promise<StagingBytes> {
  let body: unknown;
  try {
    body = (await clientFor(c).send(new GetObjectCommand({ Bucket: c.bucket, Key: key }))).Body;
  } catch (err) {
    if (isNotFound(err)) return { ok: false, reason: "missing" };
    throw err;
  }
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") return { ok: false, reason: "missing" };
  return readStreamCapped(body as AsyncIterable<Uint8Array> & { destroy?: () => void }, maxBytes);
}

/**
 * Collect an async byte stream, giving up as soon as MORE than `maxBytes` arrived
 * (then `destroy()` is called when the stream has one). Pure apart from the stream.
 */
export async function readStreamCapped(
  body: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: "too_large" }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

export async function r2DeleteStaging(c: StagingConfig, key: string): Promise<void> {
  await clientFor(c).send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
}

/** The staging store for a config from `stagingConfig(env)` (PA-3); null in ⇒ null out (⇒ 503). */
export function r2Staging(c: StagingConfig | null): StagingStore | null {
  if (!c) return null;
  return {
    bucket: c.bucket,
    prefix: c.prefix,
    presignPut: (key, mime, size, ttl) => r2PresignPut(c, key, mime, size, ttl),
    head: (key) => r2HeadStaging(c, key),
    getBytes: (key, max) => r2GetStagingBytes(c, key, max),
    delete: (key) => r2DeleteStaging(c, key),
  };
}
