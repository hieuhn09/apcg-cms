import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/**
 * AiLeaderboardRows — per-tenant, feature-gated (`dashboards`). Rows of the DTW
 * "AI Leaderboard" dashboard (previously static fixtures in the site repo).
 */
export const AiLeaderboardRows: CollectionConfig = {
  slug: "aiLeaderboardRows",
  admin: { useAsTitle: "model", defaultColumns: ["rank", "model", "maker"], group: "Data" },
  defaultSort: "rank",
  access: featureGatedAccess("dashboards", tenantManagedAccess),
  fields: [
    { name: "rank", type: "number", required: true },
    { name: "model", type: "text", required: true },
    { name: "maker", type: "text" },
    { name: "reasoning", type: "number", admin: { description: "Reasoning benchmark score." } },
    { name: "coding", type: "number", admin: { description: "Coding benchmark score." } },
    { name: "speed", type: "number", admin: { description: "Tokens/sec." } },
    { name: "price", type: "number", admin: { description: "USD per 1M tokens." } },
    { name: "ctx", type: "text", admin: { description: "Context window display string, e.g. 1M." } },
  ],
};
