/**
 * Unit tests for ./intake-hero-caption (Node's built-in runner; no test framework).
 *
 *   npm run test:intake-caption   # = tsx --test src/lib/intake-hero-caption.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHeroMediaData, parseImageCaption, parseIntakeHeroFocal, IMAGE_CAPTION_MAX } from "./intake-hero-caption";

describe("parseImageCaption", () => {
  it("keeps a plain caption as is", () => {
    assert.equal(parseImageCaption("Illustrative image"), "Illustrative image");
  });
  it("trims and collapses whitespace and newlines", () => {
    assert.equal(parseImageCaption("  a\n b  "), "a b");
    assert.equal(parseImageCaption("x\t\r\n\n  y"), "x y");
  });
  it("returns null for empty or whitespace-only strings", () => {
    assert.equal(parseImageCaption(""), null);
    assert.equal(parseImageCaption("   "), null);
    assert.equal(parseImageCaption("\n\t"), null);
  });
  it("returns null for non-strings", () => {
    for (const v of [42, null, undefined, {}, [], true, { caption: "x" }]) {
      assert.equal(parseImageCaption(v), null);
    }
  });
  it("caps at 200 characters", () => {
    assert.equal(IMAGE_CAPTION_MAX, 200);
    const out = parseImageCaption("a".repeat(500));
    assert.equal(out?.length, 200);
    assert.equal(out, "a".repeat(200));
  });
  it("caps after collapsing, with no trailing space", () => {
    const out = parseImageCaption(`${"b".repeat(199)}     c`);
    assert.equal(out, "b".repeat(199));
  });
});

describe("buildHeroMediaData", () => {
  it("is byte-identical to the old shape when caption is null", () => {
    const data = buildHeroMediaData({ title: "T", credit: "C", caption: null });
    assert.deepEqual(data, { alt: "T", credit: "C" });
    assert.equal(Object.prototype.hasOwnProperty.call(data, "caption"), false);
    assert.deepEqual(Object.keys(data), ["alt", "credit"]);
  });
  it("credit null maps to undefined, as before", () => {
    const data = buildHeroMediaData({ title: "T", credit: null, caption: null });
    assert.deepEqual(data, { alt: "T", credit: undefined });
    assert.equal("caption" in data, false);
  });
  it("includes caption when set", () => {
    assert.deepEqual(buildHeroMediaData({ title: "T", credit: "C", caption: "Illustrative image" }), {
      alt: "T",
      credit: "C",
      caption: "Illustrative image",
    });
  });
});

describe("parseIntakeHeroFocal (engine heroFocal, create-only, never rejects)", () => {
  it("accepts integer x/y in 0..100", () => {
    assert.deepEqual(parseIntakeHeroFocal({ x: 50, y: 25 }), { x: 50, y: 25 });
    assert.deepEqual(parseIntakeHeroFocal({ x: 0, y: 100 }), { x: 0, y: 100 });
  });
  it("ignores absent, null, and the centre 50/50", () => {
    assert.equal(parseIntakeHeroFocal(undefined), null);
    assert.equal(parseIntakeHeroFocal(null), null);
    assert.equal(parseIntakeHeroFocal({ x: 50, y: 50 }), null);
  });
  it("ignores invalid values instead of throwing", () => {
    for (const v of [{ x: 101, y: 0 }, { x: -1, y: 5 }, { x: 10.5, y: 5 }, { x: "50", y: "25" }, { x: 10 }, "50,25", 42, [], [50, 25], { x: NaN, y: 1 }]) {
      assert.equal(parseIntakeHeroFocal(v), null, JSON.stringify(v));
    }
  });
});

describe("buildHeroMediaData focal", () => {
  it("adds focalX/focalY when a focal is given", () => {
    assert.deepEqual(buildHeroMediaData({ title: "T", credit: "C", caption: null, focal: { x: 50, y: 25 } }), { alt: "T", credit: "C", focalX: 50, focalY: 25 });
  });
  it("is byte-identical to today without a focal (no focal keys)", () => {
    for (const focal of [undefined, null]) {
      const d = buildHeroMediaData({ title: "T", credit: null, caption: "Cap", focal });
      assert.equal(JSON.stringify(d), JSON.stringify({ alt: "T", credit: undefined, caption: "Cap" }));
      assert.equal("focalX" in d || "focalY" in d, false);
    }
  });
});
