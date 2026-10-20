/**
 * PURE transforms for the GTP legacy import (gtp-launch P4, A2, A11-S19,
 * A12-N10, A13). No Payload, no DB, no network: every function here is unit
 * tested in `gtp-transform.test.ts`.
 */
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { Mapping } from "./gtp-mapping";

/* ── small helpers ─────────────────────────────────────────────────────── */

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** jsonb `{en: "..."}` (or a plain string) -> trimmed English text. */
export function enText(v: unknown): string {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{")) {
      try {
        return enText(JSON.parse(t));
      } catch {
        return t;
      }
    }
    return t;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return str((v as Record<string, unknown>).en);
  return "";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Whitespace + NBSP normalisation (documented for the S-20 equality). */
export function normaliseWs(s: string): string {
  return s.replace(/[   ]/g, " ").replace(/[ \t]+/g, " ").trim();
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/* ── status (A11-S19) ──────────────────────────────────────────────────── */

export type ImportStatus = "published" | "draft" | "archived" | "hidden";
export type StatusDecision = { kind: "import"; status: ImportStatus } | { kind: "skip"; reason: string } | { kind: "reject"; reason: string };

export function mapStatus(raw: unknown, m: Pick<Mapping, "status">): StatusDecision {
  const key = str(raw).toLowerCase().replace(/\s+/g, " ");
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.status.map)) map[k.trim().toLowerCase()] = v;
  const target = map[key];
  if (target === "SKIP") return { kind: "skip", reason: `status ${key}` };
  if (target) return { kind: "import", status: target as ImportStatus };
  if (m.status.unknown === "SKIP") return { kind: "skip", reason: `unknown status ${key || "(empty)"}` };
  if (m.status.unknown === "draft") return { kind: "import", status: "draft" };
  return { kind: "reject", reason: `unknown status ${key || "(empty)"}` };
}

/** The single statement of record for the write flags (A11-S19 table). */
export function statusWrite(s: ImportStatus): { draft: boolean; workflowStatus: ImportStatus; _status?: "published" | "draft" } {
  if (s === "published") return { draft: false, workflowStatus: "published", _status: "published" };
  if (s === "draft") return { draft: true, workflowStatus: "draft", _status: "draft" };
  return { draft: false, workflowStatus: s }; // archived / hidden: _status not set by the importer (read back, F2b)
}

/* ── taxonomy (A2) ─────────────────────────────────────────────────────── */

export interface Taxonomy {
  pillar: string;
  subSection?: string;
  rehomed: boolean;
  oldSection: string;
  oldSub: string;
}
export type TaxonomyDecision = { ok: true; t: Taxonomy } | { ok: false; reason: string };

export function resolveTaxonomy(section: unknown, subsection: unknown, m: Pick<Mapping, "categories">): TaxonomyDecision {
  const sec = str(section).toLowerCase();
  const sub = str(subsection).toLowerCase();
  const override = m.categories.map[`${sec}/${sub}`] ?? (sub === "" ? m.categories.map[sec] : undefined) ?? m.categories.map[`${sec}/*`];
  if (override) {
    return {
      ok: true,
      t: { pillar: override.pillar, ...(override.subSection ? { subSection: override.subSection } : {}), rehomed: override.pillar !== sec || (override.subSection ?? "") !== sub, oldSection: sec, oldSub: sub },
    };
  }
  if (!sec) {
    if (m.categories.unmapped === "fallback" && m.categories.fallback) {
      const f = m.categories.fallback;
      return { ok: true, t: { pillar: f.pillar, ...(f.subSection ? { subSection: f.subSection } : {}), rehomed: true, oldSection: sec, oldSub: sub } };
    }
    return { ok: false, reason: "unmapped-category (empty section)" };
  }
  return { ok: true, t: { pillar: sec, ...(sub ? { subSection: sub } : {}), rehomed: false, oldSection: sec, oldSub: sub } };
}

/* ── tags (A12-N10) ────────────────────────────────────────────────────── */

