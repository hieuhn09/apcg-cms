/**
 * Unit tests for ./hub-direct-upload-core (hub docx import phase A — sign + register;
 * AC1 / AC3 / AC4 / AC5 / AC7). FAKE Payload only; the REAL `authenticateHubAuthorEngine`,
 * `resolveTenant` and `loadHubEditableArticle` run against it. Staging is an in-memory
 * fake; the real `createTenantMedia` (real sharp) runs with an injected Payload create.
 * `hub-direct-upload-core.ts` imports `@payload-config`, which refuses to load without
 * a DATABASE_URL, so a NON-ROUTABLE placeholder is set when absent (`getPayload` is
 * never called here).
 *
 *   npm run test:hub-direct-upload
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Payload } from "payload";
import sharp from "sharp";

process.env.DATABASE_URL ??= "postgres://direct-unit@127.0.0.1:1/direct_unit_no_db";
process.env.PAYLOAD_SECRET ??= "direct-unit-placeholder";

type Doc = Record<string, unknown>;
type Core = typeof import("./hub-direct-upload-core");
type Pure = typeof import("./hub-direct-upload-pure");
type MediaCreate = typeof import("./media-create");
type R2 = typeof import("./r2");
let core: Core;
let pure: Pure;
let mc: MediaCreate;
let r2: R2;
before(async () => {
  core = await import("./hub-direct-upload-core");
  pure = await import("./hub-direct-upload-pure");
  mc = await import("./media-create");
  r2 = await import("./r2");
});

const SECRET = "direct-unit-secret";
const ENV = { HUB_DIRECT_UPLOAD_TENANTS: "gcv,wad", PAYLOAD_SECRET: SECRET };
const TOKENS = { author: "direct-author-key", read: "direct-read-key", both: "direct-two-tenant-key" } as const;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ALT = "A very private alt text";
const NOW_MS = 1_800_000_000_000;

// ── Fakes ────────────────────────────────────────────────────────────────────

interface WorldOpts {
  articlesFeature?: boolean;
}

function world(o: WorldOpts = {}) {
  const tenants: Record<string, Doc> = {
    "1": { id: 1, slug: "gcv", name: "GCV", status: "active", features: { articles: o.articlesFeature ?? true } },
    "2": { id: 2, slug: "wad", name: "WAD", status: "active", features: { articles: true } },
    "3": { id: 3, slug: "dtw", name: "DTW", status: "active", features: { articles: true } },
  };
  const engines: Doc[] = [
    { id: 71, status: "active", tokenHash: sha(TOKENS.author), hubRead: true, hubAuthor: true, allowedTenants: [1, 3] },
    { id: 72, status: "active", tokenHash: sha(TOKENS.read), hubRead: true, allowedTenants: [1] },
    { id: 73, status: "active", tokenHash: sha(TOKENS.both), hubRead: true, hubAuthor: true, allowedTenants: [1, 2] },
  ];
  const articles: Record<string, Doc> = {
    "42": { id: 42, tenant: 1, origin: "manual", workflowStatus: "draft", lastEngine: 71 },
    "43": { id: 43, tenant: 1, origin: "manual", workflowStatus: "draft", lastEngine: 71 },
    "44": { id: 44, tenant: 1, origin: "engine", workflowStatus: "draft", lastEngine: 99 },
    "50": { id: 50, tenant: 2, origin: "manual", workflowStatus: "draft", lastEngine: 73 },
  };
  const log = { lines: [] as string[], activity: [] as Doc[] };
  const logger = {
    info: (m: unknown) => log.lines.push(String(m)),
    warn: (m: unknown) => log.lines.push(String(m)),
    error: (m: unknown) => log.lines.push(String(m)),
  };
  const payload = {
    logger,
    async find(a: Doc) {
      if (a.collection === "content-engines") {
        const h = ((a.where as Doc).tokenHash as Doc).equals;
        return { docs: engines.filter((e) => e.tokenHash === h), totalDocs: 1 };
      }
      return { docs: [], totalDocs: 0 };
    },
    async findByID(a: Doc) {
      if (a.collection === "tenants") {
        const t = tenants[String(a.id)];
        if (!t) throw new Error("not found");
        return { ...t };
      }
      if (a.collection === "content-engines") return engines.find((e) => String(e.id) === String(a.id)) ?? null;
      if (a.collection === "articles") {
        const d = articles[String(a.id)];
        return d ? { ...d } : null;
      }
      return null;
    },
    async create(a: Doc) {
      if (a.collection === "activityLog") log.activity.push(a.data as Doc);
      return {};
    },
    async update() {
      return {};
    },
  } as unknown as Payload;
  return { payload, log };
}

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

function fakeStaging(prefix = "") {
  const objects = new Map<string, StoredObject>();
  const calls = { presign: [] as unknown[][], head: 0, get: 0, deleted: [] as string[], grow: false };
  const store: import("./r2").StagingStore = {
    bucket: "stage",
    prefix,
    async presignPut(key, mime, size, ttl) {
      calls.presign.push([key, mime, size, ttl]);
      return `https://staging.example/${key}?X-Amz-Signature=deadbeef`;
    },
    async head(key) {
      calls.head++;
      const o = objects.get(key);
      return o ? { size: o.bytes.length, contentType: o.contentType } : null;
    },
    async getBytes(key, max) {
      calls.get++;
      const o = objects.get(key);
      if (!o) return { ok: false, reason: "missing" };
      // `grow` = the object was overwritten (bigger) between HEAD and GET
      const bytes = calls.grow ? Buffer.concat([o.bytes, Buffer.alloc(10)]) : o.bytes;
      async function* gen() {
        for (let i = 0; i < bytes.length; i += 1000) yield bytes.subarray(i, i + 1000);
      }
      const r = await r2.readStreamCapped(gen(), max);
      return r.ok ? r : { ok: false, reason: "too_large" };
    },
    async delete(key) {
      calls.deleted.push(key);
      objects.delete(key);
    },
  };
  /** What the browser would do with the presigned URL. */
  const put = (key: string, bytes: Buffer, contentType: string) => objects.set(key, { bytes, contentType });
  return { store, objects, calls, put };
}

