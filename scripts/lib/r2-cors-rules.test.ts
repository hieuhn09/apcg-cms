/**
 * Unit tests for ./r2-cors-rules (the pure half of `npm run r2:cors`; hub docx import
 * phase A, step 12 / AC10). No network, no credentials.
 *
 *   npm run test:hub-direct-upload
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ORIGINS, buildCorsRules, invalidOrigins, parseOrigins } from "./r2-cors-rules";

describe("parseOrigins / invalidOrigins", () => {
  it("CSV trimmed, trailing slash dropped, empty ⇒ default", () => {
    assert.deepEqual(parseOrigins(" https://a.example/ , http://localhost:3508,, "), ["https://a.example", "http://localhost:3508"]);
    assert.deepEqual(parseOrigins(undefined), [...DEFAULT_ORIGINS]);
    assert.deepEqual(parseOrigins(" , "), [...DEFAULT_ORIGINS]);
  });
  it("origins must be scheme + host[:port] only", () => {
    assert.deepEqual(invalidOrigins(["https://a.example", "http://localhost:3508", "https://*.vercel.app"]), []);
    assert.deepEqual(invalidOrigins(["a.example", "https://a.example/path", "ftp://x"]), ["a.example", "https://a.example/path", "ftp://x"]);
  });
});

describe("buildCorsRules", () => {
  it("main bucket: unchanged rule (PUT/GET/HEAD, content-type + content-length, ETag, 3600)", () => {
    assert.deepEqual(buildCorsRules(["https://cms.example"]), [
      {
        AllowedOrigins: ["https://cms.example"],
        AllowedMethods: ["PUT", "GET", "HEAD"],
        AllowedHeaders: ["content-type", "content-length"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      },
    ]);
  });
  it("staging: PUT/HEAD only, the two signed headers, 3600, no GET, no exposed headers", () => {
    assert.deepEqual(buildCorsRules(["https://hub.example", "https://hub-git-x.vercel.app"], { staging: true }), [
      {
        AllowedOrigins: ["https://hub.example", "https://hub-git-x.vercel.app"],
        AllowedMethods: ["PUT", "HEAD"],
        AllowedHeaders: ["content-type", "content-length"],
        MaxAgeSeconds: 3600,
      },
    ]);
  });
});
