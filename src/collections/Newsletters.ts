import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/** Newsletters — per-tenant, feature-gated (`newsletters`). */
export const Newsletters: CollectionConfig = {
  slug: "newsletters",
  admin: { useAsTitle: "name", defaultColumns: ["name", "cadence", "active"], group: "Editorial" },
  access: tenantManagedAccess,
  fields: [
    { name: "name", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, index: true, hooks: { beforeValidate: [uniqueWithinTenant("slug")] } },
    { name: "cadence", type: "text" },
    { name: "description", type: "textarea", localized: true },
    { name: "vertical", type: "relationship", relationTo: "pillars" },
    { name: "active", type: "checkbox", defaultValue: true },
    { name: "order", type: "number", defaultValue: 0 },
  ],
};
