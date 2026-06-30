import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { getDoc } from "@/console/data/payload";
import { listPillars, listAuthorsLite, allowedStatuses } from "@/console/data/site";
import { Badge, Button, Card, CardBody, CardHeader, PageHeader } from "@/console/ui/primitives";
import { statusTone } from "@/console/lib/status";
import { humanize } from "@/console/lib/format";
import { ArticleForm } from "../article-form";
import { updateArticleAction, setArticleStatusAction, deleteArticleAction } from "../actions";

function relId(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return Number((value as { id?: unknown }).id);
  return Number(value);
}

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ tenant: string; id: string }>;
}) {
  const { tenant: slug, id } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const doc = await getDoc("articles", id, user, { depth: 1, locale: site.defaultLanguage });
  if (!doc) notFound();

  const [pillars, authors] = await Promise.all([
    listPillars(user, site.id, site.defaultLanguage),
    listAuthorsLite(user, site.id),
  ]);

  const statuses = allowedStatuses(user, site.id);
  const current = String(doc.workflowStatus ?? "draft");
  const base = `/console/sites/${site.slug}/articles`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={String(doc.title ?? "(untitled)")}
        description={
          <span className="flex items-center gap-2">
            <Badge tone={statusTone(current)}>{humanize(current)}</Badge>
            <span className="text-muted">v{String(doc.version ?? 1)}</span>
            {doc.editedByHuman ? <span className="text-muted">· human-edited</span> : null}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/api/preview/mint?slug=${encodeURIComponent(String(doc.slug ?? ""))}&tenant=${site.id}`}
              target="_blank"
              className="rounded-md border border-accent bg-panel px-3 py-2 text-sm font-semibold text-accent"
            >
              Preview ↗
            </Link>
            <Link href={base} className="rounded-md border border-line px-3 py-2 text-sm font-semibold text-muted">
              Back
            </Link>
          </div>
        }
      />

      <Card>
        <CardHeader title="Workflow" />
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            {statuses
              .filter((s) => s !== current)
              .map((s) => (
                <form key={s} action={setArticleStatusAction}>
                  <input type="hidden" name="tenantSlug" value={site.slug} />
                  <input type="hidden" name="id" value={String(doc.id)} />
                  <input type="hidden" name="status" value={s} />
                  <Button type="submit" variant="secondary">
                    → {humanize(s)}
                  </Button>
                </form>
              ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Edit" />
        <CardBody>
          <ArticleForm
            action={updateArticleAction}
            tenantSlug={site.slug}
            isEdit
            options={{ pillars, authors, statuses }}
            initial={{
              id: doc.id,
              title: String(doc.title ?? ""),
              slug: String(doc.slug ?? ""),
              dek: String(doc.dek ?? ""),
              takeaways: typeof doc.takeaways === "string" ? doc.takeaways : "",
              pillar: relId(doc.pillar),
              author: relId(doc.author),
              workflowStatus: current,
            }}
            submitLabel="Save changes"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Danger zone" />
        <CardBody>
          <form action={deleteArticleAction}>
            <input type="hidden" name="tenantSlug" value={site.slug} />
            <input type="hidden" name="id" value={String(doc.id)} />
            <Button type="submit" variant="danger">
              Delete article
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
