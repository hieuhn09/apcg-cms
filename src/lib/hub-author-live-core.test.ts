/**
 * Unit tests for ./hub-author-live-core + the `view=edit` live block of
 * ./hub-article-edit-select (APCGHub P5.4). Node's built-in runner, FAKE Payload only:
 * no database is ever reached. `hub-author-live-core.ts` imports `@payload-config`, which
 * refuses to load without a DATABASE_URL, so a NON-ROUTABLE placeholder is set below when
 * the variable is absent (port 1 on 127.0.0.1; `getPayload` is never called here). The real
 * sanitized config is loaded for the Lexical editor config (round-trip checks) and the
 * localized-field pin.
 *
 *   npm run test:hub-live
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://p54-unit@127.0.0.1:1/p54_unit_no_db";
process.env.PAYLOAD_SECRET ??= "p54-unit-placeholder";

type Doc = Record<string, unknown>;
type LiveCore = typeof import("./hub-author-live-core");
type EditSel = typeof import("./hub-article-edit-select");
type Pure = typeof import("./hub-author-live-pure");

let core: LiveCore;
let sel: EditSel;
let pure: Pure;
let CONFIG: Payload["config"];

before(async () => {
  core = await import("./hub-author-live-core");
  sel = await import("./hub-article-edit-select");
  pure = await import("./hub-author-live-pure");
  CONFIG = (await (await import("../../payload.config")).default) as unknown as Payload["config"];
});

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
const text = (t: string) => ({ type: "text", version: 1, text: t, format: 0, detail: 0, mode: "normal", style: "" });
const para = (t: string) => ({ type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, textFormat: 0, textStyle: "", children: [text(t)] });
const up = (id: number, populated?: Doc) => ({ type: "upload", version: 3, format: "", id: `n${id}`, fields: null, relationTo: "media", value: populated ?? id });
const lex = (...children: unknown[]) => ({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children } });
const BODY = lex(para("Live body paragraph."));
const LOCALIZED = ["title", "slug", "dek", "body", "imageLabel", "leadImageCaption"];

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
  main?: Doc;
  latest?: Doc;
  translations?: boolean;
  hubAuthorLookup?: boolean;
  subsections?: Doc[];
  media?: number[];
  /** The nested translation update bumps the version a second time (N+2). */
  doubleBump?: boolean;
  /** The fake `select` is honoured (only the selected keys come back). */
  honourSelect?: boolean;
  noSession?: boolean;
}

