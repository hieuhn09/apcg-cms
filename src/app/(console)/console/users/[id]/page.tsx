import { notFound } from "next/navigation";
import { requireSystemAdmin } from "@/console/auth";
import { getDoc } from "@/console/data/payload";
import { listTenants } from "@/console/data/tenants";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/console/ui/primitives";
import { humanize } from "@/console/lib/format";
import { UserEditForm, PasswordReset, AddMembershipForm } from "../user-forms";
import { removeMembershipAction } from "../actions";

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireSystemAdmin();
  const [doc, tenants] = await Promise.all([getDoc("users", id, admin, { depth: 1 }), listTenants(admin)]);
  if (!doc) notFound();

  const memberships = (Array.isArray(doc.tenants) ? doc.tenants : []).map((row) => {
    const r = row as { tenant?: unknown; roles?: unknown; canPublish?: unknown };
    const t = r.tenant as { id?: number; name?: string } | number | null;
    const tenantId = typeof t === "object" && t ? Number(t.id) : Number(t);
    const tenantName = typeof t === "object" && t ? String(t.name ?? tenantId) : String(tenantId);
    return {
      tenantId,
      tenantName,
      roles: Array.isArray(r.roles) ? (r.roles as string[]) : [],
      canPublish: Boolean(r.canPublish),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader title={String(doc.name ?? "User")} description={String(doc.email ?? "")} />

      <Card>
        <CardHeader title="Profile" />
        <CardBody>
          <UserEditForm id={doc.id} name={String(doc.name ?? "")} role={String(doc.role ?? "standard")} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Publication memberships" />
        <CardBody className="space-y-4">
          {memberships.length === 0 ? (
            <EmptyState>No memberships. Add one below.</EmptyState>
          ) : (
            <ul className="divide-y divide-line/70 rounded-md border border-line">
              {memberships.map((m) => (
                <li key={m.tenantId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{m.tenantName}</span>
                    {m.roles.map((r) => (
                      <Badge key={r} tone="muted">
                        {humanize(r)}
                      </Badge>
                    ))}
                    {m.canPublish ? <Badge tone="good">can publish</Badge> : null}
                  </span>
                  <form action={removeMembershipAction}>
                    <input type="hidden" name="id" value={String(doc.id)} />
                    <input type="hidden" name="tenant" value={m.tenantId} />
                    <button type="submit" className="text-xs font-semibold text-bad hover:underline">
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line pt-4">
            <AddMembershipForm id={doc.id} tenants={tenants.map((t) => ({ id: t.id, name: t.name }))} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reset password" />
        <CardBody>
          <PasswordReset id={doc.id} />
        </CardBody>
      </Card>
    </div>
  );
}
