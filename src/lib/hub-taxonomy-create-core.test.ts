/**
 * Unit tests for ./hub-taxonomy-create-core (APCGHub P5.6, chặng 2 — T11–T24). FAKE
 * Payload only; the REAL `authenticateHubAuthorEngine` runs against it (no injected
 * authenticator, so swapping the route's authenticator turns T11 red). The core imports
 * `@payload-config`, which refuses to load without a DATABASE_URL, so a NON-ROUTABLE
 * placeholder is set when absent (port 1 on 127.0.0.1; `getPayload` is never called).
 *
 *   npm run test:hub-p56
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://p56-unit@127.0.0.1:1/p56_unit_no_db";
process.env.PAYLOAD_SECRET ??= "p56-unit-placeholder";

type Doc = Record<string, unknown>;
type Core = typeof import("./hub-taxonomy-create-core");
type Pure = typeof import("./hub-taxonomy-create-pure");
let core: Core;
let pure: Pure;
before(async () => {
  core = await import("./hub-taxonomy-create-core");
  pure = await import("./hub-taxonomy-create-pure");
});

const ACTOR = { email: "ed@example.invalid", role: "editor", id: "hub-user-56" } as const;
const NAME = "Canary Penname Zq";
const TITLE = "Canary Tagtitle Zq";
const TOKENS = { author: "p56-author-key", read: "p56-read-key", write: "p56-write-key", noread: "p56-noread-key" } as const;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface WorldOpts {
  authors?: Doc[];
  tags?: Doc[];
  count?: { authors?: number; tags?: number };
  createError?: () => unknown;
  /** Rows that "appear" in the store when the create throws (another request won the race). */
  raceRow?: Doc;
  findError?: boolean;
}

