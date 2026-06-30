"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUser, getPayloadClient, canPublish, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { createDoc, updateDoc, deleteDoc } from "@/console/data/payload";
import { markdownToLexical } from "@/lib/markdown";
import { slugify } from "@/lib/http";
import { CONTRIBUTOR_ALLOWED_STATUSES, type ArticleStatus } from "@/lib/constants";

export interface FormState {
  ok: boolean;
  error?: string;
}

async function resolveContext(slug: string): Promise<{ user: CmsUser; site: SiteConfig }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  const site = await getSiteConfig(user, slug);
  if (!site) throw new Error("Publication not found or not permitted");
  return { user, site };
}

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function assertStatusAllowed(user: CmsUser, tenantId: number, status: string): void {
  if (canPublish(user, tenantId)) return;
  if (!CONTRIBUTOR_ALLOWED_STATUSES.includes(status as ArticleStatus)) {
    throw new Error(`You are not allowed to set status "${status}".`);
  }
}

function estimateReadMin(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export async function createArticleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = str(formData, "tenantSlug");
  let newId: number | string | null = null;
  try {
    const { user, site } = await resolveContext(slug);
    const title = str(formData, "title");
    if (!title) return { ok: false, error: "Title is required." };
    const status = str(formData, "workflowStatus") || "draft";
    assertStatusAllowed(user, site.id, status);

    const bodyMarkdown = str(formData, "body");
    const pillar = Number(str(formData, "pillar")) || undefined;
    const author = Number(str(formData, "author")) || undefined;
    const articleSlug = slugify(str(formData, "slug") || title);

    const payload = await getPayloadClient();
    const body = bodyMarkdown ? await markdownToLexical(payload, bodyMarkdown) : undefined;

    const created = await createDoc(
      "articles",
      {
        tenant: site.id,
        title,
        slug: articleSlug,
        dek: str(formData, "dek") || title.slice(0, 200),
        takeaways: str(formData, "takeaways") || undefined,
        body,
        pillar,
        author,
        workflowStatus: status,
        _status: status === "published" ? "published" : "draft",
        origin: "manual",
        sourceLanguage: site.defaultLanguage,
        readMin: estimateReadMin(bodyMarkdown),
        publishedAt: status === "published" ? new Date().toISOString() : undefined,
      },
      user,
    );
    newId = created.id;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath(`/console/sites/${slug}/articles`);
  redirect(`/console/sites/${slug}/articles/${newId}`);
}

export async function updateArticleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = str(formData, "tenantSlug");
  const id = str(formData, "id");
  try {
    const { user, site } = await resolveContext(slug);
    if (!id) return { ok: false, error: "Missing article id." };
    const title = str(formData, "title");
    if (!title) return { ok: false, error: "Title is required." };
    const status = str(formData, "workflowStatus") || "draft";
    assertStatusAllowed(user, site.id, status);

    const bodyMarkdown = str(formData, "body");
    const pillar = Number(str(formData, "pillar")) || undefined;
    const author = Number(str(formData, "author")) || undefined;

    const payload = await getPayloadClient();
    const body = bodyMarkdown ? await markdownToLexical(payload, bodyMarkdown) : undefined;

    await updateDoc(
      "articles",
      id,
      {
        title,
        slug: slugify(str(formData, "slug") || title),
        dek: str(formData, "dek") || title.slice(0, 200),
        takeaways: str(formData, "takeaways") || undefined,
        ...(body ? { body } : {}),
        pillar,
        author,
        workflowStatus: status,
        _status: status === "published" ? "published" : "draft",
        readMin: estimateReadMin(bodyMarkdown),
        ...(status === "published" ? { publishedAt: new Date().toISOString() } : {}),
      },
      user,
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath(`/console/sites/${slug}/articles/${id}`);
  revalidatePath(`/console/sites/${slug}/articles`);
  return { ok: true };
}

/** Lightweight status transition used by the inline workflow controls. */
export async function setArticleStatusAction(formData: FormData): Promise<void> {
  const slug = str(formData, "tenantSlug");
  const id = str(formData, "id");
  const status = str(formData, "status");
  const { user, site } = await resolveContext(slug);
  assertStatusAllowed(user, site.id, status);
  await updateDoc(
    "articles",
    id,
    {
      workflowStatus: status,
      _status: status === "published" ? "published" : "draft",
      ...(status === "published" ? { publishedAt: new Date().toISOString() } : {}),
    },
    user,
  );
  revalidatePath(`/console/sites/${slug}/articles/${id}`);
  revalidatePath(`/console/sites/${slug}/articles`);
}

export async function deleteArticleAction(formData: FormData): Promise<void> {
  const slug = str(formData, "tenantSlug");
  const id = str(formData, "id");
  const { user } = await resolveContext(slug);
  await deleteDoc("articles", id, user);
  revalidatePath(`/console/sites/${slug}/articles`);
  redirect(`/console/sites/${slug}/articles`);
}
