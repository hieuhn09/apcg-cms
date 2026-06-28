/**
 * Tenant resolution + feature-flag helpers, shared by route handlers and hooks.
 */

import type { Payload } from "payload";
import type { FeatureKey } from "@/lib/constants";

export interface TenantDoc {
  id: number | string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
  defaultLanguage: string;
  supportedLanguages?: string[];
  frontendUrl?: string;
  features?: Partial<Record<FeatureKey, boolean>>;
  [key: string]: unknown;
}

/** Resolve a tenant by its stable slug (the engine's `publicationId`). */
export async function findTenantBySlug(
  payload: Payload,
  slug: string,
): Promise<TenantDoc | null> {
  const res = await payload.find({
    collection: "tenants",
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  return (res.docs[0] as TenantDoc | undefined) ?? null;
}

export async function findTenantById(
  payload: Payload,
  id: number | string,
): Promise<TenantDoc | null> {
  try {
    const doc = await payload.findByID({
      collection: "tenants",
      id,
      depth: 0,
      overrideAccess: true,
    });
    return (doc as TenantDoc) ?? null;
  } catch {
    return null;
  }
}

/** Is a feature enabled for this tenant? Unknown/absent flags default to false
 *  except `articles` and `corrections`, which default on (parity with brief-asia). */
export function featureEnabled(tenant: TenantDoc | null, key: FeatureKey): boolean {
  if (!tenant) return false;
  const flags = tenant.features ?? {};
  if (key in flags) return Boolean(flags[key]);
  return key === "articles" || key === "corrections";
}

export function tenantIsActive(tenant: TenantDoc | null): boolean {
  return tenant?.status === "active";
}

export function supportedLanguages(tenant: TenantDoc | null): string[] {
  if (!tenant) return [];
  const list = tenant.supportedLanguages ?? [];
  if (list.length) return list;
  return tenant.defaultLanguage ? [tenant.defaultLanguage] : [];
}
