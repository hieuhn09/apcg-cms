"use server";
import { revalidatePath } from "next/cache";
import { getSessionUser, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { createDoc, deleteDoc } from "@/console/data/payload";
import { getCollectionDef } from "@/console/data/collection-config";
import { slugify } from "@/lib/http";
import type { CollectionSlug } from "payload";

export interface FormState {
  ok: boolean;
  error?: string;
}

async function ctx(slug: string): Promise<{ user: CmsUser; site: SiteConfig }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  const site = await getSiteConfig(user, slug);
  if (!site) throw new Error("Publication not found or not permitted");
  return { user, site };
}

function s(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function createItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const tenantSlug = s(formData, "tenantSlug");
  const collection = s(formData, "collection");
  const def = getCollectionDef(collection);
  if (!def) return { ok: false, error: "Unknown collection." };

  try {
    const { user, site } = await ctx(tenantSlug);
    const data: Record<string, unknown> = { tenant: site.id };
    for (const f of def.fields) {
      const raw = s(formData, f.name);
      if (f.required && !raw) return { ok: false, error: `${f.label} is required.` };
      if (!raw) continue;
      data[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    // Auto-slug from the title field when a `slug` field exists but was left blank.
    if (def.fields.some((f) => f.name === "slug") && !data.slug) {
      const title = data[def.titleField];
      if (typeof title === "string") data.slug = slugify(title);
    }
    await createDoc(collection as CollectionSlug, data, user, { locale: def.localized ? site.defaultLanguage : undefined });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath(`/console/sites/${tenantSlug}`, "layout");
  return { ok: true };
}

export async function deleteItemAction(formData: FormData): Promise<void> {
  const tenantSlug = s(formData, "tenantSlug");
  const collection = s(formData, "collection");
  const id = s(formData, "id");
  const def = getCollectionDef(collection);
  if (!def) return;
  const { user } = await ctx(tenantSlug);
  await deleteDoc(collection as CollectionSlug, id, user);
  revalidatePath(`/console/sites/${tenantSlug}`, "layout");
}
