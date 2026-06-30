import Link from "next/link";
import { requireSystemAdmin } from "@/console/auth";
import { listDocs } from "@/console/data/payload";
import { Badge, ButtonLink, EmptyState, PageHeader, Table, TR, TD, TH, THead } from "@/console/ui/primitives";
import { humanize, relativeTime } from "@/console/lib/format";

export default async function EnginesPage() {
  const user = await requireSystemAdmin();
  const res = await listDocs("content-engines", user, { limit: 100, sort: "name", depth: 0 });

  return (
    <div>
      <PageHeader
        title="Content engines"
        description={`${res.totalDocs} registered`}
        actions={<ButtonLink href="/console/engines/new" variant="primary">Register engine</ButtonLink>}
      />
      {res.docs.length === 0 ? (
        <EmptyState>No engines registered.</EmptyState>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Type</TH>
              <TH>Status</TH>
              <TH>Allowed</TH>
              <TH>Token</TH>
              <TH>Last seen</TH>
            </tr>
          </THead>
          <tbody>
            {res.docs.map((d) => {
              const tenants = Array.isArray(d.allowedTenants) ? d.allowedTenants.length : 0;
              const actions = Array.isArray(d.allowedActions) ? d.allowedActions.length : 0;
              const status = String(d.status ?? "active");
              return (
                <TR key={String(d.id)}>
                  <TD>
                    <Link href={`/console/engines/${d.id}`} className="font-semibold text-accent hover:underline">
                      {String(d.name ?? d.id)}
                    </Link>
                  </TD>
                  <TD className="text-muted">{humanize(String(d.engineType ?? "—"))}</TD>
                  <TD>
                    <Badge tone={status === "active" ? "good" : "bad"}>{humanize(status)}</Badge>
                  </TD>
                  <TD className="text-muted">
                    {tenants} pub · {actions} actions
                  </TD>
                  <TD className="font-mono text-xs text-muted">{d.tokenPrefix ? `${d.tokenPrefix}…` : "—"}</TD>
                  <TD className="text-muted">{relativeTime(d.lastSeenAt as string)}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
