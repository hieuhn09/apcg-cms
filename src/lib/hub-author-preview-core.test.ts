/**
 * Unit tests for ./hub-author-preview-core (APCGHub P5.6, chặng 1 — P11–P23). FAKE
 * Payload only; the REAL `authenticateHubAuthorEngine` runs against it (no injected
 * authenticator). `hub-author-preview-core.ts` imports `@payload-config`, which refuses
 * to load without a DATABASE_URL, so a NON-ROUTABLE placeholder is set when absent
 * (port 1 on 127.0.0.1; `getPayload` is never called here). The signing secret is a
 * random throwaway value.
 *
 *   npm run test:hub-p56
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://p56-unit@127.0.0.1:1/p56_unit_no_db";
process.env.PAYLOAD_SECRET ??= "p56-unit-placeholder";
const SECRET = randomBytes(24).toString("hex");
process.env.CENTRAL_SIGNING_SECRET = SECRET;

type Doc = Record<string, unknown>;
type Core = typeof import("./hub-author-preview-core");
type Pure = typeof import("./hub-author-preview-pure");
type Crypto = typeof import("./crypto");
let core: Core;
let pure: Pure;
let crypto: Crypto;
before(async () => {
  core = await import("./hub-author-preview-core");
  pure = await import("./hub-author-preview-pure");
  crypto = await import("./crypto");
});

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
const TITLE = "Very Secret Draft Title";
const TOKENS = { author: "p56-author-key", read: "p56-read-key", write: "p56-write-key" } as const;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface WorldOpts {
  frontendUrl?: string | null;
  articlesFeature?: boolean;
  dbError?: boolean;
}

function world(o: WorldOpts = {}) {
  const tenants: Record<string, Doc> = {
    "1": {
      id: 1, slug: "gcv", name: "GCV", status: "active", defaultLanguage: "fr", supportedLanguages: ["en", "fr"],
      frontendUrl: o.frontendUrl === undefined ? "https://gcv.example.invalid/" : o.frontendUrl,
      features: { articles: o.articlesFeature ?? true },
    },
    "2": { id: 2, slug: "wad", name: "WAD", status: "active", defaultLanguage: "en", frontendUrl: "https://wad.example.invalid", features: { articles: true } },
  };
  const engines: Doc[] = [
    { id: 71, status: "active", tokenHash: sha(TOKENS.author), hubRead: true, hubAuthor: true, allowedTenants: [1] },
    { id: 72, status: "active", tokenHash: sha(TOKENS.read), hubRead: true, allowedTenants: [1] },
    { id: 73, status: "active", tokenHash: sha(TOKENS.write), hubRead: true, hubWrite: true, allowedTenants: [1] },
  ];
  // latest (draft) versions; `mainSlug` = the main row's slug, never read by the route
  const latest: Record<string, Doc> = {
    "5": { id: 5, tenant: 1, slug: "draft-slug", mainSlug: "main-slug", title: TITLE, origin: "manual", workflowStatus: "draft", lastEngine: 71 },
    "6": { id: 6, tenant: 2, slug: "other-tenant", title: TITLE },
    "7": { id: 7, tenant: 1, slug: null, title: TITLE, origin: "manual", workflowStatus: "draft", lastEngine: 71 },
    "11": { id: 11, tenant: 1, slug: "  ", title: TITLE, origin: "manual", workflowStatus: "draft", lastEngine: 71 },
    "8": { id: 8, tenant: 1, slug: "published-one", title: TITLE, origin: "manual", workflowStatus: "published", _status: "published", lastEngine: 71 },
    "9": { id: 9, tenant: 1, slug: "engine-one", title: TITLE, origin: "engine", workflowStatus: "pending_review", lastEngine: 99 },
    "10": { id: 10, tenant: 1, slug: "admin-one", title: TITLE, origin: "manual", workflowStatus: "draft", lastEngine: null },
  };
  const log = { lines: [] as string[], creates: [] as Doc[], articleReads: [] as Doc[], updates: [] as Doc[], engineLookups: 0 };
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
      if (a.collection === "content-engines") {
        log.engineLookups++;
        return engines.find((e) => String(e.id) === String(a.id)) ?? null;
      }
      if (a.collection === "articles") {
        log.articleReads.push(a);
        if (o.dbError) {
          const e = new Error(`connection to db failed for ${TITLE}`) as Error & { code?: string };
          e.name = "DatabaseError";
          e.code = "08006";
          throw e;
        }
        const d = latest[String(a.id)];
        return d ? { ...d } : null;
      }
      return null;
    },
    async create(a: Doc) {
      log.creates.push(a);
      return {};
    },
    async update(a: Doc) {
      log.updates.push(a);
      return {};
    },
  } as unknown as Payload;
  return { payload, log };
}

const req = (body: unknown, token: string | null = TOKENS.author, raw?: string) =>
  new Request("http://127.0.0.1:1/api/hub/articles/x/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const GOOD = { tenant: "gcv", actor: ACTOR };

async function call(w: ReturnType<typeof world>, id: string, r: Request, extra: Partial<import("./hub-author-preview-core").HubPreviewDeps> = {}) {
  const res = await core.handleHubPreviewMintWith(r, ctx(id), { getPayload: async () => w.payload, ...extra });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Doc, headers: res.headers };
}

test("P11 key check through the REAL authenticateHubAuthorEngine", async (t) => {
  await t.test("no / unknown token ⇒ 401", async () => {
    assert.equal((await call(world(), "5", req(GOOD, null))).status, 401);
    assert.equal((await call(world(), "5", req(GOOD, "nope"))).status, 401);
  });
  await t.test("hubRead without hubAuthor ⇒ 403 hub author", async () => {
    const r = await call(world(), "5", req(GOOD, TOKENS.read));
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "hub author not allowed for this engine");
  });
  await t.test("a hubWrite-only key ⇒ 403", async () => {
    const r = await call(world(), "5", req(GOOD, TOKENS.write));
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "hub author not allowed for this engine");
  });
  await t.test("the author key passes", async () => {
    assert.equal((await call(world(), "5", req(GOOD))).status, 200);
  });
});

test("P12 readSmallBody (D11)", async (t) => {
  const pad = (n: number) => {
    const base = JSON.stringify({ tenant: "gcv", actor: ACTOR, p: "" });
    return JSON.stringify({ tenant: "gcv", actor: ACTOR, p: "x".repeat(n - base.length) });
  };
  await t.test("exactly 4,096 bytes passes the cap; 4,097 ⇒ 413 naming 4096 before any JSON parse", async () => {
    const ok = await pure.readSmallBody(new Request("http://x/", { method: "POST", body: pad(4096) }));
    assert.equal(ok.ok, true);
    const big = await pure.readSmallBody(new Request("http://x/", { method: "POST", body: "{" + " ".repeat(4096) }));
    assert.equal(big.ok, false);
    const res = !big.ok ? big.response : null;
    assert.equal(res?.status, 413);
    assert.match(String(((await res?.json()) as Doc).reason), /4096/);
  });
  await t.test("a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ tenant: "gcv", n: "Nguyễn ✓" }));
    const cut = bytes.indexOf(0xe1) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const r = await pure.readSmallBody({ headers: new Headers(), body: stream } as unknown as Request);
    assert.deepEqual(r.ok && r.raw, { tenant: "gcv", n: "Nguyễn ✓" });
  });
  await t.test("a stream larger than the cap stops reading (absent or lying Content-Length)", async () => {
    for (const headers of [new Headers(), new Headers({ "content-length": "10" })]) {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          const chunk = new Uint8Array(1000).fill(32);
          pulled += chunk.byteLength;
          c.enqueue(chunk);
          if (pulled > 1_000_000) c.close();
        },
      });
      const r = await pure.readSmallBody({ headers, body: stream } as unknown as Request);
      assert.equal(!r.ok && r.response.status, 413);
      assert.ok(pulled <= 4097 + 1000 + 1000, `pulled ${pulled}`);
    }
  });
  await t.test("Content-Length > 4,096 ⇒ 413 without reading", async () => {
    let touched = false;
    const stream = new ReadableStream<Uint8Array>({ pull() { touched = true; } }, { highWaterMark: 0 });
    const r = await pure.readSmallBody({ headers: new Headers({ "content-length": "5000" }), body: stream } as unknown as Request);
    assert.equal(!r.ok && r.response.status, 413);
    assert.equal(touched, false);
  });
  await t.test("broken JSON ⇒ 400 (through the route)", async () => {
    const r = await call(world(), "5", req(null, TOKENS.author, "{nope"));
    assert.equal(r.status, 400);
    assert.equal(r.body.status, "bad_request");
  });
});

test("P13 tenant outside the grant ⇒ 403 + engine_tenant_denied (requested cut to 64)", async () => {
  const w = world();
  const r = await call(w, "6", req({ tenant: "wad" + "x".repeat(100), actor: ACTOR }));
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "tenant not in allowed scope");
  const denied = w.log.creates.filter((c) => (c.data as Doc).eventType === "engine_tenant_denied");
  assert.equal(denied.length, 1);
  assert.equal(String(((denied[0]!.data as Doc).detail as Doc).requested).length, 64);
});

test("P14 articles feature off ⇒ 403", async () => {
  const r = await call(world({ articlesFeature: false }), "5", req(GOOD));
  assert.equal(r.status, 403);
  assert.equal(r.body.status, "feature_disabled");
});

test("P15 frontendUrl empty / foreign http ⇒ 409", async (t) => {
  await t.test("empty ⇒ no_frontend_url", async () => {
    const r = await call(world({ frontendUrl: null }), "5", req(GOOD));
    assert.deepEqual([r.status, r.body.status, r.body.reason], [409, "preview_unavailable", "no_frontend_url"]);
  });
  await t.test("http://evil.example ⇒ bad_frontend_url", async () => {
    const r = await call(world({ frontendUrl: "http://evil.example" }), "5", req(GOOD));
    assert.deepEqual([r.status, r.body.status, r.body.reason], [409, "preview_unavailable", "bad_frontend_url"]);
  });
});

test("P16 another tenant's article ⇒ 404 byte-identical to an unknown id", async () => {
  const other = await call(world(), "6", req(GOOD));
  const missing = await call(world(), "4242", req(GOOD));
  const shape = await call(world(), "2147483648", req(GOOD));
  assert.equal(other.status, 404);
  assert.equal(other.text, missing.text);
  assert.equal(other.text, shape.text);
  assert.deepEqual(Object.fromEntries(other.headers), Object.fromEntries(missing.headers));
});

test("P17 an article without a slug (null or blank) ⇒ 409 no_slug", async () => {
  for (const id of ["7", "11"]) {
    const r = await call(world(), id, req(GOOD));
    assert.deepEqual([r.status, r.body.reason], [409, "no_slug"], id);
  }
});

test("P18 happy path: one signature, grant tenant slug, latest-version slug", async () => {
  const w = world();
  const signed: Doc[] = [];
  const r = await call(w, "5", req(GOOD), {
    now: () => 1_000_000_000,
    sign: (c) => {
      signed.push({ ...c });
      return crypto.signPayload(c);
    },
  });
  assert.equal(r.status, 200);
  assert.equal(signed.length, 1);
  assert.deepEqual(signed[0], { tenant: "gcv", slug: "draft-slug", draft: true, exp: 1_000_000 + 600 });
  assert.equal(w.log.articleReads.length, 1);
  assert.equal(w.log.articleReads[0]!.draft, true);
  assert.deepEqual(Object.keys(r.body).sort(), ["expiresAt", "id", "ok", "tenant", "url"]);
  assert.deepEqual([r.body.ok, r.body.id, r.body.tenant], [true, 5, "gcv"]);
  const u = new URL(String(r.body.url));
  assert.equal(u.origin + u.pathname, "https://gcv.example.invalid/preview");
  assert.equal(u.searchParams.get("slug"), "draft-slug");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(crypto.verifySigned(String(u.searchParams.get("token")), 1_000_000));
});

test("P19 no branch logs the token, URL, secret or a title; a successful mint writes no row", async () => {
  const quiet = world();
  const okMint = await call(quiet, "5", req(GOOD));
  assert.equal(okMint.status, 200);
  assert.equal(quiet.log.creates.length, 0, "no ActivityLog / article row on success (D8)");
  assert.deepEqual(quiet.log.updates.map((u) => u.collection), ["content-engines"], "only the key's last-seen stamp");
  const worlds = [world(), world({ frontendUrl: null }), world({ dbError: true }), world({ articlesFeature: false })];
  const bodies: string[] = [];
  for (const [i, w] of worlds.entries()) {
    for (const [id, tok] of [["5", TOKENS.author], ["6", TOKENS.author], ["7", TOKENS.author], ["5", TOKENS.read], ["5", "bad-token-value"]] as const) {
      const r = await call(w, id, req(i === 3 ? { tenant: "wad", actor: ACTOR } : GOOD, tok));
      bodies.push(r.text);
    }
  }
  const okBody = JSON.parse(bodies[0]!) as Doc;
  const url = String(okBody.url);
  const token = String(new URL(url).searchParams.get("token"));
  for (const w of worlds) {
    const text = JSON.stringify(w.log.lines) + JSON.stringify(w.log.creates);
    for (const needle of [SECRET, token, url, "gcv.example.invalid", TITLE, "bad-token-value".slice(8)]) {
      assert.equal(text.includes(needle), false, `leaked ${needle.slice(0, 12)}`);
    }
  }
});

test("P20 a DB read error ⇒ fixed 500, log has name + code only", async () => {
  const w = world({ dbError: true });
  const r = await call(w, "5", req(GOOD));
  assert.equal(r.status, 500);
  assert.equal(r.text, JSON.stringify({ ok: false, status: "internal_error" }));
  assert.ok(w.log.lines.some((l) => l.includes("name=DatabaseError") && l.includes("code=08006")));
  assert.equal(w.log.lines.join("\n").includes("connection to db"), false);
});

test("P21 a missing signing secret ⇒ fixed 500, no leak", async () => {
  const prev = process.env.CENTRAL_SIGNING_SECRET;
  delete process.env.CENTRAL_SIGNING_SECRET;
  try {
    const w = world();
    const r = await call(w, "5", req(GOOD));
    assert.equal(r.status, 500);
    assert.equal(r.text, JSON.stringify({ ok: false, status: "internal_error" }));
    assert.equal(w.log.lines.join("\n").includes("CENTRAL_SIGNING_SECRET"), false);
  } finally {
    process.env.CENTRAL_SIGNING_SECRET = prev;
  }
});

test("P22 route + modules: text scans", async (t) => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  await t.test("route.ts exports only POST + maxDuration = 30 and passes no deps", () => {
    const src = read("src/app/api/hub/articles/[id]/preview/route.ts");
    const exported = [...src.matchAll(/^export\s+(?:const|function|async function)\s+(\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exported, ["POST", "maxDuration"]);
    assert.match(src, /export const maxDuration = 30;/);
    assert.match(src, /handleHubPreviewMint\(request, ctx\)/);
    assert.equal(/With\(|deps/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), false);
  });
  await t.test("no outbound HTTP in the two preview modules", () => {
    for (const f of ["src/lib/hub-author-preview-pure.ts", "src/lib/hub-author-preview-core.ts"]) {
      const src = read(f);
      for (const bad of ["fetch(", "http.request", "undici", "axios"]) assert.equal(src.includes(bad), false, `${f}: ${bad}`);
    }
  });
});

test("P23 D9: any article of the tenant, read as latest draft at the tenant default locale", async (t) => {
  for (const id of ["8", "9", "10"]) {
    await t.test(`article ${id} ⇒ 200`, async () => {
      const w = world();
      const r = await call(w, id, req(GOOD));
      assert.equal(r.status, 200);
      const a = w.log.articleReads[0]!;
      assert.deepEqual([a.draft, a.depth, a.overrideAccess, a.locale], [true, 0, true, "fr"]);
      assert.equal(w.log.engineLookups, 0, "no hub-authored check");
    });
  }
  const src = readFileSync(path.resolve(process.cwd(), "src/lib/hub-author-preview-core.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(src.includes("loadHubEditableArticle"), false);
});
