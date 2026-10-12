/**
 * Hub author — the body IMAGE token (APCGHub P5.3, T8, branch B candidate).
 *
 * A hub body may hold an image only as the canonical token
 *
 *     ![<alt, ignored>](cms-media:<id>)
 *
 * standing ALONE as a root paragraph: the whole line is exactly the token,
 * starting in column 0 with nothing after it, the lines before and after are blank
 * (empty, or spaces/tabs only) or the start/end of the body, and the line is not
 * inside a ``` / ~~~ fence. Lines are split on `\n` only, so a token followed by
 * `\r`, U+2028 or U+2029 is NOT a token (it stays `image`). The id shape is
 * `[1-9][0-9]*` with NO int4 bound here: the references step reports a too-large
 * id as `out_of_range` instead of the token silently turning into `image`.
 *
 * The typed alt is ignored (the image's alt is `media.alt`); the export is the
 * deterministic `![](cms-media:<id>)` of `{relationTo, id}` only.
 *
 * Conversion (used inside the ONE vm call, so everything here is synchronous):
 *   import: token line → a root paragraph holding one text node = an internal
 *           placeholder (U+0001 … U+0001 — a C0 the body checks reject, so a user
 *           can never type it) → the real converter → placeholder paragraph →
 *           `upload {relationTo: "media", value: <id>}` (root children only).
 *   export: root `upload` node (value = number or a populated media object) →
 *           placeholder paragraph → the real converter → placeholder line → token.
 *           Any other relationTo, a missing id, or an upload node that is not a
 *           direct child of root ⇒ throw (the caller treats that as not safe).
 *
 * Step 1.6: written and unit-tested BEFORE the syntax decision (plan §5.1); it is
 * NOT yet used by the write path, the round-trip check or the edit view.
 * Pure: no I/O, no deferred work; does not import the read-path module.
 */

import type { BodyConverters } from "@/lib/hub-author-convert-core";

/** THE token regex (whole line, no `m` flag). Group 1 = the id digits. */
export const MEDIA_TOKEN_RE = /^!\[[^\]\n\r]*\]\(cms-media:([1-9][0-9]*)\)$/;

const PLACEHOLDER_RE = /^\u0001cms-media:([1-9][0-9]*)\u0001$/;
const BLANK_RE = /^[ \t]*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** The internal placeholder text for one id (never shown, never stored). */
export function mediaPlaceholder(id: string | number): string {
  return `\u0001cms-media:${id}\u0001`;
}

/** Valid token lines of a body, in order: `{line (0-based), id (digits)}`. */
export function findMediaTokenLines(md: string): { line: number; id: string }[] {
  const lines = md.split("\n");
  const out: { line: number; id: string }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const f = FENCE_RE.exec(l);
    if (fence !== null) {
      if (f && f[1] === fence) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const m = MEDIA_TOKEN_RE.exec(l);
    if (!m) continue;
    const prevBlank = i === 0 || BLANK_RE.test(lines[i - 1]!);
    const nextBlank = i === lines.length - 1 || BLANK_RE.test(lines[i + 1]!);
    if (prevBlank && nextBlank) out.push({ line: i, id: m[1]! });
  }
  return out;
}

/** Every id of a valid token line (digits; above int4 included, for `out_of_range`). */
export function extractMediaIds(md: string): string[] {
  return findMediaTokenLines(md).map((t) => t.id);
}

/** The body with every valid token line blanked — what the generic image check then scans. */
export function withoutMediaTokenLines(md: string): string {
  const hits = new Set(findMediaTokenLines(md).map((t) => t.line));
  if (hits.size === 0) return md;
  return md
    .split("\n")
    .map((l, i) => (hits.has(i) ? "" : l))
    .join("\n");
}

