/**
 * Hero focal point — the after-commit write through the REAL handlers (draft create / update,
 * live edit) and the guarded Media hook (content-engine plan hub-hero-focal-point_PLAN_10-11-26.md,
 * P1.3–P1.5; validate C4, C10, C11, N8). FAKE Payload only: no database is ever reached.
 * `@payload-config` refuses to load without a DATABASE_URL, so a NON-ROUTABLE placeholder is set
 * below (port 1 on 127.0.0.1; `getPayload` is never called here).
 *
 *   npm run test:hub-focal
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Payload, PayloadRequest } from "payload";

process.env.DATABASE_URL ??= "postgres://focal-unit@127.0.0.1:1/focal_unit_no_db";
process.env.PAYLOAD_SECRET ??= "focal-unit-placeholder";

type Doc = Record<string, unknown>;
let handlers: typeof import("./hub-author-handlers");
let live: typeof import("./hub-author-live-core");
let core: typeof import("./hub-hero-focal-core");
let hook: typeof import("../hooks/media-focal-revalidate");
let CONFIG: Payload["config"];

before(async () => {
  handlers = await import("./hub-author-handlers");
  live = await import("./hub-author-live-core");
  core = await import("./hub-hero-focal-core");
  hook = await import("../hooks/media-focal-revalidate");
  CONFIG = (await (await import("../../payload.config")).default) as unknown as Payload["config"];
});

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
const LOCK_REQ = { transactionID: "tx1" } as const;
const FRESH_REQ = { context: {}, marker: "fresh" } as unknown as PayloadRequest;
const LOCALIZED = ["title", "slug", "dek", "body", "imageLabel", "leadImageCaption"];
const BODY = { root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [{ type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, textFormat: 0, textStyle: "", children: [{ type: "text", version: 1, text: "Body.", format: 0, detail: 0, mode: "normal", style: "" }] }] } };

const match = (doc: Doc, w: unknown): boolean => {
  if (!w || typeof w !== "object") return true;
  const q = w as Doc;
  if (Array.isArray(q.and)) return (q.and as unknown[]).every((x) => match(doc, x));
  for (const [k, cond] of Object.entries(q)) {
    const c = (cond ?? {}) as Doc;
    const v = doc[k];
    if ("equals" in c && String(v) !== String(c.equals)) return false;
    if ("in" in c && !(c.in as unknown[]).map(String).includes(String(v))) return false;
  }
  return true;
};

interface WorldOpts {
  /** "draft" = a hub-authored manual draft (PATCH), "published" = a live-editable article. */
  state?: "draft" | "published";
  article?: Doc;
  media?: Doc[];
  /** The media read answers a doc with ANOTHER id (defence against a mis-read). */
  mediaIdMismatch?: boolean;
  /** The focal media write throws. */
  mediaWriteThrows?: boolean;
}

