/**
 * public-tags-probe.ts — empirical probe for GET /api/public/tags.
 * LOCAL DISPOSABLE DATABASE ONLY: hard-refuses any non-local DATABASE_URL via
 * scripts/lib/local-db-guard.ts (no override) and any non-loopback base URL.
 * It creates AND deletes rows (fixture tenants, articles, tags, relationship
 * rows; all carry a run tag and are deleted in `finally`).
 *
 *   npx tsx scripts/public-tags-probe.ts --preflight
 *       Guard only: prints `host:port/db` and exits non-zero on refusal. Run it
 *       BEFORE `npm run db:seed`, before any dev server and before the probe.
 *   npm run db:seed                       # schema + base tenants
 *   npm run probe:public-tags             # G4-G8 + G10 against a running dev server
 *       PUBLIC_TAGS_PROBE_BASE   default http://127.0.0.1:3511 (loopback only)
 *       PUBLIC_TAGS_PROBE_PGLOG  path of the disposable Postgres log written with
 *                                log_statement=all (needed for G10)
 *       --only=G4,G6,...         run a subset of groups (fixtures always built)
 *   npx tsx scripts/public-tags-probe.ts --compare http://127.0.0.1:3511 http://127.0.0.1:3512
 *       G9b: same fixtures, same token, existing public routes requested from
 *       both servers (branch vs origin/main); normalized body + headers must match.
 *
 * Never prints a read token (fixture tokens are labelled by prefix only).
 * Exit code 0 = every check passed.
 */
import "./lib/env";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

// Guard FIRST, before the Payload config or the db adapter are imported.
let banner: string;
try {
  banner = assertLocalDb(process.env.DATABASE_URL).banner;
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  process.exit(2);
}

const ARGS = process.argv.slice(2);
if (ARGS.includes("--preflight")) {
  console.log(`[preflight] local database ${banner} — OK`);
  process.exit(0);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
function assertLoopback(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    console.error("[probe] refusing: base URL is not a valid URL");
    process.exit(2);
  }
  if (!LOOPBACK.has(u.hostname)) {
    console.error("[probe] refusing: base URL must be a loopback address (127.0.0.1 / localhost / ::1)");
    process.exit(2);
  }
  return u.origin;
}

const compareIdx = ARGS.indexOf("--compare");
const COMPARE = compareIdx >= 0 ? [assertLoopback(ARGS[compareIdx + 1] ?? ""), assertLoopback(ARGS[compareIdx + 2] ?? "")] : null;
const BASE = assertLoopback(process.env.PUBLIC_TAGS_PROBE_BASE ?? "http://127.0.0.1:3511");
const PGLOG = process.env.PUBLIC_TAGS_PROBE_PGLOG ?? "";
const onlyArg = ARGS.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
const want = (g: string) => !ONLY || ONLY.has(g);

type Id = number;
type Row = Record<string, unknown>;
type Payload = Awaited<ReturnType<typeof import("payload").getPayload>>;
type Exec = { execute: (q: unknown) => Promise<{ rows?: Row[] }> };

