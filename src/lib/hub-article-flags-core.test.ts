/**
 * Unit tests for ./hub-article-flags-core (`POST /api/hub/articles/{id}/flags`), the
 * editorial-key gate of the two draft routes (./hub-author-handlers) and the `hubFlags`
 * branches of the Articles hooks (../hooks/article-workflow). Content-engine plan
 * process/features/apcg-hub/active/hub-pin-exclusive-flags_PLAN_28-10-26.md (D6–D11,
 * Public Contracts CMS 1 / 6 / 7). Node's built-in runner, FAKE Payload only: no database
 * is ever reached. The cores import `@payload-config`, which refuses to load without a
 * DATABASE_URL, so a NON-ROUTABLE placeholder is set below when the variable is absent
 * (port 1 on 127.0.0.1; `getPayload` is never called here).
 *
 *   npm run test:hub-flags
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://hub-flags-unit@127.0.0.1:1/hub_flags_unit_no_db";
process.env.PAYLOAD_SECRET ??= "hub-flags-unit-placeholder";

type Doc = Record<string, unknown>;
type Core = typeof import("./hub-article-flags-core");
type Handlers = typeof import("./hub-author-handlers");
type Workflow = typeof import("../hooks/article-workflow");
type Flags = typeof import("./hub-author-flags");
type Publish = typeof import("./hub-author-publish-core");

let core: Core;
let handlers: Handlers;
let wf: Workflow;
let flagsMod: Flags;
let publishMod: Publish;

before(async () => {
  core = await import("./hub-article-flags-core");
  handlers = await import("./hub-author-handlers");
  wf = await import("../hooks/article-workflow");
  flagsMod = await import("./hub-author-flags");
  publishMod = await import("./hub-author-publish-core");
});

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LOCK_REQ = { transactionID: "tx1" } as const;

// ── a fake world: one tenant (gcv, id 1), one article (id 5) ─────────────────

interface WorldOpts {
  main?: Doc;
  latest?: Doc;
  /** The update throws this. */
  updateThrows?: unknown;
  /** The update also changes this column (a slipped write — D8). */
  slip?: Doc;
  /** After the update, the LATEST version also gets this (a draft landing mid-flight — D8 `latest` leg). */
  latestSlip?: Doc;
}

function world(o: WorldOpts = {}) {
  const tenant = { id: 1, slug: "gcv", status: "active", defaultLanguage: "en", supportedLanguages: ["en"], features: { articles: true, translations: false } };
  const base: Doc = {
    id: 5, tenant: 1, slug: "s-5", origin: "engine", engineDraftId: "eng-5", workflowStatus: "published", _status: "published", version: 4,
    title: "Engine title", dek: null, body: null, pillar: 11, author: 3, publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    exclusive: false, pinnedToLatest: false, pinnedUntil: null, views: 7, lastEditedBy: null,
  };
  const st = { main: { ...base, ...o.main } as Doc, latest: { ...base, ...o.main, ...o.latest } as Doc };
  const log = { reads: [] as Doc[], updates: [] as Doc[], creates: [] as Doc[], events: [] as string[], revalidates: [] as unknown[][] };
  const payload = {
    logger: { info: () => {}, warn: (m: string) => log.events.push(`warn:${m}`), error: (m: string) => log.events.push(`error:${m}`) },
    db: { sessions: {} },
    async findByID(a: Doc) {
      log.reads.push(a);
      if (a.collection === "tenants") return { ...tenant, features: { ...tenant.features } };
      if (a.collection === "content-engines") return { id: 7, hubAuthor: true };
      if (a.collection === "articles") {
        log.events.push(`read:${a.draft ? "latest" : "main"}${a.req ? ":tx" : ""}${a.locale ? `:${String(a.locale)}` : ""}`);
        return { ...(a.draft ? st.latest : st.main) };
      }
      return null;
    },
    async find() {
      return { docs: [], totalDocs: 0 };
    },
    async create(a: Doc) {
      log.creates.push(a);
      log.events.push(`create:${String(a.collection)}${a.collection === "activityLog" ? `:${String((a.data as Doc).eventType)}` : ""}`);
      if (a.collection === "articles") return { id: 77, slug: (a.data as Doc).slug, version: 1 };
      return {};
    },
    async update(a: Doc) {
      log.updates.push(a);
      log.events.push("update");
      if (o.updateThrows) throw o.updateThrows;
      const next = { ...st.latest, ...(a.data as Doc), ...(o.slip ?? {}), updatedAt: "2026-10-28T10:00:01.000Z" };
      st.main = next;
      st.latest = { ...next, ...(o.latestSlip ?? {}) };
      return { ...next };
    },
  };
  return { payload: payload as unknown as Payload, st, log };
}
type World = ReturnType<typeof world>;

