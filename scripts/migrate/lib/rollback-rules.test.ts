import { test } from "node:test";
import assert from "node:assert/strict";
import { untouched } from "./rollback-rules";

const e = { slug: "s", baselineVersion: 1, baselineUpdatedAt: "2026-10-12T00:00:00.000Z" };

test("C8/G43 unit (S-04, N-09): untouched = same version AND (baseline updatedAt OR the timestamps-baseline value)", () => {
  assert.equal(untouched({ version: 1, updatedAt: "2026-10-12T00:00:00.000Z" }, e, {}), true);
  assert.equal(untouched({ version: 2, updatedAt: "2026-10-12T00:00:00.000Z" }, e, {}), false); // editor bump
  assert.equal(untouched({ version: 1, updatedAt: "2026-10-12T00:05:00.000Z" }, e, {}), false); // hub status-only write
  assert.equal(untouched({ version: 1, updatedAt: "2026-07-26T01:00:00.000Z" }, e, { s: "2026-07-26T01:00:00.000Z" }), true); // owner SQL set it
  assert.equal(untouched({ version: 1, updatedAt: "2026-07-27T01:00:00.000Z" }, e, { s: "2026-07-26T01:00:00.000Z" }), false);
  assert.equal(untouched({ version: 1, updatedAt: undefined }, e, {}), false);
});
