/**
 * Tenant-aware access helpers — the security core of the Central CMS.
 *
 * Two layers of multi-tenancy work together:
 *   1. @payloadcms/plugin-multi-tenant scopes WHICH tenants an admin session may
 *      touch (tenant selector + auto-filtered list views). It reads tenant access
 *      from the `tenants` array the plugin adds to the Users collection.
 *   2. These helpers + the collection `access` functions encode WHAT each role may
 *      do, on top of that tenant scoping.
 *
 * Membership model (deliberate deviation from a separate join collection):
 * tenant access lives on `Users.tenants` — the plugin-native array — where each
 * row is `{ tenant, roles[], canPublish }`. Using the plugin's own array avoids a
 * SECOND source of truth for "who can access which tenant" (a separate
 * memberships collection would have to be kept in lockstep with the plugin's
 * scoping, which is a bug farm). Trade-off: a website admin editing a user sees
 * that user's full tenant list. Acceptable for MVP; revisit if cross-tenant
 * roster privacy becomes a requirement.
 *
 * IMPORTANT INVARIANT: machine (engine intake) and public (frontend) traffic do
 * NOT authenticate as a Payload user, so the plugin's scoping never runs for
 * them. Those paths MUST set/filter `tenant` explicitly via the helpers in
 * `src/lib/scoped.ts`. Never call `payload.find/create` without a tenant filter
 * in a route handler.
 */

import type { PayloadRequest, Where } from "payload";
import type { MembershipRole, UserRole } from "@/lib/constants";

/** A row of the `Users.tenants` array, after the plugin adds it. */
export interface TenantMembership {
  tenant: number | string | { id: number | string };
  roles?: MembershipRole[];
  canPublish?: boolean;
}

/** The shape of `req.user` we rely on (a Payload editorial user). */
export interface CmsUser {
  id: number | string;
  role?: UserRole;
  tenants?: TenantMembership[];
}

/** Coerce a relationship value (id or populated doc) to a primitive id. */
export function toId(value: unknown): number | string | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return id;
  }
  return undefined;
}

export function asUser(req: PayloadRequest): CmsUser | null {
  return (req.user as CmsUser | undefined) ?? null;
}

export function isSystemAdmin(req: PayloadRequest): boolean {
  return asUser(req)?.role === "systemAdmin";
}

/** All memberships of the current user (empty for system admins / anonymous). */
export function memberships(req: PayloadRequest): TenantMembership[] {
  return asUser(req)?.tenants ?? [];
}

/** Every tenant id the user belongs to (any role). */
export function memberTenantIds(req: PayloadRequest): (number | string)[] {
  return memberships(req)
    .map((m) => toId(m.tenant))
    .filter((id): id is number | string => id != null);
}

/** Tenant ids where the user holds one of the given roles. */
export function tenantIdsWithRole(
  req: PayloadRequest,
  roles: MembershipRole[],
): (number | string)[] {
  return memberships(req)
    .filter((m) => (m.roles ?? []).some((r) => roles.includes(r)))
    .map((m) => toId(m.tenant))
    .filter((id): id is number | string => id != null);
}

/** Tenant ids where the user is a website admin. */
export function adminTenantIds(req: PayloadRequest): (number | string)[] {
  return tenantIdsWithRole(req, ["websiteAdmin"]);
}

/** Tenant ids where the user may create/edit content (any editorial role). */
export function writableTenantIds(req: PayloadRequest): (number | string)[] {
  return tenantIdsWithRole(req, ["websiteAdmin", "editor", "contributor"]);
}

/** The membership row for a specific tenant, if any. */
export function membershipForTenant(
  req: PayloadRequest,
  tenantId: number | string | undefined,
): TenantMembership | undefined {
  if (tenantId == null) return undefined;
  return memberships(req).find((m) => toId(m.tenant) === tenantId);
}

/** Does the user hold a role that can publish (editor / websiteAdmin, or a
 *  contributor explicitly granted canPublish) in the given tenant? */
export function canPublishInTenant(
  req: PayloadRequest,
  tenantId: number | string | undefined,
): boolean {
  if (isSystemAdmin(req)) return true;
  const m = membershipForTenant(req, tenantId);
  if (!m) return false;
  const roles = m.roles ?? [];
  if (roles.includes("websiteAdmin") || roles.includes("editor")) return true;
  return roles.includes("contributor") && Boolean(m.canPublish);
}

// ── Reusable Payload `access` function factories ─────────────────────────────
// A Payload access fn returns true (allow all), false (deny), or a `Where`
// (allow rows matching the filter). These factories encode the standard
// tenant-scoped patterns so individual collections stay declarative.

/** Read: system admin → all; member → own tenants; else deny. */
export function readOwnTenants(req: PayloadRequest): boolean | Where {
  if (isSystemAdmin(req)) return true;
  if (!asUser(req)) return false;
  const ids = memberTenantIds(req);
  return ids.length ? { tenant: { in: ids } } : false;
}

/** Create: system admin → all; editorial member → constrained to writable tenants. */
export function createInWritableTenants(req: PayloadRequest): boolean | Where {
  if (isSystemAdmin(req)) return true;
  const ids = writableTenantIds(req);
  return ids.length ? { tenant: { in: ids } } : false;
}

/** Delete: system admin → all; website admin → own admin tenants; else deny. */
export function deleteInAdminTenants(req: PayloadRequest): boolean | Where {
  if (isSystemAdmin(req)) return true;
  const ids = adminTenantIds(req);
  return ids.length ? { tenant: { in: ids } } : false;
}

/**
 * Update for editorial content: website admin/editor may edit anything in their
 * tenant; a contributor may edit only rows they authored or are assigned to.
 * `authorPathField` lets a collection point at its "owner" relationship (e.g.
 * Articles uses `author` + `assignedTo`).
 */
export function updateEditorialContent(req: PayloadRequest): boolean | Where {
  if (isSystemAdmin(req)) return true;
  const user = asUser(req);
  if (!user) return false;

  const fullTenants = tenantIdsWithRole(req, ["websiteAdmin", "editor"]);
  const contribTenants = tenantIdsWithRole(req, ["contributor"]);

  const or: Where[] = [];
  if (fullTenants.length) or.push({ tenant: { in: fullTenants } });
  if (contribTenants.length) {
    or.push({
      and: [
        { tenant: { in: contribTenants } },
        {
          or: [
            { author: { equals: user.id } },
            { assignedTo: { equals: user.id } },
          ],
        },
      ],
    });
  }
  return or.length ? { or } : false;
}
