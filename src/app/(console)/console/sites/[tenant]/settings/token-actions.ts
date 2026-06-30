"use server";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getSessionUser, isAdmin, type CmsUser } from "@/console/auth";
import { getSiteConfig, type SiteConfig } from "@/console/data/tenants";
import { getDoc, updateDoc } from "@/console/data/payload";
import { hashToken } from "@/lib/crypto";

export interface TokenFormState {
  ok: boolean;
  error?: string;
  rawToken?: string;
}

async function ctx(slug: string): Promise<{ user: CmsUser; site: SiteConfig }> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  if (!isAdmin(user)) throw new Error("System admin only.");
  const site = await getSiteConfig(user, slug);
  if (!site) throw new Error("Publication not found.");
  return { user, site };
}

interface TokenRow {
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  status: string;
}

function readRows(doc: Record<string, unknown>): TokenRow[] {
  const arr = Array.isArray(doc.readTokens) ? doc.readTokens : [];
  return arr.map((row) => {
    const r = row as Partial<TokenRow>;
    return {
      label: String(r.label ?? "frontend"),
      tokenHash: String(r.tokenHash ?? ""),
      tokenPrefix: String(r.tokenPrefix ?? ""),
      status: String(r.status ?? "active"),
    };
  });
}

export async function mintReadTokenAction(_prev: TokenFormState, formData: FormData): Promise<TokenFormState> {
  const slug = String(formData.get("tenantSlug") ?? "");
  try {
    const { user, site } = await ctx(slug);
    const label = String(formData.get("label") ?? "").trim() || "frontend";
    const raw = randomBytes(24).toString("hex");
    const { hash, prefix } = hashToken(raw);

    const doc = await getDoc("tenants", site.id, user, { depth: 0 });
    const rows = doc ? readRows(doc) : [];
    rows.push({ label, tokenHash: hash, tokenPrefix: prefix, status: "active" });
    await updateDoc("tenants", site.id, { readTokens: rows }, user);
    revalidatePath(`/console/sites/${slug}/settings`);
    return { ok: true, rawToken: raw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function revokeReadTokenAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("tenantSlug") ?? "");
  const prefix = String(formData.get("prefix") ?? "");
  const { user, site } = await ctx(slug);
  const doc = await getDoc("tenants", site.id, user, { depth: 0 });
  if (!doc) return;
  const rows = readRows(doc).map((r) => (r.tokenPrefix === prefix ? { ...r, status: "revoked" } : r));
  await updateDoc("tenants", site.id, { readTokens: rows }, user);
  revalidatePath(`/console/sites/${slug}/settings`);
}
