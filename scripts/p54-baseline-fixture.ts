/**
 * p54-baseline-fixture.ts — APCGHub P5.4, Phase 0 step 0.1. LOCAL DISPOSABLE POSTGRES ONLY.
 *
 * Creates, through the Payload Local API, the rows whose `GET /api/hub/articles/{id}`
 * responses are captured BEFORE any P5.4 code change and compared (sha256, `updatedAt`
 * removed) after the CMS steps, to prove the default read and the `view=edit` answer of a
 * hub DRAFT stay byte-identical:
 *   - `published`: one published manual `dtw` article with a hero + a body `upload` node;
 *   - `hubDraft`:  one hub-authored manual DRAFT (`lastEngine` = the given author engine).
 *
 *   npx tsx scripts/p54-baseline-fixture.ts --author-engine <id> [--out <file>]
 *
 * `assertLocalDb` (scripts/lib/local-db-guard.ts) runs BEFORE anything connects; a
 * non-local DATABASE_URL (incl. `?host=` tricks) is refused with exit 2; any non-empty
 * R2_* variable is refused with exit 2. Writes no token, prints no secret.
 */

import "./lib/env";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

try {
  assertLocalDb(process.env.DATABASE_URL);
} catch (err) {
  if (err instanceof LocalDbGuardError) {
    console.error(`[p54-fixture] refusing: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const R2_SET = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_BASE_URL"].filter(
  (n) => (process.env[n] ?? "").trim() !== "",
);
if (R2_SET.length > 0) {
  console.error(`[p54-fixture] refusing: R2 storage env must be unset for a local fixture (set: ${R2_SET.join(", ")})`);
  process.exit(2);
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const text = (t: string) => ({ type: "text", version: 1, text: t, format: 0, detail: 0, mode: "normal", style: "" });
const para = (...children: unknown[]) => ({
  type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, textFormat: 0, textStyle: "", children,
});
const upload = (value: number) => ({
  type: "upload", version: 3, format: "", id: randomBytes(6).toString("hex"), fields: null, relationTo: "media", value,
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const out = arg("out");
  const authorEngine = Number(arg("author-engine"));
  if (!Number.isInteger(authorEngine) || authorEngine < 1) {
    console.error("usage: npx tsx scripts/p54-baseline-fixture.ts --author-engine <id> [--out <file>]");
    process.exit(2);
  }
  const { getPayload } = await import("payload");
  const { default: config } = await import("../payload.config");
  const payload = await getPayload({ config });

  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "dtw" } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as { id: number } | undefined;
  if (!tenant) throw new Error("tenant dtw missing — run `npm run db:seed` first");
  const pillar = (
    await payload.find({ collection: "pillars", where: { tenant: { equals: tenant.id } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as { id: number } | undefined;
  if (!pillar) throw new Error("dtw has no pillar");
  const stamp = `${Date.now()}${randomBytes(3).toString("hex")}`;
  const author = (await payload.create({
    collection: "authors", overrideAccess: true,
    data: { tenant: tenant.id, slug: `p54-base-author-${stamp}`, name: "P5.4 Baseline Author" } as never,
  })) as unknown as { id: number };
  const media = (await payload.create({
    collection: "media", overrideAccess: true, locale: "en",
    data: { tenant: tenant.id, alt: "p54 baseline alt", caption: "p54 caption", credit: "p54 credit" } as never,
    file: { data: PNG_1X1, mimetype: "image/png", name: `p54-base-${stamp}.png`, size: PNG_1X1.length },
  })) as unknown as { id: number };
  const body = {
    root: {
      type: "root", version: 1, direction: "ltr", format: "", indent: 0,
      children: [para(text("P5.4 baseline paragraph before the image.")), upload(media.id), para(text("After the image."))],
    },
  };
  const published = (await payload.create({
    collection: "articles", overrideAccess: true, locale: "en", context: { disableRevalidate: true },
    data: {
      tenant: tenant.id, title: `P54 baseline published ${stamp}`, slug: `p54-baseline-pub-${stamp}`, pillar: pillar.id, author: author.id,
      origin: "manual", _status: "published", workflowStatus: "published", publishedAt: "2026-10-01T00:00:00.000Z", dek: "p54 dek", body, heroImage: media.id,
    } as never,
  })) as unknown as { id: number };
  const hubDraft = (await payload.create({
    collection: "articles", overrideAccess: true, locale: "en", draft: true,
    context: { disableRevalidate: true, hubAuthor: { actor: { email: "p54@example.invalid", role: "editor" }, action: "create" }, engineId: authorEngine },
    data: {
      tenant: tenant.id, title: `P54 baseline hub draft ${stamp}`, slug: `p54-baseline-draft-${stamp}`, pillar: pillar.id, author: author.id,
      origin: "manual", _status: "draft", workflowStatus: "draft", editedByHuman: true, lastEngine: authorEngine, dek: "p54 draft dek", body, heroImage: media.id,
    } as never,
  })) as unknown as { id: number };

  const result = { tenant: "dtw", publishedId: published.id, hubDraftId: hubDraft.id, mediaId: media.id };
  if (out) writeFileSync(out, JSON.stringify(result), { mode: 0o600 });
  console.log(`[p54-fixture] ${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[p54-fixture] failed", err);
  process.exit(1);
});
