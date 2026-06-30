/**
 * Console auth + authorization. REUSES Payload's existing user session (same
 * cookie as /admin) via `payload.auth()` — no second auth system — and REUSES
 * the tenant-aware access helpers in `src/access/helpers.ts` so the console
 * enforces exactly the same rules as the Payload admin.
 */
import "server-only";
import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation";
import { getPayload, type Payload, type PayloadRequest } from "payload";
import config from "@payload-config";
import {
  isSystemAdmin,
  memberTenantIds,
  adminTenantIds,
  writableTenantIds,
  canPublishInTenant,
  type CmsUser,
} from "@/access/helpers";

export type { CmsUser } from "@/access/helpers";

/** Payload Local API client (Payload caches the instance internally). */
export async function getPayloadClient(): Promise<Payload> {
  return getPayload({ config });
}

/** The current Payload user from the request cookies, or null if anonymous. */
export async function getSessionUser(): Promise<CmsUser | null> {
  const payload = await getPayload({ config });
  const h = await nextHeaders();
  const { user } = await payload.auth({ headers: h as unknown as Headers });
  return (user as CmsUser | null) ?? null;
}

/** Require a signed-in user; otherwise bounce to Payload's login (return to console). */
export async function requireUser(): Promise<CmsUser> {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login?redirect=%2Fconsole");
  return user;
}

/** Require a system admin; non-admins are sent back to the console root. */
export async function requireSystemAdmin(): Promise<CmsUser> {
  const user = await requireUser();
  if (!isAdmin(user)) redirect("/console");
  return user;
}

/** Adapt a CmsUser into the minimal shape the access helpers read (`req.user`). */
export function reqOf(user: CmsUser | null): PayloadRequest {
  return { user } as unknown as PayloadRequest;
}

export function isAdmin(user: CmsUser | null): boolean {
  return isSystemAdmin(reqOf(user));
}

/**
 * Which tenants this user may see. System admins see all (`all: true`, ids empty
 * means "no filter"); everyone else is limited to their membership tenants.
 */
export function tenantScope(user: CmsUser | null): { all: boolean; ids: number[] } {
  if (isAdmin(user)) return { all: true, ids: [] };
  const ids = memberTenantIds(reqOf(user)).map((id) => Number(id));
  return { all: false, ids };
}

export function writableTenants(user: CmsUser | null): number[] {
  if (isAdmin(user)) return [];
  return writableTenantIds(reqOf(user)).map((id) => Number(id));
}

export function adminTenants(user: CmsUser | null): number[] {
  if (isAdmin(user)) return [];
  return adminTenantIds(reqOf(user)).map((id) => Number(id));
}

export function canPublish(user: CmsUser | null, tenantId: number | string): boolean {
  return canPublishInTenant(reqOf(user), tenantId);
}

/** May this user access (read) a specific tenant? */
export function canAccessTenant(user: CmsUser | null, tenantId: number): boolean {
  const scope = tenantScope(user);
  return scope.all || scope.ids.includes(tenantId);
}
