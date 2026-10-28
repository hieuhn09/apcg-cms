/**
 * Unit tests for ./hub-author-flags + the editorial keys of ./hub-author-input
 * (content-engine plan process/features/apcg-hub/active/hub-pin-exclusive-flags_PLAN_28-10-26.md,
 * D2 / D3 / D5 / D8 / D9, Public Contracts CMS 1 + 6). Node's built-in runner, no DB, no
 * `@payload-config` (loads with an empty environment).
 *
 *   npm run test:hub-flags
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FLAGS_POST_WRITE_IGNORED,
  HUB_FLAGS_BODY_KEYS,
  PIN_UNTIL_MAX_DAYS,
  PIN_UNTIL_MIN_LEAD_SECONDS,
  draftEditorialErrors,
  editorialFlagsTenants,
  editorialKeysOf,
  flagsChange,
  flagsGateReason,
  flagsPostWriteCheck,
  flagsPostWriteDiff,
  isEditorialFlagsTenant,
  parseFlagsBody,
  pinUntilWindowCode,
  sameEditorialValues,
  storedEditorialValues,
} from "./hub-author-flags";
import { HUB_DRAFT_FIELD_KEYS, HUB_EDITORIAL_KEYS, HUB_FLAG_KEYS, parseCreateBody, parseUpdateBody } from "./hub-author-input";
import { HUB_LIVE_FIELD_KEYS } from "./hub-author-live-pure";

type Doc = Record<string, unknown>;

const ACTOR = { email: "ed@example.invalid", role: "editor" };
const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const createBase = (extra: Doc = {}): Doc => ({ tenant: "gcv", title: "Tiêu đề", actor: ACTOR, ...extra });
const fieldsOf = (r: { ok: boolean; status?: number; body?: Doc }) => (r.ok ? "ok" : r.status === 422 ? (r.body!.fields as Doc) : `${r.status}:${String(r.body!.reason)}`);

describe("draft parser: the three editorial ROOT keys (D2 / D5)", () => {
  it("keeps HUB_FLAG_KEYS (6) and HUB_DRAFT_FIELD_KEYS unchanged; editorial keys are a separate group", () => {
    assert.deepEqual([...HUB_FLAG_KEYS], ["aiAssisted", "breaking", "sponsored", "affiliate", "deepDive", "longHaul"]);
    assert.deepEqual([...HUB_EDITORIAL_KEYS], ["exclusive", "pinnedToLatest", "pinnedUntil"]);
    for (const k of HUB_EDITORIAL_KEYS) assert.equal((HUB_DRAFT_FIELD_KEYS as readonly string[]).includes(k), false, k);
    assert.equal(HUB_LIVE_FIELD_KEYS.length, 15);
  });

  it("flags.exclusive / flags.pinnedToLatest are STILL 400 unknown keys", () => {
    const r = parseCreateBody(createBase({ flags: { exclusive: true, pinnedToLatest: true } }));
    assert.equal(fieldsOf(r), "400:unknown field(s): flags.exclusive, flags.pinnedToLatest");
  });

  it("exclusive must be a real boolean", () => {
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ exclusive: "true" }))), { exclusive: "type" });
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ exclusive: null }))), { exclusive: "type" });
    const ok = parseCreateBody(createBase({ exclusive: true }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual([ok.value.editorial, ok.value.present], [{ exclusive: true }, ["title", "exclusive"]]);
  });

  it("pin pair: both or neither; the missing one is `required`", () => {
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedToLatest: true }))), { pinnedUntil: "required" });
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedUntil: null }))), { pinnedToLatest: "required" });
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedUntil: "2026-10-30T11:00Z" }))), { pinnedToLatest: "required" });
    assert.deepEqual(fieldsOf(parseUpdateBody({ ...createBase({ pinnedToLatest: false }), expectedVersion: 2 })), { pinnedUntil: "required" });
  });

  it("pinnedToLatest:false ⇒ pinnedUntil must be null (else `invalid`); types", () => {
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedToLatest: false, pinnedUntil: "2026-10-30T11:00:00Z" }))), { pinnedUntil: "invalid" });
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedToLatest: "yes", pinnedUntil: null }))), { pinnedToLatest: "type" });
    assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedToLatest: true, pinnedUntil: 1761645600000 }))), { pinnedUntil: "type" });
    const off = parseCreateBody(createBase({ pinnedToLatest: false, pinnedUntil: null }));
    assert.equal(off.ok, true);
    if (off.ok) assert.deepEqual(off.value.editorial, { pinnedToLatest: false, pinnedUntil: null });
  });

  it("pinnedUntil: K7 UTC only (rolled-over dates, hour 24, missing Z, an offset ⇒ format); normalised", () => {
    for (const bad of ["2026-02-30T10:00:00Z", "2026-10-30T24:00:00Z", "2026-10-30T10:00:00", "2026-10-30T17:00:00+07:00", "30/10/2026 10:00", "", " 2026-10-30T10:00Z"]) {
      assert.deepEqual(fieldsOf(parseCreateBody(createBase({ pinnedToLatest: true, pinnedUntil: bad }))), { pinnedUntil: "format" }, bad);
    }
    const ok = parseCreateBody(createBase({ pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00Z" }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.value.editorial, { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" });
  });

  it("no editorial key ⇒ `editorial` absent and `present` unchanged (byte-identical old flow)", () => {
    const r = parseCreateBody(createBase({ dek: "x" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal("editorial" in r.value, false);
      assert.deepEqual(r.value.present, ["title", "dek"]);
    }
  });
});

describe("the CMS switch HUB_EDITORIAL_FLAGS_TENANTS (D3)", () => {
  it("default OFF; CSV split + trim; exact, case-sensitive match; `*` is not a wildcard", () => {
    assert.deepEqual(editorialFlagsTenants({}), []);
    assert.deepEqual(editorialFlagsTenants({ HUB_EDITORIAL_FLAGS_TENANTS: "" }), []);
    assert.deepEqual(editorialFlagsTenants({ HUB_EDITORIAL_FLAGS_TENANTS: " , ,, " }), []);
    assert.deepEqual(editorialFlagsTenants({ HUB_EDITORIAL_FLAGS_TENANTS: " world-travel-brief , gcv,," }), ["world-travel-brief", "gcv"]);
    const list = editorialFlagsTenants({ HUB_EDITORIAL_FLAGS_TENANTS: "GCV,*,world travel brief" });
    assert.equal(isEditorialFlagsTenant("gcv", list), false);
    assert.equal(isEditorialFlagsTenant("dtw", list), false);
    assert.equal(isEditorialFlagsTenant("world-travel-brief", list), false);
    assert.equal(isEditorialFlagsTenant("GCV", list), true);
    // Read on every call: never cached.
    const env: Record<string, string | undefined> = { HUB_EDITORIAL_FLAGS_TENANTS: "gcv" };
    assert.deepEqual(editorialFlagsTenants(env), ["gcv"]);
    env.HUB_EDITORIAL_FLAGS_TENANTS = undefined;
    assert.deepEqual(editorialFlagsTenants(env), []);
  });
});

describe("pinnedUntil window (D5: now + 60 s < t ≤ now + 365 days)", () => {
  it("boundaries with an injected now", () => {
    assert.equal(PIN_UNTIL_MIN_LEAD_SECONDS, 60);
    assert.equal(PIN_UNTIL_MAX_DAYS, 365);
    assert.equal(pinUntilWindowCode(iso(NOW + 60_000), NOW), "out_of_range");
    assert.equal(pinUntilWindowCode(iso(NOW + 61_000), NOW), null);
    assert.equal(pinUntilWindowCode(iso(NOW + 365 * DAY), NOW), null);
    assert.equal(pinUntilWindowCode(iso(NOW + 365 * DAY + 1), NOW), "out_of_range");
    assert.equal(pinUntilWindowCode(iso(NOW - 1), NOW), "out_of_range");
    assert.equal(pinUntilWindowCode("not a date", NOW), "out_of_range");
  });

  it("draft gate: switch off ⇒ not_enabled on EVERY key present (window not checked); on ⇒ window", () => {
    const keys = ["exclusive", "pinnedToLatest", "pinnedUntil"] as const;
    const past = { exclusive: true, pinnedToLatest: true, pinnedUntil: iso(NOW - DAY) };
    assert.deepEqual(draftEditorialErrors({ keys: [...keys], editorial: past, tenantSlug: "dtw", tenants: ["gcv"], nowMs: NOW }), {
      exclusive: "not_enabled",
      pinnedToLatest: "not_enabled",
      pinnedUntil: "not_enabled",
    });
    assert.deepEqual(draftEditorialErrors({ keys: [...keys], editorial: past, tenantSlug: "gcv", tenants: ["gcv"], nowMs: NOW }), { pinnedUntil: "out_of_range" });
    assert.equal(draftEditorialErrors({ keys: [...keys], editorial: { ...past, pinnedUntil: iso(NOW + DAY) }, tenantSlug: "gcv", tenants: ["gcv"], nowMs: NOW }), null);
    assert.equal(draftEditorialErrors({ keys: ["pinnedToLatest", "pinnedUntil"], editorial: { pinnedToLatest: true, pinnedUntil: null }, tenantSlug: "gcv", tenants: ["gcv"], nowMs: NOW }), null);
    // No editorial key ⇒ never an error, whatever the switch says.
    assert.equal(draftEditorialErrors({ keys: [], editorial: undefined, tenantSlug: "dtw", tenants: [], nowMs: NOW }), null);
    assert.deepEqual(editorialKeysOf(["title", "pinnedUntil", "dek", "exclusive", "pinnedToLatest"]), ["pinnedUntil", "exclusive", "pinnedToLatest"]);
  });
});

describe("parseFlagsBody — POST /api/hub/articles/{id}/flags (Public Contracts CMS 6)", () => {
  const EXPECTED = { exclusive: false, pinnedToLatest: false, pinnedUntil: null };
  const body = (extra: Doc = {}): Doc => ({ tenant: "gcv", actor: ACTOR, expected: EXPECTED, set: { exclusive: true }, ...extra });
  const p = (raw: unknown) => parseFlagsBody(raw, NOW);

  it("the outer keys are exactly the four", () => {
    assert.deepEqual([...HUB_FLAGS_BODY_KEYS], ["tenant", "actor", "expected", "set"]);
    const ok = p(body());
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual([ok.value.tenant, ok.value.actor, ok.value.expected, ok.value.set, ok.value.setKeys], ["gcv", ACTOR, EXPECTED, { exclusive: true }, ["exclusive"]]);
  });

  it("400: not JSON object / tenant / unknown keys at root, expected.*, set.*, actor.* (with prefixes)", () => {
    assert.equal(fieldsOf(p(null)), "400:body must be a JSON object");
    assert.equal(fieldsOf(p([])), "400:body must be a JSON object");
    assert.equal(fieldsOf(p(body({ tenant: 5 }))), "400:tenant is required");
    assert.equal(fieldsOf(p(body({ tenant: "  " }))), "400:tenant is required");
    assert.equal(fieldsOf(p(body({ expectedVersion: 3 }))), "400:unknown field(s): expectedVersion");
    assert.equal(fieldsOf(p(body({ expected: { ...EXPECTED, breaking: false } }))), "400:unknown field(s): expected.breaking");
    assert.equal(fieldsOf(p(body({ set: { exclusive: true, title: "x" } }))), "400:unknown field(s): set.title");
    assert.equal(fieldsOf(p(body({ actor: { ...ACTOR, name: "x" } }))), "400:unknown field(s): actor.name");
    const proto = JSON.parse('{"tenant":"gcv","__proto__":{"x":1},"set":{"__proto__":true,"flags":{}}}') as Doc;
    assert.equal(fieldsOf(p(proto)), "400:unknown field(s): __proto__, set.__proto__, set.flags");
  });

  it("422: expected must carry all three, typed; set required and non-empty", () => {
    assert.deepEqual(fieldsOf(p({ tenant: "gcv", actor: ACTOR, set: { exclusive: true } })), { expected: "required" });
    assert.deepEqual(fieldsOf(p(body({ expected: null }))), { expected: "type" });
    assert.deepEqual(fieldsOf(p(body({ expected: "x" }))), { expected: "type" });
    assert.deepEqual(fieldsOf(p(body({ expected: { exclusive: false } }))), { "expected.pinnedToLatest": "required", "expected.pinnedUntil": "required" });
    assert.deepEqual(fieldsOf(p(body({ expected: { exclusive: 0, pinnedToLatest: false, pinnedUntil: "2026-10-30" } }))), { "expected.exclusive": "type", "expected.pinnedUntil": "format" });
    // expected mirrors the STORED values: an unticked pin with a leftover date is a legal state.
    assert.equal(p(body({ expected: { exclusive: false, pinnedToLatest: false, pinnedUntil: "2026-10-30T11:00:00.000Z" } })).ok, true);
    assert.deepEqual(fieldsOf(p({ tenant: "gcv", actor: ACTOR, expected: EXPECTED })), { set: "required" });
    assert.deepEqual(fieldsOf(p(body({ set: {} }))), { set: "required" });
    assert.deepEqual(fieldsOf(p(body({ set: [] }))), { set: "type" });
  });

  it("422: set uses the draft pair rules and the window; field names are bare (`pinnedUntil`, not `set.pinnedUntil`)", () => {
    assert.deepEqual(fieldsOf(p(body({ set: { pinnedToLatest: true } }))), { pinnedUntil: "required" });
    assert.deepEqual(fieldsOf(p(body({ set: { pinnedToLatest: false, pinnedUntil: iso(NOW + DAY) } }))), { pinnedUntil: "invalid" });
    assert.deepEqual(fieldsOf(p(body({ set: { pinnedToLatest: true, pinnedUntil: "2026-10-30T17:00:00+07:00" } }))), { pinnedUntil: "format" });
    assert.deepEqual(fieldsOf(p(body({ set: { pinnedToLatest: true, pinnedUntil: iso(NOW + 30_000) } }))), { pinnedUntil: "out_of_range" });
    assert.deepEqual(fieldsOf(p(body({ set: { pinnedToLatest: true, pinnedUntil: iso(NOW + 366 * DAY) } }))), { pinnedUntil: "out_of_range" });
    assert.deepEqual(fieldsOf(p(body({ set: { exclusive: "no" } }))), { exclusive: "type" });
    const ok = p(body({ set: { pinnedUntil: iso(NOW + DAY), pinnedToLatest: true } }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual([ok.value.set, ok.value.setKeys], [{ pinnedToLatest: true, pinnedUntil: iso(NOW + DAY) }, ["pinnedUntil", "pinnedToLatest"]]);
  });

  it("422: actor block like every hub write (viewer refused with `format`)", () => {
    assert.deepEqual(fieldsOf(p(body({ actor: { email: "ed@example.invalid", role: "viewer" } }))), { "actor.role": "format" });
    assert.deepEqual(fieldsOf(p({ tenant: "gcv", expected: EXPECTED, set: { exclusive: true } })), { actor: "required" });
    assert.deepEqual(fieldsOf(p(body({ actor: { role: "admin" } }))), { "actor.email": "required" });
    const m = p(body({ actor: { email: "mk@example.invalid", role: "marketer", id: "u-1" } }));
    assert.equal(m.ok, true);
  });

  it("the actor block gives the same codes as the draft parser (drift pin)", () => {
    const vectors: unknown[] = [
      "x", null, [], {}, { email: "a@b.co" }, { role: "editor" }, { email: 5, role: "editor" }, { email: "", role: "editor" }, { email: "no-at", role: "editor" },
      { email: "a b@c.d", role: "editor" }, { email: `${"a".repeat(250)}@b.co`, role: "editor" }, { email: "a@b.co", role: 1 }, { email: "a@b.co", role: "viewer" },
      { email: "a@b.co", role: "Editor" }, { email: "a@b.co", role: "admin", id: 1.5 }, { email: "a@b.co", role: "admin", id: "x".repeat(65) }, { email: "a@b.co", role: "admin", id: true },
      { email: "a@b.co", role: "admin", id: 1e70 }, { email: "a@b\u0000.co", role: "admin" }, { email: "a@b.co", role: "marketer", id: "u-7" },
    ];
    for (const actor of vectors) {
      const viaDraft = parseCreateBody(createBase({ actor }));
      const viaFlags = p(body({ actor }));
      const pick = (r: { ok: boolean; status?: number; body?: Doc }) => (r.ok ? "ok" : r.status === 422 ? JSON.stringify(r.body!.fields) : `${r.status}`);
      assert.equal(pick(viaFlags), pick(viaDraft), JSON.stringify(actor));
    }
  });
});

describe("D9 gate, expected comparison, change set", () => {
  const MAIN: Doc = { id: 9, workflowStatus: "published", _status: "published", version: 4 };

  it("flagsGateReason", () => {
    const g = (main: Doc, latest: Doc | null) => flagsGateReason({ main, latest });
    assert.equal(g(MAIN, { ...MAIN }), null);
    assert.equal(g({ ...MAIN, _status: "draft" }, { ...MAIN, _status: "draft" }), "legacy_status");
    assert.equal(g({ ...MAIN, _status: null }, { ...MAIN }), "legacy_status");
    assert.equal(g({ ...MAIN, workflowStatus: "hidden" }, { ...MAIN, workflowStatus: "hidden" }), "status");
    assert.equal(g({ ...MAIN, workflowStatus: "draft", _status: "draft" }, null), "status");
    assert.equal(g({ ...MAIN, workflowStatus: "scheduled" }, { ...MAIN }), "scheduled");
    assert.equal(g({ ...MAIN, workflowStatus: "draft", _status: "draft" }, { ...MAIN, workflowStatus: "scheduled", _status: "draft" }), "scheduled");
    assert.equal(g(MAIN, { ...MAIN, _status: "draft", version: 5 }), "draft_diverged");
    assert.equal(g(MAIN, { ...MAIN, version: 5 }), "draft_diverged");
    assert.equal(g(MAIN, null), "draft_diverged");
  });

  it("storedEditorialValues + sameEditorialValues compare pinnedUntil by instant", () => {
    const v = storedEditorialValues({ exclusive: true, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" });
    assert.deepEqual(v, { exclusive: true, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" });
    assert.deepEqual(storedEditorialValues({}), { exclusive: false, pinnedToLatest: false, pinnedUntil: null });
    assert.deepEqual(storedEditorialValues({ pinnedUntil: new Date("2026-10-30T11:00:00Z") }).pinnedUntil, "2026-10-30T11:00:00.000Z");
    assert.equal(sameEditorialValues(v, { exclusive: true, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00Z" }), true);
    assert.equal(sameEditorialValues(v, { exclusive: true, pinnedToLatest: true, pinnedUntil: null }), false);
    assert.equal(sameEditorialValues(v, { exclusive: false, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" }), false);
  });

  it("flagsChange: only differing keys, in request order, with from / to", () => {
    const cur = { exclusive: false, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" };
    assert.deepEqual(flagsChange(cur, { exclusive: false }, ["exclusive"]), { changed: [], data: {}, from: {}, to: {} });
    assert.deepEqual(flagsChange(cur, { pinnedToLatest: false, pinnedUntil: null }, ["pinnedToLatest", "pinnedUntil"]), {
      changed: ["pinnedToLatest", "pinnedUntil"],
      data: { pinnedToLatest: false, pinnedUntil: null },
      from: { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" },
      to: { pinnedToLatest: false, pinnedUntil: null },
    });
    // Same instant written differently ⇒ no change.
    assert.deepEqual(flagsChange(cur, { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z", exclusive: true }, ["pinnedUntil", "pinnedToLatest", "exclusive"]).changed, ["exclusive"]);
  });
});

describe("D8 post-write check", () => {
  const PRE: Doc = {
    id: 9, title: { en: "T", fr: "T fr" }, body: { en: { root: { type: "root", children: [] } } }, workflowStatus: "published", _status: "published",
    version: 4, publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", views: 12, lastEditedBy: 3,
    translationStatus: [{ id: "a", locale: "fr", state: "machine_translated" }], exclusive: false, pinnedToLatest: false, pinnedUntil: null,
  };

  it("ignores exactly the three flags + updatedAt", () => {
    assert.deepEqual([...FLAGS_POST_WRITE_IGNORED], ["exclusive", "pinnedToLatest", "pinnedUntil", "updatedAt"]);
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, exclusive: true, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z", updatedAt: "2026-10-28T10:00:00.000Z" }), []);
  });

  it("flags every other column, per locale and nested", () => {
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, version: 5 }), ["version"]);
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, title: { en: "T", fr: "changed" } }), ["title"]);
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, _status: "draft", publishedAt: null }), ["_status", "publishedAt"]);
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, translationStatus: [{ id: "a", locale: "fr", state: "outdated" }] }), ["translationStatus"]);
    assert.deepEqual(flagsPostWriteDiff(PRE, { ...PRE, lastEditedBy: null, views: 13 }), ["views", "lastEditedBy"]);
    const { views: _v, ...noViews } = PRE;
    void _v;
    assert.deepEqual(flagsPostWriteDiff(PRE, noViews), ["views"]);
  });

  it("flagsPostWriteCheck: fields, values and latest legs", () => {
    const want = { exclusive: true, pinnedToLatest: false, pinnedUntil: null };
    const post = { ...PRE, exclusive: true, updatedAt: "x" };
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post, latest: { ...post }, want }), { ok: true });
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post: null, latest: { ...post }, want }), { ok: false, leg: "missing", detail: ["post"] });
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post: { ...post, dek: "slipped" }, latest: { ...post }, want }), { ok: false, leg: "fields", detail: ["dek"] });
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post: { ...PRE }, latest: { ...PRE }, want }), { ok: false, leg: "values", detail: ["exclusive"] });
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post, latest: { ...post, _status: "draft" }, want }), { ok: false, leg: "latest", detail: ["latest._status"] });
    assert.deepEqual(flagsPostWriteCheck({ pre: PRE, post, latest: { ...post, version: 5 }, want }), { ok: false, leg: "latest", detail: ["latest.version"] });
  });
});
