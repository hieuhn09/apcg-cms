/**
 * Body assembly of the VowAsia legacy import (Amendment 4 §4.2.2/§4.2.3, B-3). Pure.
 *
 * `body_sections` is an array of `{heading, body}` or `{heading, body, image}`
 * (measured, Q3). Elements are processed in array order; inside ONE element the
 * order is fixed: heading -> H2, then the image -> `upload` node, then `body.en`
 * -> paragraphs. `body.en` is TEXT, not HTML (the GTP `sectionsToHtml`
 * semantics): it is split on blank lines into paragraphs and written as Lexical
 * TEXT nodes, so `<`, `>` and `&` stay literal characters and can never become
 * markup. The Lexical tree is built directly (heading / paragraph / text /
 * upload nodes only); no HTML converter is involved, so no `<img>` ever reaches
 * the Lexical HTML import (U3) and an upload node always carries a Media id.
 *
 * Links in the text are NOT changed here. They are extracted with ONE shared
 * extractor (`extractLinks`, also used by rewrite-links, E16) and classified:
 * `old-site-article` (host vowasia.com / www.vowasia.com, path /article/<slug>)
 * or `external`. An absolute URL on an old IMAGE host inside the text is not a
 * link: it is reported (`oldHostInText`) and the importer rejects the row,
 * because a body must never keep an old image host (post-check).
 */
import { createHash } from "node:crypto";
import { URL_IN_TEXT } from "./image-refs";

export type Id = number | string;

export interface BodyImage {
  url: string;
  alt: string;
  credit: string;
}

export interface BodySection {
  heading: string | null;
  image: BodyImage | null;
  paragraphs: string[];
}

export type LinkClass = "old-site-article" | "external";

export interface BodyLink {
  url: string;
  cls: LinkClass;
  /** Legacy slug from `/article/<slug>` (old-site-article only). */
  legacySlug?: string;
}

export type BodyPlan =
  | { ok: true; sections: BodySection[]; imageUrls: string[]; links: BodyLink[]; htmlLike: boolean; oldHostInText: boolean; emptySections: number }
  | { ok: false; reason: "bodyShape" | "bodyImageShape" };

export interface LexicalNode {
  type: string;
  children?: LexicalNode[];
  [k: string]: unknown;
}
export interface LexicalState {
  root: { type: "root"; children: LexicalNode[]; direction: null | "ltr"; format: ""; indent: 0; version: 1 };
}

const OLD_SITE_HOSTS = new Set(["vowasia.com", "www.vowasia.com"]);
const OLD_ARTICLE_PATH = /^\/article\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const HTML_LIKE = /<\/?[a-z][^>]*>/i;

function normaliseWs(s: string): string {
  return s.replace(/[   ]/g, " ").replace(/[ \t]+/g, " ").trim();
}

/** `string` or `{en: string}`; null/undefined -> ""; anything else -> undefined (shape error). */
function textOf(v: unknown): string | undefined {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && !Array.isArray(v)) {
    const en = (v as Record<string, unknown>).en;
    if (en === undefined || en === null) return "";
    return typeof en === "string" ? en : undefined;
  }
  return undefined;
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Classify one URL (exact string as extracted). */
export function classifyLink(url: string): BodyLink {
  try {
    const u = new URL(url);
    if ((u.protocol === "https:" || u.protocol === "http:") && OLD_SITE_HOSTS.has(u.hostname.toLowerCase()) && u.port === "") {
      const m = OLD_ARTICLE_PATH.exec(u.pathname);
      if (m && !u.search && !u.hash) return { url, cls: "old-site-article", legacySlug: m[1] as string };
    }
  } catch {
    /* not a URL: external */
  }
  return { url, cls: "external" };
}

/** Every absolute http(s) URL in a text, trailing sentence punctuation removed (the snapshot collector's rule). */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    if (URL.canParse(raw)) out.push(raw);
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The shared link extractor (E16): links in a text, image-host URLs excluded when `imageHosts` is given. */
export function extractLinks(text: string, imageHosts: readonly string[] = []): BodyLink[] {
  return extractUrls(text)
    .filter((u) => !imageHosts.includes(hostOf(u) ?? ""))
    .map(classifyLink);
}

function paragraphsOf(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => normaliseWs(p.replace(/\n/g, " ")))
    .filter(Boolean);
}

