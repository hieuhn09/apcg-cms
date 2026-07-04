import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/** MarketSnapshots — per-tenant, feature-gated (`marketData`). */
export const MarketSnapshots: CollectionConfig = {
  slug: "marketSnapshots",
  admin: { useAsTitle: "market", defaultColumns: ["country", "market", "value", "changePct"], group: "Data" },
  access: featureGatedAccess("marketData", tenantManagedAccess),
  fields: [
    { name: "order", type: "number", defaultValue: 0 },
    { name: "country", type: "text" },
    { name: "market", type: "text", required: true },
    { name: "value", type: "text", admin: { description: "Formatted display string (e.g. 3,210.45) — matches the source sites' shape." } },
    { name: "changePct", type: "number" },
    { name: "summary", type: "textarea", admin: { description: "Editor-owned; preserved across automated refreshes." } },
    { name: "updatedAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