export function titleCaseWords(s: string): string {
  return s
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface TagRef {
  slug: string;
  title: string;
}

/** `format-<v>` for the include list only; `news`/`none`/others skipped. */
export function formatTag(format: unknown, m: Pick<Mapping, "formatTags">): TagRef | null {
  const v = str(format).toLowerCase();
  if (!m.formatTags.enabled || !v || !m.formatTags.include.includes(v)) return null;
  return { slug: `format-${v}`, title: titleCaseWords(v) };
}

export function tagSlugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function legacyTags(raw: unknown, m: Pick<Mapping, "tags">): TagRef[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.startsWith("{") ? raw.slice(1, -1).split(",") : [];
  const out: TagRef[] = [];
  for (const item of list) {
    let slug = tagSlugify(String(item ?? "").replace(/^"|"$/g, ""));
    if (!slug) continue;
    slug = m.tags.renames[slug] ?? slug;
    if (m.tags.drop.includes(slug) || out.some((t) => t.slug === slug)) continue;
    if (m.tags.keepOnly && !m.tags.keepOnly.includes(slug)) continue;
    out.push({ slug, title: titleCaseWords(slug.replace(/-/g, " ")) });
    if (out.length >= m.tags.maxPerArticle) break;
  }
  return out;
}

/* ── countries ─────────────────────────────────────────────────────────── */

export interface CountryRef {
  id: number | string;
  code: string;
  name: string;
}
export function resolveCountries(raw: unknown, all: readonly CountryRef[], match: "code" | "name" | "either"): { ids: (number | string)[]; unmatched: string[] } {
  const values = Array.isArray(raw) ? raw.map((x) => String(x ?? "")) : [];
  const ids: (number | string)[] = [];
  const unmatched: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key) continue;
    const hit = all.find((c) => ((match === "code" || match === "either") && c.code.trim().toLowerCase() === key) || ((match === "name" || match === "either") && c.name.trim().toLowerCase() === key));
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else unmatched.push(v.trim());
  }
  return { ids, unmatched };
}

/* ── takeaways, readMin, dates, author, credit ─────────────────────────── */

export function takeawaysText(raw: unknown): string | undefined {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return str(v) || undefined;
    }
  }
  if (!Array.isArray(v)) return undefined;
  const lines = v.map((x) => (typeof x === "string" ? normaliseWs(x) : enText(x))).filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

export function readMinFor(readMinutes: unknown, words: number, wpm: number): { readMin: number; computed: boolean } {
  const n = typeof readMinutes === "number" ? readMinutes : Number(readMinutes);
  if (Number.isFinite(n) && n >= 1) return { readMin: Math.round(n), computed: false };
  return { readMin: Math.max(1, Math.ceil(words / wpm)), computed: true };
}

export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function publishedAtFor(publishedAt: unknown, createdAt: unknown): { iso: string | null; fellBack: boolean } {
  const p = isoOrNull(publishedAt);
  if (p) return { iso: p, fellBack: false };
  return { iso: isoOrNull(createdAt), fellBack: true };
}

/** The importer's OWN "Photo:" strip (shared stripCreditLabel only removes "credit:"). */
export function stripPhotoLabel(credit: unknown): string {
  return str(credit).replace(/^photo\s*:\s*/i, "").trim();
}

/* ── body (A2: sections) ───────────────────────────────────────────────── */

export interface SectionsResult {
  html: string;
  droppedSections: number;
  tagLikeText: boolean;
  paragraphs: string[];
  headings: string[];
  text: string;
}

/**
 * Regroup one stored paragraph into paragraphs of whole sentences, each at most `maxChars` long
 * (a single longer sentence stays on its own). This is how the AER site displayed its one-block
 * sections; on 161 real sections it reproduces the old paragraph breaks exactly in 150.
 */
export function reflowParagraph(p: string, maxChars: number): string[] {
  const sentences = p.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + 1 + s.length > maxChars) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Turn `body_sections` into escaped HTML (h2 + p). Tag-like text can never become a tag. */
