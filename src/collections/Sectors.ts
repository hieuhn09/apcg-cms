import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/**
 * Sectors — per-tenant finer-grained fields (Markets, Banking, Fintech, AI…).
 * An article can carry several. Tenant-scoped; slug unique within tenant.
 */
export const Sectors: CollectionConfig = {
  slug: "sectors",
  admin: { useAsTitle: "slug", defaultColumns: ["slug", "order"], group: "Editorial" },
  access: tenantManagedAccess,
  fields: [
    {
      name: "slug",
      type: "text",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
    },
    { name: "title", type: "text", required: true, localized: true },
    { name: "description", type: "textarea", localized: true },
    { name: "order", type: "number", defaultValue: 0 },
  ],
};
