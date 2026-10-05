/**
 * Hub author — the SYNCHRONOUS conversion core (APCGHub P5.1; D24 / D25; OQ35 /
 * OQ43 / OQ54; E23).
 *
 * Everything that runs INSIDE the one `vm` call of a hub draft save lives in this
 * file and nowhere else: `convertCore` (Markdown → Lexical → Markdown → stability
 * gate F → re-check of the stored tree), `roundTripCore` (the round-trip safety
 * comparison used for `bodyEditable`), and every helper they call (`isWs`,
 * `hasLongWhitespaceRun`, `hasDangerousLinkSyntax`, `checkExportedMarkdown`,
 * `checkLexicalTree`, the URL allowlist, the tree comparator).
 *
 * Rules for this file (checked by a TEXT scan in `scripts/hub-probe.ts --check6
 * --unit-only`, comments included): no deferred / non-blocking constructs of any
 * kind — every function here returns its value directly, so the `vm` timeout can
 * interrupt it. It does not import the `vm` module (only `hub-author-body.ts`
 * does) and does not import the read-path regex helper of
 * `hub-article-markdown.ts`.
 *
 * W (the ONE whitespace class, Public Contracts "Kiểm thân bài (0)") = the JS `\s`
 * class plus C0 (U+0000–U+001F). Not W: U+0085, U+180E, U+200B–U+200D, U+2060.
 */

import { convertLexicalToMarkdown, convertMarkdownToLexical } from "@payloadcms/richtext-lexical";
import { BODY_MAX_JSON_CHARS, BODY_MAX_NODES, WS_RUN_MAX } from "@/lib/hub-author-limits";

/** The editor config both converters take. */
export type HubEditorConfig = Parameters<typeof convertMarkdownToLexical>[0]["editorConfig"];

/** Markdown → Lexical editor state, and back. Injectable so unit checks need no real Lexical. */
export interface BodyConverters {
  toLexical: (markdown: string) => unknown;
  toMarkdown: (lexical: unknown) => string;
}

/** The real converters, bound to one (cached) editor config. */
export function lexicalConverters(editorConfig: HubEditorConfig): BodyConverters {
  return {
    toLexical: (markdown) => convertMarkdownToLexical({ editorConfig, markdown }) as unknown,
    toMarkdown: (lexical) =>
      convertLexicalToMarkdown({ data: lexical as Parameters<typeof convertLexicalToMarkdown>[0]["data"], editorConfig }),
  };
}

// ── W class ────────────────────────────────────────────────────────────────

