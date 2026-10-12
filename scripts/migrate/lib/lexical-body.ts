/**
 * HTML -> Lexical for the GTP import (gtp-launch P4, C3 checklist; a COPY of
 * the gcv approach, `import-gcv-legacy.ts` is left untouched). The sections
 * path produces only escaped `<h2>`/`<p>` HTML, so the result holds only root,
 * paragraph, heading and text nodes (S-20). Helpers here also walk a stored
 * Lexical tree for parity and the second pass.
 */
import { JSDOM } from "jsdom";
import { convertHTMLToLexical } from "@payloadcms/richtext-lexical";
import type { SanitizedServerEditorConfig } from "@payloadcms/richtext-lexical";

export interface LexicalNode {
  type?: string;
  text?: string;
  children?: LexicalNode[];
  [k: string]: unknown;
}
export interface LexicalState {
  root: { type: "root"; children: LexicalNode[]; direction: null | string; format: string; indent: number; version: number };
}

export function htmlToLexical(editorConfig: SanitizedServerEditorConfig, html: string): LexicalState | undefined {
  if (!html.trim()) return undefined;
  const state = convertHTMLToLexical({ editorConfig, html, JSDOM }) as unknown as LexicalState;
  const kept = (state?.root?.children ?? []).filter((n) => {
    if (n.type !== "paragraph") return true;
    const kids = n.children ?? [];
    return kids.length > 0 && !kids.every((k) => k.type === "text" && !(k.text ?? "").trim());
  });
  if (!kept.length) return undefined;
  return { root: { type: "root", children: kept, direction: null, format: "", indent: 0, version: 1 } };
}

export function nodeTypes(state: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (n: LexicalNode | undefined) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.type === "string") out.add(n.type);
    for (const c of n.children ?? []) walk(c);
  };
  walk((state as LexicalState | undefined)?.root as unknown as LexicalNode);
  return out;
}

function textOf(n: LexicalNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "linebreak") return "\n";
  return (n.children ?? []).map(textOf).join("");
}

/** Top-level blocks as {type, text}. */
export function blocks(state: unknown): { type: string; text: string }[] {
  return ((state as LexicalState | undefined)?.root?.children ?? []).map((n) => ({ type: String(n.type), text: textOf(n) }));
}

export function plainText(state: unknown): string {
  return blocks(state).map((b) => b.text).join("\n");
}

/** Replace exact substrings inside text nodes (second pass). Returns the count replaced. */
export function replaceInText(state: LexicalState, replacements: ReadonlyMap<string, string>): number {
  let n = 0;
  const walk = (node: LexicalNode) => {
    if (node.type === "text" && typeof node.text === "string") {
      for (const [from, to] of replacements) {
        if (node.text.includes(from)) {
          node.text = node.text.split(from).join(to);
          n++;
        }
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const c of state.root.children) walk(c);
  return n;
}
