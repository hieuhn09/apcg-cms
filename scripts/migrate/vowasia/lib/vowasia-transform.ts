/**
 * Row transform of the VowAsia legacy import (Amendment 4, B-2). Pure.
 *
 *  - Q2: `title` and `excerpt` are jsonb `{en: string}` (measured 370/370);
 *    any other shape is REJECTED (`titleShape` / `excerptShape`), never guessed.
 *  - C2 status table: published / archived kept; draft and scheduled -> draft;
 *    rejected -> skipped (never imported; 410 in the redirect map); anything
 *    else -> rejected `statusUnknown`.
 *  - C6: no cover image -> the article is imported as draft (`noCover`); the
 *    original status is kept for the report and the redirect rules (Q9).
 *  - C7: `published_at` missing -> `created_at`; counted on two bases (C1).
 *  - C8: (section, subsection) through `mapTaxonomy` (exact table, reject otherwise).
 *  - C4 / Q10: the tag comes from the target sub-section (5 mapped, all others none);
 *    the legacy `tags` column is ignored. Old SEO fields are never read (C5).
 */
import { isoOrNull } from "../../lib/gtp-transform";
import { mapTaxonomy } from "./vowasia-mapping";

export type LegacyStatus = "published" | "archived" | "draft" | "scheduled";
export type CentralStatus = "published" | "archived" | "draft";

/** One snapshot article row, read through the role -> column map (never by guessed column names). */
export interface LegacyArticle {
  legacyId: string;
  slug: unknown;
  status: unknown;
  section: unknown;
  subsection: unknown;
  title: unknown;
  excerpt: unknown;
  body: unknown;
  image: unknown;
  imageCredit: unknown;
  tags: unknown;
  createdAt: unknown;
  publishedAt: unknown;
  updatedAt: unknown;
}

/** Q10: target sub-section -> tag slug. Every other sub-section (and none) gets no tag. */
export const TAG_BY_SUBSECTION: Readonly<Record<string, string>> = Object.freeze({
  honeymoons: "honeymoons",
  "hotels-resorts": "wedding-venues",
  "gowns-attire": "bridal-fashion",
  "rings-jewellery": "bridal-fashion",
  "industry-news": "wedding-industry",
});

export function tagFor(subSection: string | null | undefined): string | null {
  if (!subSection) return null;
  return Object.prototype.hasOwnProperty.call(TAG_BY_SUBSECTION, subSection) ? (TAG_BY_SUBSECTION[subSection] as string) : null;
}

/** Q2: `{en: string}` only. */
export function readEn(v: unknown): { ok: true; text: string } | { ok: false } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false };
  const en = (v as Record<string, unknown>).en;
  if (typeof en !== "string") return { ok: false };
  return { ok: true, text: en.trim() };
}

export type StatusDecision = { kind: "import"; from: LegacyStatus; status: CentralStatus } | { kind: "skip"; reason: "rejected" } | { kind: "reject"; reason: "statusUnknown" };

export function statusDecision(raw: unknown): StatusDecision {
  switch (raw) {
    case "published":
      return { kind: "import", from: "published", status: "published" };
    case "archived":
      return { kind: "import", from: "archived", status: "archived" };
    case "draft":
      return { kind: "import", from: "draft", status: "draft" };
    case "scheduled":
      return { kind: "import", from: "scheduled", status: "draft" };
    case "rejected":
      return { kind: "skip", reason: "rejected" };
    default:
      return { kind: "reject", reason: "statusUnknown" };
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function publishedAtFor(publishedAt: unknown, createdAt: unknown): { iso: string | null; fellBack: boolean } {
  const p = isoOrNull(publishedAt);
  if (p) return { iso: p, fellBack: false };
  return { iso: isoOrNull(createdAt), fellBack: true };
}

export type DraftReason = "noCover" | "storeFailure";

export interface ImportPlanRow {
  kind: "import";
  legacyId: string;
  slug: string;
  oldStatus: LegacyStatus;
  /** Status written to Central (before store-level image failures, which the body/media plan adds). */
  status: CentralStatus;
  draftReasons: DraftReason[];
  pillar: string;
  subSection: string | null;
  tag: string | null;
  title: string;
  excerpt: string;
  publishedAt: string | null;
  publishedAtFellBack: boolean;
  coverUrl: string | null;
  coverCredit: string;
  createdAt: string | null;
  updatedAt: string | null;
  body: unknown;
}

export type TransformResult =
  | ImportPlanRow
  | { kind: "skip"; legacyId: string; slug: string; oldStatus: "rejected"; reason: "rejected"; section: unknown }
  | { kind: "reject"; legacyId: string; slug: string; oldStatus: unknown; reason: string; section: unknown };

export function transformRow(a: LegacyArticle): TransformResult {
  const slug = text(a.slug);
  const sd = statusDecision(a.status);
  if (sd.kind === "skip") return { kind: "skip", legacyId: a.legacyId, slug, oldStatus: "rejected", reason: "rejected", section: a.section };
  if (sd.kind === "reject") return { kind: "reject", legacyId: a.legacyId, slug, oldStatus: a.status, reason: sd.reason, section: a.section };
  const rej = (reason: string): TransformResult => ({ kind: "reject", legacyId: a.legacyId, slug, oldStatus: sd.from, reason, section: a.section });
  const title = readEn(a.title);
  if (!title.ok) return rej("titleShape");
  const excerpt = readEn(a.excerpt);
  if (!excerpt.ok) return rej("excerptShape");
  const tx = mapTaxonomy(a.section, a.subsection);
  if (!tx.ok) return rej(tx.reason);
  const cover = text(a.image);
  const draftReasons: DraftReason[] = cover ? [] : ["noCover"];
  const pub = publishedAtFor(a.publishedAt, a.createdAt);
  return {
    kind: "import",
    legacyId: a.legacyId,
    slug,
    oldStatus: sd.from,
    status: draftReasons.length ? "draft" : sd.status,
    draftReasons,
    pillar: tx.pillar,
    subSection: tx.subSection,
    tag: tagFor(tx.subSection),
    title: title.text,
    excerpt: excerpt.text,
    publishedAt: pub.iso,
    publishedAtFellBack: pub.fellBack,
    coverUrl: cover || null,
    coverCredit: text(a.imageCredit),
    createdAt: isoOrNull(a.createdAt),
    updatedAt: isoOrNull(a.updatedAt),
    body: a.body,
  };
}

/** C1/C7: rows without `published_at`, over ALL rows and over rows that will be imported (not rejected/skipped). */
export function dateFallbackCounts(rows: readonly LegacyArticle[]): { all: number; imported: number } {
  let all = 0;
  let imported = 0;
  for (const r of rows) {
    if (isoOrNull(r.publishedAt)) continue;
    all++;
    if (transformRow(r).kind === "import") imported++;
  }
  return { all, imported };
}

/** Snapshot row (column names) -> LegacyArticle through the snapshot's role map. */
export function rowFromSnapshot(row: Record<string, unknown>, roles: Readonly<Record<string, string>>, idColumn: string): LegacyArticle {
  const col = (role: string): unknown => {
    const c = roles[role];
    return c === undefined ? undefined : row[c];
  };
  return {
    legacyId: String(row[idColumn]),
    slug: col("slug"),
    status: col("status"),
    section: col("section"),
    subsection: col("subsection"),
    title: col("title"),
    excerpt: col("excerpt"),
    body: col("body"),
    image: col("image"),
    imageCredit: col("imageCredit"),
    tags: col("tags"),
    createdAt: col("createdAt"),
    publishedAt: col("publishedAt"),
    updatedAt: col("updatedAt"),
  };
}
