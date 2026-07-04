import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/** Corrections — per-tenant, feature-gated (`corrections`). Public trust log. */
export const Corrections: CollectionConfig = {
  slug: "corrections",
  admin: { useAsTitle: "summary", defaultColumns: ["article", "summary", "correctionDate"], group: "Editorial" },
  access: featureGatedAccess("corrections", tenantManagedAccess),
  fields: [
    { name: "article", type: "relationship", relationTo: "articles", required: true },
    { name: "correctionDate", type: "date", defaultValue: () => new Date().toISOString() },
    { name: "summary", type: "text", required: true, localized: true },
    { name: "wasText", type: "textarea", localized: true },
    { name: "nowText", type: "textarea", localized: true },
    { name: "editor", type: "relationship", relationTo: "users" },
  ],
};
