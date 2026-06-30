"use server";
import { revalidatePath } from "next/cache";
import { getSessionUser, getPayloadClient, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { deleteDoc } from "@/console/data/payload";

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

export async function uploadMediaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = String(formData.get("tenantSlug") ?? "");
  try {
    const { user, site } = await ctx(slug);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file." };
    const altValue = String(formData.get("alt") ?? "").trim() || file.name;
    const buffer = Buffer.from(await file.arrayBuffer());

    const payload = await getPayloadClient();
    await payload.create({
      collection: "media",
      data: { tenant: site.id, alt: altValue } as never,
      file: { data: buffer, mimetype: file.type || "image/jpeg", name: file.name, size: file.size },
      user: user as never,
      overrideAccess: false,
      locale: site.defaultLanguage as never,
    });
    revalidatePath(`/console/sites/${slug}/media`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteMediaAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("tenantSlug") ?? "");
  const id = String(formData.get("id") ?? "");
  const { user } = await ctx(slug);
  await deleteDoc("media", id, user);
  revalidatePath(`/console/sites/${slug}/media`);
}
