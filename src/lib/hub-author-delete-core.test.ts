/**
 * Unit tests for ./hub-author-delete-core (hub "Xoá nháp", 10-11-26). Node's built-in
 * runner, FAKE Payload only: no database is reached. The core imports `@payload-config`,
 * which refuses to load without a DATABASE_URL, so a NON-ROUTABLE placeholder is set.
 *
 *   npm run test:hub-delete
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://hubdel-unit@127.0.0.1:1/hubdel_unit_no_db";
process.env.PAYLOAD_SECRET ??= "hubdel-unit-placeholder";

type Doc = Record<string, unknown>;
type Core = typeof import("./hub-author-delete-core");
let core: Core;

before(async () => {
  core = await import("./hub-author-delete-core");
});

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;

interface WorldOpts {
  main?: Doc;
  latest?: Doc;
  hubAuthor?: boolean;
  deleteThrows?: unknown;
}

function world(o: WorldOpts = {}) {
  const base: Doc = { id: 5, tenant: 1, origin: "manual", workflowStatus: "draft", _status: "draft", version: 3, lastEngine: 7, slug: "s-5", title: "T" };
  const main = { ...base, ...o.main };
  const latest = { ...base, ...o.main, ...o.latest };
  const log = { events: [] as string[], deletes: [] as Doc[], activity: [] as Doc[] };
  const payload = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    async findByID(a: Doc) {
      if (a.collection === "tenants") return { id: 1, slug: "gcv", status: "active", features: { articles: true } };
      if (a.collection === "content-engines") return { id: 7, hubAuthor: o.hubAuthor ?? true };
      if (a.collection === "articles") {
        log.events.push(`read:${a.draft ? "latest" : "main"}${a.req ? ":tx" : ""}`);
        return a.draft ? latest : main;
      }
      return null;
    },
    async delete(a: Doc) {
      log.events.push(`delete:${String(a.collection)}${a.req ? ":tx" : ""}`);
      log.deletes.push(a);
      if (o.deleteThrows && a.collection === "articles") throw o.deleteThrows;
      return { docs: [], errors: [] };
    },
    async create(a: Doc) {
      log.events.push(`create:${String(a.collection)}`);
      if (a.collection === "activityLog") log.activity.push(a.data as Doc);
      return a.data;
    },
  } as unknown as Payload;
  const lockCalls: Doc[] = [];
  const deps = {
    getPayload: async () => payload,
    authenticate: async () => ({ ok: true as const, engine: { id: 7, hubAuthor: true } as never, tenants: [{ id: 1, slug: "gcv" }] }),
    findMain: async () => main,
    lock: (async (args: Doc, fn: (ctx: never) => Promise<{ ok: boolean; value: Response }>) => {
      lockCalls.push(args);
      log.events.push("lock");
      const r = await fn({ req: { transactionID: "tx1" }, lockSlug: async () => {} } as never);
      log.events.push(r.ok ? "commit" : "rollback");
      return r.value;
    }) as never,
  };
  return { payload, deps, log, lockCalls };
}

const req = (body: unknown) =>
  new Request("http://x/api/hub/articles/5/delete", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const ctx = (id = "5") => ({ params: Promise.resolve({ id }) });
const BODY = { tenant: "gcv", expectedVersion: 3, actor: ACTOR };

test("deleteGate: manual never-published draft passes; everything else is refused", () => {
  const d = { origin: "manual", workflowStatus: "draft", _status: "draft" };
  assert.equal(core.deleteGate(d, d), null);
  assert.equal(core.deleteGate({ ...d, _status: "published" }, d), "status");
  assert.equal(core.deleteGate({ ...d, workflowStatus: "published" }, d), "status");
  assert.equal(core.deleteGate(d, { ...d, workflowStatus: "scheduled" }), "status");
  assert.equal(core.deleteGate({ ...d, origin: "engine" }, d), "origin");
  assert.equal(core.deleteGate(null, d), "origin");
});

test("happy path: translation jobs, then the article, inside the lock; activity after commit", async () => {
  const w = world();
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 5, tenant: "gcv", deleted: true });
  assert.deepEqual(w.lockCalls, [{ tenantId: 1, articleId: 5 }]);
  const order = w.log.events.filter((e) => e.startsWith("delete") || e === "commit" || e.startsWith("create"));
  assert.deepEqual(order, ["delete:translationJobs:tx", "delete:articles:tx", "commit", "create:activityLog"]);
  const tj = w.log.deletes[0]!;
  assert.deepEqual(tj.where, { article: { equals: 5 } });
  const art = w.log.deletes[1]!;
  assert.equal(art.id, 5);
  assert.equal((art.context as Doc).disableRevalidate, true);
  assert.equal(w.log.activity.length, 1);
  const a = w.log.activity[0]!;
  assert.equal(a.eventType, "status_changed");
  assert.equal(a.toStatus, "deleted");
  assert.equal(a.targetId, "5");
  assert.deepEqual((a.detail as Doc).actor, ACTOR);
});

test("a published main row is never deleted (422 not_editable status)", async () => {
  const w = world({ main: { _status: "published" } });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { ok: false, status: "not_editable", reason: "status" });
  assert.equal(w.log.deletes.length, 0);
  assert.equal(w.log.activity.length, 0);
});

test("a scheduled draft must be unscheduled first (422 status)", async () => {
  const w = world({ latest: { workflowStatus: "scheduled" } });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 422);
  assert.equal(w.log.deletes.length, 0);
});

test("a draft not created by the hub is refused (422 not_hub_authored)", async () => {
  const w = world({ hubAuthor: false });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as Doc).reason, "not_hub_authored");
  assert.equal(w.log.deletes.length, 0);
});

test("stale expectedVersion ⇒ 409 version_conflict, nothing deleted", async () => {
  const w = world();
  const res = await core.handleHubDraftDeleteWith(req({ ...BODY, expectedVersion: 2 }), ctx(), w.deps);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, status: "version_conflict", reason: "article version changed", currentVersion: 3 });
  assert.equal(w.log.deletes.length, 0);
});

test("article of another tenant ⇒ the same 404; malformed id ⇒ 404 without a lock", async () => {
  const w = world({ main: { tenant: 2 } });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 404);
  assert.equal(w.log.deletes.length, 0);
  const w2 = world();
  const res2 = await core.handleHubDraftDeleteWith(req(BODY), ctx("abc"), w2.deps);
  assert.equal(res2.status, 404);
  assert.equal(w2.lockCalls.length, 0);
});

test("missing actor / expectedVersion ⇒ 422 invalid; unknown key ⇒ 400", async () => {
  const w = world();
  const r1 = await core.handleHubDraftDeleteWith(req({ tenant: "gcv" }), ctx(), w.deps);
  assert.equal(r1.status, 422);
  const r2 = await core.handleHubDraftDeleteWith(req({ ...BODY, title: "x" }), ctx(), w.deps);
  assert.equal(r2.status, 400);
  assert.equal(w.log.deletes.length, 0);
});

test("tenant outside the grant ⇒ 403", async () => {
  const w = world();
  const res = await core.handleHubDraftDeleteWith(req({ ...BODY, tenant: "wad" }), ctx(), w.deps);
  assert.equal(res.status, 403);
  assert.equal(w.log.deletes.length, 0);
});

test("delete failure ⇒ 500 internal_error, rolled back, no 'deleted' activity row", async () => {
  const w = world({ deleteThrows: Object.assign(new Error("boom"), { name: "DatabaseError" }) });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 500);
  assert.ok(w.log.events.includes("rollback"));
  assert.equal(w.log.activity.filter((a) => a.toStatus === "deleted").length, 0);
});

test("a busy lock-class error on delete ⇒ 503 busy", async () => {
  const w = world({ deleteThrows: Object.assign(new Error("lock"), { code: "55P03" }) });
  const res = await core.handleHubDraftDeleteWith(req(BODY), ctx(), w.deps);
  assert.equal(res.status, 503);
});
