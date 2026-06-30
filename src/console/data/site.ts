/** Per-tenant content reads via the Payload Local API (locale-aware, access-checked). */
import "server-only";
import type { CollectionSlug } from "payload";
import { listDocs } from "./payload";
import { canPublish, type CmsUser } from "../auth";
import type { CollectionDef } from "./collection-config";
import { ARTICLE_STATUSES, CONTRIBUTOR_ALLOWED_STATUSES } from "@/lib/constants";

const tenantWhere = (tenantId: number) => ({ tenant: { equals: tenantId } });

export async function listPillars(
  user: CmsUser,
  tenantId: number,
  locale: string,
): Promise<{ id: number; title: string; slug: string }[]> {
  const r = await listDocs("pillars", user, { where: tenantWhere(tenantId), limit: 200, sort: "order", depth: 0, locale });
  return r.docs.map((d) => ({ id: Number(d.id), title: String(d.title ?? d.slug ?? d.id), slug: String(d.slug ?? "") }));
}

export async function listAuthorsLite(
  user: CmsUser,
  tenantId: number,
): Promise<{ id: number; name: string }[]> {
  const r = await listDocs("authors", user, { where: tenantWhere(tenantId), limit: 200, sort: "name", depth: 0 });
  return r.docs.map((d) => ({ id: Number(d.id), name: String(d.name ?? d.id) }));
}

/** Statuses this user may set for the tenant (contributors w/o publish are limited). */
export function allowedStatuses(user: CmsUser, tenantId: number): string[] {
  return canPublish(user, tenantId) ? [...ARTICLE_STATUSES] : [...CONTRIBUTOR_ALLOWED_STATUSES];
}

/** Generic list for the simple managed collections (taxonomy, authors, modules). */
export async function listManagedItems(
  user: CmsUser,
  tenantId: number,
  def: CollectionDef,
  locale: string,
): Promise<{ id: number | string; title: string; sub?: string }[]> {
  const hasOrder = def.fields.some((f) => f.name === "order");
  const r = await listDocs(def.slug as CollectionSlug, user, {
    where: { tenant: { equals: tenantId } } as never,
    limit: 200,
    depth: 0,
    sort: hasOrder ? "order" : def.titleField,
    locale: def.localized ? locale : undefined,
  });
  return r.docs.map((d) => ({
    id: d.id,
    title: String(d[def.titleField] ?? d.id),
    sub: typeof d.slug === "string" ? d.slug : undefined,
  }));
}