function world(o: WorldOpts = {}) {
  const tenant = {
    id: 1, slug: "gcv", status: "active", defaultLanguage: "en",
    supportedLanguages: o.translations ? ["en", "fr"] : ["en"],
    features: { articles: true, translations: o.translations === true },
  };
  const base: Doc = {
    id: 5, tenant: 1, origin: "manual", workflowStatus: "published", _status: "published", version: 4, lastEngine: 7, engineDraftId: null,
    title: "Old title", titleFr: "Ancien", slug: "s-5", dek: null, body: BODY, takeaways: null, pillar: 11, subSection: null, author: 3, readMin: 2,
    sponsored: false, sponsor: null, deepDive: false, longHaul: false, secondarySections: [], briefs: [], video: null, heroImage: null,
    publishedAt: "2026-10-01T00:00:00.000Z", scheduledFor: null, sourceLanguage: "en", tags: [], countries: [], country: null, cities: [], coAuthors: [],
  };
  const st = { main: { ...base, ...o.main } as Doc, latest: { ...base, ...o.main, ...o.latest } as Doc };
  const log = { reads: [] as Doc[], updates: [] as Doc[], creates: [] as Doc[], events: [] as string[], sql: [] as unknown[] };
  const shape = (d: Doc, a: Doc): Doc => {
    const out: Doc = { ...d };
    const fr = out.titleFr;
    delete out.titleFr;
    if (a.locale === "all") {
      for (const k of LOCALIZED) if (k in out) out[k] = { en: out[k], ...(k === "title" ? { fr } : {}) };
    }
    if (o.honourSelect && a.select && typeof a.select === "object") {
      for (const k of Object.keys(out)) if (k !== "id" && !(a.select as Doc)[k]) delete out[k];
    }
    return out;
  };
  const sessions: Record<string, unknown> = o.noSession
    ? {}
    : { tx1: { db: { execute: async (q: unknown) => { log.events.push("rowlock"); log.sql.push(q); } } } };
  const payload = {
    config: CONFIG,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    db: { sessions },
    async findByID(a: Doc) {
      log.reads.push(a);
      if (a.collection === "tenants") return { ...tenant, features: { ...tenant.features } };
      if (a.collection === "content-engines") return { id: 7, hubAuthor: o.hubAuthorLookup ?? true };
      if (a.collection === "articles") {
        log.events.push(`read:${a.draft ? "latest" : "main"}${a.req ? ":tx" : ""}${a.locale ? `:${String(a.locale)}` : ""}`);
        return shape(a.draft ? st.latest : st.main, a);
      }
      return null;
    },
    async find(a: Doc) {
      const col = String(a.collection);
      const src: Doc[] =
        col === "pillars" ? [{ id: 11, tenant: 1, slug: "p-main" }, { id: 14, tenant: 1, slug: "p-other" }]
          : col === "subsections" ? (o.subsections ?? [])
            : col === "media" ? (o.media ?? []).map((id) => ({ id, tenant: 1 }))
              : [];
      const docs = src.filter((d) => match(d, a.where)).slice(0, Number(a.limit ?? 10)).map((d) => ({ ...d }));
      return { docs, totalDocs: docs.length };
    },
    async create(a: Doc) {
      log.creates.push(a);
      return {};
    },
    async update(a: Doc) {
      log.updates.push(a);
      log.events.push("update");
      // Payload's non-draft update base-merges from the LATEST version.
      const next = { ...st.latest, ...(a.data as Doc) };
      next.version = (st.latest.version as number) + (o.doubleBump ? 2 : 1);
      st.main = next;
      st.latest = { ...next };
      return { ...next, version: 9999 };
    },
  };
  return { payload: payload as unknown as Payload, st, log, tenant };
}

type World = ReturnType<typeof world>;

function deps(w: World, extra: Record<string, unknown> = {}) {
  return {
    getPayload: async () => w.payload,
    authenticate: (async () => ({ ok: true, engine: { id: 60, hubWrite: true, hubAuthor: extra.engineHubAuthor === true }, tenants: [{ id: 1, slug: "gcv" }] })) as never,
    lock: (async (_a: unknown, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
      w.log.events.push("lock");
      const r = await fn({ req: LOCK_REQ, lockSlug: async () => {} });
      w.log.events.push(r.ok ? "commit" : "kill");
      return r.value;
    }) as never,
    liveTenants: ["gcv"],
    ...extra,
  };
}
const LOCK_REQ = { transactionID: "tx1" } as const;

const request = (fields: unknown, extra: Doc = {}) =>
  new Request("http://cms.local/api/hub/articles/5/live", { method: "PATCH", body: JSON.stringify({ tenant: "gcv", expectedVersion: 4, actor: ACTOR, fields, ...extra }) });
const ctx = { params: Promise.resolve({ id: "5" }) };
async function call(w: World, fields: unknown, extra: Record<string, unknown> = {}, body: Doc = {}) {
  const res = await core.handleHubLiveUpdateWith(request(fields, body), { params: Promise.resolve({ id: "5" }) }, deps(w, extra) as never);
  return { status: res.status, body: (await res.json()) as Doc };
}
const articleReads = (w: World) => w.log.reads.filter((r) => r.collection === "articles");

