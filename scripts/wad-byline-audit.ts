/** Read-only: which bylines do WAD articles carry, and how recent are they? */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number };

  const authors = (
    await payload.find({ collection: "authors", where: { tenant: { equals: tenant.id } }, limit: 200, depth: 0, overrideAccess: true })
  ).docs as Array<{ id: number; name?: string }>;
  const nameOf = new Map<number, string>(authors.map((a) => [a.id, a.name ?? `#${a.id}`]));

  const counts = new Map<string, { n: number; newest: string }>();
  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "-createdAt",
      page,
      limit: 200,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as { author?: number | { id: number } | null; createdAt?: string };
      const aid = typeof a.author === "object" && a.author ? a.author.id : (a.author as number | null);
      const name = aid != null ? (nameOf.get(aid) ?? `(unknown #${aid})`) : "(no author)";
      const cur = counts.get(name);
      const created = (a.createdAt ?? "").slice(0, 10);
      if (!cur) counts.set(name, { n: 1, newest: created });
      else cur.n += 1;
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log("\nbyline                              count   newest article created");
  for (const [name, v] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${name.padEnd(34)} ${String(v.n).padStart(5)}   ${v.newest}`);
  }
  console.log(`\nauthors row in CMS: ${authors.map((a) => a.name).join(" | ")}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
