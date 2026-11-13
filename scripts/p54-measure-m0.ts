/**
 * p54-measure-m0.ts — APCGHub P5.4, step 1.0 (+ contract E5). LOCAL DISPOSABLE POSTGRES ONLY.
 *
 * One-shot measurements taken BEFORE the live-edit core is written:
 *
 *   M0  — `findByID({ draft: true, select: HUB_ARTICLE_EDIT_SELECT })` on a hub article
 *         that was just published: does the answer carry `_status`? (and without `select`)
 *   P1  — after the hub publish write (the exact data + context of the publish core:
 *         non-draft update `{_status, workflowStatus, publishedAt}` with `context.hubWrite`):
 *         main `_status` / `workflowStatus` / `version`, latest `_status` / `version`, and the
 *         `updatedAt` of the main row vs the newest `_articles_v` row (recorded, not decided).
 *   M0b — inside ONE transaction that holds
 *         `SELECT 1 FROM articles WHERE id = $1 FOR NO KEY UPDATE` (run on the transaction's
 *         own session, `payload.db.sessions[String(req.transactionID)].db` — the way the
 *         live core's `lockRow` will), a Save-Draft `payload.update({ draft: true })`
 *         WITHOUT `req` (a second connection) on that published article must finish in
 *         < 3 s, leave `articles` untouched (same `updated_at`) and add one `_articles_v`
 *         row. The transaction is rolled back afterwards (it wrote nothing).
 *
 *   npx tsx scripts/p54-measure-m0.ts [--out <file>]
 *
 * Guards BEFORE anything connects: `assertLocalDb` (exit 2) and any non-empty R2_* (exit 2).
 * Creates its own rows (author + article on `gcv`); prints no secret.
 */

import "./lib/env";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

