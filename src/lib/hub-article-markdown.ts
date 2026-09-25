/**
 * Article body → Markdown for the hub article-detail route
 * (`GET /api/hub/articles/{id}`, APCGHub P4 / CMS-4).
 *
 * Contract: the caller ALWAYS gets `{ bodyMarkdown: string, bodyState }` and
 * this function NEVER throws. A body problem must never turn the whole article
 * page into a 500 — the hub still needs the page to load so an operator can
 * hide / republish the article.
 *
 *   bodyState "empty" — body null / not an editor state / root with no content.
 *                       The converter is NOT called.
 *   bodyState "ok"    — converted, no dangerous link target found.
 *   bodyState "error" — the editor config or the conversion threw, OR a body
 *                       with content converted to nothing (see below), OR the
 *                       post-conversion scrub found a dangerous link target.
 *                       `bodyMarkdown` is "" in both cases.
 *
 * Conversion uses `convertLexicalToMarkdown` with the editor config built by
 * `editorConfigFactory.default({ config })` — the construction the CMS-4
 * FEASIBILITY probe verified against a real `Articles.body` (H1). Relationship
 * nodes export as "{relationTo} relation to {id}" whatever their populated value
 * holds (H3), and `sanitizeUrl()` inside the Link transformer rewrites dangerous
 * schemes to "https://" at export time (H4).
 *
 * The scrub below is defence in depth on top of `sanitizeUrl()`: FEASIBILITY
 * found 0/5 malicious variants surviving it, so this branch is not expected to
 * fire. Policy chosen: HARD BLOCK (plan §Quyết định #7 allows it) — a body with
 * a surviving dangerous link target is withheld (`bodyState: "error"`, 200),
 * never served. `error` carries only a kind and an error NAME for logging: no
 * body text, no error message, no token.
 */

import type { SanitizedConfig } from "payload";
import { convertLexicalToMarkdown, editorConfigFactory } from "@payloadcms/richtext-lexical";

export type HubBodyState = "ok" | "empty" | "error";

export interface HubBodyResult {
  bodyMarkdown: string;
  bodyState: HubBodyState;
  /** Present only when bodyState === "error". Safe to log (no content). */
  error?: { kind: "conversion_failed" | "dangerous_link"; name: string; matches?: number };
}

type EditorConfig = Awaited<ReturnType<typeof editorConfigFactory.default>>;
type Convert = (args: { data: never; editorConfig: EditorConfig }) => string;

/**
 * Link / image targets (`](target)`) whose scheme must never reach the hub:
 * `javascript:` and `vbscript:` always; `data:` unless it is the base64
 * image/video/audio form `sanitizeUrl()` itself allows.
 */
const DANGEROUS_LINK_TARGET =
  /\]\(\s*<?\s*(?:javascript|vbscript|data(?!:(?:image\/(?:bmp|gif|jpeg|jpg|png|tiff|webp)|video\/(?:mpeg|mp4|ogg|webm)|audio\/(?:mp3|oga|ogg|opus));base64,))\s*:/gi;

export function countDangerousLinkTargets(markdown: string): number {
  return markdown.match(DANGEROUS_LINK_TARGET)?.length ?? 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An empty paragraph (what the editor saves for a cleared body) counts as no content. */
function isBlankNode(node: unknown): boolean {
  if (!isPlainObject(node)) return true;
  if (node.type !== "paragraph") return false;
  const kids = node.children;
  return !Array.isArray(kids) || kids.length === 0;
}

/** null / not an editor state / root without any non-blank child. */
export function isEmptyBody(data: unknown): boolean {
  if (!isPlainObject(data)) return true;
  const root = data.root;
  if (!isPlainObject(root)) return true;
  const children = root.children;
  if (!Array.isArray(children) || children.length === 0) return true;
  return children.every(isBlankNode);
}

let editorConfigPromise: Promise<EditorConfig> | null = null;

/** Built once per server instance; a failed build is not cached, so the next call retries. */
export function loadHubEditorConfig(config: SanitizedConfig): Promise<EditorConfig> {
  if (!editorConfigPromise) {
    editorConfigPromise = editorConfigFactory.default({ config }).catch((err: unknown) => {
      editorConfigPromise = null;
      throw err;
    });
  }
  return editorConfigPromise;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

class EmptyConversionOutput extends Error {
  override name = "EmptyConversionOutput";
}

export async function hubArticleBodyToMarkdown(
  data: unknown,
  opts: {
    loadEditorConfig: () => Promise<EditorConfig>;
    /** Injectable for tests (forced throw / forced dangerous output). */
    convert?: Convert;
  },
): Promise<HubBodyResult> {
  if (isEmptyBody(data)) return { bodyMarkdown: "", bodyState: "empty" };

  const convert: Convert = opts.convert ?? (convertLexicalToMarkdown as unknown as Convert);
  let markdown: string;
  try {
    const editorConfig = await opts.loadEditorConfig();
    markdown = convert({ data: data as never, editorConfig });
    if (typeof markdown !== "string") throw new TypeError("converter returned a non-string");
    // `convertLexicalToMarkdown` does not always throw: an editor state Lexical
    // cannot parse (e.g. an unregistered node type) is reported through the
    // headless editor's default onError (console.error) and the converter
    // returns "". A body that has content but converts to nothing is therefore a
    // conversion failure, not a successful empty article.
    if (markdown.trim() === "") throw new EmptyConversionOutput();
  } catch (err) {
    return { bodyMarkdown: "", bodyState: "error", error: { kind: "conversion_failed", name: errorName(err) } };
  }

  const matches = countDangerousLinkTargets(markdown);
  if (matches > 0) {
    return { bodyMarkdown: "", bodyState: "error", error: { kind: "dangerous_link", name: "DangerousLinkTarget", matches } };
  }
  return { bodyMarkdown: markdown, bodyState: "ok" };
}
