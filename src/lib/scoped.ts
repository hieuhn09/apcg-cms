/**
 * Tenant-scoped data helpers for MACHINE and PUBLIC traffic (engine intake,
 * public read API, revalidation). These requests have no logged-in Payload user,
 * so the multi-tenant plugin's admin scoping does NOT apply. Every DB call from a
 * route handler MUST go through one of these helpers so the `tenant` filter is
 * never forgotten — that single omission is the cross-tenant leak risk flagged in
 * the plan.
 *
 * Rule for reviewers: a route handler must not call `payload.find` / `payload.create`
 * / `payload.update` directly. Use scopedFind / scopedCreate / scopedUpdate.
 */

import type { Payload, Where } from "payload";

type CollectionSlug = Parameters<Payload["find"]>[0]["collection"];

export interface ScopedFindArgs {
  payload: Payload;
  collection: CollectionSlug;
  tenantId: number | string;
  where?: Where;
  locale?: string;
  limit?: number;
  page?: number;
  sort?: string;
  depth?: number;
  /** When true, only return published rows (public API default). */
  publishedOnly?: boolean;
}

/** Merge a tenant (and optional published) constraint into a caller's where. */
function withTenant(
  tenantId: number | string,
  where?: Where,
  publishedOnly?: boolean,
): Where {
  const and: Where[] = [{ tenant: { equals: tenantId } }];
  if (publishedOnly) and.push({ _status: { equals: "published" } });
  if (where) and.push(where);
  return { and };
}

export async function scopedFind(args: ScopedFindArgs) {
  const { payload, collection, tenantId, where, publishedOnly, ...rest } = args;
  return payload.find({
    collection,
    where: withTenant(tenantId, where, publishedOnly),
    overrideAccess: true, // trust boundary is the token check in the route handler
    ...rest,
  });
}

export interface ScopedCreateArgs {
  payload: Payload;
  collection: CollectionSlug;
  tenantId: number | string;
  data: Record<string, unknown>;
  locale?: string;
  file?: Parameters<Payload["create"]>[0]["file"];
  context?: Record<string, unknown>;
}

export async function scopedCreate(args: ScopedCreateArgs) {
  const { payload, collection, tenantId, data, ...rest } = args;
  return payload.create({
    collection,
    data: { ...data, tenant: tenantId },
    overrideAccess: true,
    ...rest,
  });
}

export interface ScopedUpdateArgs {
  payload: Payload;
  collection: CollectionSlug;
  tenantId: number | string;
  id: number | string;
  data: Record<string, unknown>;
  locale?: string;
  context?: Record<string, unknown>;
}

/**
 * Update a single row, but ONLY if it belongs to the given tenant. We re-assert
 * the tenant via a `where` on `updateByID` is not available, so we update by id
 * and rely on the caller having loaded the row through scopedFind first. As a
 * belt-and-braces guard, callers should verify `doc.tenant === tenantId` before
 * calling this.
 */
export async function scopedUpdate(args: ScopedUpdateArgs) {
  const { payload, collection, tenantId, id, data, ...rest } = args;
  return payload.update({
    collection,
    id,
    data: { ...data, tenant: tenantId },
    overrideAccess: true,
    ...rest,
  });
}
