/**
 * One-off patch (GCV, 15/08/2026): legacy Skysoft bodies use U+00A0 (NBSP) as
 * the word separator in some engine-era posts — the browser cannot break those
 * lines, so paragraphs overflow the 680px article column. Also strips empty
 * root-level paragraphs (legacy double-<br> spacing) that double the vertical
 * rhythm vs the design.
 *
 * Idempotent: articles already clean are skipped. Scans ALL gcv articles
 * (published + draft). Run:
 *   IMPORT_TENANT_SLUG=gcv npx tsx scripts/migrate/fix-gcv-nbsp-bodies.ts [--dry-run]
 *
 * Mirrors the fix in import-gcv-legacy.ts (normalizeLegacyText) so future
 * delta imports produce clean bodies directly.
 */
import "../lib/env"; // loads .env/.env.local before payload.config reads them
import { getPayload } from "payload";
import config from "../../payload.config";
import { pFind } from "../lib/payload-loose";

const TENANT_SLUG = process.env.IMPORT_TENANT_SLUG || "gcv";
const DRY = process.argv.includes("--dry-run");

type Doc = Record<string, unknown>;
type Node = { type?: string; text?: string; children?: Node[] };

/** NBSP family → regular space; collapse runs introduced by the swap. */
function cleanText(s: string): string {
  return s.replace(/[   ]/g, " ").replace(/ {2,}/g, " ");
}

function walkFix(node: Node): boolean {
  let changed = false;
  if (node.type === "text" && typeof node.text === "string") {
    const next = cleanText(node.text);
    if (next !== node.text) { node.text = next; changed = true; }
  }
  for (const c of node.children ?? []) if (walkFix(c)) changed = true;
  return changed;
}

function isEmptyParagraph(n: Node): boolean {
  if (n.type !== "paragraph") return false;
  const kids = n.children ?? [];
  return kids.every((k) => k.type === "text" && !(k.text ?? "").trim()) || kids.length === 0;
}

async function main() {
  const payload = await getPayload({ config });
  const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
  if (!tenant) throw new Error(`tenant ${TENANT_SLUG} not found`);

  let page = 1, scanned = 0, patched = 0, nbspFixed = 0, emptyDropped = 0;
  for (;;) {
    // Read the PUBLISHED version (draft:false): that's what the public API
    // serves, so that's the content that must be clean. Writing with
    // draft:false below publishes the cleaned body; visibility for the 11
    // intended-draft articles is still gated by workflowStatus, so publishing
    // the payload version does not expose them.
    const res = (await pFind(payload, "articles", {
      where: { tenant: { equals: tenant.id } },
      limit: 50, page, depth: 0, draft: false,
    })) as unknown as { docs: Doc[]; hasNextPage: boolean };
    for (const a of res.docs) {
      scanned++;
      const body = a.body as { root?: Node } | null;
      let changed = false;
      if (body?.root) {
        if (walkFix(body.root)) { changed = true; nbspFixed++; }
        const before = (body.root.children ?? []).length;
        body.root.children = (body.root.children ?? []).filter((n) => !isEmptyParagraph(n));
        if ((body.root.children ?? []).length !== before) { changed = true; emptyDropped += before - body.root.children.length; }
      }
      const data: Doc = {};
      if (changed) data.body = body;
      for (const f of ["title", "dek"] as const) {
        const v = a[f];
        if (typeof v === "string" && cleanText(v) !== v) { data[f] = cleanText(v); changed = true; }
      }
      if (changed) {
        patched++;
        if (!DRY) {
          await payload.update({
            collection: "articles", id: a.id as number, data: data as never,
            context: { disableRevalidate: true, skipTranslationEnqueue: true } as never,
            overrideAccess: true, depth: 0,
            draft: false, // publish the cleaned body — public reads draft:false
          } as never);
        }
        console.log(`${DRY ? "[dry] " : ""}patched ${a.slug}`);
      }
    }
    if (!res.hasNextPage) break;
    page++;
  }
  console.log(`\nscanned=${scanned} patched=${patched} (nbsp bodies=${nbspFixed}, empty paragraphs dropped=${emptyDropped})${DRY ? " — DRY RUN, nothing written" : ""}`);
  process.exit(0);
}
main().catch((e) => { console.error("[fix-gcv-nbsp] failed", e); process.exit(1); });
