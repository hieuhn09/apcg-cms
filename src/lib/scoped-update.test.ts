/**
 * `scopedUpdate` gains optional `req` / `depth` (media-gtp-vowasia phase 5, P18): existing
 * calls must produce the exact same `payload.update` arguments; the new keys are forwarded.
 *
 *   npm run test:engine-hero
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Payload, PayloadRequest } from "payload";
import { scopedUpdate } from "./scoped";

function rec() {
  const calls: Record<string, unknown>[] = [];
  const payload = { update: async (a: Record<string, unknown>) => (calls.push(a), {}) } as unknown as Payload;
  return { payload, calls };
}

describe("scopedUpdate", () => {
  it("existing call shape is unchanged (no req, no depth keys)", async () => {
    const { payload, calls } = rec();
    await scopedUpdate({ payload, collection: "articles", tenantId: 3, id: 9, data: { title: "x" }, context: { engineWrite: true } });
    assert.deepEqual(calls[0], { collection: "articles", id: 9, data: { title: "x", tenant: 3 }, overrideAccess: true, locale: undefined, context: { engineWrite: true } });
  });
  it("forwards req and depth", async () => {
    const { payload, calls } = rec();
    const req = { transactionID: 1 } as unknown as PayloadRequest;
    await scopedUpdate({ payload, collection: "articles", tenantId: 3, id: 9, data: { heroImage: 2 }, locale: "en", req, depth: 0 });
    assert.equal(calls[0]?.req, req);
    assert.equal(calls[0]?.depth, 0);
    assert.equal(calls[0]?.locale, "en");
    assert.deepEqual(calls[0]?.data, { heroImage: 2, tenant: 3 });
  });
});