function world(o: WorldOpts = {}) {
  const tenant = { id: 7, slug: "gtp", status: "active", defaultLanguage: "en", supportedLanguages: ["en"], features: { articles: true } };
  const published = o.state === "published";
  const base: Doc = {
    id: 5, tenant: 7, origin: "manual", workflowStatus: published ? "published" : "draft", _status: published ? "published" : "draft",
    version: 3, lastEngine: 60, engineDraftId: null, title: "Old", slug: "old", dek: null, body: BODY, takeaways: null, pillar: 11,
    subSection: null, author: 3, readMin: 2, sponsored: false, sponsor: null, secondarySections: [], briefs: [], video: null,
    heroImage: 100, leadImageCaption: null, publishedAt: published ? "2026-10-01T00:00:00.000Z" : null, scheduledFor: null,
    sourceLanguage: "en", tags: [], countries: [], country: null, cities: [], coAuthors: [],
  };
  const articles = new Map<string, { main: Doc; latest: Doc }>();
  const a5 = { ...base, ...o.article };
  articles.set("5", { main: { ...a5 }, latest: { ...a5 } });
  const media = new Map<string, Doc>();
  for (const m of o.media ?? [{ id: 100, tenant: 7, focalX: 50, focalY: 50 }, { id: 101, tenant: 7, focalX: 50, focalY: 50 }, { id: 200, tenant: 8, focalX: 50, focalY: 50 }]) {
    media.set(String(m.id), { ...m });
  }
  const log = { events: [] as string[], creates: [] as Doc[], articleUpdates: [] as Doc[], mediaUpdates: [] as Doc[], mediaReads: 0 };
  let nextId = 9;
  const shape = (d: Doc, a: Doc): Doc => {
    const out: Doc = { ...d };
    if (a.locale === "all") for (const k of LOCALIZED) if (k in out) out[k] = { en: out[k] };
    return out;
  };
  const payload = {
    config: CONFIG,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    db: { sessions: { tx1: { db: { execute: async () => {} } } } },
    async findByID(a: Doc) {
      if (a.collection === "tenants") return { ...tenant, features: { ...tenant.features } };
      if (a.collection === "content-engines") return { id: 60, hubAuthor: true };
      if (a.collection === "articles") {
        const rec = articles.get(String(a.id));
        if (!rec) return null;
        return shape(a.draft ? rec.latest : rec.main, a);
      }
      if (a.collection === "media") {
        log.mediaReads++;
        const m = media.get(String(a.id));
        if (!m) return null;
        return o.mediaIdMismatch ? { ...m, id: 101 } : { ...m };
      }
      return null;
    },
    async find(a: Doc) {
      const col = String(a.collection);
      const src: Doc[] =
        col === "media" ? [...media.values()]
          : col === "pillars" ? [{ id: 11, tenant: 7, slug: "travel" }]
            : col === "authors" ? [{ id: 3, tenant: 7 }]
              : [];
      const docs = src.filter((d) => match(d, a.where)).slice(0, Number(a.limit ?? 10)).map((d) => ({ ...d }));
      return { docs, totalDocs: docs.length };
    },
    async create(a: Doc) {
      log.creates.push(a);
      log.events.push("create");
      const id = nextId++;
      const doc = { id, version: 1, ...(a.data as Doc) };
      articles.set(String(id), { main: { ...doc }, latest: { ...doc } });
      return { ...doc };
    },
    async update(a: Doc) {
      if (a.collection === "media") {
        log.events.push("media-update");
        log.mediaUpdates.push(a);
        if (o.mediaWriteThrows) throw Object.assign(new Error("boom"), { name: "DatabaseError", code: "08006" });
        const m = media.get(String(a.id))!;
        media.set(String(a.id), { ...m, ...(a.data as Doc) });
        return { ...m, ...(a.data as Doc) };
      }
      log.events.push("article-update");
      log.articleUpdates.push(a);
      const rec = articles.get(String(a.id))!;
      const next = { ...rec.latest, ...(a.data as Doc), version: (rec.latest.version as number) + 1 };
      if (a.draft) rec.latest = next;
      else {
        rec.main = next;
        rec.latest = { ...next };
      }
      return { ...next };
    },
  };
  return { payload: payload as unknown as Payload, log, media, articles };
}
type World = ReturnType<typeof world>;

const lockFake = (w: World, result?: { forceFail?: Response }) =>
  (async (_a: unknown, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
    w.log.events.push("lock");
    if (result?.forceFail) {
      w.log.events.push("kill");
      return result.forceFail;
    }
    const r = await fn({ req: LOCK_REQ, lockSlug: async () => {} });
    w.log.events.push(r.ok ? "commit" : "kill");
    return r.value;
  }) as never;

const focalDeps = (tenants: readonly string[] = ["gtp"]) => ({ tenants, createReq: async () => FRESH_REQ });

function draftDeps(w: World, extra: Doc = {}) {
  return {
    getPayload: async () => w.payload,
    authenticate: (async () => ({ ok: true, engine: { id: 60 }, tenants: [{ id: 7, slug: "gtp" }] })) as never,
    lock: lockFake(w),
    focal: focalDeps(),
    ...extra,
  };
}

