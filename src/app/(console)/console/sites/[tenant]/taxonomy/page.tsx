import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listManagedItems, listPillars } from "@/console/data/site";
import { MANAGED_COLLECTIONS, type CollectionDef } from "@/console/data/collection-config";
import { PageHeader } from "@/console/ui/primitives";
import { CollectionManager } from "../manage/collection-manager";

const DEFS = [MANAGED_COLLECTIONS.pillars, MANAGED_COLLECTIONS.sectors, MANAGED_COLLECTIONS.tags];

export default async function TaxonomyPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const lists = await Promise.all(DEFS.map((def) => listManagedItems(user, site.id, def, site.defaultLanguage)));

  // Sub-sections manager: inject the tenant's pillars as the relation options.
  const pillars = await listPillars(user, site.id, site.defaultLanguage);
  const subDef: CollectionDef = {
    ...MANAGED_COLLECTIONS.subsections,
    fields: MANAGED_COLLECTIONS.subsections.fields.map((f) =>
      f.name === "pillar"
        ? { ...f, options: pillars.map((p) => ({ value: String(p.id), label: p.title })) }
        : f,
    ),
  };
  const subItems = await listManagedItems(user, site.id, subDef, site.defaultLanguage);

  return (
    <div>
      <PageHeader title="Taxonomy" description="Pillars, sub-sections, sectors and tags for this publication." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {DEFS.map((def, i) => (
          <CollectionManager key={def.slug} def={def} tenantSlug={site.slug} items={lists[i] ?? []} />
        ))}
        <CollectionManager def={subDef} tenantSlug={site.slug} items={subItems} />
      </div>
    </div>
  );
}