/** The media table of one test: find / update / create recorders around the real createTenantMedia. */
function mediaTable() {
  const rows: Doc[] = [];
  const created: Doc[] = [];
  const updates: Doc[] = [];
  let next = 900;
  const scopedCreate = async (a: { collection: string; tenantId: number | string; data: Doc; file?: { data: Buffer; mimetype: string; name: string; size: number } }) => {
    const row: Doc = { id: next++, tenant: a.tenantId, ...a.data, filename: a.file?.name, mimeType: a.file?.mimetype, filesize: a.file?.size, _bytes: a.file?.data };
    rows.push(row);
    created.push(row);
    return row;
  };
  const deps = {
    create: ((args: Parameters<MediaCreate["createTenantMedia"]>[0]) => mc.createTenantMedia(args, { create: scopedCreate as never })) as MediaCreate["createTenantMedia"],
    findMediaByName: async (_p: Payload, tenantId: number | string, filename: string) =>
      rows.find((r) => String(r.tenant) === String(tenantId) && r.filename === filename) ?? null,
    updateMedia: async (_p: Payload, tenantId: number | string, id: number | string, data: Doc) => {
      updates.push({ tenantId, id, data });
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };
  return { rows, created, updates, deps };
}

const jpeg = (w = 64, h = 48, color = "#c83232") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
const png = (w = 32, h = 32) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
async function animatedGif(frames = 5): Promise<Buffer> {
  const f = await Promise.all(Array.from({ length: frames }, (_, i) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: i * 40, g: 10, b: 10 } } }).png().toBuffer()));
  return sharp(f, { join: { animated: true } }).gif().toBuffer();
}

function req(route: "sign" | "register", body: unknown, o: { token?: string | null; tenant?: string | null; raw?: string; noLength?: boolean } = {}) {
  const text = o.raw ?? JSON.stringify(body);
  const qs = o.tenant === null ? "" : `?tenant=${o.tenant ?? "gcv"}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = o.token === undefined ? TOKENS.author : o.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (!o.noLength) headers["content-length"] = String(Buffer.byteLength(text));
  return new Request(`http://127.0.0.1:1/api/hub/media/${route}${qs}`, { method: "POST", headers, body: text });
}

