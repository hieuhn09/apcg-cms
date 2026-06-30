import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { countByTenantStatus, recentActivity } from "@/console/data/stats";
import { ARTICLE_STATUSES } from "@/lib/constants";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, Stat } from "@/console/ui/primitives";
import { statusTone } from "@/console/lib/status";
import { humanize, relativeTime } from "@/console/lib/format";

export default async function SiteOverviewPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const scope = { all: false, ids: [site.id] };
  const [byStatus, recent] = await Promise.all([countByTenantStatus(scope), recentActivity(scope, 12)]);
  const statusCount = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
  const total = byStatus.reduce((s, r) => s + r.n, 0);
  const base = `/console/sites/${site.slug}`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Articles" value={total} />
        <Stat label="Published" value={statusCount("published")} />
        <Stat label="Pending review" value={statusCount("pending_review")} />
        <Stat label="Drafts" value={statusCount("draft")} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Articles by status"
            action={
              site.features.articles ? (
                <ButtonLink href={`${base}/articles`} variant="ghost">
                  Manage →
                </ButtonLink>
              ) : undefined
            }
          />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {ARTICLE_STATUSES.filter((s) => statusCount(s) > 0).map((s) => (
                <Badge key={s} tone={statusTone(s)}>
                  {humanize(s)}: {statusCount(s)}
                </Badge>
              ))}
              {total === 0 ? <EmptyState>No articles yet.</EmptyState> : null}
            </div>
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
                    <span className="truncate">
                      {humanize(r.eventType)}
                      {r.toStatus ? ` · → ${humanize(r.toStatus)}` : ""}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{relativeTime(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Enabled features" />
        <CardBody>
          <div className="flex flex-wrap gap-2">
            {Object.entries(site.features).map(([k, on]) => (
              <Badge key={k} tone={on ? "good" : "muted"}>
                {humanize(k)}
              </Badge>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
