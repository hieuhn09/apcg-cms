import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listManagedItems } from "@/console/data/site";
import { MANAGED_COLLECTIONS } from "@/console/data/collection-config";
import { PageHeader } from "@/console/ui/primitives";
import { CollectionManager } from "../manage/collection-manager";

export default async function AuthorsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const def = MANAGED_COLLECTIONS.authors;
  const items = await listManagedItems(user, site.id, def, site.defaultLanguage);

  return (
    <div>
      <PageHeader title="Authors" description="Bylines for this publication." />
      <div className="max-w-2xl">
        <CollectionManager def={def} tenantSlug={site.slug} items={items} />
      </div>
    </div>
  );
}