interface Ctx {
  w: ReturnType<typeof world>;
  st: ReturnType<typeof fakeStaging>;
  media: ReturnType<typeof mediaTable>;
  env: Record<string, string | undefined>;
  staging?: import("./r2").StagingStore | null;
  nowMs?: number;
  create?: MediaCreate["createTenantMedia"];
}

function ctx(o: Partial<Ctx> = {}): Ctx {
  return { w: o.w ?? world(), st: o.st ?? fakeStaging(), media: o.media ?? mediaTable(), env: o.env ?? ENV, ...o };
}

function deps(c: Ctx): import("./hub-direct-upload-core").HubDirectDeps {
  return {
    getPayload: async () => c.w.payload,
    staging: c.staging !== undefined ? c.staging : c.st.store,
    env: c.env,
    now: () => c.nowMs ?? NOW_MS,
    uuid: () => "0b8f6a1e-1111-4222-8333-444455556666",
    ...c.media.deps,
    ...(c.create ? { create: c.create } : {}),
  };
}

async function call(route: "sign" | "register", c: Ctx, r: Request) {
  const res = route === "sign" ? await core.handleHubMediaSignWith(r, deps(c)) : await core.handleHubMediaRegisterWith(r, deps(c));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Doc };
}

const signBody = (o: Doc = {}) => ({ articleId: "42", mime: "image/jpeg", size: 1, actorRole: "editor", ...o });

/** sign → (browser) PUT → returns the uploadId and key. */
async function signAndPut(c: Ctx, bytes: Buffer, o: { mime?: string; putType?: string; articleId?: string; tenant?: string; token?: string } = {}) {
  const mime = o.mime ?? "image/jpeg";
  const s = await call("sign", c, req("sign", signBody({ articleId: o.articleId ?? "42", mime, size: bytes.length }), { tenant: o.tenant, token: o.token }));
  assert.equal(s.status, 200, s.text);
  const key = (c.st.calls.presign.at(-1) as unknown[])[0] as string;
  c.st.put(key, bytes, o.putType ?? mime);
  return { uploadId: s.body.uploadId as string, key, sign: s };
}

const regBody = (uploadId: string, o: Doc = {}) => ({ uploadId, alt: ALT, actorRole: "editor", ...o });

// ── Gate (both routes) ───────────────────────────────────────────────────────

describe("gate: auth, tenant, grant, feature, switch (AC1)", () => {
  for (const route of ["sign", "register"] as const) {
    const body = route === "sign" ? signBody() : regBody("v1.x.y");
    it(`${route}: no / unknown token ⇒ 401; read-only key ⇒ 403 hub author`, async () => {
      assert.equal((await call(route, ctx(), req(route, body, { token: null }))).status, 401);
      assert.equal((await call(route, ctx(), req(route, body, { token: "nope" }))).status, 401);
      const r = await call(route, ctx(), req(route, body, { token: TOKENS.read }));
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, "hub author not allowed for this engine");
    });
    it(`${route}: tenant missing ⇒ 400; outside grant ⇒ 403 forbidden (+ engine_tenant_denied); articles off ⇒ 403`, async () => {
      assert.deepEqual((await call(route, ctx(), req(route, body, { tenant: null }))).body, { ok: false, status: "bad_request", reason: "invalid direct upload request" });
      const c = ctx();
      const r = await call(route, c, req(route, body, { tenant: "wad" }));
      assert.equal(r.status, 403);
      assert.equal(r.body.status, "forbidden");
      assert.equal(c.w.log.activity.at(-1)?.eventType, "engine_tenant_denied");
      const f = await call(route, ctx({ w: world({ articlesFeature: false }) }), req(route, body));
      assert.deepEqual([f.status, f.body.reason], [403, "articles feature disabled for tenant"]);
    });
    it(`${route}: switch OFF (unset / other tenant) ⇒ 403 feature_disabled, staging never touched`, async () => {
      for (const env of [{ PAYLOAD_SECRET: SECRET }, { PAYLOAD_SECRET: SECRET, HUB_DIRECT_UPLOAD_TENANTS: "wad,GCV" }]) {
        const c = ctx({ env });
        const r = await call(route, c, req(route, body));
        assert.deepEqual([r.status, r.text], [403, JSON.stringify({ ok: false, status: "feature_disabled", reason: "direct upload disabled for tenant" })]);
        assert.deepEqual([c.st.calls.presign.length, c.st.calls.head, c.st.calls.get, c.st.calls.deleted.length], [0, 0, 0, 0]);
      }
    });
    it(`${route}: Content-Length missing ⇒ 411; > 4096 ⇒ 413; bad JSON ⇒ 400; unknown key ⇒ 400`, async () => {
      assert.equal((await call(route, ctx(), req(route, body, { noLength: true }))).status, 411);
      const big = JSON.stringify({ ...body, pad: "x".repeat(5000) });
      const r413 = await call(route, ctx(), req(route, null, { raw: big }));
      assert.deepEqual([r413.status, r413.body.reason], [413, "request body exceeds 4096 bytes"]);
      assert.equal((await call(route, ctx(), req(route, null, { raw: "{" }))).body.reason, "body must be valid JSON");
      assert.equal((await call(route, ctx(), req(route, { ...body, tenant: "gcv" }))).status, 400);
    });
  }
});

