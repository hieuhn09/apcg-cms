"use server";
import { revalidatePath } from "next/cache";
import { getSessionUser, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { createDoc, deleteDoc } from "@/console/data/payload";

export interface FormState {
  ok: boolean;
  error?: string;
}

async function ctx(slug: string): Promise<{ user: CmsUser; site: SiteConfig }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  const site = await getSiteConfig(user, slug);
  if (!site || !site.features.corrections) throw new Error("Corrections are not enabled for this publication.");
  return { user, site };
}

function s(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function createCorrectionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = s(formData, "tenantSlug");
  try {
    const { user, site } = await ctx(slug);
    const article = Number(s(formData, "article")) || undefined;
    const summary = s(formData, "summary");
    if (!article) return { ok: false, error: "Select the article being corrected." };
    if (!summary) return { ok: false, error: "Summary is required." };
    await createDoc(
      "corrections",
      {
        tenant: site.id,
        article,
        summary,
        wasText: s(formData, "wasText") || undefined,
        nowText: s(formData, "nowText") || undefined,
        correctionDate: new Date().toISOString(),
      },
      user,
      { locale: site.defaultLanguage },
    );
    revalidatePath(`/console/sites/${slug}/corrections`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteCorrectionAction(formData: FormData): Promise<void> {
  const slug = s(formData, "tenantSlug");
  const id = s(formData, "id");
  const { user } = await ctx(slug);
  await deleteDoc("corrections", id, user);
  revalidatePath(`/console/sites/${slug}/corrections`);
}
