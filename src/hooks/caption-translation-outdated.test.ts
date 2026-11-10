/**
 * `articleBookkeeping` stale-marking on a lead caption change (content-engine plan
 * hub-live-edit-widen_PLAN_10-11-26.md, step 1.6): `leadImageCaption` is localized, so a
 * changed source caption must mark the target translations `outdated` exactly like a
 * changed title / dek / body. Without the key in `data`, or with the same caption (null and
 * "" count as "no caption"), behaviour is unchanged.
 *
 *   npm run test:hub-live
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { articleBookkeeping } from "./article-workflow";

type Doc = Record<string, unknown>;
type HookArgs = Parameters<typeof articleBookkeeping>[0];

const BODY = { root: { children: [] } };
const ROWS = [
  { locale: "vi", state: "machine_translated" },
  { locale: "fr", state: "pending" },
  { locale: "de", state: "none" },
];
const original: Doc = { id: 9, tenant: 4, version: 7, title: "T", dek: "D", body: BODY, leadImageCaption: "Old caption", translationStatus: ROWS };

/** The hook as Payload calls it on a non-draft update: `data` carries the merged doc fields. */
function run(data: Doc, orig: Doc = original): Doc {
  return articleBookkeeping({
    data: { title: "T", dek: "D", body: BODY, translationStatus: ROWS, ...data },
    originalDoc: orig,
    req: { context: { hubAuthor: { action: "update" } }, user: null } as unknown as HookArgs["req"],
    operation: "update",
    collection: {} as never,
    context: {} as never,
  } as unknown as HookArgs) as Doc;
}

const states = (out: Doc) => (out.translationStatus as Doc[]).map((r) => r.state);

describe("articleBookkeeping: leadImageCaption change marks translations outdated", () => {
  it("a changed caption marks every non-protected, non-pending row outdated", () => {
    assert.deepEqual(states(run({ leadImageCaption: "New caption" })), ["outdated", "pending", "none"]);
  });
  it("clearing the caption counts as a change", () => {
    assert.deepEqual(states(run({ leadImageCaption: null })), ["outdated", "pending", "none"]);
  });
  it("no leadImageCaption key in data ⇒ unchanged (no stale-marking)", () => {
    assert.deepEqual(states(run({})), ["machine_translated", "pending", "none"]);
  });
  it("the same caption ⇒ unchanged", () => {
    assert.deepEqual(states(run({ leadImageCaption: "Old caption" })), ["machine_translated", "pending", "none"]);
  });
  it("null, empty string and a missing stored value are all 'no caption' ⇒ unchanged", () => {
    const noCaption: Doc = { ...original };
    delete noCaption.leadImageCaption;
    assert.deepEqual(states(run({ leadImageCaption: null }, noCaption)), ["machine_translated", "pending", "none"]);
    assert.deepEqual(states(run({ leadImageCaption: "" }, { ...original, leadImageCaption: null })), ["machine_translated", "pending", "none"]);
  });
  it("a hero-only change (no caption key, same text) still marks nothing (the hero is not localized content)", () => {
    assert.deepEqual(states(run({ heroImage: 22 })), ["machine_translated", "pending", "none"]);
  });
  it("the version still bumps on a caption-only change", () => {
    assert.equal(run({ leadImageCaption: "New caption" }).version, 8);
  });
});
