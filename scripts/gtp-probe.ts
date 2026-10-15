/**
 * gtp-probe.ts — local-only empirical probe for the GlobalTravelPost (tenant
 * `gtp`) readiness of Central CMS (gtp-launch P1, plan section 9.3).
 *
 * LOCAL ONLY. First statements: refuse any non-local DATABASE_URL
 * (scripts/lib/local-db-guard.ts, no override) and any PROBE_BASE_URL whose
 * host is not localhost / 127.0.0.1 / [::1]. It creates AND deletes rows
 * (run-tagged, cleaned in `finally`) and sends HTTP writes to the local server.
 *
 *   SEED_INCLUDE_GTP=true npm run db:seed        # fresh local DB; prints a gtp read token once
 *   npm run dev                                  # http://localhost:3508
 *   PROBE_READ_TOKEN=<gtp read token> PROBE_ENGINE_TOKEN=<engine token> npm run probe:gtp
 *
 * Env: PROBE_BASE_URL (default http://localhost:3508), PROBE_READ_TOKEN,
 * PROBE_ENGINE_TOKEN (falls back to SEED_ENGINE_TOKEN), SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD (preview-mint login), CENTRAL_SIGNING_SECRET (verifies
 * the webhook + preview token). Tokens are never printed.
 *
 * Sections (order): A intake gates, B author reuse, C editor-path rules,
 * P prep (published + sponsored + tagged synthetic article, one pending
 * article), F-prep (admin login, local frontendUrl -> probe listener),
 * E subscribers / views / preview mint, F signed revalidate webhook,
 * D public API, G Lexical node matrix, H import-target facts.
 *
 * Exit code 0 = every check passed; 1 = at least one FAIL; 2 = refused.
 */
import "./lib/env";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";
// Pure modules only (no Payload instance is loaded until main() imports it
// dynamically, after the guards below).
import { pCreate, pDelete, pFind, pUpdate } from "./lib/payload-loose";
import { ruleMessage } from "../src/lib/single-home-pillars";
import { verifySigned } from "../src/lib/crypto";
import { GTP_PILLARS, GTP_TENANT_SLUG, gtpSubSections } from "./lib/gtp-taxonomy";

/* ── Guards FIRST, before the Payload config is imported ──────────────────── */

let dbBanner: string;
try {
  dbBanner = assertLocalDb(process.env.DATABASE_URL).banner;
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  process.exit(2);
}
const BASE = (process.env.PROBE_BASE_URL ?? "http://localhost:3508").replace(/\/$/, "");
{
  let host = "";
  try {
    host = new URL(BASE).hostname;
  } catch {
    host = "";
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    console.error(`[gtp-probe] PROBE_BASE_URL must point at localhost / 127.0.0.1 / [::1]; refusing (${host || "unparseable"}).`);
    process.exit(2);
  }
}
const READ_TOKEN = process.env.PROBE_READ_TOKEN?.trim() ?? "";
const ENGINE_TOKEN = (process.env.PROBE_ENGINE_TOKEN ?? process.env.SEED_ENGINE_TOKEN ?? "").trim();
if (!READ_TOKEN || !ENGINE_TOKEN) {
  console.error("[gtp-probe] PROBE_READ_TOKEN and PROBE_ENGINE_TOKEN (or SEED_ENGINE_TOKEN) are required.");
  process.exit(2);
}

type Id = number | string;
type Doc = Record<string, unknown> & { id: Id };
type Payload = Awaited<ReturnType<typeof import("payload").getPayload>>;

const RUN = randomBytes(3).toString("hex");
const SLUG = (s: string) => `zz-gtp-probe-${RUN}-${s}`;
const URL_ = (s: string) => `https://probe.invalid/gtp/${RUN}/${s}`;

let checks = 0;
let failures = 0;
function pass(name: string, detail = "") {
  checks += 1;
  console.log(`  PASS  ${name}${detail ? ` | ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${name} | ${detail}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass(name, detail);
  else fail(name, detail || "assertion false");
}
function info(line: string) {
  console.log(`  INFO  ${line}`);
}
function errText(err: unknown): string {
  const data = (err as { data?: { errors?: { message?: string }[] } })?.data;
  const msgs = (data?.errors ?? []).map((e) => e.message).filter(Boolean);
  if (msgs.length) return msgs.join("; ");
  return err instanceof Error ? err.message : String(err);
}
async function expectReject(name: string, fn: () => Promise<unknown>, message: string | RegExp) {
  try {
    await fn();
    fail(name, "write was ACCEPTED");
  } catch (err) {
    const t = errText(err);
    const ok = typeof message === "string" ? t === message : message.test(t);
    if (ok) pass(name, t);
    else fail(name, `unexpected rejection: ${t}`);
  }
}
const relId = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { id?: unknown }).id : v);

/* ── Cleanup registry ───────────────────────────────────────────────────── */

