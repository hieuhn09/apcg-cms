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
import { isLiveEditTenant, liveEditTenants, liveGateReason } from "@/lib/hub-author-live-pure";

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
  pinnedUntil: true, // hub-pin-exclusive-flags (Public Contracts CMS 2): `edit.pinnedUntil`
  sponsor: true,
  scheduledFor: true, // K10 (P5.2): the hour of a hub-scheduled latest version
  leadImageCaption: true, // P5.3 T9 (heroImage already comes from the detail select)
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
  /** APCGHub P5.4 (D6 / T3): ONLY on the branch "main row published" when the caller passed `tenantSlug`. */
  live?: HubArticleEditLive;
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
    /** hub-pin-exclusive-flags: settable from the hub as the ROOT key `pinnedToLatest` (drafts) or via `POST …/flags` (published), when the tenant is on HUB_EDITORIAL_FLAGS_TENANTS; never under `flags` in a write. */
    pinnedToLatest: boolean;
    /** hub-pin-exclusive-flags: as `pinnedToLatest` (ROOT key `exclusive`). */
    exclusive: boolean;
  };
  /** hub-pin-exclusive-flags (CMS 2): UTC `YYYY-MM-DDTHH:mm:ss.fffZ`, or null (no expiry). */
  pinnedUntil: string | null;
  sponsor: string | null;
}

/** P5.3 T9 / D6: one media of THIS tenant, raw `url` (the hub filters + absolutises it). */
export interface HubEditMedia {
  id: number | string;
  url: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
}

/** P5.3 T9: the keys attached AFTER `sanitizeHubArticleEdit` (editable branch only). */
export interface HubArticleEditMedia {
  hero: (HubEditMedia & { credit: string | null }) | null;
  leadImageCaption: string | null;
  bodyMedia: HubEditMedia[];
}

export type HubArticleEdit = HubArticleEditNo | (HubArticleEditYes & Partial<HubArticleEditMedia>) | HubArticleEditScheduled;

/** P5.4 (T3): why a published article cannot be edited live from the hub (never "origin" on the wire). */
export type HubArticleEditLiveReason = "scheduled" | "status" | "draft_diverged" | "not_hub_authored" | "feature_disabled";

export interface HubArticleEditLiveNo {
  editable: false;
  reason: HubArticleEditLiveReason;
  version: number | null;
}

/** P5.4 (T3): the live-editable block — EXACTLY 17 keys, flat like `HubArticleEditYes` (no `origin`, `reason` for `editableReason`). */
export interface HubArticleEditLiveYes {
  editable: true;
  reason: "ok";
  version: number | null;
  bodyEditable: boolean;
  pillarSlug: string | null;
  subSectionSlug: string | null;
  secondary: HubArticleEditYes["secondary"];
  tagSlugs: string[];
  countrySlugs: string[];
  citySlugs: string[];
  authorId: number | string | null;
  coAuthorIds: (number | string)[];
  flags: HubArticleEditYes["flags"];
  sponsor: string | null;
  hero: HubArticleEditMedia["hero"];
  leadImageCaption: string | null;
  bodyMedia: HubEditMedia[];
}

export type HubArticleEditLive = HubArticleEditLiveNo | HubArticleEditLiveYes;

/** P5.3: distinct media ids allowed in one hub body (= `too_many` of T5). */
export const HUB_EDIT_BODY_MEDIA_MAX = 30;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A stored date (string / Date) → `YYYY-MM-DDTHH:mm:ss.fffZ`; null / absent / unparseable → null. */
const isoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** A populated media doc of THIS tenant (depth 2 read), else null — another tenant's media is never shown. */
function ownMedia(v: unknown, tenantId: number | string): Doc | null {
  const m = obj(v);
  if (!m || toId(m) == null) return null;
  if (String(toId(m.tenant) ?? "") !== String(tenantId)) return null;
  return m;
}

function editMedia(m: Doc): HubEditMedia {
  return { id: toId(m) as number | string, url: str(m.url), alt: str(m.alt), width: num(m.width), height: num(m.height) };
}

