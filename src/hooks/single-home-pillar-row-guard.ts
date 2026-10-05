/**
 * Pillars row guards (V5): protect the KEY of the single-home rule — the
 * (tenant, slug) pair in SINGLE_HOME_PILLARS — from rename, tenant move and
 * in-use delete. Hooks only: no new Pillars field, no migration.
 *
 * beforeChange: a no-op unless `operation === 'update'` (never keyed on
 * `originalDoc` presence: create passes `{}`, duplicate passes the source doc
 * with operation 'create'), so creating the `pressroom` row stays allowed. The
 * OLD pair always comes from originalDoc; the NEW pair is the effective value
 * (`data[k] !== undefined ? data[k] : originalDoc[k]`). Tenant ids are
 * normalised, the slug is compared raw. Rejects when the pair changed and either
 * pair is single-home (covers a `PATCH {tenant}` by an editor in two tenants).
 *
 * beforeDelete: reads tenant + slug from the STORED doc and refuses while any
 * article (primary or secondary row), sub-section, newsletter `vertical` or
 * latest draft version references the pillar. 0 references = deletable.
 *
 * Lookups fail closed. Rename -> ValidationError (path `slug`, shown inline in
 * /admin); tenant move and delete -> APIError 400 (a ValidationError without a
 * usable path would only show the generic text).
 */
import type { CollectionBeforeChangeHook, CollectionBeforeDeleteHook } from "payload";
import { APIError, ValidationError } from "payload";
import {
  MSG,
  checkPillarDelete,
  checkPillarRowChange,
  idKey,
  isSingleHomePillar,
  resolveTenantSlugs,
  singleHomeSlugUnion,
} from "@/lib/single-home-pillars";
import { findFor } from "@/hooks/single-home-pillar";

export const pillarRowGuardBeforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  if (operation !== "update" || !data) return data;
  const orig: Record<string, unknown> =
    originalDoc !== null && typeof originalDoc === "object" ? (originalDoc as Record<string, unknown>) : {};

  const oldTenantId = idKey(orig.tenant);
  const oldSlug = orig.slug;
  const newTenantId = data.tenant !== undefined ? idKey(data.tenant) : oldTenantId;
  const newSlug = data.slug !== undefined ? data.slug : oldSlug;
  if (oldTenantId === newTenantId && oldSlug === newSlug) return data;

  const union = singleHomeSlugUnion();
  if (![oldSlug, newSlug].some((s) => typeof s === "string" && union.includes(s))) return data;

  const tenantIds = [oldTenantId, newTenantId].filter((k): k is string => k !== null);
  const tenants = await resolveTenantSlugs({ tenantIds, find: findFor(req), context: req.context as Record<string, unknown> });
  const verdict = checkPillarRowChange({
    oldTenantId,
    oldTenantSlug: oldTenantId !== null ? (tenants.get(oldTenantId) ?? null) : null,
    oldSlug,
    newTenantId,
    newTenantSlug: newTenantId !== null ? (tenants.get(newTenantId) ?? null) : null,
    newSlug,
  });
  if (verdict === "move") throw new APIError(MSG.move, 400);
  if (verdict === "rename") {
    throw new ValidationError({ collection: "pillars", errors: [{ message: MSG.rename, path: "slug" }], req }, req.t);
  }
  return data;
};

export const pillarRowGuardBeforeDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const stored = (await req.payload.findByID({ collection: "pillars", id, depth: 0, overrideAccess: true, req } as never)) as
    | Record<string, unknown>
    | null;
  if (!stored) return;
  const slug = stored.slug;
  const tenantKey = idKey(stored.tenant);
  if (typeof slug !== "string" || tenantKey === null || !singleHomeSlugUnion().includes(slug)) return;

  const tenants = await resolveTenantSlugs({ tenantIds: [tenantKey], find: findFor(req), context: req.context as Record<string, unknown> });
  if (!isSingleHomePillar(tenants.get(tenantKey), slug)) return;

  const count = async (collection: string, where: Record<string, unknown>) =>
    ((await req.payload.count({ collection, where, overrideAccess: true, req } as never)) as { totalDocs: number }).totalDocs;

  const articles = await count("articles", { or: [{ pillar: { equals: id } }, { "secondarySections.pillar": { equals: id } }] });
  const subsections = await count("subsections", { pillar: { equals: id } });
  const newsletters = await count("newsletters", { vertical: { equals: id } });
  // Draft-only references live in `_articles_v` (payload.count sees main tables
  // only). Count the LATEST version per doc only — counting every version would
  // block the delete forever.
  const draftVersions = (
    (await req.payload.countVersions({
      collection: "articles",
      where: {
        and: [
          { latest: { equals: true } },
          { or: [{ "version.pillar": { equals: id } }, { "version.secondarySections.pillar": { equals: id } }] },
        ],
      },
      overrideAccess: true,
      req,
    } as never)) as { totalDocs: number }
  ).totalDocs;

  if (checkPillarDelete(true, { articles, subsections, newsletters, draftVersions })) {
    throw new APIError(MSG.delete, 400);
  }
};
