/**
 * WAD audit item 5 acceptance: with /stories gone, EVERY article must sit on a
 * desk that the nav actually links to, or it is unreachable by a reader.
 * Read-only: counts articles per pillar for tenant wad and flags any article
 * whose pillar is missing or is not one of the eight navigable desks.
 *
 *   npx tsx scripts/wad-orphan-check.ts
 */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

/** The eight desks the WAD reader nav renders (src/lib/data.ts PILLARS). */
const NAV_DESKS = [
  "trending-stories",
  "competition",
  "journal",
  "home-inspiration",
  "series",
  "opinions",
  "pressroom",
  "video",
];

async function main() {
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number };

  const pillars = (
    await payload.find({ collection: "pillars", where: { tenant: { equals: tenant.id } }, limit: 200, depth: 0, overrideAccess: true })
  ).docs as Array<{ id: number; slug: string; title?: string }>;
  const slugOf = new Map<number, string>(pillars.map((p) => [p.id, p.slug]));

  const perPillar = new Map<string, number>();
  const orphans: Array<{ id: number; title: string; pillar: string }> = [];
  let total = 0;

  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 200,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as { id: number; title?: string; pillar?: number | { id: number } | null };
      total += 1;
      const pid = typeof a.pillar === "object" && a.pillar ? a.pillar.id : (a.pillar as number | null);
      const slug = pid != null ? slugOf.get(pid) : undefined;
      const key = slug ?? (pid == null ? "(no pillar)" : `(unknown pillar #${pid})`);
      perPillar.set(key, (perPillar.get(key) ?? 0) + 1);
      if (!slug || !NAV_DESKS.includes(slug)) {
        orphans.push({ id: a.id, title: (a.title ?? "").slice(0, 60), pillar: key });
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log(`\n[orphan-check] tenant wad — ${total} articles total\n`);
  console.log("per pillar:");
  let navTotal = 0;
  for (const [slug, n] of [...perPillar.entries()].sort((a, b) => b[1] - a[1])) {
    const nav = NAV_DESKS.includes(slug);
    if (nav) navTotal += n;
    console.log(`  ${nav ? " " : "!"} ${slug.padEnd(22)} ${n}`);
  }
  console.log(`\nreachable from nav : ${navTotal}`);
  console.log(`NOT reachable      : ${total - navTotal}`);

  if (orphans.length > 0) {
    console.log(`\n[orphan-check] ${orphans.length} article(s) unreachable:`);
    for (const o of orphans.slice(0, 40)) console.log(`   #${o.id} [${o.pillar}] ${o.title}`);
    if (orphans.length > 40) console.log(`   … +${orphans.length - 40} more`);
  } else {
    console.log(`\n[orphan-check] PASS — every article sits on a navigable desk.`);
  }

  // Also list pillars that exist but carry no articles (empty desks).
  const empty = pillars.filter((p) => !perPillar.has(p.slug));
  if (empty.length) console.log(`\npillars with 0 articles: ${empty.map((p) => p.slug).join(", ")}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
