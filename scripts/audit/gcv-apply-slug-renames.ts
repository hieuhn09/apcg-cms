/**
 * GCV audit item 9 — apply OWNER-APPROVED slug renames.
 *
 * Input: the reviewed csv (default scripts/audit/out/gcv-slug-renames.csv —
 * edit it down to approved rows first; the audit's guidance: prioritise
 * truncated-mid-word slugs, diacritic-only diffs may stay as they are).
 *
 * For each row: updates the article's slug AND appends old→new to the READER
 * repo's 301 map (src/lib/slug-redirects.json in global-chic-voyage) so every
 * old address permanent-redirects — never change a live slug without this.
 * Commit + deploy the reader after running.
 *
 * DRY-RUN by default; --apply to write.
 *
 *   npx tsx scripts/audit/gcv-apply-slug-renames.ts [--csv path] [--apply]
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "@payload-config";

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const READER_REDIRECTS = path.resolve(
  process.cwd(),
  "../global-chic-voyage/src/lib/slug-redirects.json"
);

async function main() {
  const csvPath =
    argValue("--csv") ?? path.resolve(process.cwd(), "scripts/audit/out/gcv-slug-renames.csv");
  if (!fs.existsSync(csvPath)) throw new Error(`csv not found: ${csvPath}`);
  const rows = fs
    .readFileSync(csvPath, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[0] && c[2] && c[3]);

  const payload = await getPayload({ config: await config });
  const tenants = await payload.find({ collection: "tenants", where: { slug: { equals: "gcv" } }, limit: 1, depth: 0 });
  const tenant = tenants.docs[0];
  if (!tenant) throw new Error("tenant gcv not found");

  const redirectFile = JSON.parse(fs.readFileSync(READER_REDIRECTS, "utf8")) as {
    redirects: Record<string, string>;
  };

  let applied = 0;
  for (const [id, , oldSlug, newSlug] of rows) {
    const doc = await payload.findByID({ collection: "articles", id: id!, depth: 0, overrideAccess: true }).catch(() => null);
    if (!doc || String((doc as { tenant?: unknown }).tenant) !== String(tenant.id)) {
      console.log(`  ${id}: not found / wrong tenant — skipped`);
      continue;
    }
    console.log(`  ${id}: ${oldSlug} → ${newSlug}`);
    if (!APPLY) continue;
    await payload.update({ collection: "articles", id: id!, data: { slug: newSlug }, overrideAccess: true });
    redirectFile.redirects[oldSlug!] = newSlug!;
    applied++;
  }

  if (APPLY) {
    fs.writeFileSync(READER_REDIRECTS, JSON.stringify(redirectFile, null, 2) + "\n");
    console.log(`APPLIED ${applied} renames; 301 map updated at ${READER_REDIRECTS} — commit + deploy the reader.`);
    console.log("NOTE: slug updates bump updatedAt — re-run gcv-reset-updated-at.ts --apply afterwards.");
  } else {
    console.log(`DRY-RUN: ${rows.length} renames would apply.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