/** `c` (a UTF-16 code unit) is W = JS `\s` ∪ C0. Parity with the regex is checked for every unit 0..0xFFFF. */
export function isWs(c: number): boolean {
  return (
    c <= 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** One linear pass: is there a run of consecutive W characters LONGER than `max`? */
export function hasLongWhitespaceRun(md: string, max: number = WS_RUN_MAX): boolean {
  let run = 0;
  for (let i = 0; i < md.length; i++) {
    if (isWs(md.charCodeAt(i))) {
      run++;
      if (run > max) return true;
    } else run = 0;
  }
  return false;
}

// ── Dangerous link syntax (linear scanner; write ⊇ read) ──────────────────────

const DANGEROUS_SCHEMES = ["javascript", "vbscript", "data"];
const SCHEME_MAX_LETTERS = 10; // "javascript"

/** Index of the first non-W character at or after `i` (bounded by `end`). */
function skipWs(s: string, i: number, end: number): number {
  while (i < end && isWs(s.charCodeAt(i))) i++;
  return i;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiAlnum(c: number): boolean {
  return isAsciiLetter(c) || (c >= 48 && c <= 57);
}

/**
 * Starting at `i`: W*, ASCII letters (W allowed BETWEEN letters), W*, then `:`.
 * True when the letters spell a dangerous scheme (case-insensitive). Reads at most
 * `SCHEME_MAX_LETTERS + 1` letters, then stops — each opener looks only at the W
 * that directly follows it and at a bounded number of letters.
 */
function dangerousSchemeAt(s: string, i: number, end: number): boolean {
  let p = skipWs(s, i, end);
  let letters = "";
  while (p < end) {
    const c = s.charCodeAt(p);
    if (isAsciiLetter(c)) {
      letters += String.fromCharCode(c | 0x20);
      if (letters.length > SCHEME_MAX_LETTERS) return false;
      p++;
    } else if (isWs(c) && letters.length > 0) {
      p++;
    } else break;
  }
  if (letters.length === 0 || p >= end || s.charCodeAt(p) !== 58) return false; // 58 = ':'
  return DANGEROUS_SCHEMES.includes(letters);
}

/**
 * Linear scanner for a dangerous link target in Markdown: after `](` (inline link,
 * optional `<`), after `<` (autolink) and after `]:` (reference definition), W is
 * skipped (also between the scheme letters), then `javascript:` / `vbscript:` /
 * `data:` (any `data:`, stricter than the read path) is a hit. It flags every
 * string the read-path regex flags (W ⊇ `\s`, W also skipped inside the scheme,
 * `data:` without the base64-media exception) — never a quadratic regex.
 */
export function hasDangerousLinkSyntax(md: string): boolean {
  const n = md.length;
  // Entity rule (PLAN-SUPPLEMENT 7 / 7b): after `](` / `]:` (+ W, one optional `<`, W) the
  // target starts at `targetStart`; while `inTarget` and until the first W after that
  // start, `&#` or `&` + [A-Za-z0-9]+ + `;` is a hit. One flag, same single pass.
  let inTarget = false;
  let targetStart = 0;
  for (let i = 0; i < n; i++) {
    const c = md.charCodeAt(i);
    if (inTarget && i >= targetStart) {
      if (isWs(c)) inTarget = false;
      else if (c === 38 /* & */ && i + 1 < n) {
        const e = md.charCodeAt(i + 1);
        if (e === 35 /* # */) return true;
        let j = i + 1;
        while (j < n && isAsciiAlnum(md.charCodeAt(j))) j++;
        if (j > i + 1 && j < n && md.charCodeAt(j) === 59 /* ; */) return true;
      }
    }
    if (c === 93 /* ] */ && i + 1 < n) {
      const o = md.charCodeAt(i + 1);
      if (o === 40 /* ( */ || o === 58 /* : */) {
        let t = skipWs(md, i + 2, n);
        if (t < n && md.charCodeAt(t) === 60 /* < */) t = skipWs(md, t + 1, n);
        inTarget = true;
        targetStart = t;
      }
    }
    if (c === 93 /* ] */ && i + 1 < n) {
      const d = md.charCodeAt(i + 1);
      if (d === 40 /* ( */) {
        let p = skipWs(md, i + 2, n);
        if (p < n && md.charCodeAt(p) === 60 /* < */) p++;
        if (dangerousSchemeAt(md, p, n)) return true;
      } else if (d === 58 /* : */) {
        let p = skipWs(md, i + 2, n);
        if (p < n && md.charCodeAt(p) === 60) p++;
        if (dangerousSchemeAt(md, p, n)) return true;
      }
    } else if (c === 60 /* < */) {
      if (dangerousSchemeAt(md, i + 1, n)) return true;
    }
  }
  return false;
}

/** Step (6): the read path runs its regex on the EXPORTED Markdown, so the write path re-checks it. */
export function checkExportedMarkdown(md: string): { ok: true } | { ok: false; code: "ws_run" | "link" } {
  if (hasLongWhitespaceRun(md)) return { ok: false, code: "ws_run" };
  if (hasDangerousLinkSyntax(md)) return { ok: false, code: "link" };
  return { ok: true };
}

// ── Lexical tree checks ──────────────────────────────────────────────────────

/** Node types a hub body may contain (P-4, frozen at Stage 0.6). Everything else ⇒ `node`. */
export const HUB_BODY_NODE_TYPES: readonly string[] = [
  "root",
  "paragraph",
  "text",
  "heading",
  "quote",
  "list",
  "listitem",
  "link",
  "horizontalrule",
  "linebreak",
];

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `&#…` or `&name;` anywhere ⇒ entity. Linear. */
function hasEntity(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 38 /* & */) continue;
    const next = s.charCodeAt(i + 1);
    if (next === 35 /* # */) return true;
    let j = i + 1;
    while (j < s.length && (isAsciiLetter(s.charCodeAt(j)) || (j > i + 1 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57))) j++;
    if (j > i + 1 && j < s.length && s.charCodeAt(j) === 59 /* ; */) return true;
  }
  return false;
}

/**
 * POSITIVE URL allowlist for `link` nodes (Public Contracts "Kiểm thân bài (5)"):
 * `https://…`, `http://…`, `mailto:…`, `tel:…` (scheme case-insensitive), a path
 * starting with exactly one `/`, `#…`, `?…`. Rejected: any entity, `\`, any W
 * character, `//host`, relative paths, and every other scheme.
 */
export function isAllowedLinkUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 92 /* \ */ || isWs(c)) return false;
  }
  if (hasEntity(url)) return false;
  const lower = url.slice(0, 8).toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:") || lower.startsWith("tel:")) {
    return true;
  }
  const c0 = url.charCodeAt(0);
  if (c0 === 47 /* / */) return url.charCodeAt(1) !== 47;
  return c0 === 35 /* # */ || c0 === 63 /* ? */;
}

