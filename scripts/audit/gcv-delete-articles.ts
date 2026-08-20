/**
 * GCV audit item 27 — delete the approved list of image-less articles.
 * Takes the OWNER-REVIEWED csv (default: the export from gcv-audit-export.ts,
 * scripts/audit/out/gcv-articles-no-hero.csv — edit it down to the rows the
 * editor approved for deletion; rows can also be given as --ids 1,2,3).
 *
 * Deletes via the Payload API so versions/relations clean up. Deleted URLs
 * then 404 from the reader (never redirected to the homepage). After running:
 * the sitemap regenerates within the hour; RELATED blocks re-query live.
 *
 * REFUSES to run without --apply. Always double-check the csv first.
 *
 *   npx tsx scripts/audit/gcv-delete-articles.ts [--csv path] [--ids 1,2] --apply
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

async function main() {
  const idsArg = argValue("--ids");
  const csvPath =
    argValue("--csv") ?? path.resolve(process.cwd(), "scripts/audit/out/gcv-articles-no-hero.csv");

  let ids: string[] = [];
  if (idsArg) {
    ids = idsArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    if (!fs.existsSync(csvPath)) throw new Error(`csv not found: ${csvPath}`);
    const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
    ids = lines.map((l) => l.split(",")[0]!.trim()).filter(Boolean);
  }
  if (!ids.length) throw new Error("no ids to delete");

  const payload = await getPayload({ config: await config });
  const tenants = await payload.find({ collection: "tenants", where: { slug: { equals: "gcv" } }, limit: 1, depth: 0 });
  const tenant = tenants.docs[0];
  if (!tenant) throw new Error("tenant gcv not found");

  console.log(`${APPLY ? "DELETING" : "DRY-RUN (no --apply)"}: ${ids.length} articles`);
  for (const id of ids) {
    const doc = await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true }).catch(() => null);
    if (!doc) {
      console.log(`  ${id}: not found — skipped`);
      continue;
    }
    if (String((doc as { tenant?: unknown }).tenant) !== String(tenant.id)) {
      console.log(`  ${id}: NOT in tenant gcv — skipped`);
      continue;
    }
    console.log(`  ${id}: ${(doc as { slug?: string }).slug}`);
    if (APPLY) {
      await payload.delete({ collection: "articles", id, overrideAccess: true });
    }
  }
  console.log(APPLY ? "Done." : "Dry-run complete — re-run with --apply after owner approval.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
