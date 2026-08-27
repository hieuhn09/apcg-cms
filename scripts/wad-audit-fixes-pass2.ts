/**
 * WAD audit 26/08 — pass 2 (run AFTER wad-audit-fixes.ts --apply):
 *
 *  0. Non-breaking spaces: the pasted bodies use U+00A0 for nearly every
 *     word gap (word-processor residue). NBSP forbids line wrapping — the
 *     direct mechanism behind audit item 23's text spilling past the window
 *     edge — so every text run is normalised to plain spaces first.
 *  A. Image captions (audit item 20): a fully-ITALIC paragraph sitting
 *     immediately after an upload node is a pasted caption — move it into the
 *     media doc's `caption` field and drop the paragraph. Italic-only + short
 *     keeps real prose safe.
 *  B. Targeted content fixes the audit called out by name:
 *     - Dome-ceiling roundup: "Domo Hata" → "HATA Dome" (one building, one
 *       name), "indoor - outdoor" → "indoor-outdoor", en-dash "Fuller–style"
 *       → "Fuller-style".
 *     - Unfinished Architecture: date the Milan Design Week panel (2025), and
 *       reword the "at least five major reprogramming events" law into the
 *       panel-derived observation it actually is.
 *
 * Usage:
 *   npx tsx scripts/wad-audit-fixes-pass2.ts            # analyze
 *   npx tsx scripts/wad-audit-fixes-pass2.ts --apply
 */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

const APPLY = process.argv.includes("--apply");
const ctx = { disableRevalidate: true };

type LexNode = {
  type?: string;
  tag?: string;
  format?: number | string;
  text?: string;
  value?: unknown;
  children?: LexNode[];
  [k: string]: unknown;
};

const ITALIC_BIT = 2;

function nodeText(n: LexNode): string {
  if (typeof n.text === "string") return n.text;
  return (n.children ?? []).map(nodeText).join("");
}

function textNodes(n: LexNode): LexNode[] {
  if (n.type === "text") return [n];
  return (n.children ?? []).flatMap(textNodes);
}

function isAllItalic(n: LexNode): boolean {
  const nodes = textNodes(n).filter((t) => (t.text ?? "").trim().length > 0);
  return nodes.length > 0 && nodes.every((t) => typeof t.format === "number" && (t.format & ITALIC_BIT) !== 0);
}

/** U+00A0 → " " in every text run; returns how many runs changed. */
function normalizeNbsp(n: LexNode): number {
  let changed = 0;
  if (n.type === "text" && typeof n.text === "string" && n.text.includes(" ")) {
    n.text = n.text.replace(/ /g, " ");
    changed += 1;
  }
  for (const child of n.children ?? []) changed += normalizeNbsp(child);
  return changed;
}

function uploadMediaId(n: LexNode): number | null {
  if (n.type !== "upload") return null;
  const v = n.value as { id?: number } | number | null | undefined;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.id === "number") return v.id;
  return null;
}

/** In-place string replacements inside a paragraph's single text run. */
const STRING_FIXES: ReadonlyArray<readonly [titleRe: RegExp, from: string, to: string]> = [
  [/dome-ceiling/i, "Domo Hata is a sculptural", "HATA Dome is a sculptural"],
  [/dome-ceiling/i, "indoor - outdoor", "indoor-outdoor"],
  [/dome-ceiling/i, "Fuller–style", "Fuller-style"],
  [
    /unfinished architecture/i,
    "A recent panel conversation at Milan Design Week brought together",
    "A panel conversation at Milan Design Week 2025 brought together",
  ],
  [
    /unfinished architecture/i,
    "A building that's meant to last fifty years will go through at least five major reprogramming events.",
    "By that rhythm, a building meant to last fifty years should expect to be reprogrammed again and again over its life.",
  ],
  [
    /unfinished architecture/i,
    "A building that’s meant to last fifty years will go through at least five major reprogramming events.",
    "By that rhythm, a building meant to last fifty years should expect to be reprogrammed again and again over its life.",
  ],
];