function flagDeps(w: World, extra: Record<string, unknown> = {}) {
  return {
    getPayload: async () => w.payload,
    authenticate: (async () => ({ ok: true, engine: { id: 60, hubRead: true, hubWrite: true, hubAuthor: extra.engineHubAuthor === true }, tenants: [{ id: 1, slug: "gcv" }] })) as never,
    lock: (async (_a: unknown, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
      w.log.events.push("lock");
      const r = await fn({ req: LOCK_REQ, lockSlug: async () => {} });
      w.log.events.push(r.ok ? "commit" : "kill");
      return r.value;
    }) as never,
    lockRow: async () => {
      w.log.events.push("rowlock");
    },
    flagsTenants: ["gcv"],
    now: () => NOW,
    revalidate: async (...args: unknown[]) => {
      w.log.events.push("revalidate");
      w.log.revalidates.push(args.slice(1));
    },
    ...extra,
  };
}
const humanEdits = (w: World) => w.log.creates.filter((c) => c.collection === "activityLog" && (c.data as Doc).eventType === "human_edit");
/** Nothing after a refused / rolled-back call: no audit row, no webhook. */
const noSideEffects = (w: World) => [humanEdits(w).length, w.log.revalidates.length];

const EXPECTED0 = { exclusive: false, pinnedToLatest: false, pinnedUntil: null };
const flagsBody = (set: Doc, extra: Doc = {}): Doc => ({ tenant: "gcv", actor: ACTOR, expected: EXPECTED0, set, ...extra });
async function callFlags(w: World, body: Doc | string, extra: Record<string, unknown> = {}, id = "5") {
  const req = new Request(`http://cms.local/api/hub/articles/${id}/flags`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  const res = await core.handleHubFlagsWith(req, { params: Promise.resolve({ id }) }, flagDeps(w, extra) as never);
  return { status: res.status, body: (await res.json()) as Doc, headers: res.headers };
}

describe("window constants", () => {
  it("are the publish / schedule window (K7) — declared locally, pinned here", () => {
    assert.equal(flagsMod.PIN_UNTIL_MIN_LEAD_SECONDS, publishMod.MIN_LEAD_SECONDS);
    assert.equal(flagsMod.PIN_UNTIL_MAX_DAYS, publishMod.MAX_SCHEDULE_DAYS);
  });
});

describe("POST /api/hub/articles/{id}/flags — check order (first failure wins)", () => {
  it("auth failure is returned as-is; an engine that also has hubAuthor ⇒ 403, nothing read", async () => {
    const w = world();
    const denied = new Response(JSON.stringify({ ok: false, status: "forbidden", reason: "hub write not allowed for this engine" }), { status: 403 });
    const r0 = await callFlags(w, flagsBody({ exclusive: true }), { authenticate: (async () => ({ ok: false, response: denied })) as never });
    assert.deepEqual([r0.status, r0.body.reason], [403, "hub write not allowed for this engine"]);
    const r = await callFlags(w, "not json at all", { engineHubAuthor: true });
    assert.deepEqual([r.status, r.body], [403, { ok: false, status: "forbidden", reason: "author key cannot change flags" }]);
    assert.equal(w.log.reads.length, 0);
    // N1: the refusal is logged like every key refusal (no token, no body).
    const denied1 = w.log.creates.filter((c) => c.collection === "activityLog");
    assert.deepEqual(denied1.map((c) => [(c.data as Doc).eventType, (c.data as Doc).actorEngine, (c.data as Doc).detail]), [["engine_action_denied", 60, { action: "hub_flags", reason: "author key cannot change flags" }]]);
  });

  it("413 / 400 / 422 come before the tenant", async () => {
    const w = world();
    const big = JSON.stringify({ ...flagsBody({ exclusive: true }), pad: "x".repeat(1_000_001) });
    assert.equal((await callFlags(w, big)).status, 413);
    // N2: a tight cap — 16,384 bytes (Content-Length or the stream).
    assert.equal(core.FLAGS_BODY_MAX_BYTES, 16_384);
    const justOver = JSON.stringify({ ...flagsBody({ exclusive: true }), pad: "" });
    const pad = "x".repeat(16_385 - Buffer.byteLength(justOver, "utf8"));
    const over = await callFlags(w, JSON.stringify({ ...flagsBody({ exclusive: true }), pad }));
    assert.deepEqual([over.status, over.body], [413, { ok: false, status: "too_large", reason: "request body exceeds 16384 bytes" }]);
    const pad2 = "x".repeat(16_384 - Buffer.byteLength(justOver, "utf8"));
    assert.deepEqual((await callFlags(w, JSON.stringify({ ...flagsBody({ exclusive: true }), pad: pad2 }))).body, { ok: false, status: "bad_request", reason: "unknown field(s): pad" });
    assert.deepEqual((await callFlags(w, "{")).body, { ok: false, status: "bad_request", reason: "body must be valid JSON" });
    assert.deepEqual((await callFlags(w, flagsBody({ exclusive: true }, { tenant: "nope", extra: 1 }))).body, { ok: false, status: "bad_request", reason: "unknown field(s): extra" });
    const r = await callFlags(w, flagsBody({ pinnedToLatest: true, pinnedUntil: iso(NOW + 30_000) }, { tenant: "nope" }));
    assert.deepEqual([r.status, r.body.fields], [422, { pinnedUntil: "out_of_range" }]);
    assert.deepEqual((await callFlags(w, flagsBody({}, { tenant: "nope" }))).body.fields, { set: "required" });
    assert.equal(w.log.reads.filter((x) => x.collection === "articles").length, 0);
  });

  it("tenant outside the grant ⇒ 403 + allowedTenants (logged); then the switch; then the id", async () => {
    const w = world();
    const r = await callFlags(w, flagsBody({ exclusive: true }, { tenant: "dtw" }));
    assert.deepEqual([r.status, r.body], [403, { ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: ["gcv"] }]);
    assert.equal(w.log.creates.filter((c) => c.collection === "activityLog" && (c.data as Doc).eventType === "engine_tenant_denied").length, 1);
    const off = await callFlags(w, flagsBody({ exclusive: true }), { flagsTenants: ["world-travel-brief"] });
    assert.deepEqual([off.status, off.body], [403, { ok: false, status: "feature_disabled", reason: "editorial flags disabled for tenant" }]);
    for (const bad of ["abc", "0", "05", "2147483648"]) {
      const nf = await callFlags(w, flagsBody({ exclusive: true }), {}, bad);
      assert.deepEqual([nf.status, nf.body], [404, { ok: false, status: "not_found", reason: "article not found for tenant" }], bad);
    }
    assert.equal(w.log.reads.filter((x) => x.collection === "articles").length, 0);
    assert.equal(w.log.events.includes("lock"), false);
  });

  it("L1: article of another tenant ⇒ the same 404 body BEFORE any lock (no row lock on another tenant's row)", async () => {
    const w = world({ main: { tenant: 2 } });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body], [404, { ok: false, status: "not_found", reason: "article not found for tenant" }]);
    assert.deepEqual(w.log.events, ["read:main"]);
    const missing = world({ main: { tenant: 1 } });
    (missing.payload as unknown as { findByID: (a: Doc) => Promise<unknown> }).findByID = async (a: Doc) => (a.collection === "tenants" ? { id: 1, slug: "gcv", features: { articles: true } } : null);
    const r2 = await callFlags(missing, flagsBody({ exclusive: true }));
    assert.deepEqual([r2.status, r2.body], [404, { ok: false, status: "not_found", reason: "article not found for tenant" }]);
    // The tenant is checked again inside the lock (same 404 body).
    const w3 = world({ latest: { tenant: 2 } });
    const r3 = await callFlags(w3, flagsBody({ exclusive: true }));
    assert.deepEqual([r3.status, r3.body.status], [404, "not_found"]);
    assert.deepEqual(w3.log.events, ["read:main", "lock", "rowlock", "read:latest:tx", "kill"]);
    assert.deepEqual([...noSideEffects(w), ...noSideEffects(w3)], [0, 0, 0, 0]);
  });

  it("D9 gate: 422 not_flaggable status / legacy_status / scheduled; 409 draft_diverged", async () => {
    const cases: [Doc, Doc, number, Doc][] = [
      [{ workflowStatus: "hidden" }, {}, 422, { ok: false, status: "not_flaggable", reason: "status" }],
      [{ _status: "draft" }, {}, 422, { ok: false, status: "not_flaggable", reason: "legacy_status" }],
      [{ workflowStatus: "draft", _status: "draft" }, { workflowStatus: "scheduled" }, 422, { ok: false, status: "not_flaggable", reason: "scheduled" }],
      [{}, { _status: "draft", version: 5 }, 409, { ok: false, status: "draft_diverged", reason: "article has unpublished changes" }],
    ];
    for (const [main, latest, status, body] of cases) {
      const w = world({ main, latest });
      const r = await callFlags(w, flagsBody({ exclusive: true }));
      assert.deepEqual([r.status, r.body], [status, body], JSON.stringify(main));
      assert.equal(w.log.updates.length, 0);
    }
  });

  it("expected ≠ the stored values ⇒ 409 flags_conflict with `current`", async () => {
    const w = world({ main: { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" } });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body], [409, {
      ok: false, status: "flags_conflict", reason: "flags changed since they were read",
      current: { exclusive: false, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" },
    }]);
    assert.equal(w.log.updates.length, 0);
    // Same instant, other spelling ⇒ no conflict.
    const w2 = world({ main: { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" } });
    const r2 = await callFlags(w2, flagsBody({ exclusive: true }, { expected: { exclusive: false, pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00Z" } }));
    assert.equal(r2.status, 200);
  });

  it("nothing to change ⇒ 200 changed: [] and NO write", async () => {
    const w = world();
    const r = await callFlags(w, flagsBody({ exclusive: false, pinnedToLatest: false, pinnedUntil: null }));
    assert.deepEqual([r.status, r.body], [200, { ok: true, id: 5, tenant: "gcv", exclusive: false, pinnedToLatest: false, pinnedUntil: null, changed: [] }]);
    assert.equal(w.log.updates.length, 0);
    assert.deepEqual(noSideEffects(w), [0, 0]);
  });
});

describe("POST …/flags — the write (D6 / D7 / D8)", () => {
  it("one NON-draft update of the changed columns only, context hubFlags + skipTranslationEnqueue, on the lock's req", async () => {
    const w = world();
    const until = iso(NOW + 2 * 3_600_000);
    const r = await callFlags(w, flagsBody({ exclusive: true, pinnedToLatest: true, pinnedUntil: until }));
    assert.deepEqual([r.status, r.body], [200, { ok: true, id: 5, tenant: "gcv", exclusive: true, pinnedToLatest: true, pinnedUntil: until, changed: ["exclusive", "pinnedToLatest", "pinnedUntil"] }]);
    assert.equal(w.log.updates.length, 1);
    const u = w.log.updates[0]!;
    assert.equal("draft" in u, false);
    assert.equal(u.req, LOCK_REQ);
    assert.equal(u.overrideAccess, true);
    assert.equal(u.depth, 0);
    assert.deepEqual(u.data, { exclusive: true, pinnedToLatest: true, pinnedUntil: until });
    const hf = { actor: ACTOR, fields: ["exclusive", "pinnedToLatest", "pinnedUntil"], from: { exclusive: false, pinnedToLatest: false, pinnedUntil: null }, to: { exclusive: true, pinnedToLatest: true, pinnedUntil: until } };
    assert.deepEqual(u.context, { hubFlags: hf, engineId: 60, skipTranslationEnqueue: true, disableRevalidate: true });
    // Order: unlocked ownership read → lock → row lock → gate reads → pre → write → post + latest → COMMIT
    // → (after the commit only) the ONE audit row → the ONE webhook.
    assert.deepEqual(w.log.events.filter((e) => !e.startsWith("warn")), [
      "read:main", "lock", "rowlock", "read:latest:tx", "read:main:tx", "read:main:tx:all", "update", "read:main:tx:all", "read:latest:tx", "commit", "create:activityLog:human_edit", "revalidate",
    ]);
    const he = humanEdits(w);
    assert.equal(he.length, 1);
    const d = he[0]!.data as Doc;
    assert.deepEqual([d.actorType, d.actorEngine, d.targetCollection, d.targetId, d.tenant, d.fromStatus, d.toStatus, d.detail], ["engine", 60, "articles", "5", 1, "published", "published", { via: "hub", ...hf, action: "flags" }]);
    assert.deepEqual(w.log.revalidates, [[1, ["articles:all"], "s-5"]]);
  });

  it("M1 / L2: no audit row and no webhook when the COMMIT does not happen (lock helper answers 503 after the block)", async () => {
    const w = world();
    const r = await callFlags(w, flagsBody({ exclusive: true }), {
      lock: (async (_a: unknown, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
        await fn({ req: LOCK_REQ, lockSlug: async () => {} });
        return new Response(JSON.stringify({ ok: false, status: "busy", reason: "article is being modified, retry" }), { status: 503 });
      }) as never,
    });
    assert.equal(r.status, 503);
    assert.deepEqual(noSideEffects(w), [0, 0]);
  });

  it("writes in the article's source language (Payload validates required localized fields in the write locale)", async () => {
    const w = world({ main: { sourceLanguage: "vi" } });
    assert.equal((await callFlags(w, flagsBody({ exclusive: true }))).status, 200);
    assert.equal(w.log.updates[0]!.locale, "vi");
    const w2 = world();
    assert.equal((await callFlags(w2, flagsBody({ exclusive: true }))).status, 200);
    assert.equal(w2.log.updates[0]!.locale, "en", "no sourceLanguage ⇒ the tenant default");
    assert.equal(core.writeLocaleOf({}, {}), "en");
    assert.equal(core.writeLocaleOf({ sourceLanguage: "" }, { defaultLanguage: "fr" }), "fr");
  });

  it("unpin: only the changed keys are written", async () => {
    const until = "2026-10-30T11:00:00.000Z";
    const w = world({ main: { pinnedToLatest: true, pinnedUntil: until } });
    const r = await callFlags(w, flagsBody({ pinnedToLatest: false, pinnedUntil: null }, { expected: { exclusive: false, pinnedToLatest: true, pinnedUntil: until } }));
    assert.deepEqual([r.status, r.body.changed, w.log.updates[0]!.data], [200, ["pinnedToLatest", "pinnedUntil"], { pinnedToLatest: false, pinnedUntil: null }]);
  });

  it("ValidationError on `exclusive` (single-home V6) ⇒ 422 fields.exclusive invalid; rollback", async () => {
    const err = Object.assign(new Error("x"), { name: "ValidationError", data: { errors: [{ path: "exclusive", message: "secret text" }] } });
    const w = world({ updateThrows: err });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body], [422, { ok: false, status: "invalid", reason: "one or more fields are invalid", fields: { exclusive: "invalid" } }]);
    assert.equal(w.log.events.at(-1), "kill");
    assert.equal(JSON.stringify(r.body).includes("secret"), false);
    assert.deepEqual(noSideEffects(w), [0, 0]);
  });

  it("busy codes ⇒ 503 + Retry-After; any other write error ⇒ 500 (name + code only)", async () => {
    const w = world({ updateThrows: Object.assign(new Error("lock"), { code: "55P03" }) });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body.status, r.headers.get("retry-after")], [503, "busy", "2"]);
    const w2 = world({ updateThrows: Object.assign(new Error("dup secret"), { code: "23505" }) });
    const r2 = await callFlags(w2, flagsBody({ exclusive: true }));
    assert.deepEqual([r2.status, r2.body], [500, { ok: false, status: "internal_error" }]);
    assert.equal(w2.log.events.some((e) => e.includes("dup secret")), false);
  });

  it("D8 (L2): another column moved / the latest version diverged ⇒ rollback + 409 draft_diverged, a warn naming the column (never its value)", async () => {
    const DIVERGED = { ok: false, status: "draft_diverged", reason: "article has unpublished changes" };
    const w = world({ slip: { title: "SLIPPED SECRET" } });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body], [409, DIVERGED]);
    assert.equal(w.log.events.at(-1), "kill");
    const warnLine = w.log.events.find((e) => e.startsWith("warn:") && e.includes("post-write")) ?? "";
    assert.match(warnLine, /post-write check failed: article=5 tenant=gcv leg=fields keys=title/);
    assert.equal(w.log.events.some((e) => e.includes("SLIPPED")), false);
    // A version bump is a slipped write too (bookkeeping must have been skipped).
    const w2 = world({ slip: { version: 5 } });
    assert.deepEqual([(await callFlags(w2, flagsBody({ exclusive: true }))).status], [409]);
    // A draft landing mid-flight (the latest version no longer the published one).
    const w3 = world({ latestSlip: { _status: "draft", version: 5 } });
    assert.deepEqual((await callFlags(w3, flagsBody({ exclusive: true }))).body, DIVERGED);
    assert.deepEqual([...noSideEffects(w), ...noSideEffects(w2), ...noSideEffects(w3)], [0, 0, 0, 0, 0, 0]);
  });

  it("D8: our own value did not land ⇒ rollback + 500 + error log + integration_error (no audit row, no webhook)", async () => {
    const w = world({ slip: { exclusive: false } });
    const r = await callFlags(w, flagsBody({ exclusive: true }));
    assert.deepEqual([r.status, r.body], [500, { ok: false, status: "internal_error" }]);
    assert.equal(w.log.events.at(-1), "kill");
    assert.match(w.log.events.find((e) => e.startsWith("error:")) ?? "", /leg=values keys=exclusive/);
    assert.equal(w.log.creates.filter((c) => c.collection === "activityLog" && (c.data as Doc).eventType === "integration_error").length, 1);
    assert.deepEqual(noSideEffects(w), [0, 0]);
  });
});

describe("source pins", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("the route is a thin POST wrapper with maxDuration 30", () => {
    const route = readFileSync(path.resolve(process.cwd(), "src/app/api/hub/articles/[id]/flags/route.ts"), "utf8");
    assert.match(route, /export const maxDuration = 30;/);
    assert.match(route, /export const POST = \(request: Request, ctx: \{ params: Promise<\{ id: string \}> \}\) => handleHubFlags\(request, ctx\);/);
    assert.equal(/export const (GET|PATCH|PUT|DELETE)/.test(route), false);
  });
  it("the core has exactly one write: no draft, WITH disableRevalidate (M1: the webhook is posted after the commit), no hubWrite / hubAuthor context", () => {
    const src = strip(readFileSync(path.resolve(process.cwd(), "src/lib/hub-article-flags-core.ts"), "utf8"));
    const at = src.indexOf("await payload.update({");
    assert.equal(at > 0 && src.indexOf("await payload.update({", at + 1) === -1, true, "exactly one write");
    const block = src.slice(at, src.indexOf("});", at));
    assert.equal(/draft|hubWrite|hubAuthor|workflowStatus|_status|publishedAt/.test(block), false, block);
    assert.match(block, /context: \{ hubFlags: \{ actor: v\.actor, fields: change\.changed, from: change\.from, to: change\.to \}, engineId: engine\.id, skipTranslationEnqueue: true, disableRevalidate: true \}/);
    assert.equal(/payload\.create\(/.test(src), false);
    // The webhook is posted only from afterCommit (one call site), never from inside the lock.
    assert.equal((src.match(/revalidateTenantDoc\)/g) ?? []).length, 1);
    const inLockAt = src.indexOf("async function inLock(");
    assert.equal(inLockAt > 0 && /revalidateTenantDoc|deps\?\.revalidate|afterCommit\(/.test(src.slice(inLockAt)), false);
  });
  it("ARTICLE_REVALIDATE_TAGS = the Articles collection hook's tags", () => {
    const articles = readFileSync(path.resolve(process.cwd(), "src/collections/Articles.ts"), "utf8");
    const m = /revalidateHooks\((\[[^\]]*\])\)/.exec(articles);
    assert.ok(m);
    assert.deepEqual(JSON.parse(m![1]!), [...core.ARTICLE_REVALIDATE_TAGS]);
  });
});