test("live body adding a new media id is rejected unknown_ref", async () => {
  const convertWith = (ids: number[]) => async () => ({ ok: true as const, lexical: lex(para("Text."), ...ids.map((i) => up(i))) });
  // Media 99 exists in the tenant but is NOT in the live body ⇒ 422 unknown_ref, nothing written.
  const w = world({ media: [99] });
  const r = await call(w, { bodyMarkdown: "Text.\n\n![](cms-media:99)" }, { convert: convertWith([99]) });
  assert.deepEqual([r.status, r.body], [422, { ok: false, status: "invalid", reason: "one or more fields are invalid", fields: { bodyMarkdown: "unknown_ref" } }]);
  assert.equal(w.log.updates.length, 0);
  // Media 99 IS already in the live body ⇒ the same Markdown passes.
  const w2 = world({ media: [99], main: { body: lex(para("Text."), up(99)) } });
  const r2 = await call(w2, { bodyMarkdown: "Text.\n\n![](cms-media:99)\n\nMore." }, { convert: async () => ({ ok: true as const, lexical: lex(para("Text."), up(99), para("More.")) }) });
  assert.equal(r2.status, 200);
  // Removing the image is allowed.
  const w3 = world({ main: { body: lex(para("Text."), up(99)) } });
  const r3 = await call(w3, { bodyMarkdown: "Text only." }, { convert: async () => ({ ok: true as const, lexical: lex(para("Text only.")) }) });
  assert.equal(r3.status, 200);
  assert.equal(core.liveBodyMediaAllowed("a\n\n![](cms-media:5)", lex(up(5))), true);
  assert.equal(core.liveBodyMediaAllowed("a\n\n![](cms-media:6)", lex(up(5))), false);
});

