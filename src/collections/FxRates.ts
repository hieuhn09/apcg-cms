import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/** FxRates — per-tenant, feature-gated (`marketData`). */
export const FxRates: CollectionConfig = {
  slug: "fxRates",
  admin: { useAsTitle: "pair", defaultColumns: ["pair", "value", "changePct"], group: "Data" },
  access: featureGatedAccess("marketData", tenantManagedAccess),
  fields: [
    { name: "order", type: "number", defaultValue: 0 },
    { name: "pair", type: "text", required: true, admin: { description: "e.g. USD/SGD" } },
    { name: "value", type: "text", admin: { description: "Formatted display string (e.g. 1.3421) — matches the source sites' shape." } },
    { name: "changePct", type: "number" },
    { name: "updatedAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