const RUN = `pt${randomBytes(3).toString("hex")}`;
let checks = 0;
let failures = 0;
function pass(name: string, detail = "") {
  checks += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${name} — ${detail}`);
}
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass(name);
  else fail(name, detail);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tok {
  raw: string;
  label: string;
}
function newToken(): Tok {
  const raw = randomBytes(24).toString("hex");
  return { raw, label: `${raw.slice(0, 6)}…` };
}

interface Hit {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
}
async function get(base: string, path: string, tok: Tok | null, extra: Record<string, string> = {}): Promise<Hit> {
  const headers: Record<string, string> = { "accept-encoding": "identity", ...extra };
  if (tok) headers.authorization = `Bearer ${tok.raw}`;
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

interface Tag {
  slug: string;
  title: string;
  count: number;
}
function docsOf(h: Hit): Tag[] {
  return ((h.json as { docs?: Tag[] } | null)?.docs ?? []) as Tag[];
}
function totalOf(h: Hit): number {
  return Number((h.json as { totalDocs?: number } | null)?.totalDocs ?? -1);
}
function sortExpected(list: Tag[]): Tag[] {
  return [...list].sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
const fmt = (l: Tag[]) => JSON.stringify(l.map((t) => `${t.slug}:${t.count}:${t.title}`));

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

/** Statement entries written to the PG log since byte offset `from`. */
function logEntriesSince(from: number): string[] {
  const buf = readFileSync(PGLOG);
  const chunk = buf.subarray(from).toString("utf8");
  const entries: string[] = [];
  let cur = "";
  for (const line of chunk.split("\n")) {
    if (/^\d{4}-\d\d-\d\d /.test(line)) {
      if (cur) entries.push(cur);
      cur = line;
    } else cur += `\n${line}`;
  }
  if (cur) entries.push(cur);
  return entries.filter((e) => /LOG:\s+(statement|execute [^:]*):/.test(e));
}

async function main() {
  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: config } = await import("../payload.config");
  const { pCreate, pDelete } = await import("./lib/payload-loose");
  const { hashToken } = await import("../src/lib/crypto");
  const { parseMinCount, parseLimit, rowsOrThrow } = await import("../src/lib/public-tags");
  console.log(`[probe] database ${banner} — run tag ${RUN} — base ${COMPARE ? COMPARE.join(" vs ") : BASE}`);
  const payload: Payload = await getPayload({ config });
  const db = (payload.db as unknown as { drizzle: Exec }).drizzle;
  const q = async (s: unknown): Promise<Row[]> => (await db.execute(s)).rows ?? [];
  const one = async (s: unknown): Promise<Row> => (await q(s))[0] ?? {};

  const tenants: Id[] = [];
  const mkTenant = async (suffix: string, defaultLanguage: string, supported: string[], articles: boolean): Promise<{ id: Id; tok: Tok }> => {
    const tok = newToken();
    const { hash, prefix } = hashToken(tok.raw);
    const doc = (await pCreate(
      payload,
      "tenants",
      {
        name: `Probe ${RUN} ${suffix}`,
        slug: `${RUN}-${suffix}`,
        status: "active",
        defaultLanguage,
        supportedLanguages: supported,
        features: { articles, corrections: true },
        readTokens: [{ label: "probe", tokenHash: hash, tokenPrefix: prefix, status: "active" }],
      },
      { context: { disableRevalidate: true }, depth: 0 },
    )) as unknown as { id: Id };
    tenants.push(doc.id);
    return { id: doc.id, tok };
  };
  const article = async (tenantId: Id, wf: string, status = "published", slug?: string): Promise<Id> => {
    const r = await one(
      sql`INSERT INTO articles (tenant_id, workflow_status, _status, published_at) VALUES (${tenantId}, ${wf}::"enum_articles_workflow_status", ${status}::"enum_articles_status", now()) RETURNING id`,
    );
    const id = Number(r.id);
    if (slug) await q(sql`INSERT INTO articles_locales (title, slug, _locale, _parent_id) VALUES (${`Title ${slug}`}, ${slug}, 'en', ${id})`);
    return id;
  };
  const tag = async (tenantId: Id, slug: string, titles: Record<string, string>): Promise<Id> => {
    const id = Number((await one(sql`INSERT INTO tags (tenant_id, slug) VALUES (${tenantId}, ${slug}) RETURNING id`)).id);
    for (const [loc, title] of Object.entries(titles)) {
      await q(sql`INSERT INTO tags_locales (title, _locale, _parent_id) VALUES (${title}, ${loc}::"_locales", ${id})`);
    }
    return id;
  };
  const rel = async (articleId: Id, tagId: Id) => {
    await q(sql`INSERT INTO articles_rels ("order", parent_id, path, tags_id) VALUES (1, ${articleId}, 'tags', ${tagId})`);
  };

  try {
    // ── fixtures ──
    const A = await mkTenant("a", "en", ["en", "vi"], true);
    const B = await mkTenant("b", "vi", ["vi", "en"], true);
    const C = await mkTenant("c", "en", ["en"], true);
    const D = await mkTenant("d", "en", ["en"], false);
    const s = (x: string) => `${RUN}-${x}`;

    // tenant A articles
    const a1 = await article(A.id, "published", "published", s("art-a1"));
    const a2 = await article(A.id, "published");
    const a3 = await article(A.id, "draft", "draft");
    const a4 = await article(A.id, "hidden");
    const a5 = await article(A.id, "archived");
    const a6 = await article(A.id, "published", "draft"); // _status draft + workflowStatus published: counts
    const a7 = await article(A.id, "published");
    // tenant A tags
    const T1 = await tag(A.id, s("t1"), { en: "T1" });
    const T2 = await tag(A.id, s("t2"), { en: "T2" });
    await tag(A.id, s("t3"), { en: "T3" }); // unused
    const T4 = await tag(A.id, s("t4"), { en: "T4" });
    const SA = await tag(A.id, s("shared"), { en: "Shared A" });
    const L1 = await tag(A.id, s("l1"), { en: "L1 en", vi: "L1 vi" });
    const L2 = await tag(A.id, s("l2"), { en: "L2 en" });
    const L0 = await tag(A.id, s("l0"), {}); // no locale rows: title falls back to slug
    for (const a of [a1, a2, a3, a4, a5]) await rel(a, T1);
    await rel(a1, T2);
    await rel(a6, T4);
    await rel(a6, T4); // raw duplicate rel row: must not inflate
    await rel(a7, T4);
    await rel(a1, SA);
    await rel(a2, SA);
    for (const t of [L1, L2, L0]) await rel(a1, t);

    // tenant B (default vi)
    const bArts: Id[] = [];
    for (let i = 0; i < 5; i++) bArts.push(await article(B.id, "published"));
    const SB = await tag(B.id, s("shared"), { vi: "Shared B vi" });
    for (const b of bArts) await rel(b, SB);
    const V1 = await tag(B.id, s("v1"), { vi: "V1 vi", en: "V1 en" });
    const V2 = await tag(B.id, s("v2"), { vi: "V2 vi" });
    await rel(bArts[0] as Id, V1);
    await rel(bArts[0] as Id, V2);
    // corrupt cross-tenant rels (both sides)
    await rel(a1, SB); // A article -> B tag (tag-side predicate)
    await rel(bArts[0] as Id, SA); // B article -> A tag (article-side predicate)

    // a tag attached through the Payload Local API (proves the stored path)
    let T5: Tag | null = null;
    try {
      const t5 = await tag(A.id, s("t5"), { en: "T5" });
      const created = (await pCreate(
        payload,
        "articles",
        { tenant: A.id, title: `Probe ${RUN} local api`, slug: s("art-local"), tags: [t5] },
        { draft: true, depth: 0, context: { disableRevalidate: true } },
      )) as unknown as { id: Id };
      await q(sql`UPDATE articles SET workflow_status = 'published' WHERE id = ${created.id}`);
      T5 = { slug: s("t5"), title: "T5", count: 1 };
    } catch (err) {
      fail("fixture: article with tags via Payload Local API", err instanceof Error ? err.message.slice(0, 200) : "error");
    }

    const expectA: Tag[] = sortExpected([
      { slug: s("t1"), title: "T1", count: 2 },
      { slug: s("t2"), title: "T2", count: 1 },
      { slug: s("t4"), title: "T4", count: 2 },
      { slug: s("shared"), title: "Shared A", count: 2 },
      { slug: s("l1"), title: "L1 en", count: 1 },
      { slug: s("l2"), title: "L2 en", count: 1 },
      { slug: s("l0"), title: s("l0"), count: 1 },
      ...(T5 ? [T5] : []),
    ]);

    if (COMPARE) {
      await runCompare(COMPARE, A.tok, s("art-a1"));
      return;
    }

    // ── server/DB identity: the fixture token must be known to the server ──
    const hello = await get(BASE, "/api/public/tags", A.tok);
    if (hello.status !== 200) {
      fail("server uses the probe database (fixture token 200)", `got ${hello.status}; is the dev server on ${BASE} using ${banner}?`);
      return;
    }
    pass("server uses the probe database (fixture token 200)", `token ${A.tok.label}`);

    // ── G4 published-only counting ──
    if (want("G4")) {
      console.log("[G4] published-only counting");
      const paths = (await q(sql`SELECT DISTINCT path FROM articles_rels WHERE tags_id IS NOT NULL`)).map((r) => String(r.path));
      check("G4 stored relationship path is 'tags'", paths.length === 1 && paths[0] === "tags", `paths=${JSON.stringify(paths)}`);
      const r1 = await get(BASE, "/api/public/tags?minCount=1", A.tok);
      check("G4 minCount=1 exact list (T1=2, T4=2 incl. _status draft, dup rel once, no T3)", fmt(docsOf(r1)) === fmt(expectA), `got ${fmt(docsOf(r1))} want ${fmt(expectA)}`);
      check("G4 minCount=1 totalDocs", totalOf(r1) === expectA.length, `totalDocs=${totalOf(r1)}`);
      const r2 = await get(BASE, "/api/public/tags?minCount=2", A.tok);
      const exp2 = expectA.filter((t) => t.count >= 2);
      check("G4 minCount=2 -> T1,T4,shared", fmt(docsOf(r2)) === fmt(exp2), `got ${fmt(docsOf(r2))}`);
      if (T5) check("G4 Local API attached tag is counted (path='tags')", docsOf(r1).some((t) => t.slug === T5?.slug && t.count === 1), "t5 missing");
    }

    // ── G5 tenant isolation ──
    if (want("G5")) {
      console.log("[G5] tenant isolation");
      const ra = docsOf(await get(BASE, "/api/public/tags?minCount=1&limit=2000", A.tok));
      const shared = ra.filter((t) => t.slug === s("shared"));
      check("G5 A: one shared-slug row with A's count 2 (no B tag, no B article counted)", shared.length === 1 && shared[0]?.count === 2 && shared[0]?.title === "Shared A", `got ${fmt(shared)}`);
      check("G5 A: no B-only tags", !ra.some((t) => t.slug === s("v1") || t.slug === s("v2")), fmt(ra));
      const rb = docsOf(await get(BASE, "/api/public/tags?minCount=1&limit=2000", B.tok));
      const expB = sortExpected([
        { slug: s("shared"), title: "Shared B vi", count: 5 },
        { slug: s("v1"), title: "V1 vi", count: 1 },
        { slug: s("v2"), title: "V2 vi", count: 1 },
      ]);
      check("G5 B: only B's tags and counts", fmt(rb) === fmt(expB), `got ${fmt(rb)}`);
    }

    // ── G7 locale ──
    if (want("G7")) {
      console.log("[G7] locale");
      const vi = docsOf(await get(BASE, "/api/public/tags?locale=vi", A.tok));
      const t = (l: Tag[], x: string) => l.find((d) => d.slug === s(x))?.title;
      check("G7 locale=vi returns vi title", t(vi, "l1") === "L1 vi", `l1=${t(vi, "l1")}`);
      check("G7 en-only tag falls back to tenant default (en)", t(vi, "l2") === "L2 en", `l2=${t(vi, "l2")}`);
      check("G7 tag without title rows returns slug", t(vi, "l0") === s("l0"), `l0=${t(vi, "l0")}`);
      const zz = docsOf(await get(BASE, "/api/public/tags?locale=zz", A.tok));
      check("G7 locale=zz clamps to default en", t(zz, "l1") === "L1 en", `l1=${t(zz, "l1")}`);
      const ben = docsOf(await get(BASE, "/api/public/tags?locale=en", B.tok));
      check("G7 B locale=en returns en title", t(ben, "v1") === "V1 en", `v1=${t(ben, "v1")}`);
      check("G7 B vi-only tag falls back to tenant default vi (not global en)", t(ben, "v2") === "V2 vi", `v2=${t(ben, "v2")}`);
      check("G7 no title is ever null/empty", [...vi, ...zz, ...ben].every((d) => typeof d.title === "string" && d.title !== ""), "null title");
    }

    // ── G8 auth / gate / CORS / gzip ──
    if (want("G8")) {
      console.log("[G8] auth, gate, CORS, gzip");
      const none = await get(BASE, "/api/public/tags", null);
      const bad = await get(BASE, "/api/public/tags", newToken());
      const artNone = await get(BASE, "/api/public/articles", null);
      check("G8 no token -> 401 unauthorized", none.status === 401 && none.text === '{"ok":false,"status":"unauthorized"}', `${none.status} ${none.text}`);
      check("G8 bad token -> 401", bad.status === 401 && bad.text === none.text, `${bad.status} ${bad.text}`);
      check("G8 401 body byte-equals the articles 401 body", none.text === artNone.text && artNone.status === 401, `${artNone.text}`);
      const gated = await get(BASE, "/api/public/tags", D.tok);
      check("G8 features.articles=false -> 404 not_found", gated.status === 404 && gated.text === '{"ok":false,"status":"not_found"}', `${gated.status} ${gated.text}`);
      const opt = await fetch(`${BASE}/api/public/tags`, { method: "OPTIONS" });
      check(
        "G8 OPTIONS -> 204 with CORS",
        opt.status === 204 && opt.headers.get("access-control-allow-methods") === "GET, OPTIONS" && Boolean(opt.headers.get("access-control-allow-origin")),
        `${opt.status} ${opt.headers.get("access-control-allow-methods")}`,
      );
      // The framework may prepend its own Vary tokens (next dev does); the route's
      // part must be exactly what jsonPublic sets, and identical to a sibling route.
      const varyTail = (h: Hit) => (h.headers.get("vary") ?? "").split(",").map((x) => x.trim()).filter((x) => x === "Origin" || x === "Accept-Encoding").join(", ");
      const small = await get(BASE, "/api/public/tags", A.tok);
      const sibSmall = await get(BASE, "/api/public/authors", A.tok);
      check(
        "G8 identity response: CORS + Vary: Origin (same Vary as /authors), no content-encoding",
        varyTail(small) === "Origin" && small.headers.get("vary") === sibSmall.headers.get("vary") && !small.headers.get("content-encoding") && Boolean(small.headers.get("access-control-allow-origin")) && small.headers.get("content-type") === "application/json",
        `vary=${small.headers.get("vary")} ce=${small.headers.get("content-encoding")} ct=${small.headers.get("content-type")}`,
      );
      // >= 1 KB body: tenant A list is small, so add a burst of tags to C for this check if needed
      const bigTags: Id[] = [];
      const cArt = await article(C.id, "published");
      for (let i = 0; i < 40; i++) bigTags.push(await tag(C.id, s(`gz${String(i).padStart(2, "0")}`), { en: `Gzip tag number ${i} with a longish title` }));
      for (const t of bigTags) await rel(cArt, t);
      const gz = await get(BASE, "/api/public/tags?limit=2000", C.tok, { "accept-encoding": "gzip" });
      check(
        "G8 gzip response >= 1 KB: Content-Encoding gzip + Vary: Origin, Accept-Encoding",
        gz.status === 200 && gz.headers.get("content-encoding") === "gzip" && varyTail(gz) === "Origin, Accept-Encoding" && (gz.headers.get("vary") ?? "").endsWith("Origin, Accept-Encoding") && Boolean(gz.headers.get("access-control-allow-origin")),
        `ce=${gz.headers.get("content-encoding")} vary=${gz.headers.get("vary")}`,
      );
      await q(sql`DELETE FROM articles WHERE id = ${cArt}`);
      for (const t of bigTags) await q(sql`DELETE FROM tags WHERE id = ${t}`);
    }

    // ── G10 query shape (1 aggregate, no N+1) ──
    let cTagsReady = false;
    if (want("G10") || want("G6")) {
      const c1 = await article(C.id, "published");
      await q(sql`INSERT INTO tags (tenant_id, slug) SELECT ${C.id}, ${s("g")} || lpad(g::text, 5, '0') FROM generate_series(1, 50) g`);
      await q(sql`INSERT INTO articles_rels ("order", parent_id, path, tags_id) SELECT 1, ${c1}, 'tags', id FROM tags WHERE tenant_id = ${C.id} AND slug LIKE ${`${s("g")}%`}`);
      const measure = async (): Promise<{ total: number; rels: number; rows: number }> => {
        await get(BASE, "/api/public/tags?minCount=1&limit=2000", C.tok); // warm-up (route compiled, token memo fresh)
        await sleep(400);
        const from = statSync(PGLOG).size;
        const h = await get(BASE, "/api/public/tags?minCount=1&limit=2000", C.tok);
        await sleep(600);
        const entries = logEntriesSince(from);
        return { total: entries.length, rels: entries.filter((e) => e.includes("articles_rels")).length, rows: docsOf(h).length };
      };
      if (want("G10")) {
        console.log("[G10] query shape");
        if (!PGLOG) fail("G10 PUBLIC_TAGS_PROBE_PGLOG set", "missing; cannot count statements");
        else {
          const m50 = await measure();
          await q(sql`INSERT INTO tags (tenant_id, slug) SELECT ${C.id}, ${s("g")} || lpad(g::text, 5, '0') FROM generate_series(51, 5000) g`);
          await q(sql`INSERT INTO articles_rels ("order", parent_id, path, tags_id) SELECT 1, ${c1}, 'tags', t.id FROM tags t WHERE t.tenant_id = ${C.id} AND t.slug LIKE ${`${s("g")}%`} AND t.id NOT IN (SELECT tags_id FROM articles_rels WHERE parent_id = ${c1})`);
          const m5k = await measure();
          console.log(`        50 tags: ${m50.rows} rows, ${m50.total} statements (${m50.rels} on articles_rels); 5000 tags: ${m5k.rows} rows, ${m5k.total} statements (${m5k.rels} on articles_rels)`);
          check("G10 50 tags returned as rows", m50.rows === 50, `rows=${m50.rows}`);
          check("G10 5000 tags returned (capped 2000)", m5k.rows === 2000, `rows=${m5k.rows}`);
          check("G10 exactly 1 statement touches articles_rels per request (50)", m50.rels === 1, `rels=${m50.rels}`);
          check("G10 exactly 1 statement touches articles_rels per request (5000)", m5k.rels === 1, `rels=${m5k.rels}`);
          check("G10 equal total statement count at 50 vs 5000 tags (warm)", m50.total === m5k.total, `${m50.total} vs ${m5k.total}`);
        }
      }
      // make sure C has the 5000 tags for G6 limit checks
      const n = Number((await one(sql`SELECT count(*)::int AS n FROM tags WHERE tenant_id = ${C.id} AND slug LIKE ${`${s("g")}%`}`)).n);
      if (n < 5000) {
        await q(sql`INSERT INTO tags (tenant_id, slug) SELECT ${C.id}, ${s("g")} || lpad(g::text, 5, '0') FROM generate_series(${n + 1}::int, 5000) g`);
        await q(sql`INSERT INTO articles_rels ("order", parent_id, path, tags_id) SELECT 1, ${c1}, 'tags', t.id FROM tags t WHERE t.tenant_id = ${C.id} AND t.slug LIKE ${`${s("g")}%`} AND t.id NOT IN (SELECT tags_id FROM articles_rels WHERE parent_id = ${c1})`);
      }
      // one tag used by 1000 published articles (for the minCount clamp at 1000)
      const bigTag = await tag(C.id, s("big"), { en: "Big" });
      await q(sql`INSERT INTO articles (tenant_id, workflow_status, _status) SELECT ${C.id}, 'published', 'published' FROM generate_series(1, 1000)`);
      await q(sql`INSERT INTO articles_rels ("order", parent_id, path, tags_id) SELECT 1, a.id, 'tags', ${bigTag} FROM articles a WHERE a.tenant_id = ${C.id} AND a.id <> ${c1}`);
      cTagsReady = true;
    }

    // ── G6 parameters ──
    if (want("G6")) {
      console.log("[G6] parameters");
      const minPins: Array<[string | null, number]> = [[null, 1], ["", 1], ["0", 1], ["-3", 1], ["abc", 1], ["1.5", 1], ["2.7", 2], ["Infinity", 1], ["1e3", 1000], ["5000", 1000]];
      const limPins: Array<[string | null, number]> = [[null, 500], ["", 500], ["0", 500], ["-5", 500], ["0.5", 500], ["abc", 500], ["2.5", 2], ["1", 1], ["99999", 2000]];
      const throws = (v: unknown) => { try { rowsOrThrow(v); return false; } catch { return true; } };
      check("G6 N1 result without a rows array throws (500 path, not an empty 200)", throws(undefined) && throws(null) && throws({}) && throws({ rows: "x" }) && !throws({ rows: [] }), "rowsOrThrow guard");
      for (const [raw, exp] of minPins) check(`G6 parseMinCount(${JSON.stringify(raw)}) = ${exp}`, parseMinCount(raw) === exp, `got ${parseMinCount(raw)}`);
      for (const [raw, exp] of limPins) check(`G6 parseLimit(${JSON.stringify(raw)}) = ${exp}`, parseLimit(raw) === exp, `got ${parseLimit(raw)}`);
      // HTTP: minCount on tenant A (counts 1 and 2)
      const all = expectA;
      const two = expectA.filter((t) => t.count >= 2);
      for (const [raw, exp] of minPins) {
        if (exp === 1000) continue;
        const qs = raw === null ? "" : `?minCount=${encodeURIComponent(raw)}`;
        const got = docsOf(await get(BASE, `/api/public/tags${qs}`, A.tok));
        check(`G6 HTTP minCount ${JSON.stringify(raw)} -> ${exp}`, fmt(got) === fmt(exp === 2 ? two : all), `got ${got.length} rows`);
      }
      const rep = docsOf(await get(BASE, "/api/public/tags?minCount=2&minCount=1", A.tok));
      check("G6 repeated param: first value wins", fmt(rep) === fmt(two), `got ${rep.length} rows`);
      const o1 = await get(BASE, "/api/public/tags?minCount=1", A.tok);
      const o2 = await get(BASE, "/api/public/tags?minCount=1", A.tok);
      check("G6 ordering count desc, slug asc, stable across two calls", o1.text === o2.text && fmt(docsOf(o1)) === fmt(expectA), "unstable or wrong order");
      if (cTagsReady) {
        for (const raw of ["1e3", "5000"]) {
          const got = docsOf(await get(BASE, `/api/public/tags?minCount=${raw}&limit=2000`, C.tok));
          check(`G6 HTTP minCount ${raw} -> 1000 (only the 1000-article tag)`, got.length === 1 && got[0]?.slug === s("big") && got[0]?.count === 1000, `got ${got.length} rows`);
        }
        for (const [raw, exp] of limPins) {
          const qs = raw === null ? "" : `?limit=${encodeURIComponent(raw)}`;
          const h = await get(BASE, `/api/public/tags${qs}`, C.tok);
          check(`G6 HTTP limit ${JSON.stringify(raw)} -> ${exp} rows, totalDocs 5001`, docsOf(h).length === exp && totalOf(h) === 5001, `got ${docsOf(h).length} rows, totalDocs ${totalOf(h)}`);
        }
        const l1 = docsOf(await get(BASE, "/api/public/tags?limit=1", C.tok));
        check("G6 limit=1 returns the top-count tag", l1[0]?.slug === s("big"), `got ${fmt(l1)}`);
      }
    }
  } finally {
    // cleanup: everything carrying the run tag
    try {
      for (const t of tenants) {
        await q(sql`DELETE FROM translation_jobs WHERE article_id IN (SELECT id FROM articles WHERE tenant_id = ${t})`);
        await q(sql`DELETE FROM _articles_v WHERE parent_id IN (SELECT id FROM articles WHERE tenant_id = ${t})`);
        await q(sql`DELETE FROM articles WHERE tenant_id = ${t}`);
        await q(sql`DELETE FROM tags WHERE tenant_id = ${t}`);
      }
      for (const t of tenants) await pDelete(payload, "tenants", t, { context: { disableRevalidate: true } });
      const left = Number((await one(sql`SELECT (SELECT count(*) FROM tenants WHERE slug LIKE ${`${RUN}-%`}) + (SELECT count(*) FROM tags WHERE slug LIKE ${`${RUN}-%`}) AS n`)).n);
      check("cleanup: no fixture rows left", left === 0, `left=${left}`);
    } catch (err) {
      fail("cleanup", err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }

  async function runCompare(bases: string[], tok: Tok, articleSlug: string) {
    console.log("[G9b] existing public routes, branch vs origin/main, same DB + token");
    const [sa, sb] = bases as [string, string];
    for (const base of [sa, sb]) {
      const h = await get(base, "/api/public/articles?limit=1", tok);
      if (h.status !== 200) {
        fail(`server ${base} uses the probe database (fixture token 200)`, `got ${h.status}`);
        return;
      }
      pass(`server ${base} uses the probe database (fixture token 200)`);
    }
    const paths = [
      "/api/public/articles",
      "/api/public/articles?view=refs",
      `/api/public/articles/${articleSlug}`,
      "/api/public/authors",
      "/api/public/cities",
      "/api/public/menus?type=header",
      "/api/public/site",
    ];
    const H = ["content-type", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "vary", "content-encoding"];
    for (const p of paths) {
      for (const enc of ["identity", "gzip"]) {
        const x = await get(sa, p, tok, { "accept-encoding": enc });
        const y = await get(sb, p, tok, { "accept-encoding": enc });
        const bx = JSON.stringify(sortKeys(x.json ?? x.text));
        const by = JSON.stringify(sortKeys(y.json ?? y.text));
        const hx = H.map((k) => `${k}=${x.headers.get(k)}`).join("|");
        const hy = H.map((k) => `${k}=${y.headers.get(k)}`).join("|");
        check(`G9b ${p} [${enc}] status ${x.status} body+headers identical`, x.status === y.status && bx === by && hx === hy, `status ${x.status}/${y.status}; headers A ${hx} B ${hy}; bodyEqual=${bx === by}`);
      }
    }
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error("[probe] error:", err instanceof Error ? err.message.slice(0, 300) : "error");
  })
  .finally(() => {
    console.log(`[probe] ${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 && checks > 0 ? 0 : 1);
  });
