/**
 * Hero focal point — pure helpers + the closed `heroFocal` key in the three body parsers
 * (content-engine plan hub-hero-focal-point_PLAN_10-11-26.md, P1.1 / P1.2 / P1.4).
 * Node's built-in runner; no Payload, no database.   npm run test:hub-focal
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HERO_FOCAL_NOT_APPLIED,
  focalColumnsChanged,
  focalColumnsEqual,
  focalTenants,
  focalToColumns,
  isFocalTenant,
  isUnsetFocal,
  parseHeroFocal,
} from "./hub-hero-focal-pure";
import { HUB_DRAFT_FIELD_KEYS, parseCreateBody, parseUpdateBody } from "./hub-author-input";
import { HUB_LIVE_FIELD_KEYS, HUB_LIVE_LOCKED_FIELD_KEYS, parseLiveBody } from "./hub-author-live-pure";

type Doc = Record<string, unknown>;
const ACTOR = { email: "ed@example.invalid", role: "editor" };

describe("parseHeroFocal", () => {
  it("accepts integers 0..100 on both axes, and null (= centre)", () => {
    assert.deepEqual(parseHeroFocal({ x: 30, y: 70 }), { ok: true, value: { x: 30, y: 70 } });
    assert.deepEqual(parseHeroFocal({ x: 0, y: 100 }), { ok: true, value: { x: 0, y: 100 } });
    assert.deepEqual(parseHeroFocal({ x: 100, y: 0 }), { ok: true, value: { x: 100, y: 0 } });
    assert.deepEqual(parseHeroFocal({ x: 50, y: 50 }), { ok: true, value: { x: 50, y: 50 } });
    assert.deepEqual(parseHeroFocal(null), { ok: true, value: null });
  });
  it("out of range: -1, 101 (either axis)", () => {
    assert.deepEqual(parseHeroFocal({ x: -1, y: 50 }), { ok: false, code: "out_of_range" });
    assert.deepEqual(parseHeroFocal({ x: 50, y: 101 }), { ok: false, code: "out_of_range" });
    assert.deepEqual(parseHeroFocal({ x: 1000, y: 0 }), { ok: false, code: "out_of_range" });
  });
  it("type: non-integer, string, NaN, Infinity, boolean, not an object", () => {
    for (const v of [{ x: 50.5, y: 50 }, { x: "50", y: 50 }, { x: 50, y: Number.NaN }, { x: Infinity, y: 1 }, { x: true, y: 1 }, { x: null, y: 1 }]) {
      assert.deepEqual(parseHeroFocal(v), { ok: false, code: "type" }, JSON.stringify(v));
    }
    for (const v of ["30,70", 30, [30, 70], true, undefined]) assert.deepEqual(parseHeroFocal(v), { ok: false, code: "type" }, String(v));
  });
  it("required: a missing axis", () => {
    assert.deepEqual(parseHeroFocal({ x: 30 }), { ok: false, code: "required" });
    assert.deepEqual(parseHeroFocal({ y: 30 }), { ok: false, code: "required" });
    assert.deepEqual(parseHeroFocal({}), { ok: false, code: "required" });
  });
});

describe("focalTenants / isFocalTenant (HUB_FOCAL_TENANTS)", () => {
  it("default OFF; CSV trimmed; exact, case-sensitive match", () => {
    assert.deepEqual(focalTenants({}), []);
    assert.deepEqual(focalTenants({ HUB_FOCAL_TENANTS: "" }), []);
    assert.deepEqual(focalTenants({ HUB_FOCAL_TENANTS: " gtp , ,gcv " }), ["gtp", "gcv"]);
    const t = focalTenants({ HUB_FOCAL_TENANTS: "gtp" });
    assert.equal(isFocalTenant("gtp", t), true);
    assert.equal(isFocalTenant("GTP", t), false);
    assert.equal(isFocalTenant("gt", t), false);
    assert.equal(isFocalTenant(null, t), false);
    assert.equal(isFocalTenant("gtp", focalTenants({ HUB_FOCAL_TENANTS: "*" })), false);
  });
  it("reads process.env on every call (no cache)", () => {
    const prev = process.env.HUB_FOCAL_TENANTS;
    try {
      process.env.HUB_FOCAL_TENANTS = "gtp";
      assert.deepEqual(focalTenants(), ["gtp"]);
      delete process.env.HUB_FOCAL_TENANTS;
      assert.deepEqual(focalTenants(), []);
    } finally {
      if (prev === undefined) delete process.env.HUB_FOCAL_TENANTS;
      else process.env.HUB_FOCAL_TENANTS = prev;
    }
  });
});

describe("focalToColumns / isUnsetFocal / equality", () => {
  it("null ⇒ 50/50, never null columns", () => {
    assert.deepEqual(focalToColumns(null), { focalX: 50, focalY: 50 });
    assert.deepEqual(focalToColumns({ x: 0, y: 100 }), { focalX: 0, focalY: 100 });
  });
  it("(50, 50) is the only 'not set'", () => {
    assert.equal(isUnsetFocal(50, 50), true);
    assert.equal(isUnsetFocal(50, 51), false);
    assert.equal(isUnsetFocal(null, null), false);
  });
  it("focalColumnsEqual / focalColumnsChanged compare numbers only", () => {
    assert.equal(focalColumnsEqual({ focalX: 30, focalY: 70 }, { focalX: 30, focalY: 70 }), true);
    assert.equal(focalColumnsEqual({ focalX: "30", focalY: 70 }, { focalX: 30, focalY: 70 }), false);
    assert.equal(focalColumnsEqual({ focalX: null, focalY: null }, { focalX: 50, focalY: 50 }), false);
    assert.equal(focalColumnsChanged({ focalX: 30, focalY: 70 }, { focalX: 50, focalY: 50 }), true);
    assert.equal(focalColumnsChanged({ focalX: 50, focalY: 51 }, { focalX: 50, focalY: 50 }), true);
    assert.equal(focalColumnsChanged({ focalX: 50, focalY: 50, alt: "new" }, { focalX: 50, focalY: 50, alt: "old" }), false);
    assert.equal(focalColumnsChanged({ focalX: 50, focalY: 50 }, { focalX: null, focalY: null }), true);
    assert.equal(focalColumnsChanged({ focalX: 50, focalY: 50 }, undefined), false);
  });
  it("the warning string is frozen", () => assert.equal(HERO_FOCAL_NOT_APPLIED, "hero_focal_not_applied"));
});

describe("heroFocal in the draft parsers (closed key)", () => {
  it("sits right after leadImageCaption and before pinnedUntil", () => {
    const keys = [...HUB_DRAFT_FIELD_KEYS] as string[];
    assert.equal(keys.indexOf("heroFocal"), keys.indexOf("leadImageCaption") + 1);
    assert.equal(keys.indexOf("pinnedUntil"), keys.indexOf("heroFocal") + 1);
  });
  it("create + update accept it, keep it in `present`, null is a value", () => {
    const c = parseCreateBody({ tenant: "gtp", title: "T", heroImageId: 9, heroFocal: { x: 30, y: 70 }, actor: ACTOR });
    assert.equal(c.ok, true);
    if (c.ok) assert.deepEqual([c.value.heroFocal, c.value.present], [{ x: 30, y: 70 }, ["title", "heroImageId", "heroFocal"]]);
    const u = parseUpdateBody({ tenant: "gtp", expectedVersion: 3, heroFocal: null, actor: ACTOR });
    assert.equal(u.ok, true);
    if (u.ok) assert.deepEqual([u.value.heroFocal, u.value.present], [null, ["heroFocal"]]);
  });
  it("absent ⇒ no heroFocal property at all (byte-identical parse)", () => {
    const c = parseCreateBody({ tenant: "gtp", title: "T", actor: ACTOR });
    assert.equal(c.ok && Object.prototype.hasOwnProperty.call(c.value, "heroFocal"), false);
  });
  it("bad values ⇒ 422 with ONE existing closed code under fields.heroFocal", () => {
    const cases: [unknown, string][] = [[{ x: 101, y: 1 }, "out_of_range"], [{ x: 1.5, y: 1 }, "type"], [{ x: 1 }, "required"], ["c", "type"], [[1, 2], "type"]];
    for (const [hf, code] of cases) {
      const r = parseUpdateBody({ tenant: "gtp", expectedVersion: 3, heroFocal: hf, actor: ACTOR });
      assert.equal(r.ok, false);
      if (!r.ok) assert.deepEqual([r.status, (r.body.fields as Doc).heroFocal], [422, code], JSON.stringify(hf));
    }
  });
  it("an unknown inner key ⇒ 400 bad_request (like flags / actor)", () => {
    const r = parseCreateBody({ tenant: "gtp", title: "T", heroFocal: { x: 1, y: 2, z: 3 }, actor: ACTOR });
    assert.deepEqual(r.ok ? null : [r.status, r.body.reason], [400, "unknown field(s): heroFocal.z"]);
  });
});

describe("heroFocal in the live parser", () => {
  it("is a live key, NOT locked; heroImageId stays locked (422 media_locked)", () => {
    assert.ok((HUB_LIVE_FIELD_KEYS as readonly string[]).includes("heroFocal"));
    assert.equal((HUB_LIVE_LOCKED_FIELD_KEYS as readonly string[]).includes("heroFocal"), false);
    const ok = parseLiveBody({ tenant: "gtp", expectedVersion: 4, actor: ACTOR, fields: { heroFocal: { x: 10, y: 90 } } });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual([ok.value.heroFocal, ok.value.present], [{ x: 10, y: 90 }, ["heroFocal"]]);
    const locked = parseLiveBody({ tenant: "gtp", expectedVersion: 4, actor: ACTOR, fields: { heroFocal: { x: 10, y: 90 }, heroImageId: 5 } });
    assert.deepEqual(locked.ok ? null : [locked.status, locked.body.reason], [422, "media_locked"]);
    const bad = parseLiveBody({ tenant: "gtp", expectedVersion: 4, actor: ACTOR, fields: { heroFocal: { x: -1, y: 0 } } });
    assert.deepEqual(bad.ok ? null : [bad.status, (bad.body.fields as Doc).heroFocal], [422, "out_of_range"]);
  });
});