// ── the draft routes (D10 / D11 / D12 on the CMS side) ───────────────────────

function draftWorld(o: { latest?: Doc } = {}) {
  const w = world({
    main: { origin: "manual", engineDraftId: null, workflowStatus: "draft", _status: "draft", lastEngine: 7, version: 3 },
    latest: o.latest,
  });
  return w;
}
function draftDeps(w: World, extra: Record<string, unknown> = {}) {
  return {
    getPayload: async () => w.payload,
    authenticate: (async () => ({ ok: true, engine: { id: 61, hubRead: true, hubAuthor: true }, tenants: [{ id: 1, slug: "gcv" }] })) as never,
    lock: (async (_a: unknown, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
      const r = await fn({ req: LOCK_REQ, lockSlug: async () => {} });
      return r.value;
    }) as never,
    editorialTenants: ["gcv"],
    now: () => NOW,
    ...extra,
  };
}
async function post(w: World, body: Doc, extra: Record<string, unknown> = {}) {
  const req = new Request("http://cms.local/api/hub/articles", { method: "POST", body: JSON.stringify({ tenant: "gcv", title: "Bài nháp", actor: ACTOR, ...body }) });
  const res = await handlers.handleHubDraftCreateWith(req, draftDeps(w, extra) as never);
  return { status: res.status, body: (await res.json()) as Doc };
}
async function patch(w: World, body: Doc, extra: Record<string, unknown> = {}) {
  const req = new Request("http://cms.local/api/hub/articles/5", { method: "PATCH", body: JSON.stringify({ tenant: "gcv", expectedVersion: 3, actor: ACTOR, ...body }) });
  const res = await handlers.handleHubDraftUpdateWith(req, { params: Promise.resolve({ id: "5" }) }, draftDeps(w, extra) as never);
  return { status: res.status, body: (await res.json()) as Doc };
}
const articleCreates = (w: World) => w.log.creates.filter((c) => c.collection === "articles");

