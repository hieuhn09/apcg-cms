import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";

/** FxRates — per-tenant, feature-gated (`marketData`). */
export const FxRates: CollectionConfig = {
  slug: "fxRates",
  admin: { useAsTitle: "pair", defaultColumns: ["pair", "value", "changePct"], group: "Data" },
  access: tenantManagedAccess,
  fields: [
    { name: "order", type: "number", defaultValue: 0 },
    { name: "pair", type: "text", required: true, admin: { description: "e.g. USD/SGD" } },
    { name: "value", type: "number" },
    { name: "changePct", type: "number" },
    { name: "updatedAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
