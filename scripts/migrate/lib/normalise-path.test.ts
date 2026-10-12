import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalise, normaliseKey } from "./normalise-path";

const GOLDEN_SHA256 = "e5b2247c46445568021bdc50050f19ea2ac832e4dc5997b596c374a2ed809a5e";
const goldenFile = path.join(path.dirname(new URL(import.meta.url).pathname), "golden-normalise.json");

test("C6/G44: the committed golden file has the pinned sha256 and 22 pairs", () => {
  const text = readFileSync(goldenFile, "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), GOLDEN_SHA256);
  assert.equal((JSON.parse(text) as unknown[]).length, 22);
});

test("C6/G44: should map every golden input to the same key as gtp-web normalise()", () => {
  for (const [input, expected] of JSON.parse(readFileSync(goldenFile, "utf8")) as [string, string][]) {
    assert.equal(normaliseKey(input), expected, JSON.stringify(input));
  }
});

test("C6/C12/G44: decoded ? and # end the key; 8 nested %25 layers are FLAGGED, 7 converge", () => {
  for (const x of ["/a%3Fb", "/a%23b", "/a%253Fb", "/a%2523b"]) assert.equal(normaliseKey(x), "/a", x);
  assert.deepEqual(normalise(`/a%${"25".repeat(8)}2Fb`), { ok: false, flag: "normaliseUnconverged" });
  assert.equal(normalise(`/a%${"25".repeat(7)}2Fb`).ok, true);
  assert.equal(normaliseKey("/İstanbul"), "/i̇stanbul");
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("C12/G44: property normalise(normalise(x)) == normalise(x) over a generated corpus incl. %3F %23 %253F U+0130", () => {
  const alphabet = ["/", "//", "a", "B", "%3F", "%23", "%253F", "%2523", "%2F", "%25", "İ", ".html", ".php", "/amp", "/index.html", "?", "#", "x", "%E2%80%93", "%zz"];
  const r = rng(42);
  const corpus = ["/a%3Fb", "/a%23b", "/a%253Fb", "/a%2523b", "/İ", `/a%${"25".repeat(5)}2Fb`];
  for (let i = 0; i < 20_000; i++) {
    let s = "";
    const n = 1 + Math.floor(r() * 8);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)];
    corpus.push(s);
  }
  let unconverged = 0;
  for (const x of corpus) {
    const k = normalise(x);
    if (!k.ok) {
      unconverged++;
      continue;
    }
    assert.equal(normaliseKey(k.key), k.key, JSON.stringify(x));
    assert.doesNotMatch(k.key, /[?#]/);
  }
  assert.equal(unconverged, 0);
});