describe("POST /api/hub/articles with editorial keys", () => {
  it("switch off ⇒ 422 not_enabled on every key present, nothing created", async () => {
    const w = draftWorld();
    const r = await post(w, { exclusive: true, pinnedToLatest: true, pinnedUntil: iso(NOW - DAY) }, { editorialTenants: ["dtw"] });
    assert.deepEqual([r.status, r.body.fields], [422, { exclusive: "not_enabled", pinnedToLatest: "not_enabled", pinnedUntil: "not_enabled" }]);
    assert.equal(articleCreates(w).length, 0);
  });

  it("switch on: window checked with the injected now", async () => {
    const w = draftWorld();
    const r = await post(w, { pinnedToLatest: true, pinnedUntil: iso(NOW + 59_000) });
    assert.deepEqual([r.status, r.body.fields], [422, { pinnedUntil: "out_of_range" }]);
    assert.equal(articleCreates(w).length, 0);
  });

  it("switch on: the columns are written, the hubAuthor context carries `fields` (D11)", async () => {
    const w = draftWorld();
    const until = iso(NOW + 3_600_000);
    const r = await post(w, { exclusive: true, pinnedToLatest: true, pinnedUntil: until });
    assert.equal(r.status, 201);
    const c = articleCreates(w)[0]!;
    const d = c.data as Doc;
    assert.deepEqual([d.exclusive, d.pinnedToLatest, d.pinnedUntil, c.draft], [true, true, until, true]);
    assert.deepEqual(c.context, { hubAuthor: { actor: ACTOR, action: "create", fields: ["exclusive", "pinnedToLatest", "pinnedUntil"] }, engineId: 61, disableRevalidate: true });
  });

  it("no editorial key ⇒ the old create, byte for byte (no fields in the context, no switch read)", async () => {
    const w = draftWorld();
    const r = await post(w, {}, { editorialTenants: undefined });
    assert.equal(r.status, 201);
    const c = articleCreates(w)[0]!;
    assert.deepEqual(c.context, { hubAuthor: { actor: ACTOR, action: "create" }, engineId: 61, disableRevalidate: true });
    for (const k of ["exclusive", "pinnedToLatest", "pinnedUntil"]) assert.equal(k in (c.data as Doc), false, k);
  });
});

