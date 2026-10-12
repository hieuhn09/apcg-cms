/**
 * `GET /api/hub/articles/{id}?tenant=<slug>&view=edit` — the composer's edit view
 * (APCGHub P5.1; D13; PVL round 3 Gap 6 "TRIM"). Without `view=edit` the route is
 * byte-identical to CMS-4 and nothing here runs.
 *
 * Read order (the `editable` gate first; the latest draft is read only when needed):
 *   (i)  the MAIN table row (the route's ordinary read, plus `origin`) must be
 *        `origin === "manual"` AND `workflowStatus === "draft"`; otherwise
 *        `editable:false` and the latest draft is NOT read;
 *   (ii) the LATEST version (`findByID({ draft: true })`) must pass the same test
 *        AND be hub-authored (`isHubAuthoredDoc`).
 * `editable:false` ⇒ `article.*` stays the MAIN row (never a draft revision of a
 * published / non-hub article) and `edit` is ONLY `{ editable, editableReason }`.
 * `editable:true`  ⇒ EVERY field (`article.*`, `bodyMarkdown`, `edit.*`) comes from
 * the ONE latest read — never mixed with the main row.
 *
 * APCGHub P5.2 (K10): ONE added branch — the main row is a manual draft AND the latest
 * version is `scheduled` AND hub-authored (same tenant) ⇒ `edit` = {editable: false,
 * editableReason: "scheduled", scheduledFor, version} and `article.*` comes from the
 * latest version (the hub shows "scheduled for …" + Unschedule). A schedule made by a
 * CMS admin user (not hub-authored) keeps the old answer (`status`, main row).
 *
 * `bodyEditable` is computed only when editable (round-trip safety, inside the vm
 * time guard; timeout ⇒ false). Same two barriers as the detail route: an explicit
 * `select` + a sanitizer that builds a FRESH object (no spread).
 */

import type { Payload } from "payload";
import { HUB_ARTICLE_DETAIL_DEPTH, HUB_ARTICLE_DETAIL_SELECT } from "@/lib/hub-article-detail-select";
import { loadHubEditorConfig } from "@/lib/hub-article-markdown";
import { isRoundTripSafeBody, type HubEditorConfig } from "@/lib/hub-author-body";
import { isHubAuthoredDoc } from "@/lib/hub-author-auth";
import { toId } from "@/access/helpers";

/** The main-table read of `view=edit` = the detail select + `origin` (needed by the gate). */
export const HUB_ARTICLE_EDIT_MAIN_SELECT = { ...HUB_ARTICLE_DETAIL_SELECT, origin: true } as const;

/** The latest-draft read of `view=edit` (editable only). */
export const HUB_ARTICLE_EDIT_SELECT = {
  ...HUB_ARTICLE_DETAIL_SELECT,
  origin: true,
  version: true,
  lastEngine: true, // for `isHubAuthoredDoc` only; never emitted
  secondarySections: true,
  countries: true,
  cities: true,
  aiAssisted: true,
  breaking: true,
  sponsored: true,
  affiliate: true,
  deepDive: true,
  longHaul: true,
  pinnedToLatest: true,
  exclusive: true,
  sponsor: true,
  scheduledFor: true, // K10 (P5.2): the hour of a hub-scheduled latest version
} as const;

export type HubEditableReason = "ok" | "origin" | "status" | "not_hub_authored" | "scheduled";

type Doc = Record<string, unknown>;

/** `origin` / `workflowStatus` gate on ONE version. null = passes. */
export function editableReasonOf(doc: Doc | null | undefined): "origin" | "status" | null {
  if (!doc || doc.origin !== "manual") return "origin";
  if (doc.workflowStatus !== "draft") return "status";
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Doc | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : null);
const bool = (v: unknown): boolean => v === true;
const slugOf = (v: unknown): string | null => str(obj(v)?.slug);
const slugs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(slugOf).filter((s): s is string => s !== null) : [];
/** Id of a populated relation, or the bare id. */
const idOf = (v: unknown): number | string | null => toId(v) ?? null;

export interface HubArticleEditNo {
  editable: false;
  editableReason: Exclude<HubEditableReason, "ok" | "scheduled">;
}

/** K10 (P5.2): a hub-authored article scheduled from the hub — read-only, with its hour. */
export interface HubArticleEditScheduled {
  editable: false;
  editableReason: "scheduled";
  /** UTC `YYYY-MM-DDTHH:mm:ss.fffZ`; null when stored without an hour (only a CMS admin can do that). */
  scheduledFor: string | null;
  version: number | null;
}

