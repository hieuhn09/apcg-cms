import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listDocs } from "@/console/data/payload";
import { ARTICLE_STATUSES } from "@/lib/constants";
import {
  Badge,
  ButtonLink,
  EmptyState,
  PageHeader,
  Table,
  TR,
  TD,
  TH,
  THead,
} from "@/console/ui/primitives";
import { statusTone } from "@/console/lib/status";
import { humanize, relativeTime } from "@/console/lib/format";

const PAGE_SIZE = 25;

export default async function ArticlesPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const page = Math.max(1, Number(sp.page) || 1);
  const where: Record<string, unknown> = { tenant: { equals: site.id } };
  if (sp.status && sp.status !== "all") where.workflowStatus = { equals: sp.status };
  if (sp.q) where.title = { like: sp.q };

  const res = await listDocs("articles", user, {
    where: where as never,
    limit: PAGE_SIZE,
    page,
    sort: "-updatedAt",
    depth: 1,
    locale: site.defaultLanguage,
  });

  const base = `/console/sites/${site.slug}/articles`;

  return (
    <div>
      <PageHeader
        title="Articles"
        description={`${res.totalDocs} total`}
        actions={<ButtonLink href={`${base}/new`} variant="primary">New article</ButtonLink>}
      />

      <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
        <select
          name="status"
          defaultValue={sp.status ?? "all"}
          className="rounded-md border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          {ARTICLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Search title…"
          className="rounded-md border border-line bg-white px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md border border-accent bg-panel px-3 py-2 text-sm font-semibold text-accent">
          Filter
        </button>
      </form>

      {res.docs.length === 0 ? (
        <EmptyState>No articles match.</EmptyState>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Title</TH>
              <TH>Status</TH>
              <TH>Author</TH>
              <TH>Pillar</TH>
              <TH>Updated</TH>
            </tr>
          </THead>
          <tbody>
            {res.docs.map((d) => {
              const author = d.author as { name?: string } | null;
              const pillar = d.pillar as { title?: string } | null;
              return (
                <TR key={String(d.id)}>
                  <TD>
                    <Link href={`${base}/${d.id}`} className="font-semibold text-accent hover:underline">
                      {String(d.title ?? "(untitled)")}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={statusTone(String(d.workflowStatus ?? "draft"))}>
                      {humanize(String(d.workflowStatus ?? "draft"))}
                    </Badge>
                  </TD>
                  <TD className="text-muted">{author?.name ?? "—"}</TD>
                  <TD className="text-muted">{pillar?.title ?? "—"}</TD>
                  <TD className="text-muted">{relativeTime(d.updatedAt as string)}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}

      {res.totalPages > 1 ? (
        <div className="mt-4 flex items-center gap-3 text-sm">
          {page > 1 ? (
            <Link className="text-accent hover:underline" href={`${base}?page=${page - 1}${sp.status ? `&status=${sp.status}` : ""}`}>
              ← Prev
            </Link>
          ) : null}
          <span className="text-muted">
            Page {page} / {res.totalPages}
          </span>
          {res.hasNextPage ? (
            <Link className="text-accent hover:underline" href={`${base}?page=${page + 1}${sp.status ? `&status=${sp.status}` : ""}`}>
              Next →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
