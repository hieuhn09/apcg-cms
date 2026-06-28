import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/** Podcasts — per-tenant, feature-gated (`podcasts`). */
export const Podcasts: CollectionConfig = {
  slug: "podcasts",
  admin: { useAsTitle: "title", defaultColumns: ["title", "show", "episode", "publishedAt"], group: "Editorial" },
  access: tenantManagedAccess,
  fields: [
    { name: "show", type: "text" },
    { name: "episode", type: "text" },
    { name: "title", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, index: true, hooks: { beforeValidate: [uniqueWithinTenant("slug")] } },
    { name: "description", type: "textarea", localized: true },
    { name: "duration", type: "text" },
    { name: "host", type: "text" },
    { name: "audioUrl", type: "text", admin: { description: "Audio file URL (object storage)." } },
    { name: "publishedAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
