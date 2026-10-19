/**
 * p53-baseline-fixture.ts — APCGHub P5.3, Phase 0 step 0.1. LOCAL DISPOSABLE POSTGRES ONLY.
 *
 * Creates ONE published `dtw` article whose body holds a real Lexical `upload` node
 * (relationTo "media") plus a hero image, through the Payload Local API, and prints
 * its id. The default (no `view`) response of `GET /api/hub/articles/{id}?tenant=dtw`
 * for that row is captured BEFORE any P5.3 code change and compared (sha256, with
 * `updatedAt` removed) after steps 1.8 and 2.2 to prove the default read stays
 * byte-identical.
 *
 *   npx tsx scripts/p53-baseline-fixture.ts [--out <file>]
 *
 * `assertLocalDb` (scripts/lib/local-db-guard.ts) runs BEFORE anything connects; a
 * non-local DATABASE_URL (incl. `?host=` tricks) is refused with exit 2.
 * Writes no token, prints no secret. Never run against a deployed database.
 */

import "./lib/env";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

try {
  assertLocalDb(process.env.DATABASE_URL);
} catch (err) {
  if (err instanceof LocalDbGuardError) {
    console.error(`[p53-fixture] refusing: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

// Review M2: never reach the real R2 bucket (payload.config.ts enables storage-s3
// when the R2_* credentials are set; scripts/lib/env.ts may load them from .env.local).
const R2_SET = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_BASE_URL"].filter(
  (n) => (process.env[n] ?? "").trim() !== "",
);
if (R2_SET.length > 0) {
  console.error(`[p53-fixture] refusing: R2 storage env must be unset for a local fixture (set: ${R2_SET.join(", ")})`);
  process.exit(2);
}

// 1×1 PNG (same bytes as the CMS-4 probe fixture).
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

async function main() {
  const out = (() => {
    const i = process.argv.indexOf("--out");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
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
    data: { tenant: tenant.id, slug: `p53-base-author-${stamp}`, name: "P5.3 Baseline Author" } as never,
  })) as unknown as { id: number };
  const media = (await payload.create({
    collection: "media", overrideAccess: true, locale: "en",
    data: { tenant: tenant.id, alt: "p53 baseline alt", caption: "p53 caption", credit: "p53 credit" } as never,
    file: { data: PNG_1X1, mimetype: "image/png", name: `p53-base-${stamp}.png`, size: PNG_1X1.length },
  })) as unknown as { id: number };
  const body = {
    root: {
      type: "root", version: 1, direction: "ltr", format: "", indent: 0,
      children: [para(text("P5.3 baseline paragraph before the image.")), upload(media.id), para(text("After the image."))],
    },
  };
  const article = (await payload.create({
    collection: "articles", overrideAccess: true, locale: "en", draft: true,
    data: {
      tenant: tenant.id, title: `P53 baseline ${stamp}`, slug: `p53-baseline-${stamp}`, pillar: pillar.id, author: author.id,
      workflowStatus: "published", publishedAt: "2026-10-01T00:00:00.000Z", dek: "p53 dek", body, heroImage: media.id,
    } as never,
  })) as unknown as { id: number };

  const result = { tenant: "dtw", articleId: article.id, mediaId: media.id };
  if (out) writeFileSync(out, JSON.stringify(result), { mode: 0o600 });
  console.log(`[p53-fixture] ${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[p53-fixture] failed", err);
  process.exit(1);
});
