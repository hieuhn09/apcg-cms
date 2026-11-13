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
 * `--staging` (hub docx import phase A): target the PRIVATE staging bucket
 * `R2_STAGING_BUCKET` instead (missing ⇒ error), PUT/HEAD only; keys
 * `R2_STAGING_ACCESS_KEY_ID` / `R2_STAGING_SECRET_ACCESS_KEY` when set, else the main
 * pair. Here R2_CORS_ORIGINS lists the HUB origins (the hub's browser does the PUT):
 *
 *   R2_CORS_ORIGINS='https://<hub-production>,https://<hub-preview-alias>' npm run r2:cors -- --staging --dry-run
 *
 * `--dry-run` prints the rules it WOULD write and the current rules (when the
 * credentials are present and allowed to read them); it never writes.
 *
 * Origins must be scheme+host[+port] with no trailing slash and no path. The
 * R2_* credentials are read from the usual local env files via ./lib/env.
 */
import "./lib/env";
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildCorsRules, invalidOrigins, parseOrigins } from "./lib/r2-cors-rules";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (set it in the environment first).`);
  return value;
};

const staging = process.argv.includes("--staging");
const dryRun = process.argv.includes("--dry-run");
const allowedOrigins = parseOrigins(process.env["R2_CORS_ORIGINS"]);

const bad = invalidOrigins(allowedOrigins);
if (bad.length) {
  throw new Error(`Not valid origins (scheme + host only, no path/slash): ${bad.join(", ")}`);
}

const rules = buildCorsRules(allowedOrigins, { staging });

const bucket = staging ? required("R2_STAGING_BUCKET") : required("R2_BUCKET");
if (staging && bucket === process.env["R2_BUCKET"]) {
  throw new Error("--staging: R2_STAGING_BUCKET must be a separate bucket, not R2_BUCKET.");
}
const keyId = staging ? (process.env["R2_STAGING_ACCESS_KEY_ID"] ?? process.env["R2_ACCESS_KEY_ID"]) : process.env["R2_ACCESS_KEY_ID"];
const keySecret = staging
  ? (process.env["R2_STAGING_SECRET_ACCESS_KEY"] ?? process.env["R2_SECRET_ACCESS_KEY"])
  : process.env["R2_SECRET_ACCESS_KEY"];
const endpoint = process.env["R2_ENDPOINT"];
const haveCredentials = Boolean(endpoint && keyId && keySecret);
if (!dryRun && !haveCredentials) {
  // Writing needs all three; a dry run can still print the rules without them.
  required("R2_ENDPOINT");
  throw new Error(`${staging ? "R2_STAGING_ACCESS_KEY_ID / R2_STAGING_SECRET_ACCESS_KEY or " : ""}R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are required.`);
}
const client = haveCredentials
  ? new S3Client({
      endpoint,
      region: "auto",
      credentials: { accessKeyId: keyId as string, secretAccessKey: keySecret as string },
      forcePathStyle: true,
    })
  : null;

const run = async (): Promise<void> => {
  console.log(`target:  ${staging ? "STAGING bucket (--staging)" : "main bucket"}`);
  console.log(`bucket:  ${bucket}`);
  console.log(`origins: ${allowedOrigins.join(", ")}`);
  console.log(`rules:   ${JSON.stringify(rules)}`);

  if (!client) {
    console.log("current: (not read — no R2 credentials in this environment)");
    console.log("\n--dry-run: nothing written.");
    return;
  }

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
