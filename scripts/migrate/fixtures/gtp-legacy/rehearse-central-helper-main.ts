/**
 * Implementation of rehearse-central-helper.ts (LOCAL ONLY; see that file).
 * Actions create/inspect fixture state in the LOCAL Central DB for the rehearsal.
 */
import sharp from "sharp";
import { getPayload } from "payload";
import { editorConfigFactory } from "@payloadcms/richtext-lexical";
import config from "../../../../payload.config";
import { pCreate, pDelete, pFind, pUpdate } from "../../../lib/payload-loose";
import { assertLocalDb } from "../../../lib/local-db-guard";
import { htmlToLexical, nodeTypes, blocks } from "../../lib/lexical-body";

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };

async function one(payload: P, collection: string, where: Doc, draft = true): Promise<Doc | undefined> {
  return ((await pFind(payload, collection, { where, limit: 1, ...(draft ? { draft: true } : {}) })) as unknown as { docs: Doc[] }).docs[0];
}
async function count(payload: P, collection: string, where: Doc, draft = false): Promise<number> {
  return ((await pFind(payload, collection, { where, limit: 0, ...(draft ? { draft: true } : {}) })) as unknown as { totalDocs: number }).totalDocs;
}
async function tenantId(payload: P, slug: string): Promise<number | string | undefined> {
  return (await one(payload, "tenants", { slug: { equals: slug } }, false))?.id as number | string | undefined;
}
async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();
}
function result(x: unknown): void {
  console.log(`RESULT ${JSON.stringify(x)}`);
}