async function create(w: World, body: Doc, extra: Doc = {}) {
  const req = new Request("http://cms.local/api/hub/articles", { method: "POST", body: JSON.stringify({ tenant: "gtp", actor: ACTOR, ...body }) });
  const res = await handlers.handleHubDraftCreateWith(req, draftDeps(w, extra) as never);
  return { status: res.status, text: await res.text() };
}
async function patch(w: World, body: Doc, extra: Doc = {}) {
  const req = new Request("http://cms.local/api/hub/articles/5", { method: "PATCH", body: JSON.stringify({ tenant: "gtp", actor: ACTOR, expectedVersion: 3, ...body }) });
  const res = await handlers.handleHubDraftUpdateWith(req, { params: Promise.resolve({ id: "5" }) }, draftDeps(w, extra) as never);
  return { status: res.status, body: (await res.json()) as Doc };
}
async function livePatch(w: World, fields: Doc, extra: Doc = {}) {
  const req = new Request("http://cms.local/api/hub/articles/5/live", { method: "PATCH", body: JSON.stringify({ tenant: "gtp", actor: ACTOR, expectedVersion: 3, fields }) });
  const deps = {
    getPayload: async () => w.payload,
    authenticate: (async () => ({ ok: true, engine: { id: 61, hubWrite: true, hubAuthor: false }, tenants: [{ id: 7, slug: "gtp" }] })) as never,
    lock: lockFake(w),
    lockRow: async () => {},
    liveTenants: ["gtp"],
    focal: focalDeps(),
    ...extra,
  };
  const res = await live.handleHubLiveUpdateWith(req, { params: Promise.resolve({ id: "5" }) }, deps as never);
  return { status: res.status, body: (await res.json()) as Doc };
}

// ── Draft create (POST) ──────────────────────────────────────────────────────

