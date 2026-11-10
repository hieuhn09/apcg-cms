/**
 * `context.heroSwap` in `articleBookkeeping` (media-gtp-vowasia phase 5, P5): a hero swap
 * changes no text, so the hook returns `data` before the version bump, the `lastEngine`
 * stamp and the stale-marking block. Without the flag, behaviour is unchanged. The second
 * half drives `enqueueTranslations` with the hook's output on a translation-enabled tenant
 * whose translations are UP TO DATE: no job may be queued after a hero swap.
 *
 *   npm run test:engine-hero
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { articleBookkeeping } from "./article-workflow";
import { enqueueTranslations } from "./translation";

type Doc = Record<string, unknown>;
type HookArgs = Parameters<typeof articleBookkeeping>[0];

const original: Doc = {
  id: 9,
  tenant: 4,
  version: 7,
  title: "T",
  dek: "D",
  body: { root: { children: [] } },
  editedByHuman: true,
  lastEngine: 1,
  workflowStatus: "published",
  _status: "published",
  translationStatus: [{ locale: "vi", state: "machine_translated", sourceVersionAtTranslation: 7 }],
};

function run(data: Doc, context: Record<string, unknown>): Doc {
  return articleBookkeeping({
    data,
    originalDoc: original,
    req: { context, user: null } as unknown as HookArgs["req"],
    operation: "update",
    collection: {} as never,
    context: context as never,
  } as unknown as HookArgs) as Doc;
}

describe("articleBookkeeping heroSwap", () => {
  it("returns data unchanged: no version bump, no lastEngine, translationStatus untouched", () => {
    const data: Doc = { heroImage: 22, tenant: 4, translationStatus: [{ locale: "vi", state: "machine_translated", sourceVersionAtTranslation: 7 }], editedByHuman: true };
    const before = JSON.stringify(data);
    const out = run(data, { engineWrite: true, engineId: 5, heroSwap: true });
    assert.equal(JSON.stringify(out), before);
    assert.equal("version" in out, false);
    assert.equal("lastEngine" in out, false);
  });
  it("without heroSwap, an engine write still bumps version and stamps lastEngine (unchanged)", () => {
    const out = run({ heroImage: 22, tenant: 4 }, { engineWrite: true, engineId: 5 });
    assert.equal(out.version, 8);
    assert.equal(out.lastEngine, 5);
    assert.equal("editedByHuman" in out, false);
  });
  it("without heroSwap, a content change still marks translations outdated (unchanged)", () => {
    const out = run({ title: "T2", translationStatus: [{ locale: "vi", state: "machine_translated" }] }, { engineWrite: true, engineId: 5 });
    assert.deepEqual(out.translationStatus, [{ locale: "vi", state: "outdated" }]);
  });
  it("heroSwap: false behaves like no flag", () => {
    const out = run({ heroImage: 22 }, { engineWrite: true, engineId: 5, heroSwap: false });
    assert.equal(out.version, 8);
  });
});

describe("enqueueTranslations after a heroSwap update (translation-enabled tenant, up-to-date rows)", () => {
  function fakeReq() {
    const created: Doc[] = [];
    const updated: Doc[] = [];
    const payload = {
      findByID: async () => ({ id: 4, slug: "t", features: { articles: true, translations: true }, defaultLanguage: "en", supportedLanguages: ["en", "vi"] }),
      find: async () => ({ docs: [] }),
      create: async (a: Doc) => (created.push(a), { id: 1 }),
      update: async (a: Doc) => (updated.push(a), {}),
      logger: { error: () => {}, warn: () => {}, info: () => {} },
    };
    return { req: { payload, context: {}, user: null }, created, updated };
  }
  const enqueue = (doc: Doc, req: unknown) => enqueueTranslations({ doc, req, previousDoc: original, operation: "update", collection: {}, context: {} } as never);

  it("heroSwap: version stays 7, no translation job, no write-back", async () => {
    const data = run({ heroImage: 22, tenant: 4 }, { engineWrite: true, engineId: 5, heroSwap: true });
    const doc = { ...original, ...data };
    assert.equal(doc.version, 7);
    const f = fakeReq();
    await enqueue(doc, f.req);
    assert.equal(f.created.filter((c) => c.collection === "translationJobs").length, 0);
    assert.equal(f.updated.length, 0);
  });
  it("control: without heroSwap the bump re-queues the up-to-date locale", async () => {
    const data = run({ heroImage: 22, tenant: 4 }, { engineWrite: true, engineId: 5 });
    const doc = { ...original, ...data };
    assert.equal(doc.version, 8);
    const f = fakeReq();
    await enqueue(doc, f.req);
    assert.equal(f.created.filter((c) => c.collection === "translationJobs").length, 1);
  });
});
