import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/**
 * FundingRows — per-tenant, feature-gated (`dashboards`). Rows of the DTW
 * "Funding Tracker" dashboard (previously static fixtures in the site repo).
 */
export const FundingRows: CollectionConfig = {
  slug: "fundingRows",
  admin: { useAsTitle: "ticker", defaultColumns: ["ticker", "name", "country", "sector"], group: "Data" },
  defaultSort: "order",
  access: featureGatedAccess("dashboards", tenantManagedAccess),
  fields: [
    { name: "order", type: "number", defaultValue: 0 },
    { name: "ticker", type: "text", required: true },
    { name: "name", type: "text", required: true },
    { name: "country", type: "text" },
    { name: "sector", type: "text" },
    { name: "px", type: "number", admin: { description: "Last price." } },
    { name: "chg", type: "number", admin: { description: "Change %." } },
    { name: "mcap", type: "text", admin: { description: "Market cap display string, e.g. 4.1B." } },
    { name: "funding", type: "text", admin: { description: "Funding display string, e.g. Series C · 210M." } },
  ],
};
