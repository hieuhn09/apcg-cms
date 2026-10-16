import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRewrittenLinks } from "./verify-parity-links";

const U = "https://globaltravelpost.com/article/fixture-summit-story-50";
const MAP = new Map([["/article/fixture-summit-story-50", "/article/fixture-summit-story-50"]]);

test("parity links: old and new paths coincide and Central still holds the absolute URL -> source text is not shortened", () => {
  const src = `Read more at ${U} today.`;
  assert.equal(applyRewrittenLinks(src, `Read more at ${U} today.`, [U], MAP), src);
  // A link Central did rewrite is still mapped.
  assert.equal(applyRewrittenLinks(src, "Read more at /article/fixture-summit-story-50 today.", [U], MAP), "Read more at /article/fixture-summit-story-50 today.");
});