test("live write uses hubAuthor context, never hubWrite, never draft, never disableRevalidate", async () => {
  const w = world();
  const r = await call(w, { title: "New title" });
  assert.equal(r.status, 200);
  assert.equal(w.log.updates.length, 1);
  const u = w.log.updates[0]!;
  assert.equal("draft" in u, false);
  assert.equal(u.req, LOCK_REQ);
  assert.equal(u.locale, "en");
  assert.deepEqual(Object.keys(u.data as Doc), ["title"]);
  const c = u.context as Doc;
  assert.deepEqual(c, { hubAuthor: { actor: ACTOR, action: "update", fields: ["title"] }, engineId: 60 });
  assert.equal("hubWrite" in c, false);
  assert.equal("disableRevalidate" in c, false);
  // Source pin: the live core never builds a hubWrite context or a draft write.
  const src = readFileSync(path.resolve(process.cwd(), "src/lib/hub-author-live-core.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/hubWrite\s*:/.test(src), false);
  assert.equal(/disableRevalidate/.test(src), false);
  const at = src.indexOf("await payload.update({");
  assert.equal(at > 0 && src.indexOf("await payload.update({", at + 1) === -1, true, "exactly one write");
  const block = src.slice(at, src.indexOf("});", at));
  assert.equal(/draft|hubWrite|disableRevalidate|workflowStatus|_status|publishedAt/.test(block), false, block);
  assert.match(block, /context: \{ hubAuthor: \{ actor: v\.actor, action: "update", fields: changed \}, engineId: engine\.id \}/);
});

test("stale expectedVersion returns 409 version_conflict inside the lock", async () => {
  // Before the lock.
  const w0 = world();
  const r0 = await call(w0, { title: "T2" }, {}, { expectedVersion: 3 });
  assert.deepEqual([r0.status, r0.body], [409, { ok: false, status: "version_conflict", reason: "article version changed", currentVersion: 4 }]);
  assert.equal(w0.log.events.includes("lock"), false);
  // Inside the lock: another write commits between gate 1 and the lock (version 4 → 5).
  const w = world();
  const r = await call(w, { title: "T2" }, {
    lockRow: async () => {
      w.st.main = { ...w.st.main, version: 5 };
      w.st.latest = { ...w.st.latest, version: 5 };
    },
  });
  assert.deepEqual([r.status, r.body], [409, { ok: false, status: "version_conflict", reason: "article version changed", currentVersion: 5 }]);
  assert.equal(w.log.updates.length, 0);
  assert.equal(w.log.events.at(-1), "kill");
});

test("view=edit live block absent for drafts and default read unchanged", async () => {
  const w = world({ main: { workflowStatus: "draft", _status: "draft" } });
  const r = await sel.loadHubArticleEdit({ payload: w.payload, mainDoc: { ...w.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] });
  assert.equal("live" in (r.edit as unknown as Doc), false);
  // Published main WITHOUT tenantSlug (an old caller) ⇒ exactly the P5.1 answer, no env read.
  const w2 = world();
  const r2 = await sel.loadHubArticleEdit({ payload: w2.payload, mainDoc: { ...w2.st.main }, tenantId: 1 });
  assert.deepEqual(r2, { edit: { editable: false, editableReason: "status" }, latest: null });
  assert.equal(articleReads(w2).length, 0);
  // Engine article (origin engine) ⇒ the origin branch, no live block.
  const w3 = world({ main: { origin: "engine" } });
  const r3 = await sel.loadHubArticleEdit({ payload: w3.payload, mainDoc: { ...w3.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] });
  assert.deepEqual(r3, { edit: { editable: false, editableReason: "origin" }, latest: null });
  // Hidden / archived main ⇒ no live block.
  for (const ws of ["hidden", "archived"]) {
    const wh = world({ main: { workflowStatus: ws } });
    const rh = await sel.loadHubArticleEdit({ payload: wh.payload, mainDoc: { ...wh.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] });
    assert.deepEqual(rh, { edit: { editable: false, editableReason: "status" }, latest: null });
  }
  // The route reads `view=edit` (and so the live block) ONLY under `wantEdit`; the default read is untouched.
  const route = readFileSync(path.resolve(process.cwd(), "src/app/api/hub/articles/[id]/route.ts"), "utf8");
  assert.match(route, /if \(wantEdit\) \{\s*try \{\s*const r = await loadHubArticleEdit\(\{ payload, mainDoc: doc, tenantId: tenant\.id, tenantSlug: tenant\.slug \}\);/);
  assert.equal((route.match(/loadHubArticleEdit\(/g) ?? []).length, 1);
});

test("post-write assertion turns an interleaved draft into 409 draft_diverged with rollback", async () => {
  const w = world();
  const r = await call(w, { dek: "New dek" }, {
    beforeWrite: async () => {
      // A Save-Draft from /admin commits between gate 2 and the write (another connection).
      w.st.latest = { ...w.st.main, title: "Unpublished draft title", _status: "draft", version: (w.st.main.version as number) + 1 };
    },
  });
  assert.deepEqual([r.status, r.body], [409, { ok: false, status: "draft_diverged", reason: "article has unpublished changes" }]);
  assert.equal(JSON.stringify(r.body).includes("Unpublished draft title"), false);
  assert.equal(w.log.events.at(-1), "kill");
  // ADV3-1: on a translation tenant, a draft that changed ONLY the fr title ⇒ 409 too.
  const wt = world({ translations: true, doubleBump: true });
  const rt = await call(wt, { dek: "New dek" }, {
    beforeWrite: async () => {
      wt.st.latest = { ...wt.st.main, titleFr: "Glissé", _status: "draft", version: (wt.st.main.version as number) + 1 };
    },
  });
  assert.equal(rt.status, 409);
  assert.equal(wt.log.events.at(-1), "kill");
  // Control: no interleaving ⇒ 200 on both tenants.
  assert.equal((await call(world(), { dek: "New dek" })).status, 200);
  assert.equal((await call(world({ translations: true, doubleBump: true }), { dek: "New dek" })).status, 200);
});

test("post-write reads use findMainTx with lk.req, never defaultFindMain", async () => {
  const w = world();
  const seen: Doc[] = [];
  const r = await call(w, { title: "T3" }, {
    findMainTx: async (p: Payload, id: number, req: unknown, o?: { locale?: string }) => {
      seen.push({ req, locale: o?.locale });
      return core.defaultFindMainTx(p, id, req as never, o);
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [{ req: LOCK_REQ, locale: "all" }, { req: LOCK_REQ, locale: "all" }]);
  // A read OUTSIDE the transaction (sees the old row) would fail D12 on every write.
  const w2 = world();
  const frozen = { ...w2.st.main };
  const r2 = await call(w2, { title: "T3" }, { findMainTx: async (_p: Payload, _id: number, _req: unknown, o?: { locale?: string }) => (o?.locale === "all" ? { ...frozen, title: { en: frozen.title } } : frozen) });
  assert.equal(r2.status, 409);
  // The default read passes `req` and the locale.
  const w3 = world();
  await core.readMainAll(w3.payload, 5, LOCK_REQ as never);
  const last = w3.log.reads.at(-1)!;
  assert.deepEqual([last.req, last.locale, last.depth, "draft" in last], [LOCK_REQ, "all", 0, false]);
});

test("live runs checkPublishable on the merged result and returns 422 invalid", async () => {
  // Pillar 11 has sub-sections, the article has none ⇒ subSectionSlug required.
  const w = world({ subsections: [{ id: 21, tenant: 1, pillar: 11 }] });
  const r = await call(w, { title: "T4" });
  assert.deepEqual([r.status, r.body], [422, { ok: false, status: "invalid", reason: "one or more fields are invalid", fields: { subSectionSlug: "required" } }]);
  assert.equal(w.log.updates.length, 0);
  assert.equal(w.log.events.includes("lock"), false);
  // An empty body on a live article ⇒ bodyMarkdown required.
  const w2 = world();
  const r2 = await call(w2, { bodyMarkdown: "" });
  assert.deepEqual([r2.status, (r2.body.fields as Doc)?.bodyMarkdown], [422, "required"]);
  assert.equal(w2.log.updates.length, 0);
  // sponsored article: clearing the sponsor ⇒ required (merge rules of PATCH).
  const w3 = world({ main: { sponsored: true, sponsor: "Acme" } });
  const r3 = await call(w3, { sponsor: null });
  assert.deepEqual([r3.status, (r3.body.fields as Doc)?.sponsor], [422, "required"]);
});

test("live returns 422 body_not_editable for a non round-trip body", async () => {
  const rel = { type: "relationship", format: "", version: 2, relationTo: "articles", value: 1 };
  const w = world({ main: { body: lex(para("Before."), rel) } });
  const r = await call(w, { bodyMarkdown: "Replacement." });
  assert.deepEqual([r.status, r.body], [422, { ok: false, status: "body_not_editable", reason: "existing body cannot be edited as Markdown" }]);
  assert.equal(w.log.updates.length, 0);
  // Other fields of that article stay editable live.
  assert.equal((await call(world({ main: { body: lex(para("Before."), rel) } }), { dek: "Dek only" })).status, 200);
});

test("returned version is re-read inside the lock, never updated.version", async () => {
  // Non-translation tenant: N + 1 (the fake's `updated.version` is 9999).
  const w = world();
  const r = await call(w, { title: "T5" });
  assert.deepEqual([r.status, r.body.version], [200, 5]);
  // Translation tenant whose nested update bumps again: N + 2, read back.
  const wt = world({ translations: true, doubleBump: true });
  const rt = await call(wt, { title: "T5" });
  assert.deepEqual([rt.status, rt.body.version], [200, 6]);
  // A second save with the returned version is not a false 409.
  const rt2 = await call(wt, { title: "T6" }, {}, { expectedVersion: rt.body.version as number });
  assert.deepEqual([rt2.status, rt2.body.version], [200, 8]);
  assert.deepEqual(Object.keys(r.body), ["ok", "id", "tenant", "workflowStatus", "version", "changed"]);
  assert.deepEqual([r.body.workflowStatus, r.body.changed], ["published", ["title"]]);
});

test("tenant outside HUB_LIVE_EDIT_TENANTS gets 403 feature_disabled before any read", async () => {
  const off = { ok: false, status: "feature_disabled", reason: "live edit disabled for tenant" };
  const w = world();
  const r = await call(w, { title: "T7" }, { liveTenants: ["dtw", "world-travel-brief"] });
  assert.deepEqual([r.status, r.body], [403, off]);
  assert.equal(articleReads(w).length, 0);
  // Default (no deps.liveTenants): the env is read on this call.
  const prev = process.env.HUB_LIVE_EDIT_TENANTS;
  try {
    for (const raw of [undefined, "", "GCV", "*", "dtw"]) {
      if (raw === undefined) delete process.env.HUB_LIVE_EDIT_TENANTS;
      else process.env.HUB_LIVE_EDIT_TENANTS = raw;
      const w2 = world();
      const d = deps(w2) as Record<string, unknown>;
      delete d.liveTenants;
      const res = await core.handleHubLiveUpdateWith(request({ title: "T7" }), ctx, d as never);
      assert.deepEqual([res.status, await res.json()], [403, off], String(raw));
      assert.equal(articleReads(w2).length, 0);
    }
    process.env.HUB_LIVE_EDIT_TENANTS = "dtw, gcv";
    const w3 = world();
    const d3 = deps(w3) as Record<string, unknown>;
    delete d3.liveTenants;
    assert.equal((await core.handleHubLiveUpdateWith(request({ title: "T7" }), { params: Promise.resolve({ id: "5" }) }, d3 as never)).status, 200);
  } finally {
    if (prev === undefined) delete process.env.HUB_LIVE_EDIT_TENANTS;
    else process.env.HUB_LIVE_EDIT_TENANTS = prev;
  }
});

test("computeEditLive returns feature_disabled without any DB read when the switch is off", async () => {
  const w = world();
  const live = await sel.computeEditLive({ payload: w.payload, mainDoc: { ...w.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["world-travel-brief"] });
  assert.deepEqual(live, { editable: false, reason: "feature_disabled", version: null });
  assert.equal(w.log.reads.length, 0);
  const w2 = world();
  const r = await sel.loadHubArticleEdit({ payload: w2.payload, mainDoc: { ...w2.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: [] });
  assert.deepEqual(r, { edit: { editable: false, editableReason: "status", live: { editable: false, reason: "feature_disabled", version: null } }, latest: null });
  assert.equal(w2.log.reads.length, 0);
});

test("view=edit live block carries populated values and cms-media tokens when live editable", async () => {
  const media = (id: number, tenant = 1) => ({ id, tenant, url: `/api/media/file/m${id}.png`, alt: `alt ${id}`, width: 10, height: 8, credit: id === 50 ? "Cr" : null });
  const display: Doc = {
    pillar: { id: 11, slug: "p-main" }, subSection: { id: 21, slug: "s-a" }, tags: [{ id: 1, slug: "t-a" }], countries: [{ id: 2, slug: "vietnam" }], cities: [],
    author: { id: 3 }, coAuthors: [{ id: 4 }], heroImage: media(50), leadImageCaption: "Cap", sponsor: null, deepDive: true,
    secondarySections: [{ pillar: { id: 14, slug: "p-other" }, subSection: null }],
    body: lex(para("Intro."), up(51, media(51)), para("End.")),
  };
  const w = world();
  const orig = w.payload.findByID.bind(w.payload);
  (w.payload as unknown as { findByID: (a: Doc) => Promise<unknown> }).findByID = async (a: Doc) => {
    const d = (await orig(a as never)) as unknown as Doc;
    return a.collection === "articles" && a.depth === 2 ? { ...d, ...display } : d;
  };
  const live = await sel.computeEditLive({ payload: w.payload, mainDoc: { ...w.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] });
  assert.deepEqual(Object.keys(live), ["editable", "reason", "version", "bodyEditable", "pillarSlug", "subSectionSlug", "secondary", "tagSlugs", "countrySlugs", "citySlugs", "authorId", "coAuthorIds", "flags", "sponsor", "hero", "leadImageCaption", "bodyMedia"]);
  assert.equal(Object.keys(live).length, 17);
  const y = live as unknown as Doc;
  assert.deepEqual([y.editable, y.reason, y.version, y.bodyEditable, y.pillarSlug, y.subSectionSlug, y.tagSlugs, y.countrySlugs, y.authorId, y.coAuthorIds, y.leadImageCaption], [true, "ok", 4, true, "p-main", "s-a", ["t-a"], ["vietnam"], 3, [4], "Cap"]);
  assert.deepEqual(y.secondary, [{ pillarSlug: "p-other", subSectionSlug: null }]);
  assert.equal((y.flags as Doc).deepDive, true);
  assert.deepEqual([(y.hero as Doc).id, (y.hero as Doc).credit, (y.bodyMedia as Doc[]).map((m) => m.id)], [50, "Cr", [51]]);
  // The display read is ONE non-draft read with the edit select (gate reads: full main + latest).
  const shown = articleReads(w).filter((r) => r.depth === 2);
  assert.deepEqual([shown.length, "draft" in shown[0]!, shown[0]!.locale, shown[0]!.select === sel.HUB_ARTICLE_EDIT_SELECT], [1, false, "en", true]);
  // Token fallback ⇒ live.bodyEditable false (CMS3-6); the old branch is untouched.
  const withLive = { editable: false, editableReason: "status", live } as never;
  assert.equal(((sel.applyBodyTokenFallback(withLive, true) as unknown as Doc).live as Doc).bodyEditable, false);
  assert.equal(sel.applyBodyTokenFallback(withLive, false), withLive);
  const noLive = { editable: false, editableReason: "status" } as never;
  assert.equal(sel.applyBodyTokenFallback(noLive, true), noLive);
  // No tenantSlug ⇒ no live block (CMS3-5).
  const w2 = world();
  assert.equal("live" in ((await sel.loadHubArticleEdit({ payload: w2.payload, mainDoc: { ...w2.st.main }, tenantId: 1 })).edit as unknown as Doc), false);
  // The route asks for media tokens on the live-editable branch too.
  const route = readFileSync(path.resolve(process.cwd(), "src/app/api/hub/articles/[id]/route.ts"), "utf8");
  assert.match(route, /\.\.\.\(edit && \(edit\.editable \|\| \("live" in edit && edit\.live\?\.editable === true\)\) \? \{ mediaTokens: true \} : \{\}\),/);
  // …and the token export of that body yields a cms-media token for the image.
  const { hubArticleBodyToMarkdown, loadHubEditorConfig } = await import("./hub-article-markdown");
  const md = await hubArticleBodyToMarkdown(display.body, { loadEditorConfig: () => loadHubEditorConfig(CONFIG as never), mediaTokens: true });
  assert.equal(String(md.bodyMarkdown).includes("cms-media:51"), true);
  // Not-editable live branches.
  const wd = world({ latest: { _status: "draft", version: 5, title: "Draft" } });
  assert.deepEqual(await sel.computeEditLive({ payload: wd.payload, mainDoc: { ...wd.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] }), { editable: false, reason: "draft_diverged", version: 4 });
  const wn = world({ hubAuthorLookup: false });
  assert.deepEqual(await sel.computeEditLive({ payload: wn.payload, mainDoc: { ...wn.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] }), { editable: false, reason: "not_hub_authored", version: 4 });
});

test("live gate is correct when the narrow main select lacks fields", async () => {
  // engineDraftId set on a hub-authored-looking article: a narrow select would drop it and open the gate.
  const w = world({ main: { engineDraftId: "eng-77" }, honourSelect: true });
  const r = await call(w, { title: "T8" });
  assert.deepEqual([r.status, r.body], [422, { ok: false, status: "not_live_editable", reason: "not_hub_authored" }]);
  const mainReads = articleReads(w).filter((a) => !a.draft && !a.req);
  assert.equal(mainReads.length >= 1, true);
  assert.equal(mainReads.every((a) => a.select === undefined), true);
  // view=edit: the gate read of computeEditLive is FULL too.
  const w2 = world({ main: { engineDraftId: "eng-77" }, honourSelect: true });
  assert.deepEqual(await sel.computeEditLive({ payload: w2.payload, mainDoc: { ...w2.st.main }, tenantId: 1, tenantSlug: "gcv", liveTenants: ["gcv"] }), { editable: false, reason: "not_hub_authored", version: 4 });
});

test("engine carrying hubAuthor is refused 403 on live even with hubWrite", async () => {
  const w = world();
  const r = await call(w, { title: "T9" }, { engineHubAuthor: true });
  assert.deepEqual([r.status, r.body], [403, { ok: false, status: "forbidden", reason: "author key cannot live-edit" }]);
  assert.equal(articleReads(w).length, 0);
  assert.equal(w.log.updates.length, 0);
});

test("LIVE_KEY_COLUMNS maps every HUB_LIVE_FIELD_KEYS key including readMin and a readMin-only edit passes D12", async () => {
  assert.deepEqual(Object.keys(core.LIVE_KEY_COLUMNS).sort(), [...pure.HUB_LIVE_FIELD_KEYS].sort());
  assert.deepEqual(core.LIVE_KEY_COLUMNS.readMin, ["readMin"]);
  assert.deepEqual(core.LIVE_KEY_COLUMNS.countrySlugs, ["countries", "country"]);
  assert.deepEqual(core.liveChangedColumns(["flags"], { flags: { deepDive: true } }), ["deepDive"]);
  const w = world();
  const r = await call(w, { readMin: 7 });
  assert.deepEqual([r.status, r.body.changed, w.st.main.readMin], [200, ["readMin"], 7]);
  // Every live key's columns are exactly what buildDraftUpdateData writes for it (one key at a time).
  for (const [k, value] of Object.entries({ title: "X", dek: "Y", takeaways: ["a"], readMin: 9, flags: { longHaul: true }, sponsor: "Sp" })) {
    const wk = world();
    const rk = await call(wk, { [k]: value });
    assert.equal(rk.status, 200, k);
    const cols = Object.keys(wk.log.updates[0]!.data as Doc).sort();
    assert.deepEqual(cols, [...core.liveChangedColumns([k as never], { flags: k === "flags" ? (value as never) : undefined })].sort(), k);
  }
  // The localized-field list is the config's (pin).
  const articles = (CONFIG as unknown as { collections: { slug: string; flattenedFields: { name: string; localized?: boolean }[] }[] }).collections.find((c) => c.slug === "articles")!;
  assert.deepEqual(articles.flattenedFields.filter((f) => f.localized).map((f) => f.name).sort(), [...pure.LIVE_LOCALIZED_FIELDS].sort());
});

test("live write data carries no workflowStatus or _status and a slipped status Hide becomes 409 without republishing", async () => {
  const w = world();
  const r = await call(w, { title: "T10" }, {
    lockRow: async () => {},
    beforeWrite: async () => {
      // `/status` Hide (context.hubWrite, no lock) commits before the write reads the latest version.
      w.st.main = { ...w.st.main, workflowStatus: "archived" };
      w.st.latest = { ...w.st.latest, workflowStatus: "archived" };
    },
  });
  assert.deepEqual([r.status, r.body.status], [409, "draft_diverged"]);
  const data = w.log.updates[0]!.data as Doc;
  assert.equal(["workflowStatus", "_status", "publishedAt"].some((k) => k in data), false);
  assert.equal(w.st.main.workflowStatus, "archived");
  assert.equal(w.log.events.at(-1), "kill");
});

test("live takes a FOR NO KEY UPDATE row lock on the article through the transaction session before the second gate reads", async () => {
  const w = world();
  const r = await call(w, { title: "T11" });
  assert.equal(r.status, 200);
  const ev = w.log.events;
  const iLock = ev.indexOf("lock");
  const iRow = ev.indexOf("rowlock");
  const iGate2 = ev.indexOf("read:latest:tx:en");
  assert.deepEqual([iLock >= 0, iRow > iLock, iGate2 > iRow], [true, true, true]);
  const q = w.log.sql[0] as { queryChunks?: unknown[] };
  const flat = JSON.stringify(q.queryChunks ?? q);
  assert.equal(flat.includes("SELECT 1 FROM articles WHERE id = "), true);
  assert.equal(flat.includes(" FOR NO KEY UPDATE"), true);
  assert.equal(flat.includes("FOR UPDATE\""), false);
  // No transaction session ⇒ throw ⇒ 500, nothing written.
  const w2 = world({ noSession: true });
  const r2 = await call(w2, { title: "T11" });
  assert.deepEqual([r2.status, r2.body], [500, { ok: false, status: "internal_error" }]);
  assert.equal(w2.log.updates.length, 0);
});