// ── sign ─────────────────────────────────────────────────────────────────────

describe("sign", () => {
  it("200: server-built key, uploadId verifies, presign(key, mime, size, 300), nothing written", async () => {
    const c = ctx();
    const r = await call("sign", c, req("sign", signBody({ mime: "image/png", size: 1234 })));
    assert.equal(r.status, 200);
    assert.deepEqual(c.st.calls.presign, [["gcv/42/0b8f6a1e-1111-4222-8333-444455556666", "image/png", 1234, 300]]);
    const v = pure.verifyUploadId(r.body.uploadId, SECRET, NOW_MS / 1000);
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual([v.claims.t, v.claims.a, v.claims.k, v.claims.m, v.claims.s, v.claims.e], [1, 42, "gcv/42/0b8f6a1e-1111-4222-8333-444455556666", "image/png", 1234, NOW_MS / 1000 + 900]);
    assert.deepEqual((r.body.put as Doc).headers, { "Content-Type": "image/png" });
    assert.equal(c.w.log.activity.length, 0, "sign writes no ActivityLog row (PA-1)");
  });
  it("prefix mode: key under `_hub-staging/`", async () => {
    const c = ctx({ st: fakeStaging("_hub-staging/") });
    await call("sign", c, req("sign", signBody()));
    assert.equal((c.st.calls.presign[0] as unknown[])[0], "_hub-staging/gcv/42/0b8f6a1e-1111-4222-8333-444455556666");
  });
  it("mime outside JPEG/PNG/WebP/GIF ⇒ 415; size > 20 MiB ⇒ 413; exactly 20 MiB passes", async () => {
    assert.equal((await call("sign", ctx(), req("sign", signBody({ mime: "image/svg+xml" })))).status, 415);
    assert.equal((await call("sign", ctx(), req("sign", signBody({ mime: "image/heic" })))).status, 415);
    const big = await call("sign", ctx(), req("sign", signBody({ size: 20 * 1024 * 1024 + 1 })));
    assert.deepEqual([big.status, big.body.reason], [413, "image exceeds 20971520 bytes"]);
    assert.equal((await call("sign", ctx(), req("sign", signBody({ size: 20 * 1024 * 1024 })))).status, 200);
    assert.equal((await call("sign", ctx(), req("sign", signBody({ mime: "image/gif" })))).status, 200);
  });
  it("article: unknown / other tenant ⇒ 404; not a hub-authored manual draft ⇒ 422 not_editable", async () => {
    assert.equal((await call("sign", ctx(), req("sign", signBody({ articleId: "999" })))).status, 404);
    assert.equal((await call("sign", ctx(), req("sign", signBody({ articleId: "50" })))).status, 404);
    assert.equal((await call("sign", ctx(), req("sign", signBody({ articleId: "abc" })))).status, 404);
    const r = await call("sign", ctx(), req("sign", signBody({ articleId: "44" })));
    assert.deepEqual([r.status, r.body.status], [422, "not_editable"]);
  });
  it("staging not configured ⇒ 503 staging_unavailable", async () => {
    const r = await call("sign", ctx({ staging: null }), req("sign", signBody()));
    assert.deepEqual([r.status, r.body.status], [503, "staging_unavailable"]);
  });
});