/**
 * P5.3 T9: `edit.hero`, `edit.leadImageCaption`, `edit.bodyMedia` from the LATEST
 * doc read at depth 2. Body ids = `upload` nodes with `relationTo: "media"`
 * anywhere in the tree (never the Markdown); distinct ids in tree order; only
 * media of this tenant, populated, are listed. `tooMany` = more than 30 distinct
 * ids ⇒ the caller locks the body (bodyEditable false) instead of cutting.
 */
export function hubEditMediaBlock(latest: Doc, tenantId: number | string): HubArticleEditMedia & { tooMany: boolean } {
  const h = ownMedia(latest.heroImage, tenantId);
  const hero = h ? { ...editMedia(h), credit: str(h.credit) } : null;
  const seen = new Map<string, unknown>();
  const root = obj(obj(latest.body)?.root);
  const stack: unknown[] = root ? [root] : [];
  while (stack.length) {
    const n = obj(stack.pop());
    if (!n) continue;
    if (n.type === "upload" && n.relationTo === "media") {
      const id = toId(n.value);
      if (id != null && !seen.has(String(id))) seen.set(String(id), n.value);
    }
    if (Array.isArray(n.children)) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  const tooMany = seen.size > HUB_EDIT_BODY_MEDIA_MAX;
  const bodyMedia: HubEditMedia[] = [];
  if (!tooMany) {
    for (const v of seen.values()) {
      const m = ownMedia(v, tenantId);
      if (m) bodyMedia.push(editMedia(m));
    }
  }
  const cap = str(latest.leadImageCaption);
  return { hero, leadImageCaption: cap === "" ? null : cap, bodyMedia, tooMany };
}

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
    pinnedUntil: isoOrNull(doc.pinnedUntil),
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
  /** P5.4 (D6): the CMS tenant slug — given by the route; absent ⇒ no `live` block (and no env read). */
  tenantSlug?: string;
  /** P5.4 (D11): the live-edit tenant switch (default: `liveEditTenants()`, read on this call). */
  liveTenants?: readonly string[];
}): Promise<{ edit: HubArticleEdit; latest: Doc | null }> {
  const { payload, mainDoc, tenantId } = args;
  const mainReason = editableReasonOf(mainDoc);
  // P5.4 (D6): the main row is published ⇒ add the `live` block, only when the caller named the tenant slug.
  if (mainReason === "status" && mainDoc.workflowStatus === "published" && args.tenantSlug !== undefined) {
    const live = await computeEditLive({ payload, mainDoc, tenantId, tenantSlug: args.tenantSlug, liveTenants: args.liveTenants ?? liveEditTenants() });
    return { edit: { editable: false, editableReason: "status", live }, latest: null };
  }
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
      latest: withholdForeignHero(latest, tenantId),
    };
  }
  if (latestReason) return { edit: { editable: false, editableReason: latestReason }, latest: null };
  if (!(await isHubAuthoredDoc(payload, latest))) {
    return { edit: { editable: false, editableReason: "not_hub_authored" }, latest: null };
  }

  const editorConfig = (await loadHubEditorConfig(payload.config)) as HubEditorConfig;
  const media = hubEditMediaBlock(latest, tenantId);
  const bodyEditable = !media.tooMany && isRoundTripSafeBody(editorConfig, latest.body);
  // P5.3 T9: the media keys are attached AFTER the sanitizer (its 16 keys — 15 + `pinnedUntil`
  // since hub-pin-exclusive-flags — stay pinned by --check6).
  const edit = sanitizeHubArticleEdit(latest, { bodyEditable, editable: true, editableReason: "ok" }) as HubArticleEditYes;
  // Review M1 (CMS-2): `article.heroImage` comes from the same latest doc; a hero that is
  // not THIS tenant's media (edit.hero null) is withheld there too — never only in `edit`.
  return { edit: { ...edit, hero: media.hero, leadImageCaption: media.leadImageCaption, bodyMedia: media.bodyMedia }, latest: withholdForeignHero(latest, tenantId) };
}

