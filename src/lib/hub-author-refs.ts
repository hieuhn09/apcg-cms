/**
 * Hub author — reference resolution for the draft write routes (APCGHub P5.1;
 * Public Contracts POST / PATCH "tham chiếu"; D21; S4-3).
 *
 * Every slug / id the hub sends is resolved INSIDE the one tenant of the request:
 * pillar (blocked pillars of `ENGINE_BLOCKED_PILLARS` refused — D21, primary and
 * secondary), sub-section by the PAIR (slug, pillar id) — two pillars may share a
 * sub-section slug —, tags, authors / co-authors (tenant must match), cities (the
 * tenant must have `citiesMap`), countries (global reference data, no tenant).
 * Tenant-scoped lookups go through `scopedFind`; every query has `depth: 0` and
 * `limit: N + 1`. A miss is a 422 field code (`unknown_ref` / `blocked_pillar` /
 * `not_enabled`), never a 500.
 *
 * `findSlugConflict` checks BOTH places a slug can live (D20 branch B keeps hub
 * edits in the latest draft version, not the main table): (1) the main table, as
 * the `uniqueWithinTenant` hook does; (2) the latest draft versions, through a
 * direct `payload.find({ draft: true })` — `scopedFind` takes no `draft` flag and
 * `scoped.ts` is off limits — so the `tenant` clause is written out EXPLICITLY.
 */

import type { Payload, Where } from "payload";
import { scopedFind } from "@/lib/scoped";
import { ENGINE_BLOCKED_PILLARS } from "@/lib/constants";
import { featureEnabled, type TenantDoc } from "@/lib/tenant";
import type { HubFieldCode, HubFieldErrors } from "@/lib/hub-author-limits";
import type { HubDraftFields } from "@/lib/hub-author-input";

type Id = number | string;
type Doc = { id: Id; [k: string]: unknown };

async function findIds(
  payload: Payload,
  collection: "pillars" | "subsections" | "tags" | "authors" | "cities",
  tenantId: Id,
  where: Where,
  limit: number,
): Promise<Doc[]> {
  const res = await scopedFind({ payload, collection, tenantId, where, depth: 0, limit: limit + 1, page: 1 });
  return res.docs as unknown as Doc[];
}

/** Pillar slug of THIS tenant → id; blocked first, then unknown. */
export async function resolvePillar(
  payload: Payload,
  tenant: { id: Id; slug: string },
  slug: string,
): Promise<{ ok: true; id: Id } | { ok: false; code: HubFieldCode }> {
  if (ENGINE_BLOCKED_PILLARS[tenant.slug]?.includes(slug)) return { ok: false, code: "blocked_pillar" };
  const docs = await findIds(payload, "pillars", tenant.id, { slug: { equals: slug } }, 1);
  return docs[0] ? { ok: true, id: docs[0].id } : { ok: false, code: "unknown_ref" };
}

/** Sub-section by the PAIR (slug, pillar id). */
export async function resolveSubSection(
  payload: Payload,
  tenantId: Id,
  slug: string,
  pillarId: Id,
): Promise<{ ok: true; id: Id } | { ok: false; code: HubFieldCode }> {
  const docs = await findIds(payload, "subsections", tenantId, { and: [{ slug: { equals: slug } }, { pillar: { equals: pillarId } }] }, 1);
  return docs[0] ? { ok: true, id: docs[0].id } : { ok: false, code: "unknown_ref" };
}

/** Every slug must resolve; ids returned in request order. */
async function resolveSlugList(
  payload: Payload,
  collection: "tags" | "cities",
  tenantId: Id,
  slugs: string[],
): Promise<{ ok: true; ids: Id[] } | { ok: false; code: HubFieldCode }> {
  if (slugs.length === 0) return { ok: true, ids: [] };
  const docs = await findIds(payload, collection, tenantId, { slug: { in: slugs } }, slugs.length);
  const bySlug = new Map(docs.map((d) => [String(d.slug), d.id]));
  const ids: Id[] = [];
  for (const s of slugs) {
    const id = bySlug.get(s);
    if (id == null) return { ok: false, code: "unknown_ref" };
    ids.push(id);
  }
  return { ok: true, ids };
}

/** Countries are GLOBAL reference data (no tenant field). */
async function resolveCountries(payload: Payload, slugs: string[]): Promise<{ ok: true; ids: Id[] } | { ok: false; code: HubFieldCode }> {
  if (slugs.length === 0) return { ok: true, ids: [] };
  const res = await payload.find({
    collection: "countries",
    where: { slug: { in: slugs } },
    depth: 0,
    limit: slugs.length + 1,
    page: 1,
    overrideAccess: true,
  });
  const bySlug = new Map((res.docs as unknown as Doc[]).map((d) => [String(d.slug), d.id]));
  const ids: Id[] = [];
  for (const s of slugs) {
    const id = bySlug.get(s);
    if (id == null) return { ok: false, code: "unknown_ref" };
    ids.push(id);
  }
  return { ok: true, ids };
}

/** Author ids of THIS tenant (the tenant filter is the ownership check). */
async function resolveAuthors(payload: Payload, tenantId: Id, ids: number[]): Promise<{ ok: true; ids: Id[] } | { ok: false; code: HubFieldCode }> {
  if (ids.length === 0) return { ok: true, ids: [] };
  const docs = await findIds(payload, "authors", tenantId, { id: { in: ids } }, ids.length);
  const found = new Set(docs.map((d) => String(d.id)));
  for (const id of ids) if (!found.has(String(id))) return { ok: false, code: "unknown_ref" };
  return { ok: true, ids: [...ids] };
}

