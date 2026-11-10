/**
 * Unit tests for ./engine-hero-replace-core (POST /api/engine/articles/hero,
 * media-gtp-vowasia phase 5). Node's built-in runner, FAKE Payload, fake fetch / DNS, fake
 * lock with snapshot rollback. No database, no network. The core has no static
 * `@payload-config` import (the route binds the real lock / row lock / reads).
 *
 *   npm run test:engine-hero
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload, PayloadRequest } from "payload";

import { handleHeroReplace, type HeroReplaceDeps } from "./engine-hero-replace-core";
import { heroToken } from "./engine-hero-replace-pure";
import { sha256Hex } from "./crypto";

type Doc = Record<string, unknown>;

const TOKEN = "engine-token-abc";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
const KEY = "replace:42:11:12";

interface World {
  engines: Doc[];
  tenants: Doc[];
  main: Map<number, Doc>;
  latest: Map<number, Doc>;
  media: Map<number, Doc>;
  activity: Doc[];
  updates: Doc[];
  articleFinds: number;
  nextMedia: number;
  failUpdate?: Error;
  mutateOnUpdate?: (doc: Doc) => void;
}

let w: World;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function article(over: Doc = {}): Doc {
  return {
    id: 42,
    tenant: 4,
    engineDraftId: "content-engine:vowasia:42",
    title: { en: "A wedding in Hue", vi: "Dam cuoi" },
    slug: { en: "a-wedding-in-hue", vi: "dam-cuoi" },
    heroImage: 11,
    _status: "published",
    workflowStatus: "published",
    version: 5,
    publishedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    editedByHuman: false,
    leadImageCaption: { en: "Lead" },
    ...over,
  };
}

function reset(art: Doc = article()) {
  w = {
    engines: [
      { id: 5, name: "ce-vowasia", status: "active", tokenHash: sha256Hex(TOKEN), allowedTenants: [4], allowedActions: ["update_article", "upload_media", "create_article"] },
    ],
    tenants: [
      { id: 4, slug: "vowasia", status: "active", features: { articles: true } },
      { id: 6, slug: "gtp", status: "active", features: { articles: true } },
    ],
    main: new Map([[42, clone(art)]]),
    latest: new Map([[42, clone(art)]]),
    media: new Map([
      [11, { id: 11, tenant: 4, filename: "a-wedding-in-hue.jpeg", credit: "Old / Pexels", url: "/api/media/file/a-wedding-in-hue.jpeg" }],
    ]),
    activity: [],
    updates: [],
    articleFinds: 0,
    nextMedia: 100,
  };
}

/** Localise a doc read like Payload would for locale "en" (strings), or keep "all" (objects). */
function loc(doc: Doc, locale?: string): Doc {
  if (locale === "all") return clone(doc);
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && "en" in (v as Doc) ? (v as Doc).en : v;
  }
  return clone(out);
}

function matches(doc: Doc, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  const wh = where as Doc;
  if (Array.isArray(wh.and)) return (wh.and as unknown[]).every((c) => matches(doc, c));
  return Object.entries(wh).every(([k, cond]) => {
    const eq = (cond as { equals?: unknown }).equals;
    return String(doc[k]) === String(eq);
  });
}

