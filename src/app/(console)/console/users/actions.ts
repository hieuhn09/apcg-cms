"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUser, isAdmin, type CmsUser } from "@/console/auth";
import { createDoc, updateDoc, getDoc } from "@/console/data/payload";
import type { MembershipRole } from "@/lib/constants";

export interface UserFormState {
  ok: boolean;
  error?: string;
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

interface MembershipRow {
  tenant: number;
  roles: MembershipRole[];
  canPublish: boolean;
}

function readMemberships(doc: Record<string, unknown>): MembershipRow[] {
  const arr = Array.isArray(doc.tenants) ? doc.tenants : [];
  return arr.map((row) => {
    const r = row as { tenant?: unknown; roles?: unknown; canPublish?: unknown };
    const tenant = typeof r.tenant === "object" && r.tenant ? Number((r.tenant as { id?: unknown }).id) : Number(r.tenant);
    return {
      tenant,
      roles: Array.isArray(r.roles) ? (r.roles as MembershipRole[]) : [],
      canPublish: Boolean(r.canPublish),
    };
  });
}

export async function createUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  let newId: number | string | null = null;
  try {
    const admin = await requireAdminUser();
    const name = s(formData, "name");
    const email = s(formData, "email");
    const password = s(formData, "password");
    if (!name || !email || !password) return { ok: false, error: "Name, email and password are required." };
    const created = await createDoc(
      "users",
      { name, email, password, role: s(formData, "role") || "standard" },
      admin,
    );
    newId = created.id;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath("/console/users");
  redirect(`/console/users/${newId}`);
}

export async function updateUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const id = s(formData, "id");
  try {
    const admin = await requireAdminUser();
    if (!id) return { ok: false, error: "Missing user id." };
    await updateDoc("users", id, { name: s(formData, "name"), role: s(formData, "role") || "standard" }, admin);
    revalidatePath(`/console/users/${id}`);
    revalidatePath("/console/users");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function setPasswordAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const id = s(formData, "id");
  try {
    const admin = await requireAdminUser();
    const password = s(formData, "password");
    if (!id || !password) return { ok: false, error: "New password required." };
    await updateDoc("users", id, { password }, admin);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function addMembershipAction(formData: FormData): Promise<void> {
  const admin = await requireAdminUser();
  const id = s(formData, "id");
  const tenantId = Number(s(formData, "tenant"));
  const role = s(formData, "role") as MembershipRole;
  const canPublish = formData.get("canPublish") === "on";
  if (!id || !tenantId || !role) return;

  const doc = await getDoc("users", id, admin, { depth: 0 });
  if (!doc) return;
  const memberships = readMemberships(doc).filter((m) => m.tenant !== tenantId);
  memberships.push({ tenant: tenantId, roles: [role], canPublish });
  await updateDoc("users", id, { tenants: memberships }, admin);
  revalidatePath(`/console/users/${id}`);
}

export async function removeMembershipAction(formData: FormData): Promise<void> {
  const admin = await requireAdminUser();
  const id = s(formData, "id");
  const tenantId = Number(s(formData, "tenant"));
  if (!id || !tenantId) return;

  const doc = await getDoc("users", id, admin, { depth: 0 });
  if (!doc) return;
  const memberships = readMemberships(doc).filter((m) => m.tenant !== tenantId);
  await updateDoc("users", id, { tenants: memberships }, admin);
  revalidatePath(`/console/users/${id}`);
}
