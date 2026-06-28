import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/**
 * Tags — per-tenant free taxonomy. Find-or-create by slug during engine intake,
 * scoped to the tenant. Slug unique within tenant.
 */
export const Tags: CollectionConfig = {
  slug: "tags",
  admin: { useAsTitle: "slug", defaultColumns: ["slug"], group: "Editorial" },
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
  ],
};
