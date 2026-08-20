/**
 * GCV audit item 1 — hero credits are in the wrong field, both directions:
 *   - the line under the image printed the SOURCE PUBLICATION's name
 *     ("TRAVEL + LEISURE") because import/intake fell back to
 *     engineSourceName when no real image credit existed;
 *   - the REAL photo credit sits as a trailing "Credit: …" paragraph at the
 *     bottom of the article body.
 *
 * This script, per published gcv article:
 *   1. finds a trailing body paragraph matching /^(photo )?credit:?\s*(.+)/i
 *      (searching the last 3 paragraphs), extracts the credit text;
 *   2. proposes: set heroImage media.credit to that text, REMOVE the paragraph
 *      from the body;
 *   3. where media.credit currently equals the article's engineSourceName
 *      (i.e. a publication name, not a photo credit) and no trailing credit
 *      exists, proposes CLEARING the credit.
 *
 * DRY-RUN by default — writes scripts/audit/out/gcv-hero-credit-fixes.csv for
 * review. Run with --apply to write changes. Run gcv-reset-updated-at.ts
 * AFTERWARDS: body updates bump updatedAt.
 *
 *   npx tsx scripts/audit/gcv-fix-hero-credits.ts [--apply]
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "@payload-config";

const APPLY = process.argv.includes("--apply");
const OUT = path.resolve(process.cwd(), "scripts/audit/out/gcv-hero-credit-fixes.csv");

type LexNode = { type?: string; text?: string; children?: LexNode[] };

function textOf(node: LexNode | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map(textOf).join("");
}

const CREDIT_RE = /^\s*(?:photo\s*)?credit:?\s*(.+?)\s*$/i;

function csv(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const payload = await getPayload({ config: await config });
  const tenants = await payload.find({ collection: "tenants", where: { slug: { equals: "gcv" } }, limit: 1, depth: 0 });
  const tenant = tenants.docs[0];
  if (!tenant) throw new Error("tenant gcv not found");

  const rows: unknown[][] = [];
  let page = 1;
  let changed = 0;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      limit: 50,
      page,
      depth: 1,
      overrideAccess: true,
    });
    for (const a of res.docs as any[]) {
      const body = a.body as { root?: { children?: LexNode[] } } | null;
      const children: LexNode[] = body?.root?.children ?? [];
      let creditText: string | null = null;
      let creditIndex = -1;
      for (let i = children.length - 1; i >= Math.max(0, children.length - 3); i--) {
        const node = children[i];
        if (node?.type !== "paragraph") continue;
        const m = textOf(node).match(CREDIT_RE);
        if (m) {
          creditText = m[1] ?? null;
          creditIndex = i;
          break;
        }
      }

      const hero = a.heroImage && typeof a.heroImage === "object" ? a.heroImage : null;
      const currentCredit: string = (hero?.credit ?? "").trim();
      const sourceName: string = (a.engineSourceName ?? "").trim();
      const creditIsSourceName =
        currentCredit && sourceName && currentCredit.toLowerCase() === sourceName.toLowerCase();

      let action = "";
      if (creditText && hero) action = "move-body-credit-to-media";
      else if (creditText && !hero) action = "body-credit-found-no-hero";
      else if (creditIsSourceName) action = "clear-source-name-credit";
      if (!action) continue;

      rows.push([a.id, a.slug, action, currentCredit, creditText ?? "", sourceName]);

      if (!APPLY) continue;
      if (action === "move-body-credit-to-media" && hero) {
        await payload.update({
          collection: "media",
          id: hero.id,
          data: { credit: creditText },
          overrideAccess: true,
        });
        const nextChildren = children.filter((_, i) => i !== creditIndex);
        await payload.update({
          collection: "articles",
          id: a.id,
          data: { body: { ...body, root: { ...body!.root, children: nextChildren } } as any },
          overrideAccess: true,
        });
        changed++;
      } else if (action === "clear-source-name-credit" && hero) {
        await payload.update({
          collection: "media",
          id: hero.id,
          data: { credit: null },
          overrideAccess: true,
        });
        changed++;
      }
    }
    if (!res.hasNextPage) break;
    page++;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    [["id", "slug", "action", "current_media_credit", "body_credit", "engine_source_name"], ...rows]
      .map((r) => r.map(csv).join(","))
      .join("\n") + "\n"
  );
  console.log(`${APPLY ? "APPLIED" : "DRY-RUN"}: ${rows.length} articles need fixes${APPLY ? `, ${changed} changed` : ""}. Report: ${OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
