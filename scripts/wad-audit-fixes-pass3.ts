/**
 * WAD audit 26/08 — pass 3: junk deks the length filter missed (audit item
 * 21). A dek that is just the project/brand name restated from the title is
 * legacy-field spillover, not a standfirst: cleared when the normalised title
 * contains the normalised dek and the dek is short.
 *
 *   npx tsx scripts/wad-audit-fixes-pass3.ts           # analyze
 *   npx tsx scripts/wad-audit-fixes-pass3.ts --apply
 */
import "./lib/env";
import { getPayload } from "payload";
import { sql } from "drizzle-orm";
import config from "../payload.config";

const APPLY = process.argv.includes("--apply");
const ctx = { disableRevalidate: true };

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function main() {
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number };
  console.log(`[pass3] tenant wad = ${tenant.id} · mode: ${APPLY ? "APPLY" : "ANALYZE"}`);

  let cleared = 0;
  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 100,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as { id: number; title?: string; dek?: string | null };
      const dek = (a.dek ?? "").trim();
      if (!dek || dek.length >= 60) continue;
      const nDek = norm(dek);
      if (!nDek || !norm(a.title ?? "").includes(nDek)) continue;
      cleared += 1;
      console.log(`[pass3] #${a.id} clear dek ${JSON.stringify(dek)} (title: "${(a.title ?? "").slice(0, 50)}")`);
      if (APPLY) {
        await payload.update({
          collection: "articles",
          id: a.id,
          data: { dek: "" } as never,
          locale: "en",
          context: ctx,
          overrideAccess: true,
        });
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log(`\n[pass3] deks cleared: ${cleared}`);
  if (APPLY && cleared > 0) {
    const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle;
    await db.execute(
      sql`UPDATE articles SET updated_at = published_at WHERE tenant_id = ${tenant.id} AND published_at IS NOT NULL`,
    );
    console.log(`[pass3] lastmod re-synced`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