// ── register ─────────────────────────────────────────────────────────────────

describe("register: happy path, caption, dedup (AC2 / AC5)", () => {
  it("201: deterministic name, caption + credit + prefix written, staging deleted, ActivityLog via hub-direct", async () => {
    const c = ctx();
    const bytes = await jpeg();
    const { uploadId, key } = await signAndPut(c, bytes);
    const r = await call("register", c, req("register", regBody(uploadId, { caption: " A caption ", credit: "Photo Credit: X" })));
    assert.equal(r.status, 201, r.text);
    const row = c.media.created[0]!;
    assert.equal(row.filename, pure.deterministicMediaName(42, bytes, "image/jpeg"));
    assert.match(String(row.filename), /^hub-[0-9a-f]{32}\.jpg$/);
    assert.deepEqual([row.alt, row.caption, row.credit, row.prefix, row.tenant], [ALT, "A caption", "Photo Credit: X", "gcv", 1]);
    assert.deepEqual(c.st.calls.deleted, [key]);
    assert.equal(r.body.deduped, false);
    assert.deepEqual([(r.body.media as Doc).caption, (r.body.media as Doc).credit, (r.body.media as Doc).id], ["A caption", "Photo Credit: X", row.id]);
    const act = c.w.log.activity.at(-1)!;
    assert.equal(act.eventType, "media_uploaded");
    assert.deepEqual(act.detail, { via: "hub-direct", actor: { role: "editor" }, articleId: 42, deduped: false });
    assert.ok(!JSON.stringify(c.w.log.activity).includes(ALT), "no alt text in ActivityLog");
  });
  it("same (article, bytes) again ⇒ 200 deduped, SAME id, alt/caption/credit updated, no second create", async () => {
    const c = ctx();
    const bytes = await jpeg();
    const first = await signAndPut(c, bytes);
    const r1 = await call("register", c, req("register", regBody(first.uploadId, { caption: "old" })));
    assert.equal(r1.status, 201);
    const second = await signAndPut(c, bytes);
    const r2 = await call("register", c, req("register", regBody(second.uploadId, { alt: "New alt", credit: "New credit" })));
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.body.deduped, true);
    assert.equal((r2.body.media as Doc).id, (r1.body.media as Doc).id);
    assert.equal(c.media.created.length, 1);
    assert.deepEqual(c.media.updates.at(-1)?.data, { alt: "New alt", caption: null, credit: "New credit" });
    assert.deepEqual([(r2.body.media as Doc).alt, (r2.body.media as Doc).caption, (r2.body.media as Doc).credit], ["New alt", null, "New credit"]);
    assert.deepEqual(c.st.calls.deleted, [first.key, second.key]);
    assert.equal((c.w.log.activity.at(-1)?.detail as Doc).deduped, true);
  });
  it("same bytes, OTHER article ⇒ other name, a second media row", async () => {
    const c = ctx();
    const bytes = await jpeg();
    await call("register", c, req("register", regBody((await signAndPut(c, bytes)).uploadId)));
    const r = await call("register", c, req("register", regBody((await signAndPut(c, bytes, { articleId: "43" })).uploadId)));
    assert.equal(r.status, 201);
    assert.equal(c.media.created.length, 2);
    assert.notEqual(c.media.created[0]!.filename, c.media.created[1]!.filename);
  });
  it("replaying a used uploadId after success ⇒ 409 object_missing (staging already deleted; the hub signs again)", async () => {
    const c = ctx();
    const { uploadId } = await signAndPut(c, await jpeg());
    assert.equal((await call("register", c, req("register", regBody(uploadId)))).status, 201);
    const again = await call("register", c, req("register", regBody(uploadId)));
    assert.deepEqual([again.status, again.body.status], [409, "object_missing"]);
    assert.equal(c.media.created.length, 1);
  });
  it("GIF with 5 frames ⇒ stored as ONE-frame PNG named .png (AC7)", async () => {
    const c = ctx();
    const gif = await animatedGif(5);
    assert.equal((await sharp(gif).metadata()).pages, 5);
    const { uploadId } = await signAndPut(c, gif, { mime: "image/gif" });
    const r = await call("register", c, req("register", regBody(uploadId)));
    assert.equal(r.status, 201, r.text);
    const row = c.media.created[0]!;
    assert.match(String(row.filename), /^hub-[0-9a-f]{32}\.png$/);
    assert.equal(row.mimeType, "image/png");
    const m = await sharp(row._bytes as Buffer).metadata();
    assert.deepEqual([m.format, m.pages ?? 1, m.width, m.height], ["png", 1, 40, 30]);
  });
});

