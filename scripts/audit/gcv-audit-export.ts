/**
 * GCV website-audit data export (audit 17/08/2026) — READ-ONLY.
 *
 * Produces the review lists the owner must approve BEFORE any deletion or
 * slug rename is run against the live tenant `gcv`:
 *
 *   out/gcv-articles-no-hero.csv   — published articles with an empty heroImage
 *                                    (audit item 27: delete or add image, per-article
 *                                    editorial decision)
 *   out/gcv-slug-renames.csv       — slugs that differ from what the fixed slugify
 *                                    now produces (audit item 9); columns include a
 *                                    `reason` (truncated-mid-word / diacritics / apostrophe)
 *                                    and the proposed new slug + needed 301
 *   out/gcv-audit-summary.json     — counts + tenant + DB fingerprint
 *
 *   npm run audit:gcv-export       (or: tsx scripts/audit/gcv-audit-export.ts)
 *
 * Writes NOTHING to the database.
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "@payload-config";
import { slugify } from "../../src/lib/http";

const OUT_DIR = path.resolve(process.cwd(), "scripts/audit/out");

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  fs.writeFileSync(file, body + "\n", "utf8");
  console.log(`  wrote ${file} (${rows.length} rows)`);
}

async function main() {
  const payload = await getPayload({ config: await config });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tenants = await payload.find({
    collection: "tenants",
    where: { slug: { equals: "gcv" } },
    limit: 1,
    depth: 0,
  });
  const tenant = tenants.docs[0];
  if (!tenant) throw new Error("tenant `gcv` not found in this database");

  type Row = {
    id: string | number;
    slug: string;
    title: string;
    workflowStatus?: string;
    publishedAt?: string;
    heroImage?: unknown;
    engineSourceName?: string;
    readMin?: number;
  };

  const all: Row[] = [];
  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      limit: 100,
      page,
      depth: 0,
      overrideAccess: true,
    });
    all.push(...(res.docs as unknown as Row[]));
    if (!res.hasNextPage) break;
    page += 1;
  }
  console.log(`articles in tenant gcv: ${all.length}`);

  // ---- 1. Published articles without a hero image (audit item 27) ----
  const noHero = all.filter((a) => a.workflowStatus === "published" && !a.heroImage);
  writeCsv(
    path.join(OUT_DIR, "gcv-articles-no-hero.csv"),
    ["id", "slug", "title", "publishedAt"],
    noHero.map((a) => [a.id, a.slug, a.title, a.publishedAt ?? ""]),
  );

  // ---- 2. Slug renames the fixed slugify would produce (audit item 9) ----
  const renames: unknown[][] = [];
  for (const a of all) {
    const fresh = slugify(a.title ?? "");
    if (!fresh || fresh === a.slug) continue;
    const reasons: string[] = [];
    // Old generator hard-cut at 80 chars mid-word.
    if (a.slug.length >= 75 && !fresh.startsWith(a.slug + "-") && fresh.startsWith(a.slug.slice(0, 60))) {
      reasons.push("truncated-mid-word");
    }
    if (/(^|-)[a-z]-[a-z]/.test(a.slug) && !/(^|-)[a-z]-[a-z]/.test(fresh)) reasons.push("broken-diacritic-or-apostrophe");
    if (a.slug.includes("-s-") && !fresh.includes("-s-")) reasons.push("apostrophe--s-");
    renames.push([a.id, a.workflowStatus ?? "", a.slug, fresh, reasons.join("+") || "other-diff"]);
  }
  writeCsv(
    path.join(OUT_DIR, "gcv-slug-renames.csv"),
    ["id", "status", "old_slug", "proposed_slug", "reason"],
    renames,
  );

  // ---- 3. Summary ----
  const summary = {
    generatedAt: new Date().toISOString(),
    tenant: { id: tenant.id, slug: "gcv" },
    dbHost: (process.env.DATABASE_URL ?? "").replace(/\/\/[^@]*@/, "//***@").split("?")[0],
    totals: {
      articles: all.length,
      published: all.filter((a) => a.workflowStatus === "published").length,
      publishedWithoutHero: noHero.length,
      slugRenameCandidates: renames.length,
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, "gcv-audit-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.totals, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