describe("PATCH /api/hub/articles/{id} with editorial keys", () => {
  it("switch off ⇒ 422 not_enabled before any article read", async () => {
    const w = draftWorld();
    const r = await patch(w, { exclusive: true }, { editorialTenants: [] });
    assert.deepEqual([r.status, r.body.fields], [422, { exclusive: "not_enabled" }]);
    assert.equal(w.log.reads.filter((x) => x.collection === "articles").length, 0);
  });

  it("compares with the LATEST version; pinnedUntil by instant; `changed` names the keys; draft write", async () => {
    const until = "2026-10-30T11:00:00.000Z";
    const w = draftWorld({ latest: { pinnedToLatest: true, pinnedUntil: until } });
    const same = await patch(w, { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00Z", exclusive: false });
    assert.deepEqual([same.status, same.body.changed], [200, []]);
    assert.equal(w.log.updates.length, 0);
    const r = await patch(w, { pinnedToLatest: false, pinnedUntil: null, exclusive: true });
    assert.deepEqual([r.status, r.body.changed], [200, ["pinnedToLatest", "pinnedUntil", "exclusive"]]);
    const u = w.log.updates[0]!;
    assert.deepEqual([u.draft, (u.data as Doc).pinnedToLatest, (u.data as Doc).pinnedUntil, (u.data as Doc).exclusive], [true, false, null, true]);
    assert.deepEqual((u.context as Doc).hubAuthor, { actor: ACTOR, action: "update", fields: ["pinnedToLatest", "pinnedUntil", "exclusive"] });
  });

  it("buildDraftUpdateData: only the pinnedUntil changes when the tick is the same", async () => {
    const w = draftWorld({ latest: { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" } });
    const r = await patch(w, { pinnedToLatest: true, pinnedUntil: iso(NOW + DAY) });
    assert.deepEqual([r.status, r.body.changed, w.log.updates[0]!.data], [200, ["pinnedUntil"], { pinnedUntil: iso(NOW + DAY), workflowStatus: "draft", _status: "draft" }]);
  });
});

// ── hooks (D7 / D11) ─────────────────────────────────────────────────────────

function hookReq(context: Doc) {
  const creates: Doc[] = [];
  const payload = { create: async (a: Doc) => { creates.push(a); return {}; }, logger: { error: () => {} } };
  return { req: { context, payload, user: null } as never, creates };
}

describe("article-workflow hooks", () => {
  it("articleBookkeeping returns early on context.hubFlags (no version bump)", async () => {
    const { req } = hookReq({ hubFlags: { actor: ACTOR, fields: ["exclusive"], from: { exclusive: false }, to: { exclusive: true } }, engineId: 60 });
    const data: Doc = { exclusive: true };
    const out = (await wf.articleBookkeeping({ data, originalDoc: { version: 4 }, req, operation: "update" } as never)) as Doc;
    assert.deepEqual(out, { exclusive: true });
    // Control: without hubFlags the same call bumps the version.
    const { req: r2 } = hookReq({ engineId: 60 });
    const out2 = (await wf.articleBookkeeping({ data: { exclusive: true }, originalDoc: { version: 4 }, req: r2, operation: "update" } as never)) as Doc;
    assert.equal(out2.version, 5);
  });

  it("articleActivity writes NOTHING for context.hubFlags (L2: the route writes its row after the commit)", async () => {
    const hf = { actor: ACTOR, fields: ["pinnedToLatest", "pinnedUntil"], from: { pinnedToLatest: true, pinnedUntil: "2026-10-30T11:00:00.000Z" }, to: { pinnedToLatest: false, pinnedUntil: null } };
    const { req, creates } = hookReq({ hubFlags: hf, engineId: 60, skipTranslationEnqueue: true, disableRevalidate: true });
    const doc = { id: 5, tenant: 1, workflowStatus: "published" };
    await wf.articleActivity({ doc, previousDoc: { ...doc }, req, operation: "update" } as never);
    // Even a status move inside a flags write (impossible: D8 rolls it back) logs nothing here.
    await wf.articleActivity({ doc: { ...doc, workflowStatus: "archived" }, previousDoc: { ...doc }, req, operation: "update" } as never);
    assert.equal(creates.length, 0);
  });

  it("article_created carries `fields` only when the hub sent editorial keys (D11)", async () => {
    const doc = { id: 77, tenant: 1, workflowStatus: "draft" };
    const a = hookReq({ hubAuthor: { actor: ACTOR, action: "create", fields: ["exclusive"] }, engineId: 61 });
    await wf.articleActivity({ doc, previousDoc: undefined, req: a.req, operation: "create" } as never);
    assert.deepEqual((a.creates[0]!.data as Doc).detail, { via: "hub", actor: ACTOR, action: "create", fields: ["exclusive"] });
    const b = hookReq({ hubAuthor: { actor: ACTOR, action: "create" }, engineId: 61 });
    await wf.articleActivity({ doc, previousDoc: undefined, req: b.req, operation: "create" } as never);
    assert.deepEqual((b.creates[0]!.data as Doc).detail, { via: "hub", actor: ACTOR, action: "create" });
  });
});
