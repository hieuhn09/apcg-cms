import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/**
 * Podcast series — per-tenant, gated by the existing `podcasts` feature (a
 * series is meaningless without episodes, so no flag of its own). Episodes
 * link to one via the optional `Podcasts.series` relation; the legacy free-text
 * `Podcasts.show` stays untouched for tenants that still use it.
 */
export const PodcastSeries: CollectionConfig = {
  slug: "podcastSeries",
  admin: { useAsTitle: "name", defaultColumns: ["name", "slug"], group: "Editorial" },
  access: featureGatedAccess("podcasts", tenantManagedAccess),
  fields: [
    { name: "name", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, index: true, hooks: { beforeValidate: [uniqueWithinTenant("slug")] } },
    { name: "description", type: "textarea", localized: true },
    { name: "order", type: "number", defaultValue: 0 },
  ],
};
