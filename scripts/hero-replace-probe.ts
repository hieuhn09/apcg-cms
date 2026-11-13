/**
 * hero-replace-probe.ts — local-only empirical probe for `POST /api/engine/articles/hero`
 * (media-gtp-vowasia phase 5, cases HP1-HP11 of (plus HP12, review M3, in-process) the content-engine plan
 * `phase-5-hero-replace_PLAN_06-11-26.md`).
 *
 * LOCAL ONLY. First statements: refuse any non-local DATABASE_URL
 * (scripts/lib/local-db-guard.ts, no override) and any PROBE_BASE_URL that is not loopback.
 * It creates AND deletes rows (run-tagged, cleaned in `finally`), temporarily changes the
 * seeded `dtw` tenant (frontendUrl, a read token, translations; restored in `finally`) and
 * sends HTTP writes to the local server only.
 *
 * Server preconditions (a disposable PG16 + `next dev`, see process/context/tests/all-tests.md):
 *   ENGINE_HERO_REPLACE_TENANTS=dtw  ENGINE_HERO_REPLACE_ALLOW_LOCAL=true
 *   CENTRAL_SIGNING_SECRET=<same value as this process>   (revalidate webhook check)
 *   npm run db:seed (tenants dtw + gcv exist)
 *
 *   PROBE_BASE_URL=http://127.0.0.1:3511 npm run probe:hero-replace
 *
 * Exit code 0 = every check passed; 1 = at least one FAIL; 2 = refused / precondition missing.
 * Tokens are generated here, never printed.
 */
import "./lib/env";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";
import { pCreate, pDelete, pFind, pUpdate } from "./lib/payload-loose";
import { sha256Hex, verifySigned } from "../src/lib/crypto";
import { heroToken } from "../src/lib/engine-hero-replace-pure";

/* ── Guards FIRST ───────────────────────────────────────────────────────── */

let dbBanner: string;
try {
  dbBanner = assertLocalDb(process.env.DATABASE_URL).banner;
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  process.exit(2);
}
const BASE = (process.env.PROBE_BASE_URL ?? "http://127.0.0.1:3511").replace(/\/$/, "");
{
  let host = "";
  try {
    host = new URL(BASE).hostname;
  } catch {
    host = "";
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    console.error(`[hero-probe] PROBE_BASE_URL must be loopback; refusing (${host || "unparseable"}).`);
    process.exit(2);
  }
}

type Id = number | string;
type Doc = Record<string, unknown> & { id: Id };
type Payload = Awaited<ReturnType<typeof import("payload").getPayload>>;
interface Exec {
  execute: (q: unknown) => Promise<{ rows?: Record<string, unknown>[] }>;
}