describe("register: token checks (AC3)", () => {
  it("garbage / forged uploadId ⇒ 422 upload_invalid; expired ⇒ 410", async () => {
    const c = ctx();
    assert.deepEqual((await call("register", c, req("register", regBody("v1.abc.def")))).body.status, "upload_invalid");
    const { uploadId } = await signAndPut(c, await jpeg());
    const late = ctx({ w: c.w, st: c.st, media: c.media, nowMs: NOW_MS + 901_000 });
    const r = await call("register", late, req("register", regBody(uploadId)));
    assert.deepEqual([r.status, r.body.status], [410, "upload_expired"]);
  });
  it("token of ANOTHER tenant (same engine grant) used with ?tenant=gcv ⇒ 422 upload_invalid, no HEAD", async () => {
    const c = ctx();
    const { uploadId } = await signAndPut(c, await jpeg(), { tenant: "wad", articleId: "50", token: TOKENS.both });
    const headsBefore = c.st.calls.head;
    const r = await call("register", c, req("register", regBody(uploadId), { tenant: "gcv", token: TOKENS.both }));
    assert.deepEqual([r.status, r.body.status], [422, "upload_invalid"]);
    assert.equal(c.st.calls.head, headsBefore);
  });
  it("validly signed token whose key is outside <prefix><tenant>/<article>/ ⇒ 422 upload_invalid", async () => {
    const c = ctx();
    const id = pure.signUploadId({ t: 1, a: 42, k: "gcv/43/x", m: "image/jpeg", s: 10, e: NOW_MS / 1000 + 900, n: "AAAA" }, SECRET);
    assert.equal((await call("register", c, req("register", regBody(id)))).body.status, "upload_invalid");
  });
  it("a token signed with another secret ⇒ 422", async () => {
    const c = ctx();
    const id = pure.signUploadId({ t: 1, a: 42, k: "gcv/42/x", m: "image/jpeg", s: 10, e: NOW_MS / 1000 + 900, n: "AAAA" }, "other");
    assert.equal((await call("register", c, req("register", regBody(id)))).body.status, "upload_invalid");
  });
  it("article no longer editable at register ⇒ 422 not_editable", async () => {
    const c = ctx();
    const id = pure.signUploadId({ t: 1, a: 44, k: "gcv/44/x", m: "image/jpeg", s: 10, e: NOW_MS / 1000 + 900, n: "AAAA" }, SECRET);
    assert.deepEqual((await call("register", c, req("register", regBody(id)))).body.status, "not_editable");
  });
});

