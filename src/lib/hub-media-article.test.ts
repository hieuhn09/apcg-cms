/**
 * `loadHubMediaArticle` — the article gate of `POST /api/hub/media` (content-engine plan
 * hub-live-edit-widen_PLAN_10-11-26.md, step 2.3): a hub-authored manual draft (as before,
 * through `loadHubEditableArticle`, unchanged) OR a PUBLISHED article that passes the WIDE
 * live gate on a tenant in both `HUB_LIVE_EDIT_TENANTS` and `HUB_LIVE_EDIT_WIDE_TENANTS`.
 * Anything else answers the draft gate's own response (404 / 422 not_editable), so a
 * non-wide tenant sees exactly the old errors. Fake Payload only, no database:
 * `hub-author-handlers.ts` imports `@payload-config`, so a NON-ROUTABLE placeholder
 * DATABASE_URL is set when absent (`getPayload` is never called here).
 *
 *   npm run test:hub-media
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://hub-media-unit@127.0.0.1:1/hub_media_unit_no_db";
process.env.PAYLOAD_SECRET ??= "hub-media-unit-placeholder";

type Doc = Record<string, unknown>;
let h: typeof import("./hub-author-handlers");

before(async () => {
  h = await import("./hub-author-handlers");
});

const PUBLISHED: Doc = { id: 5, tenant: 1, origin: "manual", workflowStatus: "published", _status: "published", version: 4, lastEngine: null, engineDraftId: null };

function world(o: { main?: Doc; latest?: Doc; hubAuthor?: boolean } = {}) {
  const main = { ...PUBLISHED, ...o.main };
  const latest = { ...main, ...o.latest };
  const reads: Doc[] = [];
  const payload = {
    async findByID(a: Doc) {
      reads.push(a);
      if (a.collection === "content-engines") return { id: 7, hubAuthor: o.hubAuthor ?? true };
      if (a.collection === "articles") return a.draft ? { ...latest } : { ...main };
      return null;
    },
  } as unknown as Payload;
  return { payload, reads };
}

const TENANT = { id: 1, slug: "gcv" };
const ON = { liveTenants: ["gcv"], wideTenants: ["gcv"] };
const result = async (r: Awaited<ReturnType<typeof h.loadHubMediaArticle>>) =>
  r.ok ? { ok: true, articleId: r.articleId } : { ok: false, status: r.response.status, body: await r.response.json() };
const notEditable = (reason: string) => ({ ok: false, status: 422, body: { ok: false, status: "not_editable", reason } });

test("a hub-authored manual draft is accepted exactly as before, wide or not", async () => {
  const draft = { workflowStatus: "draft", _status: "draft", lastEngine: 7 };
  for (const deps of [ON, { liveTenants: [], wideTenants: [] }]) {
    const w = world({ main: draft });
    assert.deepEqual(await result(await h.loadHubMediaArticle(w.payload, TENANT, "5", deps)), { ok: true, articleId: 5 });
  }
  // not hub-authored draft ⇒ the draft gate's not_hub_authored, even when wide
  const w = world({ main: { ...draft, lastEngine: 9 }, hubAuthor: false });
  assert.deepEqual(await result(await h.loadHubMediaArticle(w.payload, TENANT, "5", ON)), notEditable("not_hub_authored"));
});

test("a published engine or CMS hand-made article is accepted only on a wide tenant", async () => {
  const engine = { origin: "engine", engineDraftId: "content-engine:gcv:1", lastEngine: 9 };
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: engine }).payload, TENANT, "5", ON)), { ok: true, articleId: 5 });
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ hubAuthor: false }).payload, TENANT, "5", ON)), { ok: true, articleId: 5 });
  // not wide / wide without the narrow switch / the narrow switch only ⇒ the old not_editable answers
  for (const deps of [{ liveTenants: ["gcv"], wideTenants: [] }, { liveTenants: [], wideTenants: ["gcv"] }, { liveTenants: ["dtw"], wideTenants: ["dtw"] }]) {
    assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: engine }).payload, TENANT, "5", deps)), notEditable("origin"), JSON.stringify(deps));
    assert.deepEqual(await result(await h.loadHubMediaArticle(world().payload, TENANT, "5", deps)), notEditable("status"), JSON.stringify(deps));
  }
});

test("wide tenant still refuses import, scheduled, hidden and draft_diverged with the draft gate's answer", async () => {
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: { origin: "import" } }).payload, TENANT, "5", ON)), notEditable("origin"));
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ latest: { workflowStatus: "scheduled", _status: "draft" } }).payload, TENANT, "5", ON)), notEditable("status"));
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: { workflowStatus: "hidden" } }).payload, TENANT, "5", ON)), notEditable("status"));
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ latest: { _status: "draft", version: 5 } }).payload, TENANT, "5", ON)), notEditable("status"));
  assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: { origin: "engine" }, latest: { version: 5 } }).payload, TENANT, "5", ON)), notEditable("origin"));
});

test("404s stay 404 (id shape, other tenant) and no live read happens after a 404", async () => {
  const w = world();
  const r = await result(await h.loadHubMediaArticle(w.payload, TENANT, "abc", ON));
  assert.equal(r.status, 404);
  assert.equal(w.reads.length, 0);
  const other = world({ main: { tenant: 2 } });
  assert.equal((await result(await h.loadHubMediaArticle(other.payload, TENANT, "5", ON))).status, 404);
});

test("the switches default to the env on every call", async () => {
  const keys = ["HUB_LIVE_EDIT_TENANTS", "HUB_LIVE_EDIT_WIDE_TENANTS"] as const;
  const prev = keys.map((k) => process.env[k]);
  try {
    process.env.HUB_LIVE_EDIT_TENANTS = "gcv";
    process.env.HUB_LIVE_EDIT_WIDE_TENANTS = "gcv";
    assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: { origin: "engine" } }).payload, TENANT, "5")), { ok: true, articleId: 5 });
    delete process.env.HUB_LIVE_EDIT_WIDE_TENANTS;
    assert.deepEqual(await result(await h.loadHubMediaArticle(world({ main: { origin: "engine" } }).payload, TENANT, "5")), notEditable("origin"));
  } finally {
    keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
});

test("the media route uses loadHubMediaArticle; loadHubEditableArticle keeps its other callers", () => {
  const route = readFileSync(path.resolve(process.cwd(), "src/app/api/hub/media/route.ts"), "utf8");
  assert.match(route, /const article = await loadHubMediaArticle\(payload, tenant, f\.articleId\);/);
  assert.equal(/loadHubEditableArticle\(/.test(route), false);
  const direct = readFileSync(path.resolve(process.cwd(), "src/lib/hub-direct-upload-core.ts"), "utf8");
  assert.match(direct, /loadHubEditableArticle/);
});