/** Equality value of a condition `{field: {equals}}` inside a scoped `where`. */
function eqOf(where: unknown, field: string): unknown {
  const top = (where as Doc | undefined)?.[field] as Doc | undefined;
  if (top && "equals" in top) return top.equals;
  const and = ((where as Doc | undefined)?.and ?? []) as Doc[];
  for (const c of and) {
    const inner = (c as Doc)[field] as Doc | undefined;
    if (inner && "equals" in inner) return inner.equals;
    const nested = eqOf(c, field);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function world(o: WorldOpts = {}) {
  const tenants: Record<string, Doc> = {
    "1": { id: 1, slug: "gcv", name: "GCV", status: "active", defaultLanguage: "en", features: { articles: true } },
    "2": { id: 2, slug: "wad", name: "WAD", status: "active", defaultLanguage: "en", features: { articles: true } },
  };
  const engines: Doc[] = [
    { id: 71, status: "active", tokenHash: sha(TOKENS.author), hubRead: true, hubAuthor: true, allowedTenants: [1] },
    { id: 72, status: "active", tokenHash: sha(TOKENS.read), hubRead: true, allowedTenants: [1] },
    { id: 73, status: "active", tokenHash: sha(TOKENS.write), hubRead: true, hubWrite: true, allowedTenants: [1] },
    { id: 74, status: "active", tokenHash: sha(TOKENS.noread), hubAuthor: true, allowedTenants: [1] },
  ];
  const store: Record<"authors" | "tags", Doc[]> = { authors: [...(o.authors ?? [])], tags: [...(o.tags ?? [])] };
  const log = {
    lines: [] as string[],
    finds: [] as Doc[],
    counts: [] as Doc[],
    creates: [] as Doc[],
    activity: [] as Doc[],
  };
  const logger = {
    info: (m: unknown) => log.lines.push(String(m)),
    warn: (m: unknown) => log.lines.push(String(m)),
    error: (m: unknown) => log.lines.push(String(m)),
  };
  let nextId = 500;
  const payload = {
    logger,
    async find(a: Doc) {
      if (a.collection === "content-engines") {
        const h = ((a.where as Doc).tokenHash as Doc).equals;
        return { docs: engines.filter((e) => e.tokenHash === h), totalDocs: 1 };
      }
      const col = a.collection as "authors" | "tags";
      if (col === "authors" || col === "tags") {
        if (o.findError) {
          const e = new Error(`db down while reading ${NAME}`) as Error & { code?: string };
          e.name = "DatabaseError";
          e.code = "08006";
          throw e;
        }
        const tenant = eqOf(a.where, "tenant");
        const key = col === "authors" ? "name" : "slug";
        const want = eqOf(a.where, key);
        if (want === undefined) {
          log.counts.push(a);
          const real = store[col].filter((d) => d.tenant === tenant).length;
          return { docs: [], totalDocs: o.count?.[col] ?? real };
        }
        log.finds.push(a);
        // An UNSCOPED lookup (no tenant condition) sees every tenant's rows — as the real DB would.
        const docs = store[col].filter((d) => (tenant === undefined || d.tenant === tenant) && d[key] === want);
        return { docs: docs.slice(0, 1).map((d) => ({ ...d })), totalDocs: docs.length };
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
      return null;
    },
    async create(a: Doc) {
      if (a.collection === "activityLog") {
        log.activity.push(a.data as Doc);
        return {};
      }
      log.creates.push(a);
      const col = a.collection as "authors" | "tags";
      if (o.createError) {
        if (o.raceRow) store[col].push({ ...o.raceRow });
        throw o.createError();
      }
      const doc = { id: nextId++, ...(a.data as Doc), user: 9, avatar: 8, bio: "private bio" };
      store[col].push(doc);
      return { ...doc };
    },
    async update() {
      return {};
    },
  } as unknown as Payload;
  return { payload, log, store };
}

const req = (url: string, body: unknown, token: string | null = TOKENS.author, raw?: string) =>
  new Request(`http://127.0.0.1:1${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
const AUTHOR_BODY = { tenant: "gcv", name: NAME, role: "Analyst", actor: ACTOR };
const TAG_BODY = { tenant: "gcv", title: TITLE, actor: ACTOR };

async function callAuthor(w: ReturnType<typeof world>, r: Request = req("/api/hub/authors", AUTHOR_BODY)) {
  const res = await core.handleHubAuthorCreateWith(r, { getPayload: async () => w.payload });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Doc };
}
async function callTag(w: ReturnType<typeof world>, r: Request = req("/api/hub/tags", TAG_BODY)) {
  const res = await core.handleHubTagCreateWith(r, { getPayload: async () => w.payload });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Doc };
}
const both = [
  { name: "authors", url: "/api/hub/authors", body: AUTHOR_BODY, call: (w: ReturnType<typeof world>, r: Request) => callAuthor(w, r) },
  { name: "tags", url: "/api/hub/tags", body: TAG_BODY, call: (w: ReturnType<typeof world>, r: Request) => callTag(w, r) },
];

test("T11 key check through the REAL authenticateHubAuthorEngine (both routes)", async (t) => {
  await t.test("no / unknown token ⇒ 401", async () => {
    for (const b of both) {
      assert.equal((await b.call(world(), req(b.url, b.body, null))).status, 401, b.name);
      assert.equal((await b.call(world(), req(b.url, b.body, "nope"))).status, 401, b.name);
    }
  });
  await t.test("hubAuthor without hubRead ⇒ 403", async () => {
    for (const b of both) {
      const r = await b.call(world(), req(b.url, b.body, TOKENS.noread));
      assert.equal(r.status, 403, b.name);
      assert.notEqual(r.body.reason, "hub author not allowed for this engine");
    }
  });
  await t.test("hubRead without hubAuthor ⇒ 403 hub author", async () => {
    for (const b of both) {
      const r = await b.call(world(), req(b.url, b.body, TOKENS.read));
      assert.equal(r.status, 403, b.name);
      assert.equal(r.body.reason, "hub author not allowed for this engine");
    }
  });
  await t.test("a hubWrite key ⇒ 403; the author key passes", async () => {
    for (const b of both) {
      const w = world();
      const r = await b.call(w, req(b.url, b.body, TOKENS.write));
      assert.equal(r.status, 403, b.name);
      assert.equal(w.log.creates.length, 0);
      assert.equal((await b.call(world(), req(b.url, b.body))).status, 201, b.name);
    }
  });
});

test("T12 body cap 4,096 bytes before parse (readSmallBody, both routes)", async (t) => {
  const padded = (body: Doc, n: number) => {
    const s = JSON.stringify(body);
    return s.slice(0, -1) + " ".repeat(n - s.length) + "}";
  };
  await t.test("4,097 bytes ⇒ 413 naming 4096, nothing read from the DB", async () => {
    for (const b of both) {
      const w = world();
      const r = await b.call(w, req(b.url, null, TOKENS.author, padded(b.body, 4097)));
      assert.equal(r.status, 413, b.name);
      assert.match(String(r.body.reason), /4096/);
      assert.equal(w.log.finds.length + w.log.creates.length, 0);
    }
  });
  await t.test("exactly 4,096 bytes passes", async () => {
    for (const b of both) {
      const raw = padded(b.body, 4096);
      assert.equal(Buffer.byteLength(raw), 4096);
      assert.equal((await b.call(world(), req(b.url, null, TOKENS.author, raw))).status, 201, b.name);
    }
  });
  await t.test("broken JSON ⇒ 400", async () => {
    for (const b of both) assert.equal((await b.call(world(), req(b.url, null, TOKENS.author, "{nope"))).status, 400, b.name);
  });
});

test("T13 tenant outside the grant ⇒ 403 + denial row; lookups use the GRANT tenant id", async () => {
  for (const b of both) {
    const w = world();
    const r = await b.call(w, req(b.url, { ...b.body, tenant: "wad" }));
    assert.equal(r.status, 403, b.name);
    assert.equal(r.body.reason, "tenant not in allowed scope");
    assert.ok(w.log.activity.some((a) => a.eventType === "engine_tenant_denied"));
    assert.equal(w.log.finds.length + w.log.creates.length, 0);
    const ok = world();
    await b.call(ok, req(b.url, b.body));
    for (const f of [...ok.log.finds, ...ok.log.counts]) assert.equal(eqOf(f.where, "tenant"), 1);
    for (const c of ok.log.creates) assert.equal((c.data as Doc).tenant, 1);
  }
});

test("T14 an existing pen name (normalised) ⇒ 200 created:false, no create", async () => {
  const w = world({ authors: [{ id: 7, tenant: 1, name: NAME, role: "Columnist" }] });
  const r = await callAuthor(w, req("/api/hub/authors", { ...AUTHOR_BODY, name: `  ${NAME.replace(/ /g, "  ")} ` }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, created: false, author: { id: 7, name: NAME, role: "Columnist" } });
  assert.equal(w.log.creates.length, 0);
});

test("T15 a new pen name ⇒ scopedCreate {name, role} ⇒ 201", async () => {
  const w = world();
  const r = await callAuthor(w);
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  assert.equal(w.log.creates.length, 1);
  assert.deepEqual(w.log.creates[0]!.data, { name: NAME, role: "Analyst", tenant: 1 });
});

test("T16 an existing tag ⇒ 200 created:false, title NOT overwritten", async () => {
  const w = world({ tags: [{ id: 9, tenant: 1, slug: "canary-tagtitle-zq", title: "Old Title" }] });
  const r = await callTag(w, req("/api/hub/tags", { ...TAG_BODY, title: "canary TAGTITLE zq" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, created: false, tag: { id: 9, slug: "canary-tagtitle-zq", title: "Old Title" } });
  assert.equal(w.log.creates.length, 0);
  assert.equal(w.store.tags[0]!.title, "Old Title");
});

test("T17 a new tag ⇒ scopedCreate {slug, title} ⇒ 201", async () => {
  const w = world();
  const r = await callTag(w);
  assert.equal(r.status, 201);
  assert.deepEqual(w.log.creates[0]!.data, { slug: "canary-tagtitle-zq", title: TITLE, tenant: 1 });
  assert.equal((r.body.tag as Doc).slug, "canary-tagtitle-zq");
});

test("T18 a tag create that loses a race re-reads ONCE", async (t) => {
  const row = { id: 33, tenant: 1, slug: "canary-tagtitle-zq", title: TITLE };
  await t.test("hook message ⇒ re-read ⇒ 200 created:false", async () => {
    const w = world({ createError: () => new Error('Value "x" already exists for this tenant'), raceRow: row });
    const r = await callTag(w);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, created: false, tag: { id: 33, slug: "canary-tagtitle-zq", title: TITLE } });
    assert.equal(w.log.finds.length, 2);
  });
  await t.test("Postgres 23505 on err.code AND on err.cause.code ⇒ 200", async () => {
    for (const mk of [() => Object.assign(new Error("dup"), { code: "23505" }), () => Object.assign(new Error("wrap"), { cause: { code: "23505" } })]) {
      const w = world({ createError: mk, raceRow: row });
      const r = await callTag(w);
      assert.equal(r.status, 200);
      assert.equal(r.body.created, false);
    }
  });
  await t.test("re-read finds nothing ⇒ 500 fixed body, exactly one retry", async () => {
    const w = world({ createError: () => Object.assign(new Error("dup"), { code: "23505" }) });
    const r = await callTag(w);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { ok: false, status: "internal_error" });
    assert.equal(w.log.finds.length, 2);
    assert.equal(w.log.creates.length, 1);
  });
});

test("T19 responses go through allowlists", async (t) => {
  await t.test("author {id, name, role} only", async () => {
    const r = await callAuthor(world());
    assert.deepEqual(Object.keys(r.body.author as Doc).sort(), ["id", "name", "role"]);
    assert.doesNotMatch(r.text, /private bio|"user"|"avatar"|"bio"|"tenant"/);
  });
  await t.test("tag {id, slug, title} only", async () => {
    const r = await callTag(world());
    assert.deepEqual(Object.keys(r.body.tag as Doc).sort(), ["id", "slug", "title"]);
    assert.doesNotMatch(r.text, /private bio|"user"|"avatar"|"bio"|"tenant"/);
  });
});

test("T20 ActivityLog: ONE human_edit row when created, none otherwise, no name / title / e-mail", async (t) => {
  await t.test("created ⇒ one row with tenant + engine + target, detail without PII", async () => {
    for (const b of both) {
      const w = world();
      const r = await b.call(w, req(b.url, b.body));
      const rows = w.log.activity.filter((a) => a.eventType === "human_edit");
      assert.equal(rows.length, 1, b.name);
      const a = rows[0]!;
      assert.equal(a.tenant, 1);
      assert.equal(a.actorType, "engine");
      assert.equal(a.actorEngine, 71);
      assert.equal(a.targetCollection, b.name);
      assert.equal(a.targetId, String(((r.body.author ?? r.body.tag) as Doc).id));
      assert.deepEqual(a.detail, {
        via: "hub",
        action: b.name === "authors" ? "author_create" : "tag_create",
        actor: { role: "editor", id: "hub-user-56" },
        created: true,
      });
      const s = JSON.stringify(a);
      assert.ok(!s.includes(NAME) && !s.includes(TITLE) && !s.includes(ACTOR.email));
    }
  });
  await t.test("created:false ⇒ no row", async () => {
    const w = world({ authors: [{ id: 7, tenant: 1, name: NAME, role: "Desk" }] });
    await callAuthor(w);
    assert.equal(w.log.activity.length, 0);
  });
  await t.test("server logs never carry the name / title (canary)", async () => {
    for (const b of both) {
      const w = world({ findError: true });
      await b.call(w, req(b.url, b.body));
      const all = w.log.lines.join("\n") + JSON.stringify(w.log.activity);
      assert.ok(!all.includes(NAME) && !all.includes(TITLE) && !all.includes("Canary"), all);
      assert.ok(w.log.lines.some((l) => /name=DatabaseError code=08006/.test(l)));
    }
  });
});

test("T21 tenant isolation: the same name in tenant B does not count for tenant A", async () => {
  const w = world({ authors: [{ id: 7, tenant: 2, name: NAME, role: "Desk" }] });
  const r = await callAuthor(w);
  assert.equal(r.status, 201);
  assert.ok(w.log.finds.length >= 1);
  for (const f of w.log.finds) assert.equal(eqOf(f.where, "tenant"), 1);
});

test("T22 a DB error ⇒ 500 fixed body", async () => {
  for (const b of both) {
    const r = await b.call(world({ findError: true }), req(b.url, b.body));
    assert.equal(r.status, 500, b.name);
    assert.deepEqual(r.body, { ok: false, status: "internal_error" });
  }
});

test("T23 route files and module text", async (t) => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  await t.test("the two routes export only POST + maxDuration = 30 and never pass deps", () => {
    for (const p of ["src/app/api/hub/authors/route.ts", "src/app/api/hub/tags/route.ts"]) {
      const s = strip(read(p));
      const exported = [...s.matchAll(/export\s+(?:const|function|async function)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]).sort();
      assert.deepEqual(exported, ["POST", "maxDuration"], p);
      assert.match(s, /export const maxDuration = 30;/);
      assert.doesNotMatch(s, /\bdeps\b|With\(/, p);
      assert.match(s, /=>\s*handleHub(Author|Tag)Create\(request\)/, p);
    }
  });
  await t.test("the taxonomy modules make no network call", () => {
    for (const p of ["src/lib/hub-taxonomy-create-pure.ts", "src/lib/hub-taxonomy-create-core.ts"]) {
      assert.doesNotMatch(strip(read(p)), /fetch\(|http\.request|undici|axios/, p);
    }
  });
});

test("T24 soft cap AFTER the lookup, only on the create path (D16)", async (t) => {
  await t.test("not there + full ⇒ 409 taxonomy_full, no create", async () => {
    const a = world({ count: { authors: 950 } });
    const ra = await callAuthor(a);
    assert.equal(ra.status, 409);
    assert.equal(ra.body.status, "taxonomy_full");
    const g = world({ count: { tags: 2900 } });
    const rg = await callTag(g);
    assert.equal(rg.status, 409);
    assert.equal(a.log.creates.length + g.log.creates.length, 0);
  });
  await t.test("949 / 2,899 ⇒ created", async () => {
    assert.equal((await callAuthor(world({ count: { authors: 949 } }))).status, 201);
    assert.equal((await callTag(world({ count: { tags: 2899 } }))).status, 201);
  });
  await t.test("already there + full ⇒ 200 created:false, 0 creates, 0 counts; caps below the read caps", async () => {
    const a = world({ authors: [{ id: 7, tenant: 1, name: NAME, role: "Desk" }], count: { authors: 5000 } });
    const ra = await callAuthor(a);
    const g = world({ tags: [{ id: 9, tenant: 1, slug: "canary-tagtitle-zq", title: TITLE }], count: { tags: 9000 } });
    const rg = await callTag(g);
    assert.deepEqual([ra.status, ra.body.created, rg.status, rg.body.created], [200, false, 200, false]);
    assert.equal(a.log.creates.length + g.log.creates.length + a.log.counts.length + g.log.counts.length, 0);
    const route = readFileSync(path.resolve("src/app/api/hub/taxonomy/route.ts"), "utf8");
    const cap = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(route)?.[1]);
    assert.ok(pure.TAXONOMY_SOFT_CAP_AUTHORS < cap("AUTHORS_CAP") && cap("AUTHORS_CAP") === 1000);
    assert.ok(pure.TAXONOMY_SOFT_CAP_TAGS < cap("TAGS_CAP") && cap("TAGS_CAP") === 3000);
  });
});