export function planBody(raw: unknown, articleTitle: string, imageHosts: readonly string[]): BodyPlan {
  let v = raw;
  if (typeof v === "string") {
    if (v.trim() === "") v = [];
    else {
      try {
        v = JSON.parse(v);
      } catch {
        return { ok: false, reason: "bodyShape" };
      }
    }
  }
  if (v === null || v === undefined) v = [];
  if (!Array.isArray(v)) return { ok: false, reason: "bodyShape" };
  const sections: BodySection[] = [];
  const imageUrls: string[] = [];
  const links: BodyLink[] = [];
  let htmlLike = false;
  let oldHostInText = false;
  let emptySections = 0;
  for (const el of v) {
    if (!el || typeof el !== "object" || Array.isArray(el)) return { ok: false, reason: "bodyShape" };
    const rec = el as Record<string, unknown>;
    const h = textOf(rec.heading);
    const b = textOf(rec.body);
    if (h === undefined || b === undefined) return { ok: false, reason: "bodyShape" };
    let image: BodyImage | null = null;
    if (rec.image !== undefined && rec.image !== null) {
      const im = rec.image as Record<string, unknown>;
      if (typeof im !== "object" || Array.isArray(im) || typeof im.url !== "string" || im.url.trim() === "") return { ok: false, reason: "bodyImageShape" };
      image = { url: im.url.trim(), alt: nonEmpty(im.alt) ?? nonEmpty(im.caption) ?? articleTitle, credit: nonEmpty(im.credit) ?? "" };
      imageUrls.push(image.url);
    }
    const heading = normaliseWs(h.replace(/\r?\n/g, " ")) || null;
    const paragraphs = paragraphsOf(b);
    if (!heading && !image && !paragraphs.length) {
      emptySections++;
      continue;
    }
    for (const t of [heading ?? "", ...paragraphs]) {
      if (HTML_LIKE.test(t)) htmlLike = true;
      for (const u of extractUrls(t)) if (imageHosts.includes(hostOf(u) ?? "")) oldHostInText = true;
      links.push(...extractLinks(t, imageHosts));
    }
    sections.push({ heading, image, paragraphs });
  }
  return { ok: true, sections, imageUrls, links, htmlLike, oldHostInText, emptySections };
}

const textNode = (text: string): LexicalNode => ({ type: "text", text, detail: 0, format: 0, mode: "normal", style: "", version: 1 });

function uploadNode(mediaId: Id, seed: string, index: number): LexicalNode {
  return {
    type: "upload",
    version: 3,
    format: "",
    id: createHash("sha1").update(`${seed}:${index}`).digest("hex").slice(0, 24),
    fields: {},
    relationTo: "media",
    value: mediaId,
  };
}

export interface BuildOptions {
  /** Media id of every body image that is used (store ok + Media created or reused). */
  mediaIdByUrl: ReadonlyMap<string, Id>;
  /** Body image URLs with a store-level failure (C6): their section is dropped. */
  failedUrls: ReadonlySet<string>;
  /** Stable seed for upload node ids (the legacy id). */
  nodeSeed: string;
}

/** Sections -> Lexical state. A section whose image failed at store level is dropped and `draft` is set. */
export function buildLexical(sections: readonly BodySection[], o: BuildOptions): { state: LexicalState | undefined; draft: boolean; droppedImageSections: number } {
  const children: LexicalNode[] = [];
  let dropped = 0;
  let uploads = 0;
  for (const s of sections) {
    if (s.image && o.failedUrls.has(s.image.url)) {
      dropped++;
      continue;
    }
    if (s.heading) children.push({ type: "heading", tag: "h2", children: [textNode(s.heading)], direction: "ltr", format: "", indent: 0, version: 1 });
    if (s.image) {
      const id = o.mediaIdByUrl.get(s.image.url);
      if (id === undefined || id === null) throw new Error(`body: no Media id for a body image (section ${children.length}); refusing to write a pending upload node.`);
      children.push(uploadNode(id, o.nodeSeed, uploads++));
    }
    for (const p of s.paragraphs) children.push({ type: "paragraph", children: [textNode(p)], direction: "ltr", format: "", indent: 0, textFormat: 0, textStyle: "", version: 1 });
  }
  const state: LexicalState | undefined = children.length ? { root: { type: "root", children, direction: "ltr", format: "", indent: 0, version: 1 } } : undefined;
  return { state, draft: dropped > 0, droppedImageSections: dropped };
}

function walk(n: unknown, visit: (node: LexicalNode) => void): void {
  if (!n || typeof n !== "object") return;
  const node = n as LexicalNode;
  visit(node);
  for (const c of node.children ?? []) walk(c, visit);
}

/** Upload nodes without a Media id (pending). */
export function pendingUploadCount(state: unknown): number {
  let n = 0;
  walk((state as LexicalState | undefined)?.root, (node) => {
    if (node.type === "upload" && (node.value === undefined || node.value === null || node.value === "")) n++;
  });
  return n;
}

/** Media ids of every upload node. */
export function uploadIds(state: unknown): string[] {
  const out: string[] = [];
  walk((state as LexicalState | undefined)?.root, (node) => {
    if (node.type === "upload" && node.value !== undefined && node.value !== null) {
      const v = node.value as unknown;
      out.push(typeof v === "object" ? String((v as Record<string, unknown>).id) : String(v));
    }
  });
  return out;
}

/** Distinct old image hosts still referenced by any string in the tree. */
export function oldHostsLeft(state: unknown, hosts: readonly string[]): string[] {
  const found = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const u of extractUrls(v)) {
        const h = hostOf(u);
        if (h && hosts.includes(h)) found.add(h);
      }
      return;
    }
    if (Array.isArray(v)) for (const x of v) scan(x);
    else if (v && typeof v === "object") for (const x of Object.values(v)) scan(x);
  };
  scan(state);
  return [...found];
}

/** Text of every text node, joined by newlines (for link extraction on stored bodies). */
export function textNodes(state: unknown): LexicalNode[] {
  const out: LexicalNode[] = [];
  walk((state as LexicalState | undefined)?.root, (node) => {
    if (node.type === "text" && typeof node.text === "string") out.push(node);
  });
  return out;
}
