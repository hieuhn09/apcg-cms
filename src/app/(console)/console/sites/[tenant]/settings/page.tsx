import { notFound, redirect } from "next/navigation";
import { requireUser, isAdmin, adminTenants } from "@/console/auth";
import { getSiteConfig } from "@/console/data/tenants";
import { getDoc } from "@/console/data/payload";
import { PageHeader } from "@/console/ui/primitives";
import { SettingsForm } from "./settings-form";
import { ReadTokens, type ReadTokenRow } from "./read-tokens";

function group(doc: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = doc[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export default async function SettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const user = await requireUser();
  const site = await getSiteConfig(user, slug);
  if (!site) notFound();

  const admin = isAdmin(user);
  if (!admin && !adminTenants(user).includes(site.id)) redirect(`/console/sites/${slug}`);

  const doc = (await getDoc("tenants", site.id, user, { depth: 0 })) ?? { id: site.id };
  const brand = group(doc, "brand");
  const seo = group(doc, "seo");
  const contact = group(doc, "contact");
  const readTokens: ReadTokenRow[] = admin && Array.isArray(doc.readTokens)
    ? doc.readTokens.map((row) => {
        const r = row as { label?: unknown; tokenPrefix?: unknown; status?: unknown };
        return { label: String(r.label ?? "frontend"), prefix: String(r.tokenPrefix ?? ""), status: String(r.status ?? "active") };
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={`Configuration for ${site.name}`} />
      <SettingsForm
        tenantSlug={site.slug}
        admin={admin}
        initial={{
          frontendUrl: String(doc.frontendUrl ?? ""),
          brandColor: String(brand.color ?? ""),
          seoTitleSuffix: String(seo.titleSuffix ?? ""),
          seoTwitterHandle: String(seo.twitterHandle ?? ""),
          contactGeneralEmail: String(contact.generalEmail ?? ""),
          contactEditorialEmail: String(contact.editorialEmail ?? ""),
          contactAdvertisingEmail: String(contact.advertisingEmail ?? ""),
          status: site.status,
          features: site.features,
        }}
      />
      {admin ? <ReadTokens tenantSlug={site.slug} tokens={readTokens} /> : null}
    </div>
  );
}
