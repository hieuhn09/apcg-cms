import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";

const { afterChange, afterDelete } = revalidateHooks(["cities:all", "articles:all"]);

/**
 * Cities — per-tenant destination directory with map coordinates. Used by WTB's
 * "The Map" and /place/[slug] pages; feature-gated on `citiesMap` so it stays
 * hidden for tenants that don't run a city map (Brief Asia, DTW). Slug is unique
 * WITHIN a tenant (see uniqueWithinTenant). NOT the same as global Countries —
 * this carries lat/lng and is tenant-scoped.
 */
export const Cities: CollectionConfig = {
  slug: "cities",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "country", "region"],
    group: "Editorial",
  },
  access: featureGatedAccess("citiesMap", tenantManagedAccess),
  hooks: { afterChange: [afterChange], afterDelete: [afterDelete] },
  fields: [
    {
      name: "slug",
      type: "text",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
      admin: { description: "URL slug. Unique within this tenant." },
    },
    { name: "name", type: "text", required: true, localized: true },
    { name: "country", type: "text", localized: true },
    {
      name: "region",
      type: "select",
      options: [
        { label: "Europe", value: "europe" },
        { label: "Asia", value: "asia" },
        { label: "Americas", value: "americas" },
        { label: "Africa & Middle East", value: "africa-middle-east" },
        { label: "Oceania", value: "oceania" },
      ],
    },
    {
      type: "row",
      fields: [
        { name: "lat", type: "number" },
        { name: "lng", type: "number" },
      ],
    },
    { name: "blurb", type: "textarea", localized: true },
    { name: "bestTime", type: "text", admin: { description: "e.g. Apr–Jun, shoulder season." } },
  ],
};
