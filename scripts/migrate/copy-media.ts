/**
 * Copy media objects from a source R2/S3 bucket into the central bucket under a
 * per-tenant key prefix (`<tenant>/...`), including derivatives. This is the
 * server-side bulk alternative to import-central's re-upload-from-URL; use it
 * when you want to preserve exact keys + sharp derivatives without re-deriving.
 *
 *   SRC_R2_ENDPOINT/SRC_R2_BUCKET/SRC_R2_ACCESS_KEY_ID/SRC_R2_SECRET_ACCESS_KEY
 *   R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY (central, dest)
 *   COPY_TENANT=brief-asia
 *   npm run migrate:media -- [--dry-run]
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from "@aws-sdk/client-s3";

const TENANT = requireEnv("COPY_TENANT");
const srcBucket = requireEnv("SRC_R2_BUCKET");
const destBucket = requireEnv("R2_BUCKET");

const src = new S3Client({
  endpoint: requireEnv("SRC_R2_ENDPOINT"),
  region: "auto",
  forcePathStyle: true,
  credentials: { accessKeyId: requireEnv("SRC_R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("SRC_R2_SECRET_ACCESS_KEY") },
});
const dest = new S3Client({
  endpoint: requireEnv("R2_ENDPOINT"),
  region: "auto",
  forcePathStyle: true,
  credentials: { accessKeyId: requireEnv("R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY") },
});

async function main() {
  let token: string | undefined;
  let copied = 0;
  for (;;) {
    const list = await src.send(new ListObjectsV2Command({ Bucket: srcBucket, ContinuationToken: token }));
    for (const obj of list.Contents ?? []) {
      const key = obj.Key;
      if (!key) continue;
      const destKey = `${TENANT}/${key}`;
      if (DRY_RUN) {
        console.log(`[copy-media] would copy ${srcBucket}/${key} → ${destBucket}/${destKey}`);
        copied += 1;
        continue;
      }
      await dest.send(new CopyObjectCommand({ Bucket: destBucket, Key: destKey, CopySource: `/${srcBucket}/${encodeURIComponent(key)}` }));
      copied += 1;
      if (copied % 100 === 0) console.log(`[copy-media] ${copied} objects…`);
    }
    if (!list.IsTruncated) break;
    token = list.NextContinuationToken;
  }
  console.log(`[copy-media] done — ${copied} objects ${DRY_RUN ? "(dry-run)" : "copied"} under ${destBucket}/${TENANT}/`);
}

main().catch((err) => {
  console.error("[copy-media] failed", err);
  process.exit(1);
});
