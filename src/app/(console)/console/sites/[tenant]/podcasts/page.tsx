import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listManagedItems } from "@/console/data/site";
import { MANAGED_COLLECTIONS, type CollectionDef } from "@/console/data/collection-config";
import { PageHeader } from "@/console/ui/primitives";
import { CollectionManager } from "../manage/collection-manager";

export default async function PodcastsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site || !site.features.podcasts) notFound();

  const seriesDef = MANAGED_COLLECTIONS.podcastSeries;
  const series = await listManagedItems(user, site.id, seriesDef, site.defaultLanguage);

  // Podcasts manager: inject the tenant's series as the `series` relation options.
  const def: CollectionDef = {
    ...MANAGED_COLLECTIONS.podcasts,
    fields: MANAGED_COLLECTIONS.podcasts.fields.map((f) =>
      f.name === "series" ? { ...f, options: series.map((s) => ({ value: String(s.id), label: s.title })) } : f,
    ),
  };
  const items = await listManagedItems(user, site.id, def, site.defaultLanguage);

  return (
    <div>
      <PageHeader title="Podcasts" description="Podcast series and episodes for this publication." />
      <div className="max-w-2xl space-y-6">
        <CollectionManager def={seriesDef} tenantSlug={site.slug} items={series} />
        <CollectionManager def={def} tenantSlug={site.slug} items={items} />
      </div>
    </div>
  );
}