function fakePayload(): Payload {
  return {
    find: async (a: Doc) => {
      const c = a.collection as string;
      if (c === "content-engines") return { docs: w.engines.filter((e) => matches(e, a.where)) };
      if (c === "tenants") return { docs: w.tenants.filter((t) => matches(t, a.where)) };
      if (c === "articles") {
        w.articleFinds += 1;
        return { docs: [...w.main.values()].filter((d) => matches(d, a.where)).map((d) => loc(d, a.locale as string)) };
      }
      return { docs: [] };
    },
    findByID: async (a: Doc) => {
      const c = a.collection as string;
      const id = Number(a.id);
      if (c === "tenants") return w.tenants.find((t) => t.id === id) ?? null;
      if (c === "media") return clone(w.media.get(id) ?? null);
      if (c === "articles") {
        const src = a.draft ? (w.latest.get(id) ?? w.main.get(id)) : w.main.get(id);
        if (!src) return null;
        const d = loc(src, a.locale as string);
        if (a.depth === 1 && typeof d.heroImage === "number") d.heroImage = clone(w.media.get(d.heroImage as number) ?? d.heroImage);
        return d;
      }
      return null;
    },
    update: async (a: Doc) => {
      const c = a.collection as string;
      if (c === "content-engines") return {};
      if (c === "articles") {
        w.updates.push(a);
        if (w.failUpdate) throw w.failUpdate;
        const id = Number(a.id);
        const cur = w.main.get(id) as Doc;
        const data = { ...(a.data as Doc) };
        delete data.tenant;
        const next = { ...cur, ...data, updatedAt: "2026-11-10T00:00:00.000Z" };
        w.mutateOnUpdate?.(next);
        w.main.set(id, next);
        w.latest.set(id, clone(next));
        return clone(next);
      }
      return {};
    },
    create: async (a: Doc) => {
      const c = a.collection as string;
      if (c === "activityLog") {
        w.activity.push(a.data as Doc);
        return { id: w.activity.length };
      }
      if (c === "media") {
        const id = w.nextMedia++;
        const file = a.file as { name: string };
        const doc = { id, ...(a.data as Doc), filename: file.name, url: `/api/media/file/${file.name}` };
        w.media.set(id, doc);
        return clone(doc);
      }
      return { id: 1 };
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as Payload;
}

const REQ = { transactionID: 1 } as unknown as PayloadRequest;

function deps(over: Partial<HeroReplaceDeps> = {}): HeroReplaceDeps & { fetched: string[]; lockCalls: number } {
  const state = { fetched: [] as string[], lockCalls: 0 };
  const d: HeroReplaceDeps = {
    getPayload: async () => fakePayload(),
    env: { ENGINE_HERO_REPLACE_TENANTS: "vowasia" },
    fetch: (async (u: string) => {
      state.fetched.push(u);
      return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    }) as never,
    resolveHost: async () => ["93.184.216.34"],
    lock: async (_args, fn) => {
      state.lockCalls += 1;
      const snap = { main: clone([...w.main]), latest: clone([...w.latest]) };
      const r = await fn({ req: REQ, lockSlug: async () => {} });
      if (!r.ok) {
        w.main = new Map(snap.main);
        w.latest = new Map(snap.latest);
      }
      return r.value;
    },
    lockRow: async () => {},
    readMainAll: async (p, id, req) => (await p.findByID({ collection: "articles", id, req, depth: 0, locale: "all" as never, overrideAccess: true, disableErrors: true })) as unknown as Doc,
    ...over,
  };
  const out = d as HeroReplaceDeps & { fetched: string[]; lockCalls: number };
  out.fetched = state.fetched;
  Object.defineProperty(out, "lockCalls", { get: () => state.lockCalls });
  return out;
}

function req(body: unknown, opts: { token?: string | null; raw?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return new Request("http://cms.test/api/engine/articles/hero", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
}

const good = {
  publicationId: "vowasia",
  engineDraftId: "content-engine:vowasia:42",
  expectedHeroMediaId: 11,
  heroImageUrl: "https://x.supabase.co/storage/v1/object/public/hero-images/new.jpg",
  imageCredit: "Jane / Pexels",
  imageCaption: "Illustrative image",
  replacementKey: KEY,
  reason: "rights complaint",
};

async function call(body: unknown, d = deps(), opts?: Parameters<typeof req>[1]) {
  const res = await handleHeroReplace(req(body, opts), d);
  return { status: res.status, body: (await res.json()) as Doc, d };
}

beforeEach(() => reset());

describe("auth, switch and feature gate", () => {
  it("401 without a bearer", async () => {
    const r = await call(good, deps(), { token: null });
    assert.equal(r.status, 401);
  });
  it("401 unknown token", async () => {
    assert.equal((await call(good, deps(), { token: "nope" })).status, 401);
  });
  it("403 engine without update_article (+ engine_action_denied)", async () => {
    w.engines[0]!.allowedActions = ["upload_media"];
    const r = await call(good);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "action not allowed: update_article");
    assert.equal(w.activity.filter((a) => a.eventType === "engine_action_denied").length, 1);
  });
  it("403 engine without upload_media (+ engine_action_denied row naming it)", async () => {
    w.engines[0]!.allowedActions = ["update_article"];
    const r = await call(good);
    assert.equal(r.status, 403);
    assert.equal(r.body.status, "forbidden");
    assert.equal(r.body.reason, "action not allowed: upload_media");
    const denied = w.activity.filter((a) => a.eventType === "engine_action_denied");
    assert.equal(denied.length, 1);
    assert.deepEqual(denied[0]!.detail, { action: "upload_media" });
    assert.equal(w.articleFinds, 0);
  });
  it("403 engine not allowed on the tenant", async () => {
    const r = await call({ ...good, publicationId: "gtp" }, deps({ env: { ENGINE_HERO_REPLACE_TENANTS: "vowasia,gtp" } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "engine not allowed for this tenant");
  });
  it("403 feature_disabled before any article lookup when the tenant is not in ENGINE_HERO_REPLACE_TENANTS", async () => {
    const r = await call(good, deps({ env: { ENGINE_HERO_REPLACE_TENANTS: "gtp" } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.status, "feature_disabled");
    assert.equal(w.articleFinds, 0);
  });
  it("env unset equals off", async () => {
    const r = await call(good, deps({ env: {} }));
    assert.equal(r.body.status, "feature_disabled");
    assert.equal(w.articleFinds, 0);
  });
  it("422 when the articles feature is disabled for the tenant", async () => {
    w.tenants[0]!.features = { articles: false };
    const r = await call(good);
    assert.equal(r.status, 422);
    assert.equal(r.body.status, "unprocessable");
  });
  it("500 generic when getPayload fails", async () => {
    const r = await call(good, deps({ getPayload: async () => { throw new Error("db secret host down"); } }));
    assert.equal(r.status, 500);
    assert.equal(r.body.reason, "internal error");
  });
});

describe("body", () => {
  it("400 invalid JSON", async () => {
    const r = await call(null, deps(), { raw: "{nope" });
    assert.equal(r.status, 400);
    assert.equal(r.body.status, "bad_request");
  });
  it("413 over 16 KB measured on the text, content-length ignored", async () => {
    const r = await call(null, deps(), { raw: JSON.stringify({ ...good, reason: "x".repeat(17_000) }), headers: { "content-length": "10" } });
    assert.equal(r.status, 413);
    assert.equal(r.body.status, "too_large");
  });
  it("400 names the missing fields", async () => {
    const r = await call({ publicationId: "vowasia", engineDraftId: "x" });
    assert.equal(r.status, 400);
    assert.match(String(r.body.reason), /expectedHeroMediaId/);
    assert.match(String(r.body.reason), /replacementKey/);
  });
});

describe("lookup", () => {
  it("404 unknown engineDraftId", async () => {
    const r = await call({ ...good, engineDraftId: "content-engine:vowasia:999" });
    assert.equal(r.status, 404);
    assert.equal(r.body.status, "not_found");
  });
  it("404 for an article that exists only in another tenant", async () => {
    w.main.set(77, article({ id: 77, tenant: 6, engineDraftId: "content-engine:gtp:77" }));
    const r = await call({ ...good, engineDraftId: "content-engine:gtp:77" });
    assert.equal(r.status, 404);
  });
});

describe("optimistic id and idempotency", () => {
  it("409 hero_changed names currentHeroMediaId", async () => {
    const r = await call({ ...good, expectedHeroMediaId: 99 });
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "hero_changed");
    assert.equal(r.body.currentHeroMediaId, 11);
    assert.equal(r.d.fetched.length, 0);
  });
  it("expectedHeroMediaId null on an article with a hero -> 409", async () => {
    assert.equal((await call({ ...good, expectedHeroMediaId: null })).status, 409);
  });
  it("expectedHeroMediaId null on an article without a hero -> 200 replaced, oldMediaId null", async () => {
    reset(article({ heroImage: null }));
    const r = await call({ ...good, expectedHeroMediaId: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.oldMediaId, null);
  });
  it("200 noop on a repeated replacementKey, no second Media; 409 hero_changed on a different key with the stale id", async () => {
    const first = await call(good);
    assert.equal(first.body.status, "replaced");
    const mediaCount = w.media.size;
    const again = await call(good);
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "noop");
    assert.equal(again.body.currentHeroMediaId, first.body.newMediaId);
    assert.equal(w.media.size, mediaCount);
    const other = await call({ ...good, replacementKey: "replace:42:11:13" });
    assert.equal(other.status, 409);
    assert.equal(other.body.status, "hero_changed");
  });
});

describe("replaced", () => {
  it("updates only heroImage, keeps the old Media, creates the Media with the article title as alt and writes exactly one activity row", async () => {
    const r = await call(good);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.status, "replaced");
    assert.equal(r.body.articleId, 42);
    assert.equal(r.body.oldMediaId, 11);
    const newId = r.body.newMediaId as number;
    assert.equal(typeof newId, "number");
    assert.equal(r.body.version, 5);
    assert.match(String(r.body.heroUrl), new RegExp(`-r${heroToken(KEY)}\\.jpeg$`));
    // the write
    assert.equal(w.updates.length, 1);
    const u = w.updates[0]!;
    assert.deepEqual(Object.keys(u.data as Doc).sort(), ["heroImage", "tenant"]);
    assert.deepEqual(u.data, { heroImage: newId, tenant: 4 });
    assert.deepEqual(u.context, { engineWrite: true, engineId: 5, heroSwap: true });
    assert.equal(u.req, REQ);
    assert.equal(u.locale, "en");
    // media
    assert.ok(w.media.has(11), "old Media kept");
    const m = w.media.get(newId)!;
    assert.equal(m.alt, "A wedding in Hue");
    assert.equal(typeof m.alt, "string");
    assert.equal(m.credit, "Jane / Pexels");
    assert.equal(m.caption, "Illustrative image");
    assert.equal(m.filename, `a-wedding-in-hue-r${heroToken(KEY)}.jpeg`);
    // nothing else moved
    const after = w.main.get(42)!;
    assert.equal(after._status, "published");
    assert.equal(after.workflowStatus, "published");
    assert.equal(after.version, 5);
    assert.deepEqual(after.leadImageCaption, { en: "Lead" });
    // one activity row with the P1 detail
    const acc = w.activity.filter((a) => a.eventType === "engine_write_accepted");
    assert.equal(acc.length, 1);
    assert.deepEqual(acc[0]!.detail, { action: "replace_hero", reason: "rights complaint", replacementKey: KEY, oldMediaId: 11, newMediaId: newId });
    assert.equal(acc[0]!.actorEngine, 5);
    assert.equal(acc[0]!.targetId, "42");
    assert.equal(w.activity.length, 1);
  });
  it("empty credit leaves Media credit unset; no caption key when none sent", async () => {
    const r = await call({ ...good, imageCredit: "  ", imageCaption: undefined });
    const m = w.media.get(r.body.newMediaId as number)!;
    assert.equal(m.credit, undefined);
    assert.equal("caption" in m, false);
  });
});

describe("dry run", () => {
  it("returns the inspect fields with no fetch, no write, no activity row", async () => {
    const r = await call({ publicationId: "vowasia", engineDraftId: good.engineDraftId, expectedHeroMediaId: null, dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      ok: true,
      status: "dry_run",
      articleId: 42,
      currentHeroMediaId: 11,
      currentHeroCredit: "Old / Pexels",
      currentHeroFilename: "a-wedding-in-hue.jpeg",
      version: 5,
      workflowStatus: "published",
      draftDiverged: false,
    });
    assert.equal(r.d.fetched.length, 0);
    assert.equal(w.updates.length, 0);
    assert.equal(w.activity.length, 0);
    assert.equal(r.d.lockCalls, 0);
  });
  it("reports draftDiverged and nulls when there is no hero", async () => {
    const a = article({ heroImage: null });
    reset(a);
    w.latest.set(42, { ...a, _status: "draft", version: 6 });
    const r = await call({ engineDraftId: good.engineDraftId, expectedHeroMediaId: null, dryRun: true, publicationId: "vowasia" });
    assert.equal(r.body.draftDiverged, true);
    assert.equal(r.body.currentHeroMediaId, null);
    assert.equal(r.body.currentHeroCredit, null);
    assert.equal(r.body.currentHeroFilename, null);
  });
});

describe("gate (P9)", () => {
  it("409 draft_diverged and change nothing when the latest version differs from the published main row (no fetch, no Media)", async () => {
    w.latest.set(42, { ...article(), _status: "draft", version: 6, title: { en: "Editor draft" } });
    const media = w.media.size;
    const r = await call(good);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "draft_diverged");
    assert.equal(r.body.reason, "article has unpublished changes");
    assert.equal(r.d.fetched.length, 0);
    assert.equal(w.media.size, media);
    assert.equal(w.updates.length, 0);
  });
  it("published + versions differ -> 409", async () => {
    w.latest.set(42, { ...article(), version: 6 });
    assert.equal((await call(good)).status, 409);
  });
  it("accepts a legacy row (_status draft, workflowStatus published, equal versions) and keeps both statuses after the swap", async () => {
    reset(article({ _status: "draft", workflowStatus: "published" }));
    const r = await call(good);
    assert.equal(r.status, 200);
    assert.equal(w.main.get(42)!._status, "draft");
    assert.equal(w.main.get(42)!.workflowStatus, "published");
  });
  it("draft-status (pending_review) row: equal versions pass, unequal fail", async () => {
    reset(article({ _status: "draft", workflowStatus: "pending_review" }));
    assert.equal((await call(good)).status, 200);
    reset(article({ _status: "draft", workflowStatus: "pending_review" }));
    w.latest.set(42, { ...article({ _status: "draft", workflowStatus: "pending_review" }), version: 6 });
    assert.equal((await call(good)).status, 409);
  });
  it("gate 2 inside the lock catches a change made after gate 1 (no write)", async () => {
    const d = deps({
      lockRow: async () => {
        // a concurrent editor draft lands between gate 1 and gate 2
        w.latest.set(42, { ...article(), _status: "draft", version: 6 });
      },
    });
    const r = await call(good, d);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "draft_diverged");
    assert.equal(w.updates.length, 0);
    assert.equal(w.activity.filter((a) => a.eventType === "engine_write_accepted").length, 0);
  });
  it("gate 2 hero_changed when an editor swapped the hero after gate 1", async () => {
    const d = deps({ lockRow: async () => void w.main.set(42, { ...w.main.get(42)!, heroImage: 77 }) });
    const r = await call(good, d);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "hero_changed");
    assert.equal(w.updates.length, 0);
  });
  it("lock busy -> 503 busy and no write", async () => {
    const d = deps({ lock: async () => new Response(JSON.stringify({ ok: false, status: "busy", reason: "article is busy, retry" }), { status: 503 }) });
    const r = await call(good, d);
    assert.equal(r.status, 503);
    assert.equal(r.body.status, "busy");
    assert.equal(w.updates.length, 0);
    assert.equal(w.activity.filter((a) => a.eventType === "engine_write_accepted").length, 0);
  });
  it("roll back and answer 409 when the post-write check sees an extra changed key, a moved version or a moved _status", async () => {
    for (const mutate of [(d: Doc) => void (d.editedByHuman = true), (d: Doc) => void (d.version = 6), (d: Doc) => void (d._status = "draft")]) {
      reset();
      w.mutateOnUpdate = mutate;
      const r = await call(good);
      assert.equal(r.status, 409, "status");
      assert.equal(r.body.status, "draft_diverged");
      assert.equal(w.main.get(42)!.heroImage, 11, "rolled back");
      assert.equal(w.activity.filter((a) => a.eventType === "engine_write_accepted").length, 0);
    }
  });
});

describe("errors", () => {
  it("single-home rule error maps to 422", async () => {
    w.failUpdate = new Error("pillar rule: Pressroom articles cannot have secondary sections.");
    const r = await call(good);
    assert.equal(r.status, 422);
    assert.equal(r.body.status, "unprocessable");
  });
  it("Payload ValidationError maps to 422 article_invalid", async () => {
    const e = new Error("The following field is invalid: author");
    e.name = "ValidationError";
    w.failUpdate = e;
    const r = await call(good);
    assert.equal(r.status, 422);
    assert.match(String(r.body.reason), /^article_invalid/);
    assert.equal(w.main.get(42)!.heroImage, 11);
  });
  it("unexpected error -> 500 with the generic reason; the message goes to integration_error only", async () => {
    w.failUpdate = new Error("secret detail xyz");
    const r = await call(good);
    assert.equal(r.status, 500);
    assert.equal(r.body.reason, "internal error");
    assert.equal(JSON.stringify(r.body).includes("secret detail xyz"), false);
    const ie = w.activity.filter((a) => a.eventType === "integration_error");
    assert.equal(ie.length, 1);
    assert.match(JSON.stringify(ie[0]!.detail), /secret detail xyz/);
  });
  it("502 hero_upload_failed on fetch failure; article untouched, no Media", async () => {
    const media = w.media.size;
    const r = await call(good, deps({ fetch: (async () => new Response("x", { status: 404 })) as never }));
    assert.equal(r.status, 502);
    assert.equal(r.body.status, "hero_upload_failed");
    assert.equal(w.media.size, media);
    assert.equal(w.updates.length, 0);
  });
});

describe("hardening (P15)", () => {
  for (const [url, why] of [
    ["http://x.supabase.co/a.jpg", "http"],
    ["https://127.0.0.1/a.jpg", "loopback"],
    ["https://169.254.169.254/a.jpg", "metadata"],
    ["https://u@x.supabase.co/a.jpg", "userinfo"],
  ] as const) {
    it(`422 invalid_hero_url: ${why}`, async () => {
      const r = await call({ ...good, heroImageUrl: url });
      assert.equal(r.status, 422);
      assert.match(String(r.body.reason), /^invalid_hero_url/);
      assert.equal(r.d.fetched.length, 0);
    });
  }
  it("redirect (3xx) -> 422 invalid_hero_url", async () => {
    const r = await call(good, deps({ fetch: (async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })) as never }));
    assert.equal(r.status, 422);
    assert.match(String(r.body.reason), /^invalid_hero_url/);
  });
  it("hostname resolving to a private address -> 422, no fetch", async () => {
    const r = await call(good, deps({ resolveHost: async () => ["10.1.2.3"] }));
    assert.equal(r.status, 422);
    assert.equal(r.d.fetched.length, 0);
  });
  it("wrong magic bytes behind Content-Type image/jpeg -> 422 hero_not_an_image", async () => {
    const r = await call(good, deps({ fetch: (async () => new Response("<svg/>", { headers: { "content-type": "image/jpeg" } })) as never }));
    assert.equal(r.status, 422);
    assert.match(String(r.body.reason), /^hero_not_an_image/);
  });
  it("host allowlist honoured when set", async () => {
    const env = { ENGINE_HERO_REPLACE_TENANTS: "vowasia", ENGINE_HERO_REPLACE_URL_HOSTS: "other.example" };
    const r = await call(good, deps({ env }));
    assert.equal(r.status, 422);
    const ok = await call(good, deps({ env: { ...env, ENGINE_HERO_REPLACE_URL_HOSTS: "x.supabase.co" } }));
    assert.equal(ok.status, 200);
  });
  it("ALLOW_LOCAL relaxes the URL guard and the DNS check, but not under NODE_ENV=production", async () => {
    const local = { ...good, heroImageUrl: "http://127.0.0.1:4555/a.jpg" };
    const on = await call(local, deps({ env: { ENGINE_HERO_REPLACE_TENANTS: "vowasia", ENGINE_HERO_REPLACE_ALLOW_LOCAL: "true" }, resolveHost: async () => ["127.0.0.1"] }));
    assert.equal(on.status, 200);
    reset();
    const prod = await call(local, deps({ env: { ENGINE_HERO_REPLACE_TENANTS: "vowasia", ENGINE_HERO_REPLACE_ALLOW_LOCAL: "true", NODE_ENV: "production" } }));
    assert.equal(prod.status, 422);
  });
  it("route exports maxDuration = 60 and only POST", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/api/engine/articles/hero/route.ts"), "utf8");
    assert.match(src, /export const maxDuration = 60;/);
    const exportsFound = [...src.matchAll(/^export (?:const|async function|function) (\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exportsFound, ["POST", "maxDuration"]);
  });
  it("the core has no static @payload-config import", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/engine-hero-replace-core.ts"), "utf8");
    assert.equal(/from\s+["']@payload-config["']/.test(src), false);
  });
});