const RUN = randomBytes(3).toString("hex");
const TAG = `zz-hero-probe-${RUN}`;

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` | ${detail}` : ""}`);
}
const info = (l: string) => console.log(`  INFO  ${l}`);
const relId = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { id?: unknown }).id : v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Listener: JPEGs + webhook receiver ─────────────────────────────────── */

const received: { path: string; body: string }[] = [];
const images = new Map<string, Buffer>();

function startListener(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const img = req.method === "GET" ? images.get(req.url ?? "") : undefined;
    if (img) {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(img.length) });
      res.end(img);
      return;
    }
    if (req.method === "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function hero(token: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${BASE}/api/engine/articles/hero`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`[hero-probe] run ${RUN} | database ${dbBanner} (local) | server ${BASE}`);
  const sharp = (await import("sharp")).default;
  const mk = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
  for (let i = 0; i < 12; i++) images.set(`/hero-${i}.jpg`, await mk(20 * i, 120, 200 - 10 * i));
  const server = await startListener();
  const LISTENER = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const imgUrl = (i: number) => `${LISTENER}/hero-${i}.jpg`;

  // Preflight: the route exists and answers 401 without a bearer.
  const pre = await fetch(`${BASE}/api/engine/articles/hero`, { method: "POST", body: "{}" }).catch(() => null);
  if (!pre || pre.status !== 401) {
    console.error(`[hero-probe] preflight: expected 401 from the route, got ${pre ? pre.status : "no response"}.`);
    server.close();
    process.exit(2);
  }

  const { getPayload } = await import("payload");
  const { default: config } = await import("@payload-config");
  const payload: Payload = await getPayload({ config });
  const db = (payload.db as unknown as { drizzle: Exec }).drizzle;
  const { sql } = await import("@payloadcms/db-postgres");

  const tenantBy = async (slug: string) => (await pFind(payload, "tenants", { where: { slug: { equals: slug } }, limit: 1 })).docs[0] as unknown as Doc | undefined;
  const T = await tenantBy("dtw");
  const T2 = await tenantBy("gcv");
  if (!T || !T2) {
    console.error("[hero-probe] tenants dtw and gcv must exist: run `npm run db:seed` on the local DB first.");
    process.exit(2);
  }
  const tOrig = { frontendUrl: T.frontendUrl ?? "", features: T.features, supportedLanguages: T.supportedLanguages, readTokens: T.readTokens };
  const firstOf = async (collection: string, tenant: Id, where: Record<string, unknown> = {}) =>
    (await pFind(payload, collection, { where: { and: [{ tenant: { equals: tenant } }, where] }, limit: 1 })).docs[0] as unknown as Doc;
  const pillarT = await firstOf("pillars", T.id, { slug: { not_equals: "pressroom" } });
  const pillarT2 = await firstOf("pillars", T2.id, { slug: { not_in: ["pressroom", "exclusive"] } });

  const created = { articles: [] as Id[], media: [] as Id[], engines: [] as Id[], authors: [] as Id[] };
  const mkAuthor = async (tenant: Id) => {
    const a = (await pCreate(payload, "authors", { tenant, name: `${TAG} author ${String(tenant)}`, role: "Staff Writer", city: "" })) as unknown as Doc;
    created.authors.push(a.id);
    return a;
  };
  const authorT = await mkAuthor(T.id);
  const authorT2 = await mkAuthor(T2.id);
  const tokA = randomBytes(24).toString("hex");
  const tokB = randomBytes(24).toString("hex");
  const readTok = randomBytes(24).toString("hex");
  let n = 0;

  const mkMedia = async (tenant: Id, i: number): Promise<Doc> => {
    const buf = images.get(`/hero-${i}.jpg`) as Buffer;
    const m = (await pCreate(payload, "media", { tenant, alt: `${TAG} m${i}`, credit: `Old credit ${i}` }, { file: { data: buf, mimetype: "image/jpeg", name: `${TAG}-old-${i}.jpg`, size: buf.length } })) as unknown as Doc;
    created.media.push(m.id);
    return m;
  };
  const mkArticle = async (tenant: Id, pillar: Id, author: Id, heroId: Id | null, extra: Record<string, unknown> = {}): Promise<Doc> => {
    n += 1;
    const a = (await pCreate(payload, "articles", {
      tenant,
      pillar,
      author,
      title: `${TAG} article ${n}`,
      slug: `${TAG}-a${n}`,
      engineDraftId: `content-engine:probe:${RUN}-${n}`,
      leadImageCaption: `Lead caption ${n}`,
      workflowStatus: "published",
      _status: "published",
      ...(heroId != null ? { heroImage: heroId } : {}),
      ...extra,
    }, { context: { disableRevalidate: true } })) as unknown as Doc;
    created.articles.push(a.id);
    return a;
  };
  const readMain = async (id: Id) => (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, locale: "all" } as never)) as unknown as Doc;
  const readLatest = async (id: Id) => (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, draft: true, locale: "en" } as never)) as unknown as Doc;
  const acceptedRows = async (articleId: Id) =>
    (await pFind(payload, "activityLog", { where: { and: [{ eventType: { equals: "engine_write_accepted" } }, { targetId: { equals: String(articleId) } }] }, limit: 50 })).docs as unknown as Doc[];
  const mediaCount = async () => (await pFind(payload, "media", { where: { tenant: { equals: T.id } }, limit: 0 })).totalDocs as number;
  const body = (a: Doc, expected: Id | null, i: number, extra: Record<string, unknown> = {}) => ({
    publicationId: "dtw",
    engineDraftId: a.engineDraftId,
    expectedHeroMediaId: expected,
    heroImageUrl: imgUrl(i),
    imageCredit: `New credit ${i}`,
    imageCaption: "Illustrative image",
    replacementKey: `replace:${String(a.id)}:${String(expected)}:${i}:${RUN}`,
    reason: "probe",
    ...extra,
  });

  try {
    // Fixtures: engines (token hashed by the collection hook), tenant tweaks.
    const engA = (await pCreate(payload, "content-engines", { name: `${TAG}-A`, engineType: "other", status: "active", allowedTenants: [T.id, T2.id], allowedActions: ["create_article", "update_article", "upload_media"], rawToken: tokA })) as unknown as Doc;
    const engB = (await pCreate(payload, "content-engines", { name: `${TAG}-B`, engineType: "other", status: "active", allowedTenants: [T.id], allowedActions: ["update_article"], rawToken: tokB })) as unknown as Doc;
    created.engines.push(engA.id, engB.id);
    await pUpdate(payload, "tenants", T.id, {
      frontendUrl: LISTENER,
      readTokens: [...(((T.readTokens as unknown[]) ?? []) as Doc[]).map((r) => ({ label: r.label, tokenHash: r.tokenHash, tokenPrefix: r.tokenPrefix, status: r.status })), { label: TAG, tokenHash: sha256Hex(readTok), tokenPrefix: readTok.slice(0, 8), status: "active" }],
    });

    /* HP1 */
    console.log("\n[HP1] engine without upload_media");
    const m1 = await mkMedia(T.id, 0);
    const a1 = await mkArticle(T.id, pillarT.id, authorT.id, m1.id);
    const r1 = await hero(tokB, body(a1, m1.id, 1));
    check("HP1 403 action not allowed: upload_media", r1.status === 403 && r1.json.reason === "action not allowed: upload_media", `${r1.status} ${String(r1.json.reason)}`);
    const denied = (await pFind(payload, "activityLog", { where: { and: [{ eventType: { equals: "engine_action_denied" } }, { actorEngine: { equals: engB.id } }] }, limit: 5 })).docs as unknown as Doc[];
    check("HP1 engine_action_denied row naming upload_media", denied.some((d) => (d.detail as Doc | undefined)?.action === "upload_media"), `${denied.length} row(s)`);
    check("HP1 article untouched", relId((await readMain(a1.id)).heroImage) === m1.id);

    /* HP2 */
    console.log("\n[HP2] tenant not in ENGINE_HERO_REPLACE_TENANTS");
    const mg = (await pCreate(payload, "media", { tenant: T2.id, alt: `${TAG} g`, credit: "g" }, { file: { data: images.get("/hero-0.jpg") as Buffer, mimetype: "image/jpeg", name: `${TAG}-g.jpg`, size: (images.get("/hero-0.jpg") as Buffer).length } })) as unknown as Doc;
    created.media.push(mg.id);
    const g = await mkArticle(T2.id, pillarT2.id, authorT2.id, mg.id);
    const r2 = await hero(tokA, { ...body(g, mg.id, 2), publicationId: "gcv" });
    check("HP2 403 feature_disabled", r2.status === 403 && r2.json.status === "feature_disabled", `${r2.status} ${String(r2.json.status)}`);
    check("HP2 gcv article untouched", relId((await readMain(g.id)).heroImage) === mg.id);

    /* HP3 */
    console.log("\n[HP3] another tenant's article");
    const r3 = await hero(tokA, { ...body(g, mg.id, 3), publicationId: "dtw" });
    check("HP3 404 not_found", r3.status === 404 && r3.json.status === "not_found", `${r3.status} ${String(r3.json.status)}`);

    /* HP4 */
    console.log("\n[HP4] stale expectedHeroMediaId");
    const r4 = await hero(tokA, body(a1, Number(m1.id) + 100000, 4));
    check("HP4 409 hero_changed + currentHeroMediaId", r4.status === 409 && r4.json.status === "hero_changed" && r4.json.currentHeroMediaId === m1.id, `${r4.status} ${JSON.stringify(r4.json)}`);
    const r4b = await hero(tokA, body(a1, null, 4));
    check("HP4 expectedHeroMediaId null on an article with a hero -> 409", r4b.status === 409, String(r4b.status));

    /* dry run */
    console.log("\n[DRY] inspect");
    const mcDry = await mediaCount();
    const rd = await hero(tokA, { publicationId: "dtw", engineDraftId: a1.engineDraftId, expectedHeroMediaId: null, dryRun: true });
    check("DRY 200 dry_run with current ids/credit/filename", rd.status === 200 && rd.json.status === "dry_run" && rd.json.currentHeroMediaId === m1.id && rd.json.currentHeroCredit === "Old credit 0" && String(rd.json.currentHeroFilename).startsWith(`${TAG}-old-0`) && rd.json.draftDiverged === false, JSON.stringify(rd.json));
    check("DRY no Media created", (await mediaCount()) === mcDry);

    /* HP5 + HP6 */
    console.log("\n[HP5] replace a normal published article");
    const before = await readMain(a1.id);
    const vRowsBefore = (await db.execute(sql`SELECT count(*)::int AS n FROM _articles_v WHERE parent_id = ${Number(a1.id)}`)).rows?.[0]?.n as number;
    received.length = 0;
    const b5 = body(a1, m1.id, 5);
    const r5 = await hero(tokA, b5);
    check("HP5 200 replaced", r5.status === 200 && r5.json.status === "replaced", `${r5.status} ${JSON.stringify(r5.json)}`);
    const newId = r5.json.newMediaId as Id;
    const after = await readMain(a1.id);
    check("HP5 heroImage = new Media id", relId(after.heroImage) === newId, `${String(relId(after.heroImage))} vs ${String(newId)}`);
    for (const k of ["_status", "workflowStatus", "editedByHuman", "version", "publishedAt", "lastEngine", "engineDraftId"]) {
      check(`HP5 ${k} unchanged`, JSON.stringify(after[k]) === JSON.stringify(before[k]), `${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
    }
    for (const k of ["title", "slug", "body", "leadImageCaption", "dek"]) {
      check(`HP5 ${k} unchanged (all locales)`, JSON.stringify(after[k]) === JSON.stringify(before[k]));
    }
    const nm = (await payload.findByID({ collection: "media", id: newId, depth: 0, overrideAccess: true, locale: "en" } as never)) as unknown as Doc;
    check("HP5 new Media caption / credit / alt", nm.caption === "Illustrative image" && nm.credit === "New credit 5" && nm.alt === String((await readLatest(a1.id)).title), `${String(nm.caption)} / ${String(nm.credit)} / ${String(nm.alt)}`);
    check("HP5 new Media filename carries the token", String(nm.filename).includes(`-r${heroToken(b5.replacementKey)}`), String(nm.filename));
    created.media.push(newId);
    const old = (await payload.findByID({ collection: "media", id: m1.id, depth: 0, overrideAccess: true, disableErrors: true } as never)) as unknown as Doc | null;
    check("HP5 old Media row still present", !!old);
    check("HP5 exactly one engine_write_accepted row with the P1 detail", (await acceptedRows(a1.id)).length === 1 && JSON.stringify((await acceptedRows(a1.id))[0]?.detail).includes('"action":"replace_hero"'));
    const vRowsAfter = (await db.execute(sql`SELECT count(*)::int AS n FROM _articles_v WHERE parent_id = ${Number(a1.id)}`)).rows?.[0]?.n as number;
    const latestV = (await db.execute(sql`SELECT version__status AS s, version_version AS v, version_hero_image_id AS h FROM _articles_v WHERE parent_id = ${Number(a1.id)} AND latest = true`)).rows?.[0];
    // Control: Payload (localization + versions) writes a version row PLUS a snapshot row on
    // every non-draft save, so "one save" is measured on a plain Local API update, not assumed.
    const mc = await mkMedia(T.id, 2);
    const ctl = await mkArticle(T.id, pillarT.id, authorT.id, mc.id);
    const vCount = async (id: Id) => (await db.execute(sql`SELECT count(*)::int AS n FROM _articles_v WHERE parent_id = ${Number(id)}`)).rows?.[0]?.n as number;
    const c0 = await vCount(ctl.id);
    await payload.update({ collection: "articles", id: ctl.id, data: { heroImage: mc.id } as never, overrideAccess: true, locale: "en", context: { heroSwap: true, disableRevalidate: true } } as never);
    const perSave = (await vCount(ctl.id)) - c0;
    info(`one plain non-draft save adds ${perSave} _articles_v row(s) (version + snapshot)`);
    check("HP5 exactly one save's worth of _articles_v rows; latest row published, same version, new hero", vRowsAfter - vRowsBefore === perSave && latestV?.s === "published" && Number(latestV?.h) === Number(newId) && Number(latestV?.v) === Number(before.version), `${vRowsBefore}->${vRowsAfter} (per save ${perSave}) ${JSON.stringify(latestV)}`);
    const hook = await (async () => {
      for (let i = 0; i < 50; i++) {
        const hit = received.find((x) => x.path === "/api/revalidate");
        if (hit) return hit;
        await sleep(100);
      }
      return undefined;
    })();
    let claims: Record<string, unknown> | null = null;
    try {
      claims = hook ? (verifySigned(String((JSON.parse(hook.body) as { token?: string }).token), Math.floor(Date.now() / 1000)) as Record<string, unknown> | null) : null;
    } catch {
      claims = null;
    }
    check("HP5 signed revalidate webhook received for the article", !!claims && claims.tenant === "dtw", hook ? JSON.stringify(claims) : "no webhook");
    const slugEn = String((await readLatest(a1.id)).slug);
    const pubRes = await fetch(`${BASE}/api/public/articles/${encodeURIComponent(slugEn)}`, { headers: { authorization: `Bearer ${readTok}`, "accept-encoding": "identity" } });
    const pubText = await pubRes.text();
    check("HP5 public read shows the new hero", pubRes.status === 200 && pubText.includes(`-r${heroToken(b5.replacementKey)}`) && !pubText.includes(`${TAG}-old-0`), `${pubRes.status}`);

    console.log("\n[HP6] repeat with the same replacementKey");
    const mc6 = await mediaCount();
    const r6 = await hero(tokA, b5);
    check("HP6 200 noop, same current id", r6.status === 200 && r6.json.status === "noop" && r6.json.currentHeroMediaId === newId, `${r6.status} ${JSON.stringify(r6.json)}`);
    check("HP6 no second Media", (await mediaCount()) === mc6);
    check("HP6 still one accepted row", (await acceptedRows(a1.id)).length === 1);

    /* HP7 legacy shape */
    console.log("\n[HP7] legacy shape (_status draft + workflowStatus published)");
    const m7 = await mkMedia(T.id, 7);
    const a7 = await mkArticle(T.id, pillarT.id, authorT.id, m7.id);
    await db.execute(sql`UPDATE articles SET _status = 'draft' WHERE id = ${Number(a7.id)}`);
    await db.execute(sql`UPDATE _articles_v SET version__status = 'draft' WHERE parent_id = ${Number(a7.id)}`);
    const b7 = await readMain(a7.id);
    check("HP7 fixture shape", b7._status === "draft" && b7.workflowStatus === "published", `${String(b7._status)} / ${String(b7.workflowStatus)}`);
    const r7 = await hero(tokA, body(a7, m7.id, 8));
    check("HP7 200 replaced", r7.status === 200 && r7.json.status === "replaced", `${r7.status} ${JSON.stringify(r7.json)}`);
    if (r7.json.newMediaId != null) created.media.push(r7.json.newMediaId as Id);
    const a7after = await readMain(a7.id);
    check("HP7 _status still draft", a7after._status === "draft", String(a7after._status));
    check("HP7 workflowStatus still published", a7after.workflowStatus === "published", String(a7after.workflowStatus));
    check("HP7 version unchanged", a7after.version === b7.version, `${String(b7.version)} -> ${String(a7after.version)}`);
    check("HP7 publishedAt unchanged", JSON.stringify(a7after.publishedAt) === JSON.stringify(b7.publishedAt));
    check("HP7 heroImage swapped", relId(a7after.heroImage) === r7.json.newMediaId);
    const l7 = await readLatest(a7.id);
    check("HP7 latest version still draft at the same version", l7._status === "draft" && l7.version === b7.version, `${String(l7._status)} v${String(l7.version)}`);

    /* HP8 translations */
    console.log("\n[HP8] translation-enabled tenant, up-to-date translations");
    await pUpdate(payload, "tenants", T.id, { features: { ...((T.features as Doc) ?? {}), translations: true }, supportedLanguages: ["en", "vi"] });
    const m8 = await mkMedia(T.id, 9);
    const a8 = await mkArticle(T.id, pillarT.id, authorT.id, m8.id);
    const v8 = (await readMain(a8.id)).version as number;
    await pUpdate(payload, "articles", a8.id, { translationStatus: [{ locale: "vi", state: "machine_translated", sourceVersionAtTranslation: v8 }] }, { context: { systemWrite: true, skipTranslationEnqueue: true, disableRevalidate: true } });
    const jobs = async () => (await db.execute(sql`SELECT count(*)::int AS n FROM translation_jobs WHERE article_id = ${Number(a8.id)}`)).rows?.[0]?.n as number;
    const j0 = await jobs();
    const b8 = await readMain(a8.id);
    const r8 = await hero(tokA, body(a8, m8.id, 10));
    check("HP8 200 replaced", r8.status === 200 && r8.json.status === "replaced", `${r8.status} ${JSON.stringify(r8.json)}`);
    if (r8.json.newMediaId != null) created.media.push(r8.json.newMediaId as Id);
    await sleep(300);
    const a8after = await readMain(a8.id);
    check("HP8 version unchanged", a8after.version === b8.version, `${String(b8.version)} -> ${String(a8after.version)}`);
    check("HP8 no new translationJobs row", (await jobs()) === j0, `${j0} -> ${await jobs()}`);
    const ts = (a8after.translationStatus as Doc[] | undefined) ?? [];
    check("HP8 translation row not outdated", ts.length === 1 && ts[0]!.state === "machine_translated", JSON.stringify(ts.map((r) => r.state)));
    await pUpdate(payload, "tenants", T.id, { features: tOrig.features, supportedLanguages: tOrig.supportedLanguages });

    /* HP9 intake unchanged (smoke; probe:gtp + probe:single-home are run separately) */
    console.log("\n[HP9] intake create path (lenient hero upload) unchanged");
    const intake = async (name: string, heroUrl: string) => {
      const r = await fetch(`${BASE}/api/engine/intake`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` },
        body: JSON.stringify({ publicationId: "dtw", title: `${TAG} intake ${name}`, slug: `${TAG}-intake-${name}`, pillarSlug: pillarT.slug, body_markdown: "Probe body.", byline: String(authorT.name), heroImageUrl: heroUrl, imageCredit: "C", sourceProvenance: { url: `https://probe.invalid/${RUN}/${name}`, name: "probe" } }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (j.id != null) created.articles.push(j.id as Id);
      return { status: r.status, json: j };
    };
    const i1 = await intake("ok", imgUrl(11));
    const i1doc = i1.json.id != null ? await readMain(i1.json.id as Id) : null;
    check("HP9 intake with a hero -> 201 + hero set", i1.status === 201 && relId(i1doc?.heroImage) != null, `${i1.status} ${JSON.stringify(i1.json)}`);
    if (i1doc?.heroImage != null) {
      const hm = (await payload.findByID({ collection: "media", id: relId(i1doc.heroImage) as Id, depth: 0, overrideAccess: true } as never)) as unknown as Doc;
      created.media.push(hm.id);
      check("HP9 intake media name = `${slug}.jpeg` (no token)", String(hm.filename).startsWith(`${TAG}-intake-ok`) && !String(hm.filename).includes("-r"), String(hm.filename));
    }
    const i2 = await intake("nohero", `${LISTENER}/missing.jpg`);
    const i2doc = i2.json.id != null ? await readMain(i2.json.id as Id) : null;
    check("HP9 intake with a 404 hero -> 201 without hero (lenient)", i2.status === 201 && (i2doc?.heroImage ?? null) === null, `${i2.status}`);

    /* HP10 pending editor draft */
    console.log("\n[HP10] editor draft saved over a published row");
    const m10 = await mkMedia(T.id, 3);
    const a10 = await mkArticle(T.id, pillarT.id, authorT.id, m10.id);
    await payload.update({ collection: "articles", id: a10.id, data: { title: `${TAG} EDITOR DRAFT` } as never, draft: true, overrideAccess: true, locale: "en", context: { disableRevalidate: true } } as never);
    const b10 = await readMain(a10.id);
    const mc10 = await mediaCount();
    const r10 = await hero(tokA, body(a10, m10.id, 4));
    check("HP10 409 draft_diverged", r10.status === 409 && r10.json.status === "draft_diverged", `${r10.status} ${JSON.stringify(r10.json)}`);
    const a10after = await readMain(a10.id);
    for (const k of ["title", "body", "_status", "version", "heroImage", "workflowStatus", "publishedAt"]) {
      check(`HP10 ${k} unchanged`, JSON.stringify(a10after[k]) === JSON.stringify(b10[k]), `${JSON.stringify(b10[k])} -> ${JSON.stringify(a10after[k])}`);
    }
    check("HP10 draft not leaked to the main row", !JSON.stringify(a10after.title).includes("EDITOR DRAFT"));
    check("HP10 editor draft still the latest version", String((await readLatest(a10.id)).title).includes("EDITOR DRAFT"));
    check("HP10 no accepted activity row", (await acceptedRows(a10.id)).length === 0);
    check("HP10 no Media created (gate 1 refuses before the upload)", (await mediaCount()) === mc10);

    /* HP11 concurrent Hide */
    const adapter = payload.db as unknown as { beginTransaction: () => Promise<Id>; commitTransaction: (id: Id) => Promise<void>; rollbackTransaction: (id: Id) => Promise<void>; sessions: Record<string, { db: Exec }> };
    for (const variant of ["payload-hub-hide", "raw-sql-hide"] as const) {
      console.log(`\n[HP11 ${variant}] Hide committed between gate 1 and the write`);
      const m11 = await mkMedia(T.id, variant === "payload-hub-hide" ? 5 : 6);
      const a11 = await mkArticle(T.id, pillarT.id, authorT.id, m11.id);
      const txId = await adapter.beginTransaction();
      const { createLocalReq } = await import("payload");
      const req = await createLocalReq({}, payload);
      req.transactionID = txId as never;
      if (variant === "payload-hub-hide") {
        await payload.update({
          collection: "articles",
          id: a11.id,
          data: { workflowStatus: "hidden" } as never,
          overrideAccess: true,
          req: req as never,
          context: { hubWrite: { actor: { email: "probe@example.invalid", role: "admin" }, reason: "probe hide" }, disableRevalidate: true },
        } as never);
      } else {
        await adapter.sessions[String(txId)]!.db.execute(sql`UPDATE articles SET workflow_status = 'hidden' WHERE id = ${Number(a11.id)}`);
      }
      const t0 = Date.now();
      const pending = hero(tokA, body(a11, m11.id, variant === "payload-hub-hide" ? 0 : 1));
      await sleep(1200);
      await adapter.commitTransaction(txId);
      const r11 = await pending;
      const waited = Date.now() - t0;
      if (r11.json.newMediaId != null) created.media.push(r11.json.newMediaId as Id);
      const a11after = await readMain(a11.id);
      check(`HP11 ${variant}: answered 200 replaced or 409 draft_diverged`, (r11.status === 200 && r11.json.status === "replaced") || (r11.status === 409 && r11.json.status === "draft_diverged"), `${r11.status} ${String(r11.json.status)} after ${waited} ms`);
      check(`HP11 ${variant}: the call waited on the row lock`, waited >= 1000, `${waited} ms`);
      check(`HP11 ${variant}: Hide NOT overwritten (workflowStatus hidden)`, a11after.workflowStatus === "hidden", String(a11after.workflowStatus));
      if (r11.status === 200) check(`HP11 ${variant}: hero swapped`, relId(a11after.heroImage) === r11.json.newMediaId);
      else check(`HP11 ${variant}: hero untouched after the rollback`, relId(a11after.heroImage) === m11.id);
      info(`HP11 ${variant}: ${r11.status} ${String(r11.json.status)}`);
    }

    /* HP12 fail closed without a host list (review M3), in-process on the real DB + real auth */
    console.log("\n[HP12] tenant enabled, ENGINE_HERO_REPLACE_URL_HOSTS empty, not the local probe");
    {
      const { handleHeroReplace } = await import("../src/lib/engine-hero-replace-core");
      const m12 = await mkMedia(T.id, 0);
      const a12 = await mkArticle(T.id, pillarT.id, authorT.id, m12.id);
      const never = async (): Promise<never> => {
        throw new Error("HP12: must not reach the lock / article reads");
      };
      const res12 = await handleHeroReplace(
        new Request(`${BASE}/api/engine/articles/hero`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` }, body: JSON.stringify(body(a12, m12.id, 2)) }),
        { getPayload: async () => payload, lock: never, lockRow: never, readMainAll: never, env: { ENGINE_HERO_REPLACE_TENANTS: "dtw", ENGINE_HERO_REPLACE_URL_HOSTS: "" } },
      );
      const j12 = (await res12.json()) as Doc;
      check("HP12 403 feature_disabled (url hosts not configured)", res12.status === 403 && j12.status === "feature_disabled" && j12.reason === "hero replace url hosts not configured", `${res12.status} ${JSON.stringify(j12)}`);
      check("HP12 article untouched", relId((await readMain(a12.id)).heroImage) === m12.id);
      const denied12 = (await pFind(payload, "activityLog", { where: { and: [{ eventType: { equals: "engine_action_denied" } }, { actorEngine: { equals: engA.id } }] }, limit: 50 })).docs as unknown as Doc[];
      check("HP12 engine_action_denied row with the reason", denied12.some((d) => (d.detail as Doc | undefined)?.reason === "hero replace url hosts not configured"), `${denied12.length} row(s)`);
    }
  } finally {
    console.log("\n[cleanup]");
    for (const id of created.articles) {
      try {
        await db.execute(sql`DELETE FROM translation_jobs WHERE article_id = ${Number(id)}`);
        await pDelete(payload, "articles", id, { context: { disableRevalidate: true } });
      } catch (err) {
        console.log(`  (cleanup) article ${String(id)}: ${(err as Error).message}`);
      }
    }
    const tokenMedia = (await pFind(payload, "media", { where: { filename: { like: TAG } }, limit: 500 })).docs as unknown as Doc[];
    for (const id of new Set([...created.media.map(String), ...tokenMedia.map((m) => String(m.id))])) {
      try {
        await pDelete(payload, "media", id);
      } catch (err) {
        console.log(`  (cleanup) media ${id}: ${(err as Error).message}`);
      }
    }
    for (const id of created.authors) {
      try {
        await pDelete(payload, "authors", id);
      } catch (err) {
        console.log(`  (cleanup) author ${String(id)}: ${(err as Error).message}`);
      }
    }
    for (const id of created.engines) {
      try {
        await pDelete(payload, "content-engines", id);
      } catch (err) {
        console.log(`  (cleanup) engine ${String(id)}: ${(err as Error).message}`);
      }
    }
    try {
      await pUpdate(payload, "tenants", T.id, {
        frontendUrl: tOrig.frontendUrl,
        features: tOrig.features,
        supportedLanguages: tOrig.supportedLanguages,
        readTokens: (((tOrig.readTokens as unknown[]) ?? []) as Doc[]).map((r) => ({ label: r.label, tokenHash: r.tokenHash, tokenPrefix: r.tokenPrefix, status: r.status })),
      });
    } catch (err) {
      console.log(`  (cleanup) tenant restore: ${(err as Error).message}`);
    }
    server.close();
  }
  console.log(`\n[hero-probe] ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("[hero-probe] crashed:", err);
  process.exit(1);
});