async function main(): Promise<void> {
  assertLocalDb(process.env.DATABASE_URL);
  const [action, rawArgs] = process.argv.slice(2);
  const args = (rawArgs ? JSON.parse(rawArgs) : {}) as Record<string, string>;
  const payload = await getPayload({ config });
  const gtp = await tenantId(payload, "gtp");
  switch (action) {
    case "setup-scope": {
      // Second tenant fixture-b with the same pillar slug, tag slug, author name, media filename and one article slug.
      let fb = await tenantId(payload, "fixture-b");
      if (!fb) fb = ((await pCreate(payload, "tenants", { slug: "fixture-b", name: "[FIXTURE] Tenant B", frontendUrl: "http://localhost:3999" }, { context: ctx })) as unknown as Doc).id as number;
      const pillar = (await one(payload, "pillars", { and: [{ tenant: { equals: fb } }, { slug: { equals: "news" } }] }, false))?.id ?? ((await pCreate(payload, "pillars", { tenant: fb, slug: "news", title: "News", order: 1 }, { context: ctx, locale: "en" })) as unknown as Doc).id;
      const author = (await one(payload, "authors", { and: [{ tenant: { equals: fb } }, { name: { equals: "Daniel Cheong" } }] }, false))?.id ?? ((await pCreate(payload, "authors", { tenant: fb, name: "Daniel Cheong", slug: "daniel-cheong" }, { context: ctx })) as unknown as Doc).id;
      if (!(await one(payload, "tags", { and: [{ tenant: { equals: fb } }, { slug: { equals: "airlines" } }] }, false))) await pCreate(payload, "tags", { tenant: fb, slug: "airlines", title: "Airlines" }, { context: ctx, locale: "en" });
      if (args.mediaFilename && !(await one(payload, "media", { and: [{ tenant: { equals: fb } }, { filename: { equals: args.mediaFilename } }] }, false))) {
        const buf = await jpeg();
        await pCreate(payload, "media", { tenant: fb, alt: "fixture-b" }, { file: { data: buf, mimetype: "image/jpeg", name: args.mediaFilename, size: buf.length }, context: ctx, locale: "en" });
      }
      if (!(await one(payload, "articles", { and: [{ tenant: { equals: fb } }, { slug: { equals: args.foreignSlug } }] }))) {
        await pCreate(payload, "articles", { tenant: fb, title: "[FIXTURE] tenant-b article", slug: args.foreignSlug, workflowStatus: "published", _status: "published", pillar, author, readMin: 1, origin: "import", engineSourceName: "legacy:globaltravelpost" }, { context: ctx, draft: false, locale: "en" });
      }
      // Same-tenant MANUAL article with a legacy slug -> must produce slugConflictForeign.
      const gNews = (await one(payload, "pillars", { and: [{ tenant: { equals: gtp } }, { slug: { equals: "news" } }] }, false))?.id;
      const gAuthor = (await one(payload, "authors", { and: [{ tenant: { equals: gtp } }, { name: { equals: "Daniel Cheong" } }] }, false))?.id;
      if (args.manualSlug && !(await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.manualSlug } }] }))) {
        await pCreate(payload, "articles", { tenant: gtp, title: "[FIXTURE] manual gtp article", slug: args.manualSlug, workflowStatus: "draft", pillar: gNews, author: gAuthor, readMin: 1, origin: "manual" }, { context: ctx, draft: true, locale: "en" });
      }
      return result({ fixtureB: fb });
    }
    case "fixture-b-counts": {
      const fb = await tenantId(payload, "fixture-b");
      const w = { tenant: { equals: fb } };
      const art = await one(payload, "articles", { and: [{ tenant: { equals: fb } }] });
      return result({
        articles: await count(payload, "articles", w, true), tags: await count(payload, "tags", w), authors: await count(payload, "authors", w), media: await count(payload, "media", w),
        articleUpdatedAt: art?.updatedAt ?? null, articleVersion: art?.version ?? null,
      });
    }
    case "manual-article": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }] });
      return result({ exists: Boolean(d), origin: d?.origin ?? null, version: d?.version ?? null, updatedAt: d?.updatedAt ?? null });
    }
    case "delete-manual": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }, { origin: { equals: "manual" } }] });
      if (d) await pDelete(payload, "articles", d.id as number, { context: ctx });
      return result({ deleted: Boolean(d) });
    }
    case "gtp-article": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }] });
      return result(d ? { id: d.id, tenant: typeof d.tenant === "object" ? (d.tenant as Doc).id : d.tenant, author: d.author, tags: d.tags, heroImage: d.heroImage, version: d.version, updatedAt: d.updatedAt, workflowStatus: d.workflowStatus, _status: d._status, body: d.body } : null);
    }
    case "create-adopted-media": {
      const buf = await jpeg();
      const c = (await pCreate(payload, "media", { tenant: gtp, alt: "pre-existing" }, { file: { data: buf, mimetype: "image/jpeg", name: args.filename, size: buf.length }, context: ctx, locale: "en" })) as unknown as Doc;
      return result({ id: c.id, filename: c.filename });
    }
    case "media-exists": {
      const d = await one(payload, "media", { and: [{ tenant: { equals: gtp } }, { id: { equals: args.id } }] }, false);
      return result({ exists: Boolean(d) });
    }
    case "edit-article": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }] });
      if (!d) return result({ edited: false });
      await pUpdate(payload, "articles", d.id as number, { title: `${String(d.title)} (edited)` }, { context: ctx, draft: d.workflowStatus === "draft", locale: "en" });
      const r = await one(payload, "articles", { id: { equals: d.id } });
      return result({ edited: true, version: r?.version, updatedAt: r?.updatedAt });
    }
    case "delete-article": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }] });
      if (d) await pDelete(payload, "articles", d.id as number, { context: ctx });
      return result({ deleted: Boolean(d) });
    }
    case "alter-body": {
      const d = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: args.slug } }] });
      if (!d) return result({ altered: false });
      const editorConfig = await editorConfigFactory.default({ config: payload.config });
      await pUpdate(payload, "articles", d.id as number, { body: htmlToLexical(editorConfig, "<p>Completely different text that no longer matches the source.</p>") }, { context: { ...ctx, systemWrite: true }, draft: d.workflowStatus === "draft", locale: "en" });
      return result({ altered: true });
    }
    case "read-updated": {
      const out: Record<string, unknown> = {};
      for (const slug of JSON.parse(args.slugs ?? "[]") as string[]) {
        const pub = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: slug } }] }, false);
        const dr = await one(payload, "articles", { and: [{ tenant: { equals: gtp } }, { slug: { equals: slug } }] }, true);
        out[slug] = { draftFalse: pub?.updatedAt ?? null, draftTrue: dr?.updatedAt ?? null, status: dr?.workflowStatus ?? null };
      }
      return result(out);
    }
    case "public-predicate": {
      // The public route keys on workflowStatus === "published" (src/app/api/public/articles/route.ts).
      const marker = { and: [{ tenant: { equals: gtp } }, { origin: { equals: "import" } }, { engineSourceName: { equals: "legacy:globaltravelpost" } }] };
      const visible = await count(payload, "articles", { and: [...marker.and, { workflowStatus: { equals: "published" } }] }, true);
      const archived = await count(payload, "articles", { and: [...marker.and, { workflowStatus: { equals: "archived" } }] }, true);
      const drafts = await count(payload, "articles", { and: [...marker.and, { workflowStatus: { equals: "draft" } }] }, true);
      const arch = await one(payload, "articles", { and: [...marker.and, { workflowStatus: { equals: "archived" } }] }, false);
      const archDraftRead = arch ? await one(payload, "articles", { id: { equals: arch.id } }, true) : undefined;
      const draftRow = await one(payload, "articles", { and: [...marker.and, { workflowStatus: { equals: "draft" } }] }, true);
      return result({ visible, archived, drafts, archivedStatusDraftFalse: arch?._status ?? null, archivedStatusDraftTrue: archDraftRead?._status ?? null, draftStatus: draftRow?._status ?? null });
    }
    case "f2": {
      // F2a: createdAt/updatedAt passed on a Local API create (tenant fixture-b, deleted afterwards).
      const fb = await tenantId(payload, "fixture-b");
      const pillar = (await one(payload, "pillars", { and: [{ tenant: { equals: fb } }, { slug: { equals: "news" } }] }, false))?.id;
      const author = (await one(payload, "authors", { and: [{ tenant: { equals: fb } }] }, false))?.id;
      const c = (await pCreate(payload, "articles", { tenant: fb, title: "[FIXTURE] f2a", slug: "f2a-probe", workflowStatus: "published", _status: "published", pillar, author, readMin: 1, createdAt: "2020-01-02T03:04:05.000Z", updatedAt: "2020-02-03T04:05:06.000Z", publishedAt: "2020-01-01T00:00:00.000Z" }, { context: ctx, draft: false, locale: "en" })) as unknown as Doc;
      const rb = await one(payload, "articles", { id: { equals: c.id } });
      await pDelete(payload, "articles", c.id as number, { context: ctx });
      // F2c: table and blockquote with a cite through the HTML -> Lexical path.
      const editorConfig = await editorConfigFactory.default({ config: payload.config });
      const html = "<table><tr><td>Country</td><td>Days</td></tr><tr><td>Japan</td><td>90</td></tr></table><blockquote><p>Quote text</p><cite>Someone</cite></blockquote>";
      const lx = htmlToLexical(editorConfig, html);
      return result({
        f2a: { createdAtPreserved: rb?.createdAt === "2020-01-02T03:04:05.000Z", updatedAtPreserved: rb?.updatedAt === "2020-02-03T04:05:06.000Z", createdAt: rb?.createdAt, updatedAt: rb?.updatedAt },
        f2c: { nodeTypes: [...nodeTypes(lx)], blocks: blocks(lx) },
      });
    }
    default:
      throw new Error(`rehearse-helper: unknown action ${String(action)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[rehearse-helper] ${(err as Error).message}`);
    process.exit(1);
  });
