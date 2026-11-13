import type { CollectionConfig, FilterOptions } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";
import { boothHallValidate } from "@/hooks/booth-hall";
import { BOOTH_HALLS } from "@/lib/booth-halls";

const { afterChange, afterDelete } = revalidateHooks(["booths:all"]);

// Halls (select options, per-tenant allowlist, decision) live in the pure
// src/lib/booth-halls.ts; re-exported here for existing importers.
export { BOOTH_HALLS } from "@/lib/booth-halls";

export const BOOTH_TIERS = [
  { label: "Basic", value: "basic" },
  { label: "Verified", value: "verified" },
  { label: "Premium", value: "premium" },
] as const;

/** Related articles must belong to the booth's own tenant. */
const sameTenantArticles: FilterOptions = ({ data }) => {
  const t = (data as { tenant?: unknown } | undefined)?.tenant;
  const id = t && typeof t === "object" ? (t as { id?: unknown }).id : t;
  return id == null || id === "" ? true : { tenant: { equals: id } };
};

/**
 * Booths: exhibitor listings of "The Beauty Exhibition" (abb) and "The
 * Exhibition" (amb) directories. Per-tenant, feature-gated on `exhibition`
 * (in practice only tenants `abb` and `amb` turn it on), so
 * the collection is hidden in admin and 404s in the public API for every other
 * tenant. Editor-managed ONLY: content engines have no write path to booths
 * (engine intake only writes articles; there is no `booths` engine action).
 *
 * The booth <-> article link lives on the BOOTH side (`articles`) on purpose:
 * Articles gains no field. Only rows with `published` ticked are public.
 */
export const Booths: CollectionConfig = {
  slug: "booths",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "hall", "tier", "verified", "published"],
    group: "Exhibition",
  },
  access: featureGatedAccess("exhibition", tenantManagedAccess),
  hooks: { afterChange: [afterChange], afterDelete: [afterDelete] },
  fields: [
    { name: "name", type: "text", required: true },
    {
      name: "slug",
      type: "text",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
      admin: { description: "URL slug. Unique within this tenant." },
    },
    {
      name: "published",
      type: "checkbox",
      defaultValue: false,
      index: true,
      admin: { position: "sidebar", description: "Only published booths appear on the website." },
    },
    {
      name: "hall",
      type: "select",
      options: [...BOOTH_HALLS],
      index: true,
      validate: boothHallValidate,
      admin: { description: "Each title uses six of these halls (AsiaBeautyBrief / AsiaMaterialsBrief); another title's hall is refused." },
    },
    { name: "typeLine", type: "text", admin: { description: 'e.g. "OEM/ODM Manufacturer".' } },
    { type: "row", fields: [{ name: "city", type: "text" }, { name: "country", type: "text" }] },
    { type: "row", fields: [
      { name: "verified", type: "checkbox", defaultValue: false },
      { name: "tier", type: "select", options: [...BOOTH_TIERS], defaultValue: "basic", required: true },
    ] },
    { name: "summary", type: "textarea" },
    { name: "about", type: "richText" },
    {
      name: "capabilities",
      type: "array",
      fields: [
        { name: "category", type: "text" },
        { name: "formats", type: "text" },
        { name: "moq", type: "text", admin: { description: "Minimum order quantity." } },
        { name: "leadTime", type: "text" },
      ],
    },
    {
      name: "atAGlance",
      type: "group",
      fields: [
        { name: "founded", type: "text" },
        { name: "employees", type: "text" },
        { name: "certifications", type: "text" },
        { name: "marketsServed", type: "text" },
        { name: "languages", type: "text" },
      ],
    },
    { name: "logo", type: "upload", relationTo: "media" },
    { name: "catalog", type: "upload", relationTo: "media", admin: { description: "Optional. Media accepts images only today." } },
    { name: "website", type: "text", admin: { description: "https://..." } },
    { name: "inquiryEmail", type: "email", admin: { description: 'Used for the "Request a quote" mailto link.' } },
    {
      name: "articles",
      type: "relationship",
      relationTo: "articles",
      hasMany: true,
      filterOptions: sameTenantArticles,
      admin: { description: "Articles this booth appears in (same tenant)." },
    },
  ],
};