const cleanup = {
  articles: new Set<string>(),
  tags: new Set<string>(),
  authors: new Set<string>(),
  subsections: new Set<string>(),
  subscribers: new Set<string>(),
  media: new Set<string>(),
};

/* ── Local listener: hero JPEG + revalidate webhook receiver ─────────────── */

interface Received {
  path: string;
  body: string;
}
const received: Received[] = [];
let jpeg: Buffer = Buffer.alloc(0);

function startListener(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/probe.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length) });
      res.end(jpeg);
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

async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

/* ── HTTP helpers ───────────────────────────────────────────────────────── */

async function intake(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${BASE}/api/engine/intake`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENGINE_TOKEN}` },
    body: JSON.stringify({ publicationId: GTP_TENANT_SLUG, ...body }),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof json.id === "number" || typeof json.id === "string") cleanup.articles.add(String(json.id));
  return { status: r.status, json };
}

async function pub(path: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${BASE}/api/public${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}`, ...(init.headers ?? {}) },
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

const baseArticle = (name: string, extra: Record<string, unknown> = {}) => ({
  title: `GTP probe ${RUN} ${name}`,
  slug: SLUG(name),
  pillarSlug: "news",
  body_markdown: `Probe body for ${name}. Plain paragraph text.`,
  byline: "Priya Nair",
  sourceProvenance: { url: URL_(name), name: "GTP probe" },
  ...extra,
});

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`[gtp-probe] run ${RUN} | database ${dbBanner} (local) | server ${BASE}`);
  const sharp = (await import("sharp")).default;
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 157, g: 44, b: 30 } } }).jpeg().toBuffer();
  const server = await startListener();
  const port = (server.address() as AddressInfo).port;
  const LISTENER = `http://127.0.0.1:${port}`;

  const { getPayload } = await import("payload");
  const { default: config } = await import("@payload-config");
  const payload: Payload = await getPayload({ config });

  const tenant = (await pFind(payload, "tenants", { where: { slug: { equals: GTP_TENANT_SLUG } }, limit: 1 })).docs[0] as unknown as Doc | undefined;
  if (!tenant) {
    console.error("[gtp-probe] tenant gtp not found: run `SEED_INCLUDE_GTP=true npm run db:seed` on the local DB first.");
    process.exit(1);
  }
  const tenantId = tenant.id;
  const originalFrontendUrl = (tenant.frontendUrl as string | null | undefined) ?? "";
  const pillars = (await pFind(payload, "pillars", { where: { tenant: { equals: tenantId } }, limit: 100 })).docs as unknown as Doc[];
  const pillar = (slug: string) => pillars.find((p) => p.slug === slug)?.id as Id;
  const subs = (await pFind(payload, "subsections", { where: { tenant: { equals: tenantId } }, limit: 200 })).docs as unknown as Doc[];
  const sub = (slug: string) => subs.find((s) => s.slug === slug)?.id as Id;
  const authorsBefore = (await pFind(payload, "authors", { where: { tenant: { equals: tenantId } }, limit: 200 })).docs as unknown as Doc[];
  const priya = authorsBefore.find((a) => a.name === "Priya Nair");

  // The sample engine's allowedTenants is fixed at its first creation: make sure gtp is in it (LOCAL DB only).
  const engine = (await pFind(payload, "content-engines", { where: { name: { equals: "content-engine" } }, limit: 1 })).docs[0] as unknown as Doc | undefined;
  const engineTenantsBefore = ((engine?.allowedTenants as unknown[]) ?? []).map((t) => relId(t) as Id);
  let engineTouched = false;
  if (engine && !engineTenantsBefore.map(String).includes(String(tenantId))) {
    await pUpdate(payload, "content-engines", engine.id, { allowedTenants: [...engineTenantsBefore, tenantId] });
    engineTouched = true;
    info("added gtp to the local sample engine's allowedTenants (restored in cleanup)");
  }

  let adminToken = "";
  try {
    /* ── A: intake gates ───────────────────────────────────────────────── */
    console.log("\n[A] intake gates (G10)");
    for (const blocked of ["press-room", "events-awards"]) {
      const r = await intake(baseArticle(`blk-${blocked}`, { pillarSlug: blocked }));
      check(`intake ${blocked} -> 422 pillar not writable by engine`, r.status === 422 && r.json.reason === `pillar not writable by engine: ${blocked}`, `${r.status} ${String(r.json.reason)}`);
    }
    const a1 = await intake(baseArticle("a-news", { engineDraftId: `content-engine:gtp:probe-${RUN}-a1` }));
    check("intake news -> 201 pending_review", a1.status === 201 && a1.json.status === "pending_review", `${a1.status} ${String(a1.json.status)}`);
    for (const blocked of ["press-room", "events-awards"]) {
      const r = await intake(baseArticle("a-news", { engineDraftId: `content-engine:gtp:probe-${RUN}-a1`, pillarSlug: blocked }));
      check(`refresh of an existing article moved to ${blocked} -> 422`, r.status === 422 && r.json.reason === `pillar not writable by engine: ${blocked}`, `${r.status} ${String(r.json.reason)}`);
    }
    const unk = await intake(baseArticle("unknown", { pillarSlug: "no-such-pillar" }));
    check("unknown pillar -> 422", unk.status === 422 && String(unk.json.reason).startsWith("unknown pillar"), `${unk.status} ${String(unk.json.reason)}`);
    const nob = await intake(baseArticle("nobyline", { byline: "" }));
    check("missing byline -> 400", nob.status === 400, `${nob.status} ${String(nob.json.reason)}`);
    const sec = await intake(baseArticle("sec-events", { sections: ["events-awards"] }));
    check("primary news + sections:[events-awards] is NOT blocked by the engine block (primary only) -> 201", sec.status === 201, `${sec.status} ${String(sec.json.reason ?? sec.json.status)}`);
    if (sec.status === 201) {
      const d = (await payload.findByID({ collection: "articles" as never, id: sec.json.id as Id, depth: 0, overrideAccess: true })) as unknown as Doc;
      const rows = (d.secondarySections as { pillar: unknown }[] | undefined) ?? [];
      check("  stored secondary section = events-awards", rows.length === 1 && String(relId(rows[0]!.pillar)) === String(pillar("events-awards")), JSON.stringify(rows.map((r) => relId(r.pillar))));
    }
    const v3 = await intake(baseArticle("sec-press", { sections: ["press-room"] }));
    check("sections:[press-room] -> 422 V3", v3.status === 422 && v3.json.reason === ruleMessage("press-room", "V3"), `${v3.status} ${String(v3.json.reason)}`);

    /* ── B: author reuse, no ghost ─────────────────────────────────────── */
    console.log("\n[B] author reuse (G11)");
    if (a1.status === 201) {
      const d = (await payload.findByID({ collection: "articles" as never, id: a1.json.id as Id, depth: 0, overrideAccess: true })) as unknown as Doc;
      check("byline Priya Nair reuses the seeded author id", priya !== undefined && String(relId(d.author)) === String(priya.id), `article author ${String(relId(d.author))}, seeded ${String(priya?.id)}`);
    }
    const countAuthors = async () => (await pFind(payload, "authors", { where: { tenant: { equals: tenantId } }, limit: 500 })).docs.length;
    const authorsNow = await countAuthors();
    check("gtp author count unchanged after Priya Nair intakes", authorsNow === authorsBefore.length, `${authorsBefore.length} -> ${authorsNow}`);
    const ghost = await intake(baseArticle("ghost", { byline: "Zed Nobody" }));
    const ghostAuthor = (await pFind(payload, "authors", { where: { and: [{ tenant: { equals: tenantId } }, { name: { equals: "Zed Nobody" } }] }, limit: 1 })).docs[0] as unknown as Doc | undefined;
    if (ghostAuthor) cleanup.authors.add(String(ghostAuthor.id));
    check(
      "byline Zed Nobody creates a ghost author (role Staff Writer, no slug, no rank)",
      ghost.status === 201 && !!ghostAuthor && ghostAuthor.role === "Staff Writer" && (ghostAuthor.slug ?? null) === null && (ghostAuthor.rank ?? null) === null,
      ghostAuthor ? `role=${String(ghostAuthor.role)} slug=${String(ghostAuthor.slug ?? null)} rank=${String(ghostAuthor.rank ?? null)} city=${String(ghostAuthor.city ?? null)}` : `status ${ghost.status}`,
    );

    /* ── C: editor-path rules (Local API) ──────────────────────────────── */
    console.log("\n[C] editor-path rules (G12)");
    const art = async (name: string, data: Record<string, unknown>) => {
      const d = (await pCreate(payload, "articles", { tenant: tenantId, title: `GTP probe ${RUN} ${name}`, slug: SLUG(name), workflowStatus: "draft", ...data }, { context: { disableRevalidate: true } })) as unknown as Doc;
      cleanup.articles.add(String(d.id));
      return d;
    };
    try {
      await art("c-press-noauthor", { pillar: pillar("press-room") });
      pass("press-room article with NO author saves");
    } catch (err) {
      fail("press-room article with NO author saves", errText(err));
    }
    await expectReject("press-room + secondary section -> V1", () => art("c-v1", { pillar: pillar("press-room"), secondarySections: [{ pillar: pillar("news") }] }), ruleMessage("press-room", "V1"));
    await expectReject("press-room + sub-section -> V2", () => art("c-v2", { pillar: pillar("press-room"), subSection: sub("aviation") }), ruleMessage("press-room", "V2"));
    await expectReject("press-room + exclusive:true -> V6", () => art("c-v6", { pillar: pillar("press-room"), exclusive: true }), ruleMessage("press-room", "V6"));
    await expectReject(
      "sub-section under press-room -> V4",
      async () => {
        const d = (await pCreate(payload, "subsections", { tenant: tenantId, pillar: pillar("press-room"), slug: `zz-${RUN}-pr`, title: "X", order: 1 }, { context: { disableRevalidate: true } })) as unknown as Doc;
        cleanup.subsections.add(String(d.id));
      },
      new RegExp(ruleMessage("press-room", "V4").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    try {
      await art("c-ev-noauthor", { pillar: pillar("events-awards") });
      fail("events-awards article with NO author -> rejected on field author", "write was ACCEPTED");
    } catch (err) {
      const paths = ((err as { data?: { errors?: { path?: string }[] } })?.data?.errors ?? []).map((e) => e.path);
      check("events-awards article with NO author -> rejected on field author", paths.includes("author"), `${errText(err)} (path ${JSON.stringify(paths)})`);
    }
    try {
      await art("c-ev-ok", { pillar: pillar("events-awards"), subSection: sub("industry-calendar"), secondarySections: [{ pillar: pillar("news") }], author: priya?.id });
      pass("events-awards + industry-calendar + secondary news (with author) saves");
    } catch (err) {
      fail("events-awards + industry-calendar + secondary news (with author) saves", errText(err));
    }

    /* ── P: prep (published + sponsored + tagged synthetic, one pending) ── */
    console.log("\n[P] prep: synthetic article (Section G Markdown), published via the Local API; one pending article");
    const tagLabel = `zz-gtp-probe-${RUN}-tag`;
    const markdown = [
      "## Visa rules at a glance",
      "",
      "Intro paragraph with **bold**, *italic*, an [internal link](/news/visa-entry) and an [outbound link](https://example.com/visa).",
      "",
      "| Country | Visa-free days |",
      "|---|---|",
      "| Thailand | 60 |",
      "| Japan | 90 |",
      "",
      "> Travel is getting easier across the region.",
      "> , Jane Doe, Analyst",
      "",
      "- first bullet",
      "- second bullet",
      "",
      "1. first step",
      "2. second step",
      "",
      `![Probe image alt](${LISTENER}/probe.jpg)`,
      "",
      "### A smaller heading",
      "",
      "---",
      "",
      "Closing paragraph.",
    ].join("\n");
    const synth = await intake({
      title: `GTP probe ${RUN} synthetic`,
      slug: SLUG("synthetic"),
      pillarSlug: "news",
      subSectionSlug: "visa-entry",
      byline: "Priya Nair",
      aiAssisted: true,
      tags: [tagLabel],
      heroImageUrl: `${LISTENER}/probe.jpg`,
      sourceProvenance: { url: URL_("synthetic"), name: "GTP probe" },
      body_markdown: markdown,
    });
    check("synthetic intake -> 201 pending_review", synth.status === 201 && synth.json.status === "pending_review", `${synth.status} ${String(synth.json.status ?? synth.json.reason)}`);
    const synthId = synth.json.id as Id;
    const tagDoc = (await pFind(payload, "tags", { where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: tagLabel } }] }, limit: 1 })).docs[0] as unknown as Doc | undefined;
    if (tagDoc) cleanup.tags.add(String(tagDoc.id));
    check("probe tag created by intake tags[] (find-or-create)", !!tagDoc, tagLabel);
    let synthDoc = (await payload.findByID({ collection: "articles" as never, id: synthId, depth: 0, overrideAccess: true })) as unknown as Doc;
    const heroId = relId(synthDoc.heroImage);
    if (heroId != null) cleanup.media.add(String(heroId));
    check("synthetic article has a non-null heroImage (hero upload really happened)", heroId != null, `heroImage ${String(heroId)}`);
    if (heroId != null) {
      const media = (await payload.findByID({ collection: "media" as never, id: heroId as Id, depth: 0, overrideAccess: true })) as unknown as Doc;
      info(`hero media: filename=${String(media.filename)} url=${String(media.url)} prefix=${String(media.prefix ?? null)}`);
    }
    check("synthetic sub-section = visa-entry", String(relId(synthDoc.subSection)) === String(sub("visa-entry")));
    await pUpdate(
      payload,
      "articles",
      synthId,
      { _status: "published", workflowStatus: "published", sponsored: true, sponsor: "Probe Sponsor" },
      { context: { disableRevalidate: true } },
    );
    synthDoc = (await payload.findByID({ collection: "articles" as never, id: synthId, depth: 0, overrideAccess: true })) as unknown as Doc;
    check("synthetic published (both statuses) + sponsored via the Local API", synthDoc._status === "published" && synthDoc.workflowStatus === "published" && synthDoc.sponsored === true, `_status=${String(synthDoc._status)} workflowStatus=${String(synthDoc.workflowStatus)} sponsored=${String(synthDoc.sponsored)}`);
    const pending = await intake(baseArticle("pending"));
    check("second intake article stays pending_review", pending.status === 201 && pending.json.status === "pending_review", `${pending.status} ${String(pending.json.status)}`);

    /* ── F-prep: admin login + local frontendUrl -> listener ───────────── */
    console.log("\n[F-prep] admin login, LOCAL tenant frontendUrl -> probe listener");
    const login = await fetch(`${BASE}/api/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }),
    });
    adminToken = ((await login.json().catch(() => ({}))) as { token?: string }).token ?? "";
    check("admin login (SEED_ADMIN_*)", login.ok && adminToken !== "", `HTTP ${login.status}`);
    await pUpdate(payload, "tenants", tenantId, { frontendUrl: LISTENER }, { context: { disableRevalidate: true } });

    /* ── E: subscribers, views, preview mint ───────────────────────────── */
    console.log("\n[E] subscribers / views / preview mint (G14)");
    const email = `zz-gtp-probe-${RUN}@example.invalid`;
    const s1 = await pub("/subscribers", { method: "POST", body: JSON.stringify({ email, set: ["the-post", "nope"] }) });
    const s2 = await pub(`/subscribers?email=${encodeURIComponent(email)}`);
    const subRow = (await pFind(payload, "subscribers", { where: { and: [{ tenant: { equals: tenantId } }, { email: { equals: email } }] }, limit: 1 })).docs[0] as unknown as Doc | undefined;
    if (subRow) cleanup.subscribers.add(String(subRow.id));
    check("subscribers POST set:[the-post,nope] -> 200", s1.status === 200, String(s1.status));
    check("subscribers GET shows exactly [the-post] (unknown slug silently dropped)", JSON.stringify(s2.json.newsletters) === JSON.stringify(["the-post"]), JSON.stringify(s2.json.newsletters));
    const viewsBefore = Number(synthDoc.views ?? 0);
    const vr = await pub("/views", { method: "POST", body: JSON.stringify({ slug: SLUG("synthetic") }) });
    const afterViews = Number(((await payload.findByID({ collection: "articles" as never, id: synthId, depth: 0, overrideAccess: true })) as unknown as Doc).views ?? 0);
    check("views POST increments views by 1", vr.status === 200 && afterViews === viewsBefore + 1, `${vr.status} ${viewsBefore} -> ${afterViews}`);
    const mint = await fetch(`${BASE}/api/preview/mint?tenant=${String(tenantId)}&slug=${encodeURIComponent(SLUG("pending"))}`, {
      headers: { cookie: `payload-token=${adminToken}` },
      redirect: "manual",
    });
    const loc = mint.headers.get("location") ?? "";
    let mintOk = false;
    let mintDetail = `HTTP ${mint.status}`;
    if (mint.status === 302 && loc.startsWith(`${LISTENER}/preview?`)) {
      const u = new URL(loc);
      const claims = verifySigned<{ tenant?: string; slug?: string; draft?: boolean; exp: number }>(u.searchParams.get("token") ?? "", Math.floor(Date.now() / 1000));
      mintOk = !!claims && claims.tenant === "gtp" && claims.slug === SLUG("pending") && claims.draft === true && u.searchParams.get("slug") === SLUG("pending");
      mintDetail = `302 -> ${LISTENER}/preview, token ${claims ? "verifies" : "does NOT verify"}, slug ${claims?.slug === SLUG("pending") ? "matches" : "differs"}`;
    }
    check("preview mint -> 302 with a verifying token and matching slug", mintOk, mintDetail);

    /* ── F: signed revalidate webhook ──────────────────────────────────── */
    console.log("\n[F] signed revalidate webhook (G15)");
    const now = () => Math.floor(Date.now() / 1000);
    const decode = (r: Received) => {
      const token = (JSON.parse(r.body) as { token?: string }).token ?? "";
      return verifySigned<{ tags?: string[]; tenant?: string; slug?: string; exp: number }>(token, now());
    };
    received.length = 0;
    await pUpdate(payload, "articles", synthId, { dek: `Probe dek edit ${RUN}` });
    const artHit = await waitFor(() => received.find((r) => r.path === "/api/revalidate"), 8000);
    const artClaims = artHit ? decode(artHit) : null;
    check(
      "article edit -> signed POST: tags EQUAL [articles:all], tenant gtp, exp future, slug present",
      !!artClaims &&
        JSON.stringify(artClaims.tags) === JSON.stringify(["articles:all"]) &&
        artClaims.tenant === "gtp" &&
        artClaims.exp > now() &&
        artClaims.slug === SLUG("synthetic"),
      artClaims ? JSON.stringify({ tags: artClaims.tags, tenant: artClaims.tenant, slug: artClaims.slug, expIn: artClaims.exp - now() }) : artHit ? "token did not verify" : "no POST received",
    );
    received.length = 0;
    const news = pillars.find((p) => p.slug === "news")!;
    const newsHeading = news.heading as string;
    await pUpdate(payload, "pillars", news.id, { heading: `${newsHeading} probe` });
    const pilHit = await waitFor(() => received.find((r) => r.path === "/api/revalidate"), 8000);
    await pUpdate(payload, "pillars", news.id, { heading: newsHeading }, { context: { disableRevalidate: true } });
    const pilClaims = pilHit ? decode(pilHit) : null;
    check(
      "pillar edit -> tags EQUAL [pillars:all, articles:all], tenant gtp (no gtp: prefix)",
      !!pilClaims && JSON.stringify(pilClaims.tags) === JSON.stringify(["pillars:all", "articles:all"]) && pilClaims.tenant === "gtp",
      pilClaims ? JSON.stringify({ tags: pilClaims.tags, tenant: pilClaims.tenant }) : "no verified POST",
    );
    await pUpdate(payload, "tenants", tenantId, { frontendUrl: "" }, { context: { disableRevalidate: true } });
    received.length = 0;
    await pUpdate(payload, "articles", synthId, { dek: `Probe dek edit 2 ${RUN}` });
    await new Promise((r) => setTimeout(r, 2000));
    check("with frontendUrl empty NO POST arrives at the listener", received.filter((r) => r.path === "/api/revalidate").length === 0, `${received.length} request(s)`);

    /* ── D: public API ─────────────────────────────────────────────────── */
    console.log("\n[D] public API (G13)");
    const site = await pub("/site");
    const sp = ((site.json.pillars as unknown as Doc[]) ?? []).map((p) => p.slug);
    const ss = ((site.json.subsections as unknown as Doc[]) ?? []).map((s) => s.slug);
    check("/site returns the 6 pillars in order", site.status === 200 && JSON.stringify(sp) === JSON.stringify(GTP_PILLARS.map((p) => p.slug)), JSON.stringify(sp));
    check("/site returns the 20 base sub-sections", ss.length === 20 && gtpSubSections().every((x) => ss.includes(x.slug)), `${ss.length}`);
    const list = await pub("/articles?limit=50");
    const slugs = ((list.json.docs as unknown as Doc[]) ?? []).map((d) => d.slug);
    check("/articles serves the published synthetic and NOT the pending one", list.status === 200 && slugs.includes(SLUG("synthetic")) && !slugs.includes(SLUG("pending")) && !slugs.includes(SLUG("a-news")), JSON.stringify(slugs));
    const f1 = await pub("/articles?pillar=news");
    check("?pillar=news", ((f1.json.docs as unknown as Doc[]) ?? []).some((d) => d.slug === SLUG("synthetic")), `${String(f1.json.totalDocs)}`);
    const f2 = await pub("/articles?pillar=news&subsection=visa-entry");
    check("?pillar=news&subsection=visa-entry", ((f2.json.docs as unknown as Doc[]) ?? []).map((d) => d.slug).join() === SLUG("synthetic"), `${String(f2.json.totalDocs)}`);
    const f2b = await pub("/articles?pillar=news&subsection=aviation");
    check("?pillar=news&subsection=aviation excludes it", ((f2b.json.docs as unknown as Doc[]) ?? []).length === 0, `${String(f2b.json.totalDocs)}`);
    const f3 = await pub(`/articles?tag=${encodeURIComponent(tagLabel)}`);
    check("?tag=<probe tag>", ((f3.json.docs as unknown as Doc[]) ?? []).map((d) => d.slug).join() === SLUG("synthetic"), `${String(f3.json.totalDocs)}`);
    const f4 = await pub("/articles?flag=sponsored");
    check("?flag=sponsored", ((f4.json.docs as unknown as Doc[]) ?? []).map((d) => d.slug).join() === SLUG("synthetic"), `${String(f4.json.totalDocs)}`);
    const one = await pub(`/articles/${SLUG("synthetic")}`);
    const body = (one.json.doc as unknown as Doc | undefined)?.body as { root?: { children?: unknown[] } } | undefined;
    check("/articles/{slug} returns a Lexical body", one.status === 200 && Array.isArray(body?.root?.children), `${one.status}`);
    const pendingOne = await pub(`/articles/${SLUG("pending")}`);
    check("/articles/{pending slug} -> 404", pendingOne.status === 404, `${pendingOne.status}`);
    const nl = await pub("/newsletters");
    const nls = (((nl.json.data as Record<string, unknown>)?.newsletters as unknown as Doc[]) ?? []).map((n) => n.slug);
    check("/newsletters returns the 2 rows", nl.status === 200 && JSON.stringify(nls) === JSON.stringify(["the-post", "business-of-travel-weekly"]), JSON.stringify(nls));
    const menus = await pub("/menus");
    check("/menus -> 200", menus.status === 200, `shape keys: ${Object.keys(menus.json).join(",")}; menus=${JSON.stringify(menus.json.menus)}`);
    const refs = await pub("/articles?view=refs&limit=50");
    const ref = ((refs.json.docs as unknown as Doc[]) ?? []).find((d) => d.slug === SLUG("synthetic"));
    check("view=refs returns slug + dates only", !!ref && Object.keys(ref).every((k) => ["id", "slug", "updatedAt", "publishedAt"].includes(k)), ref ? Object.keys(ref).join(",") : "missing");

    /* ── G: Lexical node matrix ────────────────────────────────────────── */
    console.log("\n[G] Lexical node matrix (G16)");
    const stored = ((await payload.findByID({ collection: "articles" as never, id: synthId, depth: 0, overrideAccess: true })) as unknown as Doc).body as {
      root: { children: Array<Record<string, unknown>> };
    };
    const textOf = (n: Record<string, unknown>): string =>
      typeof n.text === "string" ? n.text : ((n.children as Record<string, unknown>[] | undefined) ?? []).map(textOf).join("");
    const nested = (n: Record<string, unknown>): string[] => {
      const kids = (n.children as Record<string, unknown>[] | undefined) ?? [];
      return kids.flatMap((k) => [String(k.type) + (k.tag ? `:${String(k.tag)}` : k.listType ? `:${String(k.listType)}` : ""), ...nested(k)]);
    };
    for (const n of stored.root.children) {
      const t = textOf(n);
      const flag = /\|---|!\[/.test(t) ? "  <-- raw Markdown left in text" : "";
      const label = String(n.type) + (n.tag ? `:${String(n.tag)}` : n.listType ? `:${String(n.listType)}` : "");
      console.log(`  NODE  ${label.padEnd(16)} nested=[${[...new Set(nested(n))].join(",")}] text=${JSON.stringify(t.slice(0, 70))}${flag}`);
    }
    const types = new Set(stored.root.children.map((n) => String(n.type)));
    const all = new Set(stored.root.children.flatMap((n) => [String(n.type), ...nested(n).map((x) => x.split(":")[0]!)]));
    info(`matrix: table=${types.has("table") ? "node" : "LOST"}; quote=${types.has("quote") ? "node" : "LOST"}; list=${types.has("list") ? "node" : "LOST"}; image/upload=${all.has("upload") ? "node" : "LOST"}; link=${all.has("link") || all.has("autolink") ? "node" : "LOST"}; heading=${types.has("heading") ? "node" : "LOST"}; horizontalrule=${types.has("horizontalrule") ? "node" : "LOST"}`);
    check("Lexical matrix printed (decision recorded in the phase report)", stored.root.children.length > 0, `${stored.root.children.length} top-level nodes`);

    /* ── H: import-target facts ────────────────────────────────────────── */
    console.log("\n[H] import-target facts (G19)");
    const ictx = { context: { disableRevalidate: true, skipTranslationEnqueue: true } };
    const plain = (await pCreate(payload, "articles", { tenant: tenantId, title: `GTP probe ${RUN} h-default`, slug: SLUG("h-default"), pillar: pillar("news"), author: priya?.id, workflowStatus: "draft" }, ictx)) as unknown as Doc;
    cleanup.articles.add(String(plain.id));
    info(`Local API create with no editedByHuman -> editedByHuman=${String(plain.editedByHuman)} (code default true, Articles.ts:439-443)`);
    check("recorded: Local API default editedByHuman", typeof plain.editedByHuman === "boolean", String(plain.editedByHuman));
    if (a1.status === 201) {
      const e = (await payload.findByID({ collection: "articles" as never, id: a1.json.id as Id, depth: 0, overrideAccess: true })) as unknown as Doc;
      check("engine create stamps editedByHuman=false", e.editedByHuman === false, String(e.editedByHuman));
    }
    const legacy = { createdAt: "2020-01-02T03:04:05.000Z", updatedAt: "2020-02-03T04:05:06.000Z", publishedAt: "2020-01-01T00:00:00.000Z" };
    const imp = (await pCreate(
      payload,
      "articles",
      {
        tenant: tenantId,
        title: `GTP probe ${RUN} h-import`,
        slug: SLUG("h-import"),
        pillar: pillar("news"),
        author: priya?.id,
        ...legacy,
        origin: "import",
        editedByHuman: true,
        engineSourceUrl: URL_("h-import"),
        _status: "published",
        workflowStatus: "published",
      },
      { ...ictx, draft: false },
    )) as unknown as Doc;
    cleanup.articles.add(String(imp.id));
    const impRead = (await payload.findByID({ collection: "articles" as never, id: imp.id, depth: 0, overrideAccess: true })) as unknown as Doc;
    const keep = (k: keyof typeof legacy) => (new Date(String(impRead[k])).toISOString() === legacy[k] ? "PRESERVED" : `NOT preserved (${String(impRead[k])})`);
    info(`import create: createdAt ${keep("createdAt")}; updatedAt ${keep("updatedAt")}; publishedAt ${keep("publishedAt")}; editedByHuman=${String(impRead.editedByHuman)}; version=${String(impRead.version)}; origin=${String(impRead.origin)}`);
    check("recorded: import timestamps / editedByHuman / version", impRead.editedByHuman === true, `editedByHuman=${String(impRead.editedByHuman)}`);
    const h409 = await intake(baseArticle("h-import-refresh", { sourceProvenance: { url: URL_("h-import"), name: "GTP probe" } }));
    check("engine POST with the import's source URL -> 409 human_edited_content_not_overwritten", h409.status === 409 && h409.json.reason === "human_edited_content_not_overwritten", `${h409.status} ${String(h409.json.reason)}`);
    const hr1 = await intake(baseArticle("h-refresh"));
    const hr2 = await intake(baseArticle("h-refresh", { title: `GTP probe ${RUN} h-refresh REFRESHED` }));
    const hrDoc = hr1.status === 201 ? ((await payload.findByID({ collection: "articles" as never, id: hr1.json.id as Id, depth: 0, overrideAccess: true })) as unknown as Doc) : undefined;
    check("same POST against editedByHuman:false REFRESHES (title overwritten)", hr2.status === 200 && hr2.json.status === "refreshed" && hrDoc?.title === `GTP probe ${RUN} h-refresh REFRESHED`, `${hr2.status} ${String(hr2.json.status)} title=${String(hrDoc?.title)}`);
    const arch = (await pCreate(
      payload,
      "articles",
      { tenant: tenantId, title: `GTP probe ${RUN} h-archived`, slug: SLUG("h-archived"), pillar: pillar("news"), author: priya?.id, _status: "published", workflowStatus: "archived" },
      { ...ictx, draft: false },
    )) as unknown as Doc;
    cleanup.articles.add(String(arch.id));
    const archOne = await pub(`/articles/${SLUG("h-archived")}`);
    const archList = await pub("/articles?limit=50");
    check(
      "archived row (draft:false, workflowStatus archived) is NOT served",
      archOne.status === 404 && !((archList.json.docs as unknown as Doc[]) ?? []).some((d) => d.slug === SLUG("h-archived")),
      `detail ${archOne.status}`,
    );
  } finally {
    console.log("\n[cleanup]");
    try {
      await pUpdate(payload, "tenants", tenantId, { frontendUrl: originalFrontendUrl }, { context: { disableRevalidate: true } });
    } catch (err) {
      console.log(`  (cleanup) frontendUrl restore failed: ${errText(err)}`);
    }
    const ids = [...cleanup.articles];
    try {
      const jobs = (await pFind(payload, "translationJobs", { where: { article: { in: ids } }, limit: 500 })).docs as unknown as Doc[];
      for (const j of jobs) await pDelete(payload, "translationJobs", j.id);
    } catch {
      /* no translation jobs */
    }
    for (const id of ids) await pDelete(payload, "articles", id, { context: { disableRevalidate: true } }).catch((e) => console.log(`  (cleanup) article ${id}: ${errText(e)}`));
    for (const id of cleanup.subsections) await pDelete(payload, "subsections", id, { context: { disableRevalidate: true } }).catch(() => undefined);
    for (const id of cleanup.tags) await pDelete(payload, "tags", id, { context: { disableRevalidate: true } }).catch((e) => console.log(`  (cleanup) tag ${id}: ${errText(e)}`));
    for (const id of cleanup.authors) await pDelete(payload, "authors", id, { context: { disableRevalidate: true } }).catch((e) => console.log(`  (cleanup) author ${id}: ${errText(e)}`));
    for (const id of cleanup.subscribers) await pDelete(payload, "subscribers", id).catch((e) => console.log(`  (cleanup) subscriber ${id}: ${errText(e)}`));
    for (const id of cleanup.media) await pDelete(payload, "media", id).catch((e) => console.log(`  (cleanup) media ${id}: ${errText(e)}`));
    if (engine && engineTouched) await pUpdate(payload, "content-engines", engine.id, { allowedTenants: engineTenantsBefore }).catch(() => undefined);
    const left = (await pFind(payload, "articles", { where: { slug: { like: `zz-gtp-probe-${RUN}` } }, limit: 50 })).docs.length;
    console.log(`  removed ${ids.length} article(s), ${cleanup.tags.size} tag(s), ${cleanup.authors.size} ghost author(s), ${cleanup.subscribers.size} subscriber(s), ${cleanup.media.size} media; left behind: ${left} probe article(s)`);
    server.close();
  }

  console.log(`\n[gtp-probe] ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("[gtp-probe] crashed:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
