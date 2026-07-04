import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/** Newsletters — per-tenant, feature-gated (`newsletters`). */
export const Newsletters: CollectionConfig = {
  slug: "newsletters",
  admin: { useAsTitle: "name", defaultColumns: ["name", "cadence", "active"], group: "Editorial" },
  access: featureGatedAccess("newsletters", tenantManagedAccess),
  fields: [
    { name: "name", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, index: true, hooks: { beforeValidate: [uniqueWithinTenant("slug")] } },
    { name: "cadence", type: "text" },
    { name: "description", type: "textarea", localized: true },
    { name: "vertical", type: "relationship", relationTo: "pillars" },
    { name: "subscribers", type: "text", admin: { description: "Display string for the subscriber count (e.g. 48,200)." } },
    { name: "active", type: "checkbox", defaultValue: true },
    { name: "order", type: "number", defaultValue: 0 },
  ],
};