describe("register: re-check after upload (AC4)", () => {
  it("object never PUT ⇒ 409 object_missing", async () => {
    const c = ctx();
    const s = await call("sign", c, req("sign", signBody({ size: 100 })));
    const r = await call("register", c, req("register", regBody(s.body.uploadId as string)));
    assert.deepEqual([r.status, r.body.status], [409, "object_missing"]);
  });
  it("HEAD size ≠ signed size ⇒ 422 upload_invalid AND the object is deleted", async () => {
    const c = ctx();
    const bytes = await jpeg();
    const s = await call("sign", c, req("sign", signBody({ size: bytes.length - 1 })));
    const key = (c.st.calls.presign[0] as unknown[])[0] as string;
    c.st.put(key, bytes, "image/jpeg");
    const r = await call("register", c, req("register", regBody(s.body.uploadId as string)));
    assert.deepEqual([r.status, r.body.status], [422, "upload_invalid"]);
    assert.deepEqual(c.st.calls.deleted, [key]);
    assert.equal(c.media.created.length, 0);
  });
  it("HEAD Content-Type ≠ signed mime ⇒ 422 upload_invalid, deleted", async () => {
    const c = ctx();
    const { uploadId, key } = await signAndPut(c, await jpeg(), { putType: "image/png" });
    assert.equal((await call("register", c, req("register", regBody(uploadId)))).body.status, "upload_invalid");
    assert.deepEqual(c.st.calls.deleted, [key]);
  });
  it("mime lie: signed + PUT as image/png, bytes are JPEG ⇒ 415 media_type, deleted, nothing created", async () => {
    const c = ctx();
    const { uploadId, key } = await signAndPut(c, await jpeg(), { mime: "image/png" });
    const r = await call("register", c, req("register", regBody(uploadId)));
    assert.deepEqual([r.status, r.body.status], [415, "media_type"]);
    assert.deepEqual(c.st.calls.deleted, [key]);
    assert.equal(c.media.created.length, 0);
  });
  it("object grows between HEAD and GET ⇒ read stops at the cap ⇒ 413 too_large, deleted", async () => {
    const c = ctx();
    const { uploadId, key } = await signAndPut(c, await jpeg());
    c.st.calls.grow = true;
    const r = await call("register", c, req("register", regBody(uploadId)));
    assert.deepEqual([r.status, r.body.status], [413, "too_large"]);
    assert.deepEqual(c.st.calls.deleted, [key]);
  });
  it("pixel bomb from the header (PNG 13000x100, edge > 12000; and > maxPixels) ⇒ 422 media_dimensions, deleted, never decoded", async () => {
    const ihdr = (w: number, h: number) => {
      const b = Buffer.alloc(45);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12, "latin1");
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      b[24] = 8;
      b[25] = 6;
      return b;
    };
    const side = Math.ceil(Math.sqrt(pure.HUB_DIRECT_UPLOAD_LIMITS.maxPixels + 1)) + 1;
    for (const bomb of [ihdr(13_000, 100), ihdr(side, side)]) {
      const c = ctx();
      const { uploadId, key } = await signAndPut(c, bomb, { mime: "image/png" });
      const r = await call("register", c, req("register", regBody(uploadId)));
      assert.deepEqual([r.status, r.body.status], [422, "media_dimensions"]);
      assert.deepEqual(c.st.calls.deleted, [key]);
    }
  });
  it("text-field errors keep the object (alt blank ⇒ 422 alt_required; caption with LF ⇒ 400), then a fixed retry succeeds", async () => {
    const c = ctx();
    const { uploadId } = await signAndPut(c, await png(), { mime: "image/png" });
    assert.deepEqual((await call("register", c, req("register", regBody(uploadId, { alt: "  " })))).body.status, "alt_required");
    assert.deepEqual((await call("register", c, req("register", regBody(uploadId, { caption: "a\nb" })))).status, 400);
    assert.deepEqual((await call("register", c, req("register", regBody(uploadId, { credit: "x".repeat(301) })))).status, 400);
    assert.deepEqual(c.st.calls.deleted, []);
    assert.equal((await call("register", c, req("register", regBody(uploadId)))).status, 201);
  });
  it("staging gone at register ⇒ 503", async () => {
    const c = ctx();
    const { uploadId } = await signAndPut(c, await jpeg());
    assert.equal((await call("register", ctx({ w: c.w, st: c.st, media: c.media, staging: null }), req("register", regBody(uploadId)))).status, 503);
  });
});

