import { notFound } from "next/navigation";
import { requireUser, isAdmin, adminTenants } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { TabLink } from "@/console/ui/nav-link";
import { Badge } from "@/console/ui/primitives";

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const canManage = isAdmin(user) || adminTenants(user).includes(site.id);
  const base = `/console/sites/${site.slug}`;
  const tabs: { href: string; label: string; show: boolean }[] = [
    { href: base, label: "Overview", show: true },
    { href: `${base}/articles`, label: "Articles", show: site.features.articles },
    { href: `${base}/taxonomy`, label: "Taxonomy", show: true },
    { href: `${base}/authors`, label: "Authors", show: true },
    { href: `${base}/media`, label: "Media", show: true },
    { href: `${base}/newsletters`, label: "Newsletters", show: site.features.newsletters },
    { href: `${base}/podcasts`, label: "Podcasts", show: site.features.podcasts },
    { href: `${base}/corrections`, label: "Corrections", show: site.features.corrections },
    { href: `${base}/menus`, label: "Menus", show: true },
    { href: `${base}/settings`, label: "Settings", show: canManage },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">{site.name}</h1>
        <Badge tone={site.status === "active" ? "good" : "warn"}>{site.status}</Badge>
        <span className="text-sm text-muted">/{site.slug}</span>
      </div>
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <TabLink key={t.href} href={t.href} exact={t.href === base}>
              {t.label}
            </TabLink>
          ))}
      </div>
      {children}
    </div>
  );
}