/**
 * P5.4 (D6): the `edit.live` block of a PUBLISHED main row. (0) tenant outside
 * `liveTenants` ⇒ `feature_disabled`, NO database read; (i) the gate reads — the FULL
 * main row (depth 0, no select) + the latest version — through `liveGateReason`; (ii)
 * only when the gate passes, ONE display read (no draft, detail depth, `en`,
 * `HUB_ARTICLE_EDIT_SELECT`) feeds the sanitizer, the media block and `bodyEditable`.
 */
export async function computeEditLive(args: {
  payload: Payload;
  mainDoc: Doc;
  tenantId: number | string;
  tenantSlug: string;
  liveTenants: readonly string[];
}): Promise<HubArticleEditLive> {
  const { payload, mainDoc, tenantId } = args;
  if (!isLiveEditTenant(args.tenantSlug, args.liveTenants)) return { editable: false, reason: "feature_disabled", version: null };
  const id = mainDoc.id as number | string;
  const main = (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc | null;
  if (!main || String(toId(main.tenant)) !== String(tenantId)) return { editable: false, reason: "status", version: null };
  const latest = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc | null;
  const version = typeof main.version === "number" ? main.version : null;
  const reason = liveGateReason({ main, latest, isHubAuthored: latest ? await isHubAuthoredDoc(payload, latest) : false });
  if (reason) return { editable: false, reason: reason === "origin" ? "status" : reason, version };
  const shown = (await payload.findByID({
    collection: "articles",
    id,
    depth: HUB_ARTICLE_DETAIL_DEPTH,
    locale: "en",
    overrideAccess: true,
    select: HUB_ARTICLE_EDIT_SELECT,
    disableErrors: true,
  })) as unknown as Doc | null;
  if (!shown || String(toId(shown.tenant)) !== String(tenantId)) return { editable: false, reason: "status", version };
  const editorConfig = (await loadHubEditorConfig(payload.config)) as HubEditorConfig;
  const media = hubEditMediaBlock(shown, tenantId);
  const bodyEditable = !media.tooMany && isRoundTripSafeBody(editorConfig, shown.body);
  const y = sanitizeHubArticleEdit(shown, { bodyEditable, editable: true, editableReason: "ok" }) as HubArticleEditYes;
  return {
    editable: true,
    reason: "ok",
    version,
    bodyEditable,
    pillarSlug: y.pillarSlug,
    subSectionSlug: y.subSectionSlug,
    secondary: y.secondary,
    tagSlugs: y.tagSlugs,
    countrySlugs: y.countrySlugs,
    citySlugs: y.citySlugs,
    authorId: y.authorId,
    coAuthorIds: y.coAuthorIds,
    flags: y.flags,
    sponsor: y.sponsor,
    hero: media.hero,
    leadImageCaption: media.leadImageCaption,
    bodyMedia: media.bodyMedia,
  };
}

/**
 * Review M1 (CMS-2) + review-3 M3: the ONE withhold rule for `article.heroImage` in
 * `view=edit` — every branch (editable, scheduled, and the main row of the
 * not-editable branches). A hero that is not a populated media of THIS tenant is
 * replaced by null; an own hero, or no hero, returns the SAME object.
 */
export function withholdForeignHero<T extends Doc>(doc: T, tenantId: number | string): T {
  return doc.heroImage != null && ownMedia(doc.heroImage, tenantId) === null ? { ...doc, heroImage: null } : doc;
}

/**
 * Review M2 (CMS-2): the invariant "bodyEditable:true ⇒ the token export did NOT fall
 * back". When `hubArticleBodyToMarkdown` reports `tokenFallback`, the body the hub
 * receives has lost its images, so it must never be offered as editable Markdown.
 */
export function applyBodyTokenFallback(edit: HubArticleEdit, tokenFallback: boolean): HubArticleEdit {
  // P5.4 (CMS3-6): same invariant for the `live` block (its Markdown came from the same token export).
  if (tokenFallback && edit.editable === false && "live" in edit && edit.live?.editable === true) return { ...edit, live: { ...edit.live, bodyEditable: false } };
  if (!tokenFallback || edit.editable !== true || edit.bodyEditable !== true) return edit;
  return { ...edit, bodyEditable: false };
}