/** The resolved relationship values, ready for `data` (only the keys that were resolved). */
export interface ResolvedRefs {
  pillar?: Id;
  subSection?: Id | null;
  secondarySections?: { pillar: Id; subSection?: Id }[];
  tags?: Id[];
  countries?: Id[];
  cities?: Id[];
  author?: Id;
  coAuthors?: Id[];
}

/**
 * Resolve every reference present in `input`. `currentPillarId` = the pillar a
 * sub-section is checked against when the request does not change the pillar
 * (PATCH). Errors are collected (one tier: references) and returned together.
 */
export async function resolveDraftRefs(args: {
  payload: Payload;
  tenant: TenantDoc;
  input: HubDraftFields;
  currentPillarId?: Id | null;
}): Promise<{ ok: true; refs: ResolvedRefs } | { ok: false; fields: HubFieldErrors }> {
  const { payload, tenant, input } = args;
  const t = { id: tenant.id, slug: tenant.slug };
  const fields: HubFieldErrors = {};
  const refs: ResolvedRefs = {};

  let pillarId: Id | null | undefined = args.currentPillarId;
  if (input.pillarSlug !== undefined) {
    const r = await resolvePillar(payload, t, input.pillarSlug);
    if (r.ok) {
      refs.pillar = r.id;
      pillarId = r.id;
    } else {
      fields.pillarSlug = r.code;
      pillarId = undefined;
    }
  }

  if (input.subSectionSlug !== undefined) {
    if (input.subSectionSlug === null) refs.subSection = null;
    else if (pillarId != null) {
      const r = await resolveSubSection(payload, tenant.id, input.subSectionSlug, pillarId);
      if (r.ok) refs.subSection = r.id;
      else fields.subSectionSlug = r.code;
    } else if (!("pillarSlug" in fields)) fields.subSectionSlug = "unknown_ref";
  }

  if (input.secondary !== undefined) {
    const rows: { pillar: Id; subSection?: Id }[] = [];
    for (let i = 0; i < input.secondary.length; i++) {
      const row = input.secondary[i]!;
      const p = await resolvePillar(payload, t, row.pillarSlug);
      if (!p.ok) {
        fields[`secondary[${i}].pillarSlug`] = p.code;
        continue;
      }
      if (row.subSectionSlug !== null) {
        const s = await resolveSubSection(payload, tenant.id, row.subSectionSlug, p.id);
        if (!s.ok) {
          fields[`secondary[${i}].subSectionSlug`] = s.code;
          continue;
        }
        rows.push({ pillar: p.id, subSection: s.id });
      } else rows.push({ pillar: p.id });
    }
    refs.secondarySections = rows;
  }

  if (input.tagSlugs !== undefined) {
    const r = await resolveSlugList(payload, "tags", tenant.id, input.tagSlugs);
    if (r.ok) refs.tags = r.ids;
    else fields.tagSlugs = r.code;
  }

  if (input.countrySlugs !== undefined) {
    const r = await resolveCountries(payload, input.countrySlugs);
    if (r.ok) refs.countries = r.ids;
    else fields.countrySlugs = r.code;
  }

  if (input.citySlugs !== undefined && input.citySlugs.length > 0) {
    if (!featureEnabled(tenant, "citiesMap")) fields.citySlugs = "not_enabled";
    else {
      const r = await resolveSlugList(payload, "cities", tenant.id, input.citySlugs);
      if (r.ok) refs.cities = r.ids;
      else fields.citySlugs = r.code;
    }
  } else if (input.citySlugs !== undefined) refs.cities = [];

  if (input.authorId !== undefined) {
    const r = await resolveAuthors(payload, tenant.id, [input.authorId]);
    if (r.ok) refs.author = r.ids[0];
    else fields.authorId = r.code;
  }

  if (input.coAuthorIds !== undefined) {
    const r = await resolveAuthors(payload, tenant.id, input.coAuthorIds);
    if (r.ok) refs.coAuthors = r.ids;
    else fields.coAuthorIds = r.code;
  }

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, refs };
}

/** Minimal Payload surface `findSlugConflict` needs (a fake can stand in for unit checks). */
export interface SlugLookup {
  find: Payload["find"];
}

/**
 * Is `slug` already used in this tenant — in the main table OR in the latest draft
 * version of an article? Returns the first OTHER article (`excludeId` = the article
 * being edited, removed by comparing ids in code) or null.
 */
export async function findSlugConflict(args: {
  payload: SlugLookup;
  tenantId: Id;
  slug: string;
  excludeId?: Id;
}): Promise<{ id: Id } | null> {
  const { payload, tenantId, slug, excludeId } = args;
  const other = (docs: unknown[]): { id: Id } | null => {
    for (const d of docs as Doc[]) if (excludeId == null || String(d.id) !== String(excludeId)) return { id: d.id };
    return null;
  };
  // (1) main table — the same view the uniqueWithinTenant hook has.
  const main = await scopedFind({
    payload: payload as Payload,
    collection: "articles",
    tenantId,
    where: { slug: { equals: slug } },
    limit: 2,
    depth: 0,
  });
  const hitMain = other(main.docs);
  if (hitMain) return hitMain;
  // (2) latest draft versions — tenant clause EXPLICIT (no scoped helper here).
  const latest = await payload.find({
    collection: "articles",
    draft: true,
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
    limit: 2,
    depth: 0,
    overrideAccess: true,
  });
  return other(latest.docs);
}
