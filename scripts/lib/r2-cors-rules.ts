/**
 * The PURE half of `scripts/set-r2-cors.ts`: parse/validate the origin list and build
 * the CORS rule set. No I/O, no env read — the script passes what it read.
 *
 * Main bucket (default): PUT/GET/HEAD for the CMS admin's client uploads (unchanged).
 * Staging bucket (`--staging`, hub docx import phase A): PUT/HEAD only — the hub's
 * browser PUTs to a presigned URL and nothing ever reads staging objects from a
 * browser. `content-type` and `content-length` are the headers the presigned PUT
 * signs (spike A1: X-Amz-SignedHeaders = content-length;content-type;host).
 */
import type { CORSRule } from "@aws-sdk/client-s3";

export const DEFAULT_ORIGINS: readonly string[] = ["http://localhost:3508"];

/** Split a CSV, trim, drop a trailing slash and empty items. Empty ⇒ the default list. */
export function parseOrigins(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_ORIGINS];
}

/** Origins that are not scheme + host[:port] (no path, no trailing slash). */
export function invalidOrigins(origins: readonly string[]): string[] {
  return origins.filter((o) => !/^https?:\/\/[^/]+$/.test(o));
}

export function buildCorsRules(origins: readonly string[], opts: { staging?: boolean } = {}): CORSRule[] {
  if (opts.staging) {
    return [
      {
        AllowedOrigins: [...origins],
        AllowedMethods: ["PUT", "HEAD"],
        AllowedHeaders: ["content-type", "content-length"],
        MaxAgeSeconds: 3600,
      },
    ];
  }
  /**
   * PUT is the upload itself. GET/HEAD keep direct-from-R2 reads working for any
   * browser code that fetches bytes rather than rendering an <img>. ETag is the
   * only response header the AWS SDK's client handler needs back.
   */
  return [
    {
      AllowedOrigins: [...origins],
      AllowedMethods: ["PUT", "GET", "HEAD"],
      AllowedHeaders: ["content-type", "content-length"],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    },
  ];
}