function linkUrlOf(n: Node): unknown {
  const f = n.fields;
  if (isNode(f)) return f.url;
  return n.url;
}

export type TreeCheck = { ok: true; nodes: number; jsonLength: number } | { ok: false; code: "node" | "url" };

/**
 * Step (5) on one Lexical editor state — ITERATIVE walk (a 100,000-level tree must
 * not overflow the stack): node type allowlist ⇒ `node`; link URL allowlist ⇒
 * `url`; node count > BODY_MAX_NODES ⇒ `node` (stops early); then the JSON length
 * > BODY_MAX_JSON_CHARS ⇒ `node`. First failure in document order wins.
 */
export function checkLexicalTree(lexical: unknown): TreeCheck {
  if (!isNode(lexical) || !isNode(lexical.root) || lexical.root.type !== "root") return { ok: false, code: "node" };
  const stack: unknown[] = [lexical.root];
  let nodes = 0;
  while (stack.length > 0) {
    const n = stack.pop();
    if (!isNode(n)) return { ok: false, code: "node" };
    nodes++;
    if (nodes > BODY_MAX_NODES) return { ok: false, code: "node" };
    const type = n.type;
    if (typeof type !== "string" || !HUB_BODY_NODE_TYPES.includes(type)) return { ok: false, code: "node" };
    if (type === "link" && !isAllowedLinkUrl(linkUrlOf(n))) return { ok: false, code: "url" };
    const kids = n.children;
    if (kids !== undefined) {
      if (!Array.isArray(kids)) return { ok: false, code: "node" };
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  let jsonLength: number;
  try {
    jsonLength = JSON.stringify(lexical).length;
  } catch {
    return { ok: false, code: "node" };
  }
  if (jsonLength > BODY_MAX_JSON_CHARS) return { ok: false, code: "node" };
  return { ok: true, nodes, jsonLength };
}

/**
 * Round-trip comparator (P-1b, frozen at Stage 0.6). Compared per node: `type`,
 * `format`, `tag`, `text`, `listType`, `indent`, `checked` (absent ≡ undefined),
 * `children`, and for links `fields.url` / `fields.newTab` / `fields.linkType`.
 * IGNORED: the link node `id` (random 24 hex on every conversion), `direction`,
 * `textFormat`, `textStyle`, and every other key. Iterative.
 */
const COMPARED_KEYS = ["type", "format", "tag", "text", "listType", "indent", "checked"] as const;
const COMPARED_LINK_FIELDS = ["url", "newTab", "linkType"] as const;

export function lexicalTreesEqual(a: unknown, b: unknown): boolean {
  if (!isNode(a) || !isNode(b)) return false;
  const stack: [unknown, unknown][] = [[a.root, b.root]];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [unknown, unknown];
    if (!isNode(x) || !isNode(y)) return false;
    for (const k of COMPARED_KEYS) if (x[k] !== y[k]) return false;
    if (x.type === "link" || x.type === "autolink") {
      const fx = isNode(x.fields) ? x.fields : {};
      const fy = isNode(y.fields) ? y.fields : {};
      for (const k of COMPARED_LINK_FIELDS) if (fx[k] !== fy[k]) return false;
    }
    const kx = x.children;
    const ky = y.children;
    if (kx === undefined && ky === undefined) continue;
    if (!Array.isArray(kx) || !Array.isArray(ky) || kx.length !== ky.length) return false;
    for (let i = 0; i < kx.length; i++) stack.push([kx[i], ky[i]]);
  }
  return true;
}

// ── The two functions that run inside the vm call ─────────────────────────────

export type ConvertFailReason = "too_slow" | "unstable" | "ws_run" | "link" | "url" | "node";

export type ConvertResult =
  | { ok: true; lexical: unknown; markdownOut: string; nodes: number; jsonLength: number }
  | { ok: false; reason: ConvertFailReason; error?: { name: string; code?: string } };

export interface ConvertCoreArgs extends BodyConverters {
  /** The body AFTER the pure checks (trimmed, non-empty). */
  md: string;
}

/**
 * (4) md → lex1 → (5) tree check on lex1 (type allowlist, URL allowlist — the ONLY
 * gate for schemes the exporter silently rewrites to `https://`, OQ50 — and tree
 * caps) → md1 (empty export for a body with content ⇒ `node`) → (6) W-run + link
 * scan on md1 → gate F: lex2 = import(md1), md2 = export(lex2), md2 !== md1 ⇒
 * `unstable` → tree check again on lex2, the tree that is STORED (OQ13).
 * A throw propagates to the caller (mapped to `node`, or `too_slow` on timeout).
 */
export function convertCore(a: ConvertCoreArgs): ConvertResult {
  const lex1 = a.toLexical(a.md);
  const t1 = checkLexicalTree(lex1);
  if (!t1.ok) return { ok: false, reason: t1.code };
  const md1 = a.toMarkdown(lex1);
  if (typeof md1 !== "string" || md1.trim() === "") return { ok: false, reason: "node" };
  const exported = checkExportedMarkdown(md1);
  if (!exported.ok) return { ok: false, reason: exported.code };
  const lex2 = a.toLexical(md1);
  const md2 = a.toMarkdown(lex2);
  if (md2 !== md1) return { ok: false, reason: "unstable" };
  const t2 = checkLexicalTree(lex2);
  if (!t2.ok) return { ok: false, reason: t2.code };
  return { ok: true, lexical: lex2, markdownOut: md1, nodes: t2.nodes, jsonLength: t2.jsonLength };
}

export interface RoundTripCoreArgs extends BodyConverters {
  /** A stored, NON-empty Lexical body. */
  lexical: unknown;
}

/**
 * Is a stored body a structural fixed point of export → import (D6)? md =
 * export(body), back = import(md), compared with `lexicalTreesEqual`. An export
 * that is empty for a body with content is NOT safe.
 */
export function roundTripCore(a: RoundTripCoreArgs): boolean {
  const md = a.toMarkdown(a.lexical);
  if (typeof md !== "string" || md.trim() === "") return false;
  const back = a.toLexical(md);
  return lexicalTreesEqual(a.lexical, back);
}
