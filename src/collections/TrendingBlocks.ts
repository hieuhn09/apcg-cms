import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/** TrendingBlocks — per-tenant blocklist of trending terms (feature: marketData/trending). */
export const TrendingBlocks: CollectionConfig = {
  slug: "trendingBlocks",
  admin: { useAsTitle: "term", defaultColumns: ["term"], group: "Data" },
  access: featureGatedAccess("marketData", tenantManagedAccess),
  fields: [{ name: "term", type: "text", required: true }],
};
