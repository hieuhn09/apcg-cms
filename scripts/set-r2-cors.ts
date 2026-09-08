/**
 * Apply the bucket CORS rules that browser-side media uploads need.
 *
 * With `clientUploads` on (payload.config.ts), the admin PUTs the file straight
 * to R2 from the editor's browser. R2 rejects that cross-origin PUT unless the
 * bucket allows the admin's origin — without this the editor sees a generic
 * "There was a problem while uploading the file" and nothing reaches storage.
 *
 * Idempotent: PutBucketCors replaces the whole rule set, so re-running with a
 * new origin list is the way to add or drop an origin.
 *
 *   R2_CORS_ORIGINS='https://apcg-cms.vercel.app,http://localhost:3508' npm run r2:cors
 *   npm run r2:cors -- --dry-run
 *
 * Origins must be scheme+host[+port] with no trailing slash and no path. The
 * R2_* credentials are read from the usual local env files via ./lib/env.
 */
import "./lib/env";
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
  type CORSRule,
} from "@aws-sdk/client-s3";

const DEFAULT_ORIGINS = ["http://localhost:3508"];

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (set it in the environment first).`);
  return value;
};

const origins = (process.env["R2_CORS_ORIGINS"] ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const allowedOrigins = origins.length ? origins : DEFAULT_ORIGINS;
const dryRun = process.argv.includes("--dry-run");

const bad = allowedOrigins.filter((o) => !/^https?:\/\/[^/]+$/.test(o));
if (bad.length) {
  throw new Error(`Not valid origins (scheme + host only, no path/slash): ${bad.join(", ")}`);
}

/**
 * PUT is the upload itself. GET/HEAD keep direct-from-R2 reads working for any
 * browser code that fetches bytes rather than rendering an <img>. ETag is the
 * only response header the AWS SDK's client handler needs back.
 */
const rules: CORSRule[] = [
  {
    AllowedOrigins: allowedOrigins,
    AllowedMethods: ["PUT", "GET", "HEAD"],
    AllowedHeaders: ["content-type", "content-length"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  },
];

const bucket = required("R2_BUCKET");
const client = new S3Client({
  endpoint: required("R2_ENDPOINT"),
  region: "auto",
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
  forcePathStyle: true,
});

const run = async (): Promise<void> => {
  console.log(`bucket:  ${bucket}`);
  console.log(`origins: ${allowedOrigins.join(", ")}`);

  // "No rules" and "not allowed to look" must never print the same thing: the
  // R2 key normally used here has Object Read/Write only, so bucket-level calls
  // come back AccessDenied — and reading that as "no CORS configured" would send
  // you off to fix a bucket that is already correct.
  try {
    const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    console.log(`current: ${JSON.stringify(current.CORSRules ?? [])}`);
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "NoSuchCORSConfiguration") {
      console.log("current: (none set — bucket really has no CORS policy)");
    } else {
      console.log(
        `current: UNKNOWN — could not read it (${name || (err as Error).message}).\n` +
          "         This key likely lacks bucket-level permission (needs an R2 API\n" +
          "         token with Admin Read & Write). Check the policy in the Cloudflare\n" +
          "         dashboard instead; do NOT assume the bucket has no CORS.",
      );
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  await client.send(
    new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }),
  );
  const applied = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log(`\napplied: ${JSON.stringify(applied.CORSRules ?? [])}`);
};

run().catch((err: unknown) => {
  console.error(`Failed to set CORS: ${(err as Error).message}`);
  process.exit(1);
});
