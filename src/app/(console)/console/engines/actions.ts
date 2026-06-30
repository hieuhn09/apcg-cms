"use server";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getSessionUser, isAdmin, type CmsUser } from "@/console/auth";
import { createDoc, updateDoc } from "@/console/data/payload";

export interface EngineFormState {
  ok: boolean;
  error?: string;
  /** Raw token shown ONCE after create/rotate. */
  rawToken?: string;
}

async function requireAdminUser(): Promise<CmsUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  if (!isAdmin(user)) throw new Error("System admin only.");
  return user;
}

function s(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function numbers(formData: FormData, key: string): number[] {
  return formData.getAll(key).map((v) => Number(v)).filter((n) => !Number.isNaN(n));
}

function strings(formData: FormData, key: string): string[] {
  return formData.getAll(key).map((v) => String(v)).filter(Boolean);
}

export async function createEngineAction(_prev: EngineFormState, formData: FormData): Promise<EngineFormState> {
  try {
    const user = await requireAdminUser();
    const name = s(formData, "name");
    if (!name) return { ok: false, error: "Name is required." };
    const raw = randomBytes(24).toString("hex");
    await createDoc(
      "content-engines",
      {
        name,
        engineType: s(formData, "engineType") || "writer",
        status: s(formData, "status") || "active",
        rawToken: raw,
        allowedTenants: numbers(formData, "allowedTenants"),
        allowedActions: strings(formData, "allowedActions"),
        rateLimitPerMin: Number(s(formData, "rateLimitPerMin")) || undefined,
        notes: s(formData, "notes") || undefined,
      },
      user,
    );
    revalidatePath("/console/engines");
    return { ok: true, rawToken: raw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateEngineAction(_prev: EngineFormState, formData: FormData): Promise<EngineFormState> {
  const id = s(formData, "id");
  try {
    const user = await requireAdminUser();
    if (!id) return { ok: false, error: "Missing engine id." };
    await updateDoc(
      "content-engines",
      id,
      {
        status: s(formData, "status") || "active",
        engineType: s(formData, "engineType") || "writer",
        allowedTenants: numbers(formData, "allowedTenants"),
        allowedActions: strings(formData, "allowedActions"),
        rateLimitPerMin: Number(s(formData, "rateLimitPerMin")) || undefined,
        notes: s(formData, "notes") || undefined,
      },
      user,
    );
    revalidatePath(`/console/engines/${id}`);
    revalidatePath("/console/engines");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function rotateEngineTokenAction(_prev: EngineFormState, formData: FormData): Promise<EngineFormState> {
  const id = s(formData, "id");
  try {
    const user = await requireAdminUser();
    if (!id) return { ok: false, error: "Missing engine id." };
    const raw = randomBytes(24).toString("hex");
    await updateDoc("content-engines", id, { rawToken: raw }, user);
    revalidatePath(`/console/engines/${id}`);
    return { ok: true, rawToken: raw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
