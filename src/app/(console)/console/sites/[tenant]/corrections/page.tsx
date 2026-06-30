import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listDocs } from "@/console/data/payload";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/console/ui/primitives";
import { formatDate } from "@/console/lib/format";
import { CorrectionForm } from "./correction-form";
import { deleteCorrectionAction } from "./actions";

export default async function CorrectionsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site || !site.features.corrections) notFound();

  const [corr, arts] = await Promise.all([
    listDocs("corrections", user, {
      where: { tenant: { equals: site.id } } as never,
      limit: 100,
      sort: "-correctionDate",
      depth: 1,
      locale: site.defaultLanguage,
    }),
    listDocs("articles", user, {
      where: { tenant: { equals: site.id } } as never,
      limit: 200,
      sort: "-updatedAt",
      depth: 0,
      locale: site.defaultLanguage,
    }),
  ]);

  const articles = arts.docs.map((d) => ({ id: Number(d.id), title: String(d.title ?? d.id) }));

  return (
    <div>
      <PageHeader title="Corrections" description="Public corrections log for this publication." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Logged corrections" />
          <CardBody className="p-0">
            {corr.docs.length === 0 ? (
              <div className="p-4">
                <EmptyState>No corrections logged.</EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-line/70">
                {corr.docs.map((d) => {
                  const article = d.article as { title?: string } | null;
                  return (
                    <li key={String(d.id)} className="flex items-start justify-between gap-2 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold">{String(d.summary ?? "")}</div>
                        <div className="text-xs text-muted">
                          {article?.title ?? "—"} · {formatDate(d.correctionDate as string)}
                        </div>
                      </div>
                      <form action={deleteCorrectionAction}>
                        <input type="hidden" name="tenantSlug" value={site.slug} />
                        <input type="hidden" name="id" value={String(d.id)} />
                        <button type="submit" className="shrink-0 text-xs font-semibold text-bad hover:underline">
                          Delete
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="New correction" />
          <CardBody>
            <CorrectionForm tenantSlug={site.slug} articles={articles} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
