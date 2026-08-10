/**
 * Direct R2 (S3) access for the few server-side object operations Payload's
 * storage plugin does not cover — currently only relocating a client-uploaded
 * original into its tenant prefix (see hooks/relocate-stranded-upload).
 *
 * Env-gated exactly like the s3Storage plugin in payload.config: when the R2_*
 * vars are absent (local disk dev), `r2` is null and callers must no-op.
 */
import { S3Client, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

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

/** Server-side copy then delete (R2 has no atomic rename). */
export async function r2MoveObject(fromKey: string, toKey: string): Promise<void> {
  if (!r2) return;
  await r2.client.send(
    new CopyObjectCommand({
      Bucket: r2.bucket,
      Key: toKey,
      CopySource: `/${r2.bucket}/${encodeURIComponent(fromKey)}`,
    }),
  );
  await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: fromKey }));
}
