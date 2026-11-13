/**
 * LOCAL DISPOSABLE Postgres probe for the AsiaBeautyBrief booths collection +
 * public API (abb launch, 22-10-26). NOT for any shared/production database:
 * the local-DB guard refuses a non-local DATABASE_URL before Payload loads.
 *
 *   1) DATABASE_URL=<local> npx payload migrate
 *   2) DATABASE_URL=<local> npm run dev            (in another shell)
 *   3) DATABASE_URL=<local> npx tsx scripts/abb-booths-probe.ts [--base=http://localhost:3508]
 *
 * Seeds (idempotently, prefix `zzprobe`) tenant `abb` (exhibition ON) and a
 * control tenant `zzprobe-noexh` (exhibition OFF), a read token each, one
 * published + one unpublished booth, one article; then checks over HTTP:
 *  (a) list + detail shapes are the allowlist (no tenant/published/articles/ids),
 *  (b) hall / article filters, unknown hall -> empty envelope, unpublished -> 404,
 *  (c) tenant without the feature -> 404 { ok:false, status:"not_found" },
 *  (d) a content-engine token cannot read or write booths via REST, and engine
 *      intake has no booths path.
 */
import "./lib/env";
import { randomBytes, createHash } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

try {
  assertLocalDb(process.env.DATABASE_URL);
} catch (e) {
  if (e instanceof LocalDbGuardError) {
    console.error(`[abb-booths-probe] ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const base = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3508").replace(/\/$/, "");
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || info === undefined ? "" : `  -> ${JSON.stringify(info).slice(0, 400)}`}`);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  const { getPayload } = await import("payload");
  const { default: config } = await import("../payload.config");
  const { pCreate, pFind, pUpdate } = await import("./lib/payload-loose");
  const sharp = (await import("sharp")).default;
  const payload = await getPayload({ config });
  const ctx = { context: { disableRevalidate: true } };
  const one = async (c: string, where: object) => (await pFind(payload, c, { where, limit: 1 })).docs[0] as unknown as Record<string, unknown> | undefined;

  const abbToken = `abb_${randomBytes(16).toString("hex")}`;
  const noToken = `noexh_${randomBytes(16).toString("hex")}`;
  const tenantData = (slug: string, name: string, exhibition: boolean, token: string) => ({
    name, slug, status: "active", defaultLanguage: "en", supportedLanguages: ["en"], timezone: "Asia/Singapore",
    autoPublishEngineDrafts: false,
    features: { articles: true, newsletters: true, corrections: true, exhibition },
    readTokens: [{ label: "probe", tokenHash: sha(token), tokenPrefix: token.slice(0, 8), status: "active" }],
  });
  const upsertTenant = async (slug: string, name: string, exhibition: boolean, token: string) => {
    const t = await one("tenants", { slug: { equals: slug } });
    return (t
      ? await pUpdate(payload, "tenants", t.id as number, tenantData(slug, name, exhibition, token), ctx)
      : await pCreate(payload, "tenants", tenantData(slug, name, exhibition, token), ctx)) as unknown as Record<string, unknown>;
  };
  const abb = await upsertTenant("abb", "AsiaBeautyBrief", true, abbToken);
  const noexh = await upsertTenant("zzprobe-noexh", "No Exhibition", false, noToken);

  const pillar = (await one("pillars", { and: [{ tenant: { equals: abb.id } }, { slug: { equals: "zzprobe-pillar" } }] }))
    ?? ((await pCreate(payload, "pillars", { tenant: abb.id, slug: "zzprobe-pillar", title: "Probe" }, ctx)) as unknown as Record<string, unknown>);
  const author = (await one("authors", { and: [{ tenant: { equals: abb.id } }, { name: { equals: "Zz Probe" } }] }))
    ?? ((await pCreate(payload, "authors", { tenant: abb.id, name: "Zz Probe", slug: "zz-probe" }, ctx)) as unknown as Record<string, unknown>);
  const article = (await one("articles", { and: [{ tenant: { equals: abb.id } }, { slug: { equals: "zzprobe-article" } }] }))
    ?? ((await pCreate(payload, "articles", {
      tenant: abb.id, pillar: pillar.id, author: author.id, title: "Probe article", slug: "zzprobe-article",
      workflowStatus: "published", _status: "published",
    }, ctx)) as unknown as Record<string, unknown>);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c33" } }).png().toBuffer();
  const logo = (await one("media", { and: [{ tenant: { equals: abb.id } }, { alt: { equals: "zzprobe logo" } }] }))
    ?? ((await pCreate(payload, "media", { tenant: abb.id, alt: "zzprobe logo" }, { ...ctx, file: { data: png, mimetype: "image/png", name: `zzprobe-${Date.now()}.png`, size: png.length } })) as unknown as Record<string, unknown>);

  const boothData = (slug: string, published: boolean) => ({
    tenant: abb.id, slug, name: slug === "zzprobe-acme" ? "Acme Labs" : "Hidden Co", published, hall: "manufacturers",
    typeLine: "OEM/ODM Manufacturer", city: "Seoul", country: "South Korea", verified: true, tier: "premium",
    summary: "Probe summary.", logo: logo.id, catalog: logo.id, website: "https://acme.example", inquiryEmail: "sales@acme.example",
    about: { root: { type: "root", version: 1, direction: null, format: "", indent: 0, children: [{ type: "paragraph", version: 1, direction: null, format: "", indent: 0, textFormat: 0, children: [{ type: "text", version: 1, text: "About Acme.", format: 0, detail: 0, mode: "normal", style: "" }] }] } },
    capabilities: [{ category: "Skincare", formats: "Cream, serum", moq: "3,000 units", leadTime: "8 weeks" }],
    atAGlance: { founded: "2004", employees: "250", certifications: "ISO 22716, GMP", marketsServed: "Asia, EU", languages: "EN, KO" },
    articles: [article.id],
  });
  for (const [slug, pub] of [["zzprobe-acme", true], ["zzprobe-hidden", false]] as const) {
    const b = await one("booths", { and: [{ tenant: { equals: abb.id } }, { slug: { equals: slug } }] });
    if (b) await pUpdate(payload, "booths", b.id as number, boothData(slug, pub), ctx);
    else await pCreate(payload, "booths", boothData(slug, pub), ctx);
  }
  // Duplicate slug within tenant must be refused (hook + unique index).
  let dupRefused = false;
  try { await pCreate(payload, "booths", boothData("zzprobe-acme", false), ctx); } catch { dupRefused = true; }
  check("duplicate booth slug within tenant is refused", dupRefused);

  const engineRaw = `eng_${randomBytes(16).toString("hex")}`;
  const eng = await one("content-engines", { name: { equals: "zzprobe-engine" } });
  const engData = { name: "zzprobe-engine", engineType: "writer", status: "active", rawToken: engineRaw, allowedTenants: [abb.id], allowedActions: ["create_article", "update_article", "upload_media"] };
  if (eng) await pUpdate(payload, "content-engines", eng.id as number, engData, ctx);
  else await pCreate(payload, "content-engines", engData, ctx);

  /* ── HTTP checks ── */
  const get = async (path: string, token?: string) => {
    const r = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body: body as Record<string, unknown> };
  };
  const SUMMARY_KEYS = ["atAGlance", "city", "country", "hall", "logo", "name", "slug", "summary", "tier", "typeLine", "verified"];
  const DETAIL_KEYS = [...SUMMARY_KEYS, "about", "capabilities", "catalog", "inquiryEmail", "website"].sort();
  const ENVELOPE = ["docs", "hasNextPage", "hasPrevPage", "limit", "nextPage", "page", "pagingCounter", "prevPage", "totalDocs", "totalPages"];

  const list = await get("/api/public/booths", abbToken);
  const docs = (list.body?.docs ?? []) as Array<Record<string, unknown>>;
  check("(a) list 200", list.status === 200, list);
  check("(a) list envelope = Payload list envelope", JSON.stringify(Object.keys(list.body ?? {}).sort()) === JSON.stringify(ENVELOPE), Object.keys(list.body ?? {}));
  check("(a) list shows only the published booth", docs.length === 1 && docs[0]?.slug === "zzprobe-acme", docs.map((d) => d.slug));
  check("(a) list row keys = allowlist", JSON.stringify(Object.keys(docs[0] ?? {}).sort()) === JSON.stringify(SUMMARY_KEYS), Object.keys(docs[0] ?? {}));
  const logoObj = docs[0]?.logo as Record<string, unknown> | null;
  check("(a) list logo {url, alt}", !!logoObj && typeof logoObj.url === "string" && logoObj.alt === "zzprobe logo" && Object.keys(logoObj).length === 2, logoObj);
  check("(a) list atAGlance only certifications", JSON.stringify(docs[0]?.atAGlance) === JSON.stringify({ certifications: "ISO 22716, GMP" }), docs[0]?.atAGlance);
  const raw = JSON.stringify(list.body);
  check("(a) no internal field names leak in list", !/"tenant"|"published"|"articles"|"createdAt"|"updatedAt"|"id"/.test(raw.replace(/"docs"/, "")), raw.slice(0, 300));

  const det = await get("/api/public/booths/zzprobe-acme", abbToken);
  const doc = (det.body?.doc ?? {}) as Record<string, unknown>;
  check("(a) detail 200 { doc }", det.status === 200 && Object.keys(det.body ?? {}).join() === "doc", det.body);
  check("(a) detail keys = allowlist", JSON.stringify(Object.keys(doc).sort()) === JSON.stringify(DETAIL_KEYS), Object.keys(doc).sort());
  check("(a) detail no tenant/published/articles/id", !/"tenant"|"published"|"articles"|"createdAt"|"updatedAt"|"id"\s*:/.test(JSON.stringify(doc)), JSON.stringify(doc).slice(0, 300));
  check("(a) detail about is Lexical JSON", typeof (doc.about as Record<string, unknown> | null)?.root === "object");
  check("(a) detail catalog {url, filename}", !!doc.catalog && Object.keys(doc.catalog as object).sort().join() === "filename,url", doc.catalog);
  check("(a) detail capabilities shape", JSON.stringify(doc.capabilities) === JSON.stringify([{ category: "Skincare", formats: "Cream, serum", moq: "3,000 units", leadTime: "8 weeks" }]), doc.capabilities);

  check("(b) unpublished booth detail -> 404", (await get("/api/public/booths/zzprobe-hidden", abbToken)).status === 404);
  check("(b) unknown slug -> 404 not_found", JSON.stringify((await get("/api/public/booths/nope", abbToken)).body) === JSON.stringify({ ok: false, status: "not_found" }));
  check("(b) hall=manufacturers -> 1", ((await get("/api/public/booths?hall=manufacturers", abbToken)).body?.totalDocs) === 1);
  check("(b) hall=services -> 0", ((await get("/api/public/booths?hall=services", abbToken)).body?.totalDocs) === 0);
  const badHall = await get("/api/public/booths?hall=bogus", abbToken);
  check("(b) unknown hall -> empty envelope", badHall.status === 200 && JSON.stringify(badHall.body) === JSON.stringify({ docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false }), badHall.body);
  check("(b) article=zzprobe-article -> 1", ((await get("/api/public/booths?article=zzprobe-article", abbToken)).body?.totalDocs) === 1);
  check("(b) article=unknown -> 0", ((await get("/api/public/booths?article=nope", abbToken)).body?.totalDocs) === 0);
  check("(b) no token -> 401", (await get("/api/public/booths")).status === 401);

  const off = await get("/api/public/booths", noToken);
  check("(c) tenant without exhibition: list 404 not_found", off.status === 404 && JSON.stringify(off.body) === JSON.stringify({ ok: false, status: "not_found" }), off);
  check("(c) tenant without exhibition: detail 404", (await get("/api/public/booths/zzprobe-acme", noToken)).status === 404);

  const engGet = await get("/api/booths", engineRaw);
  check("(d) engine token cannot read /api/booths (REST)", engGet.status === 401 || engGet.status === 403 || (Array.isArray(engGet.body?.docs) && (engGet.body.docs as unknown[]).length === 0), engGet);
  const engPost = await fetch(`${base}/api/booths`, { method: "POST", headers: { authorization: `Bearer ${engineRaw}`, "content-type": "application/json" }, body: JSON.stringify({ tenant: abb.id, name: "Engine", slug: "zzprobe-engine-booth" }) });
  check("(d) engine token cannot create via /api/booths (REST)", engPost.status === 401 || engPost.status === 403, engPost.status);
  check("(d) no booth created by the engine", !(await one("booths", { slug: { equals: "zzprobe-engine-booth" } })));
  const readPost = await fetch(`${base}/api/booths`, { method: "POST", headers: { authorization: `Bearer ${abbToken}`, "content-type": "application/json" }, body: JSON.stringify({ tenant: abb.id, name: "X", slug: "zzprobe-read-booth" }) });
  check("(d) read token cannot create via /api/booths (REST)", readPost.status === 401 || readPost.status === 403, readPost.status);
  check("(d) control tenant untouched (no booths)", (await pFind(payload, "booths", { where: { tenant: { equals: noexh.id } } })).totalDocs === 0);

  console.log(`\n[abb-booths-probe] ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[abb-booths-probe] crashed:", e);
  process.exit(1);
});