export function sectionsToHtml(raw: unknown, lineBreaks: "space" | "br" = "space", reflowMaxChars?: number): SectionsResult {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = [];
    }
  }
  const sections = Array.isArray(v) ? v : [];
  const parts: string[] = [];
  const paragraphs: string[] = [];
  const headings: string[] = [];
  let dropped = 0;
  let tagLike = false;
  for (const s of sections) {
    const rec = (s ?? {}) as Record<string, unknown>;
    const heading = normaliseWs(enText(rec.heading));
    const body = enText(rec.body).replace(/\r\n?/g, "\n");
    const paras = body
      .split(/\n{2,}/)
      .map((p) => normaliseWs(lineBreaks === "space" ? p.replace(/\n/g, " ") : p))
      .filter(Boolean)
      .flatMap((p) => (reflowMaxChars ? reflowParagraph(p, reflowMaxChars) : [p]));
    if (!heading && !paras.length) {
      dropped++;
      continue;
    }
    if (/[<>&]/.test(heading) || paras.some((p) => /[<>&]/.test(p))) tagLike = true;
    if (heading) {
      parts.push(`<h2>${escapeHtml(heading)}</h2>`);
      headings.push(heading);
    }
    for (const p of paras) {
      const html = lineBreaks === "br" ? escapeHtml(p).replace(/\n/g, "<br>") : escapeHtml(p);
      parts.push(`<p>${html}</p>`);
      paragraphs.push(p);
    }
  }
  return { html: parts.join(""), droppedSections: dropped, tagLikeText: tagLike, paragraphs, headings, text: [...headings, ...paragraphs].join("\n") };
}

/** Generic-mode sniff (safety net; the real source is `sections`). */
export function sniffBodyFormat(text: string): "lexical-json" | "other-json" | "html" | "markdown" | "plain" | "empty" | "sections" {
  const t = text.trim();
  if (!t) return "empty";
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t) as unknown;
      if (Array.isArray(j) && j.every((x) => x && typeof x === "object" && ("body" in (x as object) || "heading" in (x as object)))) return "sections";
      if (j && typeof j === "object" && "root" in (j as object)) return "lexical-json";
      return "other-json";
    } catch {
      /* not json */
    }
  }
  if (/<p[\s>]/i.test(t) || /<\/(h[1-6]|div|ul|ol|table|blockquote)>/i.test(t)) return "html";
  if (/^#{1,6}\s|^\s*[-*]\s|\[[^\]]+\]\([^)]+\)/m.test(t)) return "markdown";
  return "plain";
}

/** Generic-mode HTML sanitizer (7.4); the sections path never produces tags from text. */
export function sanitizeLegacyHtml(html: string, opts: { allowedTags: readonly string[]; sponsored?: boolean }): { html: string; embedsFlattened: number } {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document;
  const allowed = new Set(opts.allowedTags.map((t) => t.toUpperCase()));
  const removeAll = new Set(["SCRIPT", "STYLE", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SVG", "MATH", "TEMPLATE", "NOSCRIPT"]);
  let embeds = 0;
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase();
      if (removeAll.has(tag)) {
        child.remove();
        continue;
      }
      if (tag === "IFRAME") {
        const src = child.getAttribute("src") ?? "";
        const p = doc.createElement("p");
        if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be|player\.vimeo\.com)\//.test(src)) p.textContent = src;
        embeds++;
        child.replaceWith(p);
        continue;
      }
      walk(child);
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (!["href", "src", "alt", "title", "colspan", "rowspan"].includes(name)) child.removeAttribute(attr.name);
        else if ((name === "href" || name === "src") && /^\s*(javascript|vbscript|data):/i.test(attr.value)) child.removeAttribute(attr.name);
      }
      if (tag === "A" && child.getAttribute("href")) {
        try {
          const u = new URL(child.getAttribute("href") as string);
          for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
          child.setAttribute("href", u.toString());
          child.setAttribute("rel", opts.sponsored ? "sponsored noopener noreferrer" : "noopener noreferrer");
        } catch {
          /* relative link: keep */
        }
      }
      if (!allowed.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
      }
    }
  };
  walk(doc.body);
  return { html: doc.body.innerHTML, embedsFlattened: embeds };
}

