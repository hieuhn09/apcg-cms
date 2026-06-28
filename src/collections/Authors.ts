import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";

/**
 * Authors — per-tenant bylines. Separate from Users so published bylines can
 * outlive accounts and external contributors are supported. The `tenant` field
 * is added by the multi-tenant plugin. Find-or-create by name during engine
 * intake (scoped to the tenant).
 */
export const Authors: CollectionConfig = {
  slug: "authors",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "role", "city"],
    group: "Editorial",
  },
  access: tenantManagedAccess,
  fields: [
    { name: "name", type: "text", required: true },
    { name: "role", type: "text", admin: { description: "e.g. Asia Bureau Chief, Staff Writer." } },
    { name: "city", type: "text" },
    { name: "bio", type: "textarea", localized: true },
    {
      name: "user",
      type: "relationship",
      relationTo: "users",
      admin: { description: "Optional link to a CMS user (auto-fills byline when they publish)." },
    },
  ],
};
