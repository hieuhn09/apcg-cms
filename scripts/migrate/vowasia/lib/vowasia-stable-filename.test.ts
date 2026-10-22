import { test } from "node:test";
import assert from "node:assert/strict";
import { vowasiaStableFilename, vowasiaStoredFilenameMatches } from "./vowasia-stable-filename";

test("vowasiaStableFilename is deterministic, prefixed vowasia- and never gtp-", () => {
  const u = "https://img.example.invalid/storage/v1/object/public/media/Hello%20World.PNG";
  const a = vowasiaStableFilename(u);
  assert.equal(a, vowasiaStableFilename(u));
  assert.match(a, /^vowasia-[0-9a-f]{8}-hello-world\.png$/);
  assert.ok(!a.startsWith("gtp-"));
  assert.notEqual(vowasiaStableFilename(`${u}?v=2`), a, "different URL -> different hash");
});

test("vowasiaStableFilename defaults the extension, guards a trailing digit and unparseable URLs", () => {
  assert.match(vowasiaStableFilename("https://img.example.invalid/a/photo123"), /^vowasia-[0-9a-f]{8}-photo123-img\.jpg$/);
  assert.match(vowasiaStableFilename("not a url"), /^vowasia-[0-9a-f]{8}-image\.jpg$/);
  assert.match(vowasiaStableFilename("https://img.example.invalid/"), /^vowasia-[0-9a-f]{8}-image\.jpg$/);
});

test("vowasiaStoredFilenameMatches accepts Payload's -<n> rename only", () => {
  const s = vowasiaStableFilename("https://img.example.invalid/x/cake.webp");
  assert.ok(vowasiaStoredFilenameMatches(s, s));
  assert.ok(vowasiaStoredFilenameMatches(s.replace(/\.webp$/, "-3.webp"), s));
  assert.ok(!vowasiaStoredFilenameMatches(s.replace(/^vowasia-/, "gtp-"), s));
  assert.ok(!vowasiaStoredFilenameMatches(s.replace(/\.webp$/, ".jpg"), s));
  assert.ok(!vowasiaStoredFilenameMatches(`x${s}`, s));
});
