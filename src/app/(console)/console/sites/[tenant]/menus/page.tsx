import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { listDocs } from "@/console/data/payload";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TR, TD, TH, THead } from "@/console/ui/primitives";
import { humanize } from "@/console/lib/format";

export default async function MenusPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const res = await listDocs("menus", user, {
    where: { tenant: { equals: site.id } } as never,
    limit: 50,
    depth: 0,
    locale: site.defaultLanguage,
  });

  return (
    <div>
      <PageHeader
        title="Menus"
        description="Navigation menus. Nested items are edited in the Payload admin."
      />
      <Card>
        <CardHeader
          title="Menus"
          action={
            <Link
              href="/admin/collections/menus"
              className="text-sm font-semibold text-accent hover:underline"
              target="_blank"
            >
              Edit in Payload admin ↗
            </Link>
          }
        />
        <CardBody className="p-0">
          {res.docs.length === 0 ? (
            <div className="p-4">
              <EmptyState>No menus configured. Create one in the Payload admin.</EmptyState>
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Menu</TH>
                  <TH>Location</TH>
                  <TH />
                </tr>
              </THead>
              <tbody>
                {res.docs.map((d) => (
                  <TR key={String(d.id)}>
                    <TD className="font-semibold">{String(d.title ?? d.name ?? d.id)}</TD>
                    <TD className="text-muted">{humanize(String(d.location ?? d.type ?? "—"))}</TD>
                    <TD className="text-right">
                      <Link
                        href={`/admin/collections/menus/${d.id}`}
                        target="_blank"
                        className="text-sm font-semibold text-accent hover:underline"
                      >
                        Edit ↗
                      </Link>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
