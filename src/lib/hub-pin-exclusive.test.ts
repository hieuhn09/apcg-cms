/**
 * Hub pin + exclusive flags (05-11-26): `pinnedToLatest` and `exclusive` are hub-writable
 * flags on draft create/update and on a live edit. Pure parsers only; no database.
 * The Pressroom (single-home) exclusive => 422 single_home case lives in hub-pressroom.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HUB_FLAG_KEYS, parseUpdateBody } from "./hub-author-input";
import { HUB_LIVE_EDITABLE_FLAGS, HUB_LIVE_LOCKED_FLAGS, parseLiveBody } from "./hub-author-live-pure";

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