describe("register: create failures", () => {
  it("MediaCreateError too_large (ladder exhausted) ⇒ 413, staging deleted", async () => {
    const c = ctx({
      create: async () => {
        throw new mc.MediaCreateError("too_large");
      },
    });
    const { uploadId, key } = await signAndPut(c, await jpeg());
    const r = await call("register", c, req("register", regBody(uploadId)));
    assert.deepEqual([r.status, r.body.status], [413, "too_large"]);
    assert.deepEqual(c.st.calls.deleted, [key]);
  });
  it("an unexpected error ⇒ 500 internal_error, staging deleted best-effort, logs carry NO token / url / alt / key", async () => {
    const c = ctx({
      create: async () => {
        const e = new Error(`db exploded with ${ALT}`) as Error & { code?: string };
        e.name = "DatabaseError";
        e.code = "08006";
        throw e;
      },
    });
    const { uploadId, key } = await signAndPut(c, await jpeg());
    const r = await call("register", c, req("register", regBody(uploadId)));
    assert.deepEqual([r.status, r.text], [500, JSON.stringify({ ok: false, status: "internal_error" })]);
    assert.deepEqual(c.st.calls.deleted, [key]);
    const logs = c.w.log.lines.join("\n") + JSON.stringify(c.w.log.activity);
    for (const secret of [uploadId, key, ALT, "X-Amz-Signature", TOKENS.author, SECRET]) assert.ok(!logs.includes(secret), `leaked ${secret.slice(0, 12)}`);
    assert.match(c.w.log.lines.join("\n"), /name=DatabaseError code=08006/);
    assert.deepEqual(c.w.log.activity.at(-1)?.detail, { scope: "hub/media/direct", name: "DatabaseError", code: "08006" });
  });
  it("a staging delete failure never changes a 201", async () => {
    const st = fakeStaging();
    st.store.delete = async () => {
      throw Object.assign(new Error("r2 down"), { name: "S3ServiceException" });
    };
    const c = ctx({ st });
    const { uploadId } = await signAndPut(c, await jpeg());
    assert.equal((await call("register", c, req("register", regBody(uploadId)))).status, 201);
    assert.match(c.w.log.lines.join("\n"), /staging delete failed: name=S3ServiceException/);
  });
});

describe("readStreamCapped (r2.ts)", () => {
  it("stops reading once more than maxBytes arrived and destroys the stream", async () => {
    let pulled = 0;
    let destroyed = false;
    const body = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          pulled += 1000;
          yield new Uint8Array(1000);
          if (pulled > 1_000_000) return;
        }
      },
      destroy: () => {
        destroyed = true;
      },
    };
    const r = await r2.readStreamCapped(body, 4500);
    assert.deepEqual([r.ok, destroyed], [false, true]);
    assert.ok(pulled <= 5000, `pulled ${pulled}`);
    async function* exact() {
      yield new Uint8Array(3000);
      yield new Uint8Array(1500);
    }
    const ok = await r2.readStreamCapped(exact(), 4500);
    assert.equal(ok.ok && ok.bytes.length, 4500);
  });
});

describe("source guards", () => {
  it("the route files are thin, nodejs, force-dynamic; register maxDuration ≤ 60, sign 15", async () => {
    const { readFileSync } = await import("node:fs");
    const sign = readFileSync("src/app/api/hub/media/sign/route.ts", "utf8");
    const reg = readFileSync("src/app/api/hub/media/register/route.ts", "utf8");
    for (const s of [sign, reg]) {
      assert.match(s, /export const runtime = "nodejs";/);
      assert.match(s, /export const dynamic = "force-dynamic";/);
      assert.ok(!/console\.log\(/.test(s));
    }
    assert.match(sign, /export const maxDuration = 15;/);
    assert.match(reg, /export const maxDuration = 60;/);
  });
  it("the core never logs through console and never interpolates a url / uploadId / key into a log line", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/hub-direct-upload-core.ts", "utf8");
    assert.ok(!/console\./.test(src));
    for (const line of src.split("\n").filter((l) => /logger\.(info|warn|error)/.test(l))) {
      assert.ok(!/url|uploadId|\bkey\b|c\.k|alt|caption|credit/i.test(line.replace(/\[\$\{SCOPE\}\]/, "")), line.trim());
    }
  });
});