describe("POST /api/hub/articles with heroFocal", () => {
  it("201, then the hero media gets {focalX, focalY} AFTER the commit, on a FRESH req (never the lock's)", async () => {
    const w = world();
    const r = await create(w, { title: "Hello", heroImageId: 100, heroFocal: { x: 30, y: 70 } });
    assert.equal(r.status, 201);
    const b = JSON.parse(r.text) as Doc;
    assert.deepEqual(Object.keys(b), ["ok", "id", "tenant", "slug", "workflowStatus", "version"], "no warnings key");
    assert.deepEqual(w.log.events, ["lock", "create", "commit", "media-update"]);
    const u = w.log.mediaUpdates[0]!;
    assert.deepEqual([u.collection, u.id, u.data, u.overrideAccess, u.depth], ["media", 100, { focalX: 30, focalY: 70 }, true, 0]);
    assert.equal(u.req, FRESH_REQ);
    assert.notEqual(u.req, LOCK_REQ);
    assert.equal((u.req as unknown as Doc).transactionID, undefined);
    assert.equal("file" in (u.req as unknown as Doc), false);
    assert.equal("draft" in u, false);
    assert.deepEqual([w.media.get("100")!.focalX, w.media.get("100")!.focalY], [30, 70]);
  });
  it("byte-identical without heroFocal: same article data, same body text, no media read/write", async () => {
    const w1 = world();
    const r1 = await create(w1, { title: "Hello", heroImageId: 100 });
    const w2 = world();
    const r2 = await create(w2, { title: "Hello", heroImageId: 100 }, { focal: undefined });
    assert.equal(r1.status, 201);
    assert.equal(r1.text, r2.text);
    assert.deepEqual(w1.log.creates[0]!.data, w2.log.creates[0]!.data);
    assert.equal(w1.log.mediaUpdates.length, 0);
    assert.equal(w1.log.mediaReads, 0);
    assert.doesNotMatch(r1.text, /warnings/);
    // heroFocal never leaks into the article write.
    const w3 = world();
    await create(w3, { title: "Hello", heroImageId: 100, heroFocal: { x: 1, y: 2 } });
    assert.deepEqual(w3.log.creates[0]!.data, w1.log.creates[0]!.data);
  });
  it("tenant outside HUB_FOCAL_TENANTS: the article is saved (201) + warning, the media is NOT touched", async () => {
    const w = world();
    const r = await create(w, { title: "Hello", heroImageId: 100, heroFocal: { x: 30, y: 70 } }, { focal: focalDeps([]) });
    assert.equal(r.status, 201);
    assert.deepEqual((JSON.parse(r.text) as Doc).warnings, ["hero_focal_not_applied"]);
    assert.equal(w.log.creates.length, 1);
    assert.equal(w.log.mediaUpdates.length, 0);
    assert.equal(w.log.mediaReads, 0);
  });
  it("N8: an object focal without a hero ⇒ 422 unknown_ref BEFORE the lock (switch on); null without a hero ⇒ 201, nothing", async () => {
    const w = world();
    const r = await create(w, { title: "Hello", heroFocal: { x: 30, y: 70 } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [422, { ok: false, status: "invalid", reason: "one or more fields are invalid", fields: { heroFocal: "unknown_ref" } }]);
    assert.deepEqual(w.log.events, []);
    const w2 = world();
    const r2 = await create(w2, { title: "Hello", heroFocal: null });
    assert.equal(r2.status, 201);
    assert.doesNotMatch(r2.text, /warnings/);
    assert.equal(w2.log.mediaUpdates.length, 0);
  });
  it("a slug conflict inside the lock (409) never writes the focal", async () => {
    const w = world();
    const conflict = new Response(JSON.stringify({ ok: false, status: "slug_conflict" }), { status: 409 });
    const r = await create(w, { title: "Hello", heroImageId: 100, heroFocal: { x: 30, y: 70 } }, { lock: lockFake(w, { forceFail: conflict }) });
    assert.equal(r.status, 409);
    assert.equal(w.log.mediaUpdates.length, 0);
    assert.equal(w.log.mediaReads, 0);
  });
});

// ── Draft update (PATCH) ─────────────────────────────────────────────────────

describe("PATCH /api/hub/articles/{id} with heroFocal", () => {
  it("focal-only ⇒ 200 changed [] version unchanged, NO article write, NO lock; media written", async () => {
    const w = world();
    const r = await patch(w, { heroFocal: { x: 20, y: 80 } });
    assert.deepEqual([r.status, r.body.changed, r.body.version, "warnings" in r.body], [200, [], 3, false]);
    assert.deepEqual(w.log.events, ["media-update"]);
    assert.deepEqual(w.log.mediaUpdates[0]!.data, { focalX: 20, focalY: 80 });
  });
  it("title + focal ⇒ lock → update → commit, THEN the media write; changed has no heroFocal", async () => {
    const w = world();
    const r = await patch(w, { title: "New", heroFocal: { x: 20, y: 80 } });
    assert.deepEqual([r.status, r.body.changed, r.body.version], [200, ["title"], 4]);
    assert.deepEqual(w.log.events, ["lock", "article-update", "commit", "media-update"]);
    assert.equal("heroFocal" in (w.log.articleUpdates[0]!.data as Doc), false);
    assert.equal(w.log.articleUpdates[0]!.req, LOCK_REQ);
    assert.equal(w.log.mediaUpdates[0]!.req, FRESH_REQ);
  });
  it("heroFocal null ⇒ the columns are written 50/50, never NULL", async () => {
    const w = world({ media: [{ id: 100, tenant: 7, focalX: 30, focalY: 70 }] });
    const r = await patch(w, { heroFocal: null });
    assert.equal(r.status, 200);
    assert.deepEqual(w.log.mediaUpdates[0]!.data, { focalX: 50, focalY: 50 });
  });
  it("same values already stored ⇒ no write, no warning", async () => {
    const w = world({ media: [{ id: 100, tenant: 7, focalX: 20, focalY: 80 }] });
    const r = await patch(w, { heroFocal: { x: 20, y: 80 } });
    assert.deepEqual([r.status, "warnings" in r.body, w.log.mediaUpdates.length], [200, false, 0]);
  });
  it("hero changed in the same PATCH ⇒ the focal goes to the NEW hero", async () => {
    const w = world();
    const r = await patch(w, { heroImageId: 101, heroFocal: { x: 5, y: 95 } });
    assert.deepEqual([r.status, r.body.changed], [200, ["heroImageId"]]);
    assert.equal(w.log.mediaUpdates[0]!.id, 101);
  });
  it("N8: hero removed + object focal ⇒ 422 unknown_ref before the lock; no hero + null ⇒ 200 skipped", async () => {
    const w = world();
    const r = await patch(w, { heroImageId: null, heroFocal: { x: 5, y: 95 } });
    assert.deepEqual([r.status, (r.body.fields as Doc).heroFocal], [422, "unknown_ref"]);
    assert.deepEqual(w.log.events, []);
    const w2 = world({ article: { heroImage: null } });
    const r2 = await patch(w2, { heroFocal: null });
    assert.deepEqual([r2.status, "warnings" in r2.body, w2.log.mediaUpdates.length], [200, false, 0]);
  });
  it("C10: the hero media of ANOTHER tenant is never written (warning instead)", async () => {
    const w = world({ article: { heroImage: 200 } });
    const r = await patch(w, { heroFocal: { x: 5, y: 95 } });
    assert.deepEqual([r.status, r.body.warnings], [200, ["hero_focal_not_applied"]]);
    assert.equal(w.log.mediaUpdates.length, 0);
    assert.equal(w.media.get("200")!.tenant, 8);
  });
  it("C10: a media read that is not the article's hero is never written", async () => {
    const w = world({ mediaIdMismatch: true });
    const r = await patch(w, { heroFocal: { x: 5, y: 95 } });
    assert.deepEqual([r.status, r.body.warnings], [200, ["hero_focal_not_applied"]]);
    assert.equal(w.log.mediaUpdates.length, 0);
  });
  it("D10: the focal write throws ⇒ the article write stays (200, version bumped) + warning", async () => {
    const w = world({ mediaWriteThrows: true });
    const r = await patch(w, { title: "New", heroFocal: { x: 5, y: 95 } });
    assert.deepEqual([r.status, r.body.changed, r.body.version, r.body.warnings], [200, ["title"], 4, ["hero_focal_not_applied"]]);
    assert.deepEqual(w.log.events, ["lock", "article-update", "commit", "media-update"]);
    assert.equal(w.articles.get("5")!.latest.title, "New");
  });
  it("a 409 version conflict never writes the focal", async () => {
    const w = world();
    const r = await patch(w, { heroFocal: { x: 5, y: 95 }, expectedVersion: 2 });
    assert.equal(r.status, 409);
    assert.equal(w.log.mediaReads + w.log.mediaUpdates.length, 0);
  });
  it("no heroFocal ⇒ byte-identical: no media read, no warnings key", async () => {
    const w = world();
    const r = await patch(w, { title: "New" });
    assert.deepEqual(Object.keys(r.body), ["ok", "id", "tenant", "workflowStatus", "version", "changed"]);
    assert.equal(w.log.mediaReads, 0);
  });
});

// ── Live edit (PATCH …/live) ─────────────────────────────────────────────────

describe("PATCH /api/hub/articles/{id}/live with heroFocal", () => {
  it("focal-only on a published hub article ⇒ 200 changed [] version unchanged, no article write; media written", async () => {
    const w = world({ state: "published" });
    const r = await livePatch(w, { heroFocal: { x: 40, y: 60 } });
    assert.deepEqual([r.status, r.body.changed, r.body.version, r.body.workflowStatus, "warnings" in r.body], [200, [], 3, "published", false]);
    assert.deepEqual(w.log.events, ["media-update"]);
    assert.equal(w.articles.get("5")!.main.heroImage, 100, "the hero image itself never changes");
  });
  it("title + focal ⇒ lock → update → commit → media write; heroImageId stays 422 not_live_editable", async () => {
    const w = world({ state: "published" });
    const r = await livePatch(w, { title: "Live new", heroFocal: { x: 40, y: 60 } });
    assert.deepEqual([r.status, r.body.changed, r.body.version], [200, ["title"], 4]);
    assert.deepEqual(w.log.events, ["lock", "article-update", "commit", "media-update"]);
    const locked = await livePatch(world({ state: "published" }), { heroImageId: 101, heroFocal: { x: 1, y: 1 } });
    assert.deepEqual([locked.status, locked.body.status, locked.body.reason], [422, "not_live_editable", "media_locked"]);
  });
  it("live switch on but focal switch off ⇒ 200 + warning, media untouched", async () => {
    const w = world({ state: "published" });
    const r = await livePatch(w, { heroFocal: { x: 40, y: 60 } }, { focal: focalDeps([]) });
    assert.deepEqual([r.status, r.body.warnings, w.log.mediaUpdates.length], [200, ["hero_focal_not_applied"], 0]);
  });
});

// ── Pure-ish helpers of the core ─────────────────────────────────────────────

describe("core helpers", () => {
  it("heroFocalPrecheck", () => {
    assert.equal(core.heroFocalPrecheck({ heroFocal: undefined, heroAfter: null, enabled: true }), null);
    assert.equal(core.heroFocalPrecheck({ heroFocal: null, heroAfter: null, enabled: true }), null);
    assert.equal(core.heroFocalPrecheck({ heroFocal: { x: 1, y: 1 }, heroAfter: null, enabled: false }), null);
    assert.deepEqual(core.heroFocalPrecheck({ heroFocal: { x: 1, y: 1 }, heroAfter: null, enabled: true }), { heroFocal: "unknown_ref" });
    assert.equal(core.heroFocalPrecheck({ heroFocal: { x: 1, y: 1 }, heroAfter: { id: 9 }, enabled: true }), null);
  });
  it("finishWithHeroFocal: non-2xx untouched and apply not called; 2xx keeps status + headers", async () => {
    let called = 0;
    const r409 = new Response("{}", { status: 409 });
    assert.equal(await core.finishWithHeroFocal(r409, async () => (called++, "not_applied")), r409);
    assert.equal(called, 0);
    const ok = new Response(JSON.stringify({ ok: true, id: 1 }), { status: 201, headers: { "Content-Type": "application/json", "X-T": "1" } });
    const out = await core.finishWithHeroFocal(ok, async () => "not_applied");
    assert.deepEqual([out.status, out.headers.get("x-t"), await out.json()], [201, "1", { ok: true, id: 1, warnings: ["hero_focal_not_applied"] }]);
    const same = new Response(JSON.stringify({ ok: true }), { status: 200 });
    assert.equal(await core.finishWithHeroFocal(same, async () => "applied"), same);
  });
  it("focalLocalReq (the real createLocalReq): no transaction, no file, no upload edits", async () => {
    const req = (await core.focalLocalReq({ config: CONFIG, logger: console } as unknown as Payload)) as unknown as Doc;
    assert.equal(req.transactionID, undefined);
    assert.equal(req.file, undefined);
    assert.equal((req.query as Doc | undefined)?.uploadEdits, undefined);
    assert.deepEqual(req.context, {});
  });
});

// ── The Media afterChange hook (P1.5) ────────────────────────────────────────

describe("mediaFocalRevalidate", () => {
  const run = async (a: { operation?: string; doc?: Doc; previousDoc?: Doc; context?: Doc; tenants?: string[]; slug?: string; findThrows?: boolean }) => {
    const posts: Doc[] = [];
    let tenantReads = 0;
    const h = hook.makeMediaFocalRevalidate({
      tenants: () => a.tenants ?? ["gtp"],
      findTenant: async () => {
        tenantReads++;
        if (a.findThrows) throw new Error("db down");
        return { id: 7, slug: a.slug ?? "gtp" } as never;
      },
      post: async (_p, t, body) => {
        posts.push({ tenant: t?.slug, ...body });
      },
    });
    const doc = a.doc ?? { id: 100, tenant: 7, focalX: 30, focalY: 70 };
    const out = await h({
      doc,
      previousDoc: a.previousDoc ?? { id: 100, tenant: 7, focalX: 50, focalY: 50 },
      operation: (a.operation ?? "update") as never,
      req: { payload: { logger: { warn: () => {} } }, context: a.context ?? {} } as never,
      collection: {} as never,
      context: {} as never,
      data: {} as never,
    } as never);
    return { out, doc, posts, tenantReads };
  };
  it("fires ONE articles:all webhook on a real focal change of an enabled tenant", async () => {
    const r = await run({});
    assert.deepEqual(r.posts, [{ tenant: "gtp", tags: ["articles:all"] }]);
    assert.equal(r.out, r.doc);
  });
  it("silent on create, on no focal change (alt edit), on disableRevalidate", async () => {
    assert.equal((await run({ operation: "create" })).posts.length, 0);
    assert.equal((await run({ doc: { id: 1, tenant: 7, focalX: 50, focalY: 50, alt: "n" } })).posts.length, 0);
    assert.equal((await run({ context: { disableRevalidate: true } })).posts.length, 0);
  });
  it("silent for a tenant outside HUB_FOCAL_TENANTS; empty switch ⇒ not even a tenant read", async () => {
    assert.equal((await run({ slug: "gcv" })).posts.length, 0);
    const off = await run({ tenants: [] });
    assert.deepEqual([off.posts.length, off.tenantReads], [0, 0]);
  });
  it("never throws: a failing tenant read is swallowed and the doc returned", async () => {
    const r = await run({ findThrows: true });
    assert.deepEqual([r.posts.length, r.out === r.doc], [0, true]);
  });
});
