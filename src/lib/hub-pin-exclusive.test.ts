/**
 * Hub pin + exclusive flags (05-11-26): `pinnedToLatest` and `exclusive` are hub-writable
 * flags on draft create/update and on a live edit. Pure parsers only; no database.
 * The Pressroom (single-home) exclusive => 422 single_home case lives in hub-pressroom.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HUB_DRAFT_FIELD_KEYS, HUB_FLAG_KEYS, parseCreateBody, parseUpdateBody } from "./hub-author-input";
import { HUB_LIVE_EDITABLE_FLAGS, HUB_LIVE_FIELD_KEYS, HUB_LIVE_LOCKED_FLAGS, parseLiveBody } from "./hub-author-live-pure";

const actor = { email: "e@x.test", role: "editor" };

describe("hub pin + exclusive flags", () => {
  it("both flags are in the draft flag allowlist and editable live", () => {
    for (const f of ["pinnedToLatest", "exclusive"] as const) {
      assert.ok((HUB_FLAG_KEYS as readonly string[]).includes(f));
      assert.ok((HUB_LIVE_EDITABLE_FLAGS as readonly string[]).includes(f));
      assert.ok(!(HUB_LIVE_LOCKED_FLAGS as readonly string[]).includes(f));
    }
  });
  it("draft PATCH accepts them as booleans", () => {
    const r = parseUpdateBody({ tenant: "gcv", expectedVersion: 1, actor, flags: { pinnedToLatest: true, exclusive: false } });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.flags, { pinnedToLatest: true, exclusive: false });
  });
  it("non-boolean is a type error", () => {
    const r = parseUpdateBody({ tenant: "gcv", expectedVersion: 1, actor, flags: { exclusive: "yes" } });
    assert.equal(r.ok, false);
  });
  it("live body accepts them", () => {
    const r = parseLiveBody({ tenant: "gcv", expectedVersion: 1, actor, fields: { flags: { pinnedToLatest: true, exclusive: true } } });
    assert.equal(r.ok, true);
  });
});

describe("hub pinnedUntil", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const upd = (pinnedUntil: unknown) => parseUpdateBody({ tenant: "gcv", expectedVersion: 1, actor, pinnedUntil });
  it("is a draft field and a live field", () => {
    assert.ok((HUB_DRAFT_FIELD_KEYS as readonly string[]).includes("pinnedUntil"));
    assert.ok((HUB_LIVE_FIELD_KEYS as readonly string[]).includes("pinnedUntil"));
  });
  it("future ISO UTC accepted and normalized", () => {
    const r = upd(future);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.pinnedUntil, future);
  });
  it("null clears", () => {
    const r = upd(null);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.pinnedUntil, null);
  });
  it("past => out_of_range", () => {
    const r = upd(new Date(Date.now() - 60_000).toISOString());
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r), /"pinnedUntil":"out_of_range"/);
  });
  it("non-UTC / garbage => format, number => type", () => {
    assert.equal(upd("2099-01-01T10:00:00+07:00").ok, false);
    assert.equal(upd("tomorrow").ok, false);
    assert.equal(upd(123).ok, false);
  });
  it("create and live accept it", () => {
    assert.equal(parseCreateBody({ tenant: "gcv", actor, title: "T", flags: { pinnedToLatest: true }, pinnedUntil: future }).ok, true);
    assert.equal(parseLiveBody({ tenant: "gcv", expectedVersion: 1, actor, fields: { pinnedUntil: future } }).ok, true);
  });
});
