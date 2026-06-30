import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listManagedItems } from "@/console/data/site";
import { MANAGED_COLLECTIONS } from "@/console/data/collection-config";
import { PageHeader } from "@/console/ui/primitives";
import { CollectionManager } from "../manage/collection-manager";

export default async function PodcastsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site || !site.features.podcasts) notFound();

  const def = MANAGED_COLLECTIONS.podcasts;
  const items = await listManagedItems(user, site.id, def, site.defaultLanguage);

  return (
    <div>
      <PageHeader title="Podcasts" description="Podcast catalogue for this publication." />
      <div className="max-w-2xl">
        <CollectionManager def={def} tenantSlug={site.slug} items={items} />
      </div>
    </div>
  );
}
