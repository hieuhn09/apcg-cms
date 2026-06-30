import Link from "next/link";
import { requireSystemAdmin } from "@/console/auth";
import { listDocs } from "@/console/data/payload";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TR, TD, TH, THead } from "@/console/ui/primitives";
import { humanize } from "@/console/lib/format";
import { UserCreateForm } from "./user-forms";

export default async function UsersPage() {
  const user = await requireSystemAdmin();
  const res = await listDocs("users", user, { limit: 200, sort: "name", depth: 0 });

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description={`${res.totalDocs} users`} />

      <Card>
        <CardHeader title="All users" />
        <CardBody className="p-0">
          {res.docs.length === 0 ? (
            <div className="p-4">
              <EmptyState>No users.</EmptyState>
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Memberships</TH>
                </tr>
              </THead>
              <tbody>
                {res.docs.map((d) => {
                  const role = String(d.role ?? "standard");
                  const memberships = Array.isArray(d.tenants) ? d.tenants.length : 0;
                  return (
                    <TR key={String(d.id)}>
                      <TD>
                        <Link href={`/console/users/${d.id}`} className="font-semibold text-accent hover:underline">
                          {String(d.name ?? d.id)}
                        </Link>
                      </TD>
                      <TD className="text-muted">{String(d.email ?? "")}</TD>
                      <TD>
                        <Badge tone={role === "systemAdmin" ? "accent" : "muted"}>{humanize(role)}</Badge>
                      </TD>
                      <TD className="text-muted">{memberships}</TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Create user" />
        <CardBody>
          <UserCreateForm />
        </CardBody>
      </Card>
    </div>
  );
}