/** Rewrite old internal links using a normalised-path -> new-path map. Returns the count rewritten. */
export function rewriteInternalLinks(html: string, oldOrigin: string, map: (oldPath: string) => string | undefined): { html: string; rewritten: number } {
  let n = 0;
  const host = (() => {
    try {
      return new URL(oldOrigin).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const out = html.replace(/href="([^"]*)"/g, (all, href: string) => {
    let p: string | undefined;
    try {
      const u = new URL(href, oldOrigin);
      if (u.host.replace(/^www\./, "") === host) p = u.pathname;
    } catch {
      return all;
    }
    if (!p) return all;
    const to = map(p);
    if (!to) return all;
    n++;
    return `href="${to}"`;
  });
  return { html: out, rewritten: n };
}

/* ── media + parity helpers ────────────────────────────────────────────── */

/**
 * Stable media filename per source URL: `gtp-<sha1 8>-<basename>.<ext>`. The
 * basename never ends in `-<digits>` (Payload's upload renamer increments such a
 * suffix), and lookups must accept Payload's `-<n>` rename (`storedFilenameMatches`).
 */
export function stableFilename(url: string, prefix = "gtp"): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  let base = "image";
  try {
    base = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean).pop() || "image";
  } catch {
    /* keep default */
  }
  base = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  let ext = "jpg";
  const m = /\.(jpe?g|png|webp|gif|avif)$/.exec(base);
  if (m) {
    ext = m[1] as string;
    base = base.slice(0, -m[0].length);
  }
  base = base.replace(/\./g, "-").slice(-60).replace(/^-+|-+$/g, "") || "image";
  if (/[0-9]$/.test(base)) base += "-img";
  return `${prefix}-${hash}-${base}.${ext}`;
}

/** Does a stored media filename match the stable one, allowing Payload's `-<n>` rename? */
export function storedFilenameMatches(stored: string, stable: string): boolean {
  const dot = stable.lastIndexOf(".");
  const stem = stable.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ext = stable.slice(dot + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${stem}(-\\d+)?\\.${ext}$`).test(stored);
}

export function plainTextForParity(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKC")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function jaccard(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size && !tb.size) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Canonical form for collision REPORTS only (stored value stays exact). */
export function canonicalSourceUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    url.hash = "";
    url.host = url.host.toLowerCase();
    for (const k of [...url.searchParams.keys()]) if (/^utm_/i.test(k)) url.searchParams.delete(k);
    return url.toString();
  } catch {
    return u.trim();
  }
}

/** Provenance row (not stored in the CMS; written to provenance.ndjson). */
export function provenanceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { legacyId: row.id };
  for (const [k, v] of Object.entries(row)) {
    if (k === "migrate_source" || k === "editor_hold" || k === "citations" || k === "label" || k === "region" || k === "category" || /^ai_/.test(k) || /score/.test(k)) out[k] = v;
  }
  return out;
}

/** Hero URL host check helper: is the URL's host in the allow-list? */
export function hostAllowed(url: string, allow: readonly string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && allow.includes(u.host.toLowerCase());
  } catch {
    return false;
  }
}

/** Old URL of an article from the mapping template (`{section}`, `{sub}`, `{slug}`, `{id}`, `{yyyy}`). */
export function oldArticleUrl(template: string, v: { section: string; sub: string; slug: string; id: string; publishedAt?: string | null }): string {
  const yyyy = v.publishedAt ? v.publishedAt.slice(0, 4) : "";
  return template
    .replace(/\{section\}/g, v.section)
    .replace(/\{sub\}/g, v.sub)
    .replace(/\{category\}/g, v.section)
    .replace(/\{slug\}/g, v.slug)
    .replace(/\{id\}/g, v.id)
    .replace(/\{yyyy\}/g, yyyy)
    .replace(/\/{2,}/g, "/");
}
