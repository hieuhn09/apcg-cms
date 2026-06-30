import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listPillars, listAuthorsLite, allowedStatuses } from "@/console/data/site";
import { PageHeader } from "@/console/ui/primitives";
import { ArticleForm } from "../article-form";
import { createArticleAction } from "../actions";

export default async function NewArticlePage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const [pillars, authors] = await Promise.all([
    listPillars(user, site.id, site.defaultLanguage),
    listAuthorsLite(user, site.id),
  ]);

  return (
    <div>
      <PageHeader title="New article" description={`Draft for ${site.name}`} />
      <ArticleForm
        action={createArticleAction}
        tenantSlug={site.slug}
        options={{ pillars, authors, statuses: allowedStatuses(user, site.id) }}
        submitLabel="Create article"
      />
    </div>
  );
}