export interface HubArticleEditYes {
  origin: string | null;
  version: number | null;
  editable: true;
  editableReason: "ok";
  bodyEditable: boolean;
  pillarSlug: string | null;
  subSectionSlug: string | null;
  secondary: { pillarSlug: string | null; subSectionSlug: string | null }[];
  tagSlugs: string[];
  countrySlugs: string[];
  citySlugs: string[];
  authorId: number | string | null;
  coAuthorIds: (number | string)[];
  flags: {
    aiAssisted: boolean;
    breaking: boolean;
    sponsored: boolean;
    affiliate: boolean;
    deepDive: boolean;
    longHaul: boolean;
    /** Read-only in P5.1. */
    pinnedToLatest: boolean;
    /** Read-only in P5.1. */
    exclusive: boolean;
  };
  sponsor: string | null;
}

export type HubArticleEdit = HubArticleEditNo | HubArticleEditYes | HubArticleEditScheduled;

export function sanitizeHubArticleEdit(
  doc: Doc,
  o: { bodyEditable: boolean; editable: boolean; editableReason: HubEditableReason },
): HubArticleEdit {
  if (!o.editable || o.editableReason !== "ok") {
    return { editable: false, editableReason: o.editableReason === "ok" || o.editableReason === "scheduled" ? "status" : o.editableReason };
  }
  const secondary = Array.isArray(doc.secondarySections)
    ? doc.secondarySections.map((row) => {
        const r = obj(row) ?? {};
        return { pillarSlug: slugOf(r.pillar), subSectionSlug: slugOf(r.subSection) };
      })
    : [];
  const co = Array.isArray(doc.coAuthors) ? doc.coAuthors.map(idOf).filter((x): x is number | string => x !== null) : [];
  return {
    origin: str(doc.origin),
    version: typeof doc.version === "number" ? doc.version : null,
    editable: true,
    editableReason: "ok",
    bodyEditable: o.bodyEditable,
    pillarSlug: slugOf(doc.pillar),
    subSectionSlug: slugOf(doc.subSection),
    secondary,
    tagSlugs: slugs(doc.tags),
    countrySlugs: slugs(doc.countries),
    citySlugs: slugs(doc.cities),
    authorId: idOf(doc.author),
    coAuthorIds: co,
    flags: {
      aiAssisted: bool(doc.aiAssisted),
      breaking: bool(doc.breaking),
      sponsored: bool(doc.sponsored),
      affiliate: bool(doc.affiliate),
      deepDive: bool(doc.deepDive),
      longHaul: bool(doc.longHaul),
      pinnedToLatest: bool(doc.pinnedToLatest),
      exclusive: bool(doc.exclusive),
    },
    sponsor: str(doc.sponsor),
  };
}

/**
 * Run the `view=edit` gate for one article whose MAIN row is already read (with
 * `HUB_ARTICLE_EDIT_MAIN_SELECT`) and tenant-checked. Returns the `edit` block and,
 * when editable, the LATEST doc the route must use for every `article.*` field.
 */
export async function loadHubArticleEdit(args: {
  payload: Payload;
  mainDoc: Doc;
  tenantId: number | string;
}): Promise<{ edit: HubArticleEdit; latest: Doc | null }> {
  const { payload, mainDoc, tenantId } = args;
  const mainReason = editableReasonOf(mainDoc);
  if (mainReason) return { edit: { editable: false, editableReason: mainReason }, latest: null };

  const latest = (await payload.findByID({
    collection: "articles",
    id: mainDoc.id as number | string,
    draft: true,
    depth: HUB_ARTICLE_DETAIL_DEPTH,
    locale: "en",
    overrideAccess: true,
    select: HUB_ARTICLE_EDIT_SELECT,
    disableErrors: true,
  })) as unknown as Doc | null;
  if (!latest || String(toId(latest.tenant)) !== String(tenantId)) {
    return { edit: { editable: false, editableReason: "status" }, latest: null };
  }
  const latestReason = editableReasonOf(latest);
  // K10 (P5.2): main manual draft (checked above) + latest scheduled + hub-authored ⇒ "scheduled".
  if (latestReason === "status" && latest.workflowStatus === "scheduled" && (await isHubAuthoredDoc(payload, latest))) {
    const at = latest.scheduledFor == null ? null : new Date(latest.scheduledFor as string);
    return {
      edit: {
        editable: false,
        editableReason: "scheduled",
        scheduledFor: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
        version: typeof latest.version === "number" ? latest.version : null,
      },
      latest,
    };
  }
  if (latestReason) return { edit: { editable: false, editableReason: latestReason }, latest: null };
  if (!(await isHubAuthoredDoc(payload, latest))) {
    return { edit: { editable: false, editableReason: "not_hub_authored" }, latest: null };
  }

  const editorConfig = (await loadHubEditorConfig(payload.config)) as HubEditorConfig;
  const bodyEditable = isRoundTripSafeBody(editorConfig, latest.body);
  return { edit: sanitizeHubArticleEdit(latest, { bodyEditable, editable: true, editableReason: "ok" }), latest };
}
