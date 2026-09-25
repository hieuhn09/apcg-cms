/**
 * Field allowlist + response sanitizer for `GET /api/hub/articles/{id}`
 * (APCGHub P4 / CMS-4) — the same two independent barriers as the CMS-1/CMS-2
 * list route (`HUB_ARTICLE_SELECT` + `sanitizeHubArticle`):
 *
 *   1. `HUB_ARTICLE_DETAIL_SELECT` — what Payload is asked to fetch (allowlist
 *      mode: a future Articles field stays invisible until named here).
 *   2. `sanitizeHubArticleDetail` — builds a FRESH object from the fetched doc,
 *      field by field, never spreading it. Whatever depth-2 population drags in
 *      (the tenant document, Media's tenant, Users fields, engine documents)
 *      cannot reach the wire unless this function names it.
 *
 * NEVER emitted: lastEngine, assignedTo, lastEditedBy, translationStatus, any
 * Tenants field other than the slug (taken from the narrowed tenant, not from
 * the doc), any Users / ContentEngines field, any Authors field other than
 * {name, role}. `body` is fetched but only ever leaves as `bodyMarkdown`.
 */

import { resolveArticleVideo, type ResolvedArticleVideo } from "@/lib/article-video";
import type { HubBodyState } from "@/lib/hub-article-markdown";

export const HUB_ARTICLE_DETAIL_SELECT = {
  id: true,
  tenant: true, // for the tenant-ownership check only; never emitted
  title: true,
  slug: true,
  dek: true,
  body: true,
  workflowStatus: true,
  publishedAt: true,
  updatedAt: true,
  contentType: true,
  readMin: true,
  takeaways: true,
  pillar: true,
  subSection: true,
  author: true,
  coAuthors: true,
  tags: true,
  views: true,
  heroImage: true,
  video: true,
  videoCaption: true,
  videoCredit: true,
  videoDescription: true,
} as const;

/** Depth 2: body Upload nodes need ≥1 (FEASIBILITY H2); `resolveArticleVideo`
 *  expects the single-article depth 2 (video + heroImage sizes). */
export const HUB_ARTICLE_DETAIL_DEPTH = 2;

type Slugged = { slug: string | null; title: string | null };
type Person = { name: string | null; role: string | null };

export interface HubArticleDetail {
  id: number | string;
  tenant: { slug: string };
  title: string | null;
  slug: string | null;
  dek: string | null;
  workflowStatus: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  contentType: string | null;
  readMin: number | null;
  takeaways: string[];
  pillar: Slugged | null;
  subSection: Slugged | null;
  author: Person | null;
  coAuthors: Person[];
  tags: Slugged[];
  views: number | null;
  heroImage: { url: string | null; alt: string | null; caption: string | null; credit: string | null } | null;
  video: ResolvedArticleVideo | null;
  bodyMarkdown: string;
  bodyState: HubBodyState;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A relation that did not populate (id only / deleted target) ⇒ null. */
function slugged(v: unknown): Slugged | null {
  const o = obj(v);
  return o ? { slug: str(o.slug), title: str(o.title) } : null;
}
function person(v: unknown): Person | null {
  const o = obj(v);
  return o ? { name: str(o.name), role: str(o.role) } : null;
}
function list<T>(v: unknown, pick: (x: unknown) => T | null): T[] {
  return Array.isArray(v) ? v.map(pick).filter((x): x is T => x !== null) : [];
}

/** Stored as one textarea, one takeaway per line (intake joins an array with "\n"). */
function takeaways(v: unknown): string[] {
  return typeof v === "string" ? v.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

function heroImage(v: unknown): HubArticleDetail["heroImage"] {
  const o = obj(v);
  return o ? { url: str(o.url), alt: str(o.alt), caption: str(o.caption), credit: str(o.credit) } : null;
}

export function sanitizeHubArticleDetail(
  doc: Record<string, unknown>,
  tenantSlug: string,
  body: { bodyMarkdown: string; bodyState: HubBodyState },
): HubArticleDetail {
  return {
    id: doc.id as number | string,
    tenant: { slug: tenantSlug },
    title: str(doc.title),
    slug: str(doc.slug),
    dek: str(doc.dek),
    workflowStatus: str(doc.workflowStatus),
    publishedAt: str(doc.publishedAt),
    updatedAt: str(doc.updatedAt),
    contentType: str(doc.contentType),
    readMin: num(doc.readMin),
    takeaways: takeaways(doc.takeaways),
    pillar: slugged(doc.pillar),
    subSection: slugged(doc.subSection),
    author: person(doc.author),
    coAuthors: list(doc.coAuthors, person),
    tags: list(doc.tags, slugged),
    // NULL in the DB stays null — not coerced to 0 (same as the list route).
    views: num(doc.views),
    heroImage: heroImage(doc.heroImage),
    video: resolveArticleVideo(doc),
    bodyMarkdown: body.bodyMarkdown,
    bodyState: body.bodyState,
  };
}
