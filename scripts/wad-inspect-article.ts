/** Read-only: print an article's body text nodes (for targeted audit edits).
 *  npx tsx scripts/wad-inspect-article.ts "<title regex>" */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

type LexNode = { type?: string; tag?: string; text?: string; children?: LexNode[] };

function nodeText(n: LexNode): string {
  if (typeof n.text === "string") return n.text;
  return (n.children ?? []).map(nodeText).join("");
}

async function main() {
  const re = new RegExp(process.argv[2] ?? "", "i");
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number };
  const { docs } = await payload.find({
    collection: "articles",
    where: { tenant: { equals: tenant.id } },
    limit: 2000,
    depth: 0,
    locale: "en",
    overrideAccess: true,
  });
  for (const doc of docs as Array<{ id: number; title?: string; slug?: string; dek?: string; body?: { root?: LexNode } }>) {
    if (!re.test(doc.title ?? "")) continue;
    console.log(`\n=== #${doc.id} "${doc.title}" (${doc.slug})`);
    console.log(`dek: ${JSON.stringify(doc.dek)}`);
    for (const child of doc.body?.root?.children ?? []) {
      const text = nodeText(child).trim();
      if (text) console.log(`[${child.type}${child.tag ? ":" + child.tag : ""}] ${text}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
