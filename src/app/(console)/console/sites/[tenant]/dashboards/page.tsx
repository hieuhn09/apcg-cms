import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listManagedItems } from "@/console/data/site";
import { MANAGED_COLLECTIONS } from "@/console/data/collection-config";
import { PageHeader } from "@/console/ui/primitives";
import { CollectionManager } from "../manage/collection-manager";

const DEFS = [MANAGED_COLLECTIONS.fundingRows, MANAGED_COLLECTIONS.aiLeaderboardRows];

export default async function DashboardsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site || !site.features.dashboards) notFound();

  const lists = await Promise.all(DEFS.map((def) => listManagedItems(user, site.id, def, site.defaultLanguage)));

  return (
    <div>
      <PageHeader title="Dashboards" description="Funding tracker and AI leaderboard rows for this publication." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {DEFS.map((def, i) => (
          <CollectionManager key={def.slug} def={def} tenantSlug={site.slug} items={lists[i] ?? []} />
        ))}
      </div>
    </div>
  );
}