try {
  assertLocalDb(process.env.DATABASE_URL);
} catch (err) {
  if (err instanceof LocalDbGuardError) {
    console.error(`[p54-m0] refusing: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
const R2_SET = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_BASE_URL"].filter(
  (n) => (process.env[n] ?? "").trim() !== "",
);
if (R2_SET.length > 0) {
  console.error(`[p54-m0] refusing: R2 storage env must be unset (set: ${R2_SET.join(", ")})`);
  process.exit(2);
}

type Doc = Record<string, unknown>;

const text = (t: string) => ({ type: "text", version: 1, text: t, format: 0, detail: 0, mode: "normal", style: "" });
const para = (t: string) => ({ type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, textFormat: 0, textStyle: "", children: [text(t)] });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const out = arg("out");
  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: config } = await import("../payload.config");
  const { HUB_ARTICLE_EDIT_SELECT } = await import("../src/lib/hub-article-edit-select");
  const { withHubArticleLock } = await import("../src/lib/hub-article-lock");
  const payload = await getPayload({ config });
  const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows?: Doc[] }> } }).drizzle;
  const rows = async (q: unknown) => (await db.execute(q)).rows ?? [];

  const tenant = (await payload.find({ collection: "tenants", where: { slug: { equals: "gcv" } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined;
  if (!tenant) throw new Error("tenant gcv missing — run `npm run db:seed` first");
  const tenantId = tenant.id as number;
  const pillar = (await payload.find({ collection: "pillars", where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: "trends-inspiration" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined;
  if (!pillar) throw new Error("gcv pillar trends-inspiration missing");
  const stamp = `${Date.now()}${randomBytes(3).toString("hex")}`;
  const author = (await payload.create({ collection: "authors", overrideAccess: true, data: { tenant: tenantId, slug: `p54-m0-author-${stamp}`, name: "P54 M0" } as never })) as unknown as Doc;
  const engine = (await payload.create({
    collection: "content-engines", overrideAccess: true,
    data: { name: `p54-m0-author-${stamp}`, engineType: "other", allowedActions: ["import"], rawToken: randomBytes(24).toString("hex"), status: "active", hubRead: true, hubAuthor: true, hubWrite: false, allowedTenants: [tenantId] } as never,
  })) as unknown as Doc;

  // A hub-authored draft (the create of the hub author route, draft: true).
  const created = (await payload.create({
    collection: "articles", overrideAccess: true, locale: "en", draft: true,
    context: { hubAuthor: { actor: { email: "p54-m0@example.invalid", role: "editor" }, action: "create" }, engineId: engine.id, disableRevalidate: true },
    data: {
      tenant: tenantId, _status: "draft", workflowStatus: "draft", origin: "manual", editedByHuman: true, contentType: "article", sourceLanguage: "en",
      lastEngine: engine.id, title: `P54 M0 ${stamp}`, slug: `p54-m0-${stamp}`, readMin: 3, pillar: pillar.id, author: author.id,
      body: { root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [para("P5.4 M0 body.")] } },
    } as never,
  })) as unknown as Doc;
  const id = created.id as number;

  // The hub publish write (hub-author-publish-core.ts step 9, op "publish").
  await payload.update({
    collection: "articles", id, overrideAccess: true, depth: 0,
    data: { _status: "published", workflowStatus: "published", publishedAt: new Date().toISOString() } as never,
    context: { hubWrite: { actor: { email: "p54-m0@example.invalid", role: "editor" }, reason: "hub composer publish" }, engineId: engine.id, disableRevalidate: true },
  });

  const main = (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc;
  const latestSel = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, disableErrors: true, select: HUB_ARTICLE_EDIT_SELECT })) as unknown as Doc;
  const latestAll = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc;
  const mainRow = (await rows(sql`SELECT updated_at, version, _status, workflow_status FROM articles WHERE id = ${id}`))[0] ?? {};
  const verRow = (await rows(sql`SELECT updated_at, version_version, version__status, latest FROM _articles_v WHERE parent_id = ${id} ORDER BY updated_at DESC, id DESC LIMIT 1`))[0] ?? {};

  const m0 = {
    selectHasStatusKey: Object.prototype.hasOwnProperty.call(latestSel, "_status"),
    selectStatus: latestSel._status ?? null,
    noSelectStatus: latestAll._status ?? null,
  };
  const p1 = {
    mainStatus: main._status, mainWorkflow: main.workflowStatus, mainVersion: main.version,
    latestStatus: latestAll._status, latestVersion: latestAll.version, latestWorkflow: latestAll.workflowStatus,
    latestEqualsMain: latestAll._status === "published" && latestAll.version === main.version,
    updatedAtMainRow: mainRow.updated_at, updatedAtNewestVersionRow: verRow.updated_at, newestVersionRowLatestFlag: verRow.latest,
  };

  // M0b — the Save-Draft under a FOR NO KEY UPDATE row lock held by another transaction.
  const vCount = async () => Number((await rows(sql`SELECT count(*)::int AS n FROM _articles_v WHERE parent_id = ${id}`))[0]?.n);
  const before = (await rows(sql`SELECT updated_at, title_check FROM (SELECT a.updated_at, (SELECT title FROM articles_locales l WHERE l._parent_id = a.id AND l._locale = 'en') AS title_check FROM articles a WHERE a.id = ${id}) s`))[0] ?? {};
  const v0 = await vCount();
  const m0b: Doc = {};
  const res = await withHubArticleLock({ tenantId, articleId: id }, async (lk) => {
    const adapter = payload.db as unknown as { sessions?: Record<string, { db?: { execute: (q: unknown) => Promise<unknown> } } | undefined> };
    const exec = adapter.sessions?.[String(lk.req?.transactionID)]?.db;
    if (!exec) throw new Error("M0b: no transaction session");
    await exec.execute(sql`SELECT 1 FROM articles WHERE id = ${id} FOR NO KEY UPDATE`);
    m0b.rowLockTaken = true;
    const t0 = Date.now();
    try {
      await Promise.race([
        payload.update({ collection: "articles", id, draft: true, overrideAccess: true, depth: 0, locale: "en", context: { disableRevalidate: true }, data: { title: `P54 M0b slipped draft ${stamp}` } as never }),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("M0b timeout 10s"), { name: "M0bTimeout" })), 10_000)),
      ]);
      m0b.saveDraft = "ok";
    } catch (e) {
      m0b.saveDraft = { name: (e as Error).name, code: (e as { code?: string }).code ?? null };
    }
    m0b.ms = Date.now() - t0;
    return { ok: false, value: new Response(null, { status: 204 }) };
  });
  const after = (await rows(sql`SELECT updated_at, title_check FROM (SELECT a.updated_at, (SELECT title FROM articles_locales l WHERE l._parent_id = a.id AND l._locale = 'en') AS title_check FROM articles a WHERE a.id = ${id}) s`))[0] ?? {};
  const v1 = await vCount();
  const latestAfter = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc;
  m0b.lockHelperStatus = res.status;
  m0b.under3s = typeof m0b.ms === "number" && (m0b.ms as number) < 3000;
  m0b.articlesUpdatedAtSame = String(before.updated_at) === String(after.updated_at);
  m0b.articlesTitleSame = before.title_check === after.title_check;
  m0b.articlesVersionsDelta = v1 - v0;
  m0b.latestStatusAfter = latestAfter._status;
  m0b.pass = m0b.saveDraft === "ok" && m0b.under3s === true && m0b.articlesUpdatedAtSame === true && m0b.articlesTitleSame === true && m0b.articlesVersionsDelta === 1;

  const result = { articleId: id, tenant: "gcv", m0, p1, m0b };
  if (out) writeFileSync(out, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`[p54-m0] ${JSON.stringify(result)}`);
  process.exit(m0b.pass ? 0 : 3);
}

main().catch((err) => {
  console.error("[p54-m0] failed", (err as Error).name, (err as Error).message);
  process.exit(1);
});
