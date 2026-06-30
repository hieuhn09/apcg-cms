import { requireUser, isAdmin, tenantScope } from "@/console/auth";
import { listTenants } from "@/console/data/tenants";
import {
  countByTenantStatus,
  countByOrigin,
  translationBacklog,
  engineHealth,
  activityRollup,
  recentActivity,
} from "@/console/data/stats";
import { ARTICLE_STATUSES } from "@/lib/constants";
import {
  Badge,
  BarList,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
  Table,
  TR,
  TD,
  TH,
  THead,
} from "@/console/ui/primitives";
import { statusTone, originTone } from "@/console/lib/status";
import { humanize, relativeTime } from "@/console/lib/format";

const ACTIVITY_WINDOW_DAYS = 14;

export default async function OverviewPage() {
  const user = await requireUser();
  const admin = isAdmin(user);
  const scope = tenantScope(user);
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [tenants, byStatus, byOrigin, backlog, rollup, recent, engines] = await Promise.all([
    listTenants(user),
    countByTenantStatus(scope),
    countByOrigin(scope),
    translationBacklog(scope),
    activityRollup(scope, since),
    recentActivity(scope, 15),
    admin ? engineHealth() : Promise.resolve([]),
  ]);

  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));

  // Totals
  const total = byStatus.reduce((s, r) => s + r.n, 0);
  const published = byStatus.filter((r) => r.status === "published").reduce((s, r) => s + r.n, 0);
  const pending = byStatus.filter((r) => r.status === "pending_review").reduce((s, r) => s + r.n, 0);
  const staleEngines = engines.filter(
    (e) => e.status === "active" && (!e.lastSeenAt || Date.now() - e.lastSeenAt.getTime() > 24 * 60 * 60 * 1000),
  ).length;

  // Pivot per-tenant status counts. Only show statuses that actually occur.
  const usedStatuses = ARTICLE_STATUSES.filter((st) => byStatus.some((r) => r.status === st && r.n > 0));
  const perTenant = tenants.map((t) => {
    const counts: Record<string, number> = {};
    let rowTotal = 0;
    for (const st of usedStatuses) {
      const n = byStatus.find((r) => r.tenantId === t.id && r.status === st)?.n ?? 0;
      counts[st] = n;
      rowTotal += n;
    }
    return { tenant: t, counts, rowTotal };
  });

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`Across ${tenants.length} publication${tenants.length === 1 ? "" : "s"} · activity window ${ACTIVITY_WINDOW_DAYS}d`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Articles" value={total} />
        <Stat label="Published" value={published} />
        <Stat label="Pending review" value={pending} />
        <Stat
          label={admin ? "Engines" : "Publications"}
          value={admin ? engines.length : tenants.length}
          sub={admin && staleEngines ? `${staleEngines} stale / inactive` : undefined}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Articles by publication & status" />
          <CardBody className="p-0">
            {perTenant.length === 0 ? (
              <div className="p-4">
                <EmptyState>No publications visible to your account.</EmptyState>
              </div>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Publication</TH>
                    {usedStatuses.map((st) => (
                      <TH key={st} className="text-right">
                        {humanize(st)}
                      </TH>
                    ))}
                    <TH className="text-right">Total</TH>
                  </tr>
                </THead>
                <tbody>
                  {perTenant.map(({ tenant, counts, rowTotal }) => (
                    <TR key={tenant.id}>
                      <TD className="font-semibold">{tenant.name}</TD>
                      {usedStatuses.map((st) => (
                        <TD key={st} className="text-right tabular-nums">
                          {counts[st] ? <Badge tone={statusTone(st)}>{counts[st]}</Badge> : <span className="text-muted">0</span>}
                        </TD>
                      ))}
                      <TD className="text-right font-bold tabular-nums">{rowTotal}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="By origin" />
          <CardBody>
            <BarList items={byOrigin.map((o) => ({ label: humanize(o.label), value: o.n, tone: originTone(o.label) }))} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader title="Translation backlog" />
          <CardBody>
            <BarList items={backlog.map((b) => ({ label: humanize(b.label), value: b.n }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`Activity · last ${ACTIVITY_WINDOW_DAYS}d`} />
          <CardBody>
            <BarList
              items={rollup.slice(0, 8).map((a) => ({
                label: humanize(a.label),
                value: a.n,
                tone: a.label.includes("error") || a.label.includes("failed") || a.label.includes("denied") ? "bad" : "accent",
              }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          <CardBody className="p-0">
            {recent.length === 0 ? (
              <div className="p-4">
                <EmptyState>No recent activity.</EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-line/70">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{humanize(r.eventType)}</div>
                      <div className="truncate text-xs text-muted">
                        {r.tenantId != null ? tenantName.get(r.tenantId) ?? `tenant ${r.tenantId}` : "system"}
                        {r.actorType ? ` · ${r.actorType}` : ""}
                        {r.toStatus ? ` · → ${humanize(r.toStatus)}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted">{relativeTime(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {admin ? (
        <div className="mt-6">
          <Card>
            <CardHeader title="Content engines" />
            <CardBody className="p-0">
              {engines.length === 0 ? (
                <div className="p-4">
                  <EmptyState>No content engines registered.</EmptyState>
                </div>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Engine</TH>
                      <TH>Status</TH>
                      <TH>Last seen</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {engines.map((e) => {
                      const stale = e.status === "active" && (!e.lastSeenAt || Date.now() - e.lastSeenAt.getTime() > 24 * 60 * 60 * 1000);
                      return (
                        <TR key={e.id}>
                          <TD className="font-semibold">{e.name}</TD>
                          <TD>
                            <Badge tone={e.status === "active" ? "good" : "bad"}>{humanize(e.status)}</Badge>
                          </TD>
                          <TD className={stale ? "text-warn" : "text-muted"}>{relativeTime(e.lastSeenAt)}</TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
