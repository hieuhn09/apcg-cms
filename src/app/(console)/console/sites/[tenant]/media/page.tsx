/* eslint-disable @next/next/no-img-element */
import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listDocs } from "@/console/data/payload";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/console/ui/primitives";
import { MediaUploader } from "./media-uploader";
import { deleteMediaAction } from "./actions";

export default async function MediaPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const res = await listDocs("media", user, {
    where: { tenant: { equals: site.id } } as never,
    limit: 60,
    sort: "-createdAt",
    depth: 0,
    locale: site.defaultLanguage,
  });

  return (
    <div>
      <PageHeader title="Media" description={`${res.totalDocs} files`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Library" />
          <CardBody>
            {res.docs.length === 0 ? (
              <EmptyState>No media uploaded yet.</EmptyState>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {res.docs.map((d) => {
                  const url = (d.thumbnailURL as string) || (d.url as string) || "";
                  return (
                    <div key={String(d.id)} className="overflow-hidden rounded-md border border-line">
                      <div className="flex aspect-video items-center justify-center bg-line/30">
                        {url ? (
                          <img src={url} alt={String(d.alt ?? "")} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-xs text-muted">{String(d.filename ?? "file")}</span>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-1 p-2">
                        <span className="truncate text-xs text-muted" title={String(d.alt ?? "")}>
                          {String(d.alt ?? d.filename ?? d.id)}
                        </span>
                        <form action={deleteMediaAction}>
                          <input type="hidden" name="tenantSlug" value={site.slug} />
                          <input type="hidden" name="id" value={String(d.id)} />
                          <button type="submit" className="shrink-0 text-xs font-semibold text-bad hover:underline">
                            ✕
                          </button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Upload" />
          <CardBody>
            <MediaUploader tenantSlug={site.slug} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