/** Id of an upload node `value`: a positive integer, or a populated object's `id`. Else null. */
export function uploadValueId(value: unknown): number | null {
  const v = isNode(value) ? value.id : value;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** The canonical token of an upload node — a function of `{relationTo, id}` only. */
export function mediaTokenFor(node: { relationTo?: unknown; value?: unknown }): string {
  const id = uploadValueId(node.value);
  if (node.relationTo !== "media" || id === null) throw new Error("hub media token: not a media upload with an id");
  return `![](cms-media:${id})`;
}

/** import side 1: token lines → placeholder lines. */
export function tokensToPlaceholders(md: string): string {
  const hits = new Map(findMediaTokenLines(md).map((t) => [t.line, t.id]));
  if (hits.size === 0) return md;
  return md
    .split("\n")
    .map((l, i) => (hits.has(i) ? mediaPlaceholder(hits.get(i)!) : l))
    .join("\n");
}

/** export side 2: placeholder lines → canonical tokens. */
export function placeholdersToTokens(md: string): string {
  if (!md.includes("\u0001")) return md;
  return md
    .split("\n")
    .map((l) => {
      const m = PLACEHOLDER_RE.exec(l);
      return m ? `![](cms-media:${m[1]})` : l;
    })
    .join("\n");
}

function rootChildren(lex: unknown): Node[] | null {
  if (!isNode(lex) || !isNode(lex.root) || !Array.isArray(lex.root.children)) return null;
  return lex.root.children as Node[];
}

function withRootChildren(lex: unknown, children: unknown[]): unknown {
  const l = lex as Node;
  return { ...l, root: { ...(l.root as Node), children } };
}

/** Fixed 24-hex node id per position — node ids are not compared and never derived from input. */
const nodeId = (i: number) => (0x1000000 + i).toString(16).padStart(24, "0");

/** import side 2: root paragraphs whose only child is a placeholder text → upload nodes. */
export function placeholdersToUploadNodes(lex: unknown): unknown {
  const kids = rootChildren(lex);
  if (!kids) return lex;
  let changed = false;
  const next = kids.map((n, i) => {
    if (n.type !== "paragraph" || !Array.isArray(n.children) || n.children.length !== 1) return n;
    const t = n.children[0];
    if (!isNode(t) || t.type !== "text" || typeof t.text !== "string") return n;
    const m = PLACEHOLDER_RE.exec(t.text);
    if (!m) return n;
    changed = true;
    return { type: "upload", version: 3, format: "", id: nodeId(i), fields: null, relationTo: "media", value: Number(m[1]) };
  });
  return changed ? withRootChildren(lex, next) : lex;
}

/** export side 1: root upload nodes → placeholder paragraphs (non-media / no id / nested ⇒ throw). */
export function uploadNodesToPlaceholders(lex: unknown): unknown {
  const kids = rootChildren(lex);
  if (!kids) return lex;
  const stack: unknown[] = [];
  for (const n of kids) if (isNode(n) && Array.isArray(n.children)) stack.push(...(n.children as unknown[]));
  while (stack.length) {
    const n = stack.pop();
    if (!isNode(n)) continue;
    if (n.type === "upload") throw new Error("hub media token: upload node is not a direct child of root");
    if (Array.isArray(n.children)) stack.push(...(n.children as unknown[]));
  }
  let changed = false;
  const next = kids.map((n) => {
    if (n.type !== "upload") return n;
    mediaTokenFor(n);
    changed = true;
    return {
      type: "paragraph",
      version: 1,
      direction: null,
      format: "",
      indent: 0,
      textFormat: 0,
      textStyle: "",
      children: [{ type: "text", version: 1, text: mediaPlaceholder(uploadValueId(n.value)!), format: 0, detail: 0, mode: "normal", style: "" }],
    };
  });
  return changed ? withRootChildren(lex, next) : lex;
}

/** Media ids of every `upload` node with `relationTo: "media"` anywhere in a tree (digits, in order). */
export function uploadIdsInTree(lex: unknown): string[] {
  const out: string[] = [];
  if (!isNode(lex)) return out;
  const stack: unknown[] = [lex.root];
  while (stack.length) {
    const n = stack.pop();
    if (!isNode(n)) continue;
    if (n.type === "upload" && n.relationTo === "media") {
      const id = uploadValueId(n.value);
      out.push(id === null ? "" : String(id));
    }
    if (Array.isArray(n.children)) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

/** The ONE wrapper (T8): real converters + token handling on both directions. */
export function mediaTokenConverters(base: BodyConverters): BodyConverters {
  return {
    toLexical: (md) => placeholdersToUploadNodes(base.toLexical(tokensToPlaceholders(md))),
    toMarkdown: (lex) => placeholdersToTokens(base.toMarkdown(uploadNodesToPlaceholders(lex))),
  };
}