async function main() {
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number };
  console.log(`[pass2] tenant wad = ${tenant.id} · mode: ${APPLY ? "APPLY" : "ANALYZE"}`);

  let captionsMoved = 0;
  let stringFixes = 0;
  let articlesTouched = 0;
  let nbspRuns = 0;

  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 50,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as { id: number; title?: string; body?: { root?: LexNode } };
      const root = a.body?.root;
      if (!root?.children) continue;
      let changed = false;

      // 0. NBSP → plain space (mutates text runs in place before any matching).
      const nbsp = normalizeNbsp(root);
      if (nbsp > 0) {
        nbspRuns += nbsp;
        changed = true;
      }

      // A. italic caption directly after an upload → media.caption.
      const kept: LexNode[] = [];
      let prevUpload: number | null = null;
      for (const node of root.children) {
        const mid = uploadMediaId(node);
        if (mid != null) {
          prevUpload = mid;
          kept.push(node);
          continue;
        }
        const text = nodeText(node).trim();
        if (
          prevUpload != null &&
          node.type === "paragraph" &&
          text.length > 0 &&
          text.length < 300 &&
          isAllItalic(node) &&
          !/^photo\s*credit/i.test(text)
        ) {
          captionsMoved += 1;
          changed = true;
          // Targeted string fixes apply to caption text too (e.g. the
          // Halodome "indoor - outdoor" cell lives in a caption).
          let captionText = text;
          for (const [re, from, to] of STRING_FIXES) {
            if (re.test(a.title ?? "") && captionText.includes(from)) {
              captionText = captionText.replace(from, to);
              stringFixes += 1;
              console.log(`[pass2] #${a.id} caption fix: "${from.slice(0, 40)}"`);
            }
          }
          if (APPLY) {
            await payload.update({
              collection: "media",
              id: prevUpload,
              data: { caption: captionText } as never,
              locale: "en",
              context: ctx,
              overrideAccess: true,
            });
          }
          prevUpload = null;
          continue; // drop the caption paragraph
        }
        if (text.length > 0) prevUpload = null;
        kept.push(node);
      }

      // B. targeted string fixes.
      const fixes = STRING_FIXES.filter(([re]) => re.test(a.title ?? ""));
      const finalChildren = kept.map((node) => {
        if (fixes.length === 0 || node.type !== "paragraph") return node;
        const combined = nodeText(node);
        const hit = fixes.find(([, from]) => combined.includes(from));
        if (!hit) return node;
        const runs = textNodes(node);
        const target = runs.find((t) => (t.text ?? "").includes(hit[1]));
        if (!target) {
          console.warn(`[pass2] #${a.id} fix spans text runs — skipped: ${hit[1].slice(0, 40)}…`);
          return node;
        }
        stringFixes += 1;
        changed = true;
        console.log(`[pass2] #${a.id} string fix: "${hit[1].slice(0, 50)}"`);
        target.text = target.text!.replace(hit[1], hit[2]);
        return { ...node };
      });

      if (changed) {
        articlesTouched += 1;
        console.log(`[pass2] #${a.id} "${(a.title ?? "").slice(0, 60)}"`);
        if (APPLY) {
          await payload.update({
            collection: "articles",
            id: a.id,
            data: { body: { ...a.body, root: { ...root, children: finalChildren } } } as never,
            locale: "en",
            context: ctx,
            overrideAccess: true,
          });
        }
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log(
    `\n[pass2] captions moved: ${captionsMoved} · string fixes: ${stringFixes} · nbsp runs: ${nbspRuns} · articles touched: ${articlesTouched}`,
  );

  if (APPLY) {
    const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle;
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`UPDATE articles SET updated_at = published_at WHERE tenant_id = ${tenant.id} AND published_at IS NOT NULL`,
    );
    console.log(`[pass2] lastmod re-synced (updated_at ← published_at)`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
