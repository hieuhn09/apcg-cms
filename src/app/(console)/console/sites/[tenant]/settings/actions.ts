"use server";
import { revalidatePath } from "next/cache";
import { getSessionUser, isAdmin, adminTenants, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { updateDoc } from "@/console/data/payload";
import { FEATURE_KEYS } from "@/lib/constants";

export interface FormState {
  ok: boolean;
  error?: string;
}

async function ctx(slug: string): Promise<{ user: CmsUser; site: SiteConfig; admin: boolean; canManage: boolean }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  const site = await getSiteConfig(user, slug);
  if (!site) throw new Error("Publication not found or not permitted");
  const admin = isAdmin(user);
  const canManage = admin || adminTenants(user).includes(site.id);
  if (!canManage) throw new Error("You do not have permission to edit settings.");
  return { user, site, admin, canManage };
}

function s(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function updateSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = s(formData, "tenantSlug");
  try {
    const { user, site, admin } = await ctx(slug);

    const data: Record<string, unknown> = {
      frontendUrl: s(formData, "frontendUrl") || undefined,
      brand: { color: s(formData, "brandColor") || undefined },
      seo: {
        titleSuffix: s(formData, "seoTitleSuffix") || undefined,
        twitterHandle: s(formData, "seoTwitterHandle") || undefined,
      },
      contact: {
        generalEmail: s(formData, "contactGeneralEmail") || undefined,
        editorialEmail: s(formData, "contactEditorialEmail") || undefined,
        advertisingEmail: s(formData, "contactAdvertisingEmail") || undefined,
      },
    };

    // Feature flags + status are system-admin only (protected fields).
    if (admin) {
      const features: Record<string, boolean> = {};
      for (const k of FEATURE_KEYS) features[k] = formData.get(`feature_${k}`) === "on";
      data.features = features;
      const status = s(formData, "status");
      if (status) data.status = status;
    }

    await updateDoc("tenants", site.id, data, user);
    revalidatePath(`/console/sites/${slug}/settings`);
    revalidatePath(`/console/sites/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
