/**
 * Tenant listing for the console, scoped to what the user may see. Read via
 * Drizzle (locale-agnostic columns only).
 */
import "server-only";
import { inArray, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { tenants } from "./schema";
import { tenantScope, type CmsUser } from "../auth";
import type { FeatureKey } from "@/lib/constants";

export interface TenantRow {
  id: number;
  name: string;
  slug: string;
  status: string;
}

export interface SiteConfig extends TenantRow {
  defaultLanguage: string;
  features: Record<FeatureKey, boolean>;
}

export async function listTenants(user: CmsUser | null): Promise<TenantRow[]> {
  const scope = tenantScope(user);
  const base = db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, status: tenants.status })
    .from(tenants)
    .orderBy(asc(tenants.name));
  const rows = scope.all
    ? await base
    : await base.where(inArray(tenants.id, scope.ids.length ? scope.ids : [-1]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? r.slug ?? String(r.id),
    slug: r.slug ?? "",
    status: r.status ?? "active",
  }));
}

export async function resolveTenant(user: CmsUser | null, slug: string): Promise<TenantRow | null> {
  const all = await listTenants(user);
  return all.find((t) => t.slug === slug) ?? null;
}

/** Full per-site config (incl. feature flags), access-scoped via resolveTenant. */
export async function getSiteConfig(user: CmsUser | null, slug: string): Promise<SiteConfig | null> {
  const base = await resolveTenant(user, slug);
  if (!base) return null;
  const rows = await db.select().from(tenants).where(eq(tenants.id, base.id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...base,
    defaultLanguage: r.defaultLanguage ?? "en",
    features: {
      articles: Boolean(r.featuresArticles),
      newsletters: Boolean(r.featuresNewsletters),
      podcasts: Boolean(r.featuresPodcasts),
      marketData: Boolean(r.featuresMarketData),
      sponsorSlots: Boolean(r.featuresSponsorSlots),
      wireDrops: Boolean(r.featuresWireDrops),
      corrections: Boolean(r.featuresCorrections),
      translations: Boolean(r.featuresTranslations),
    },
  };
}
