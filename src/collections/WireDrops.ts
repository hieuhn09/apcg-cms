import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { revalidateHooks } from "@/hooks/revalidate";

const { afterChange, afterDelete } = revalidateHooks(["wire-drops"]);

/** WireDrops — per-tenant realtime band items, feature-gated (`wireDrops`). */
export const WireDrops: CollectionConfig = {
  slug: "wireDrops",
  admin: { useAsTitle: "text", defaultColumns: ["city", "text", "publishedAt"], group: "Editorial" },
  access: featureGatedAccess("wireDrops", tenantManagedAccess),
  hooks: { afterChange: [afterChange], afterDelete: [afterDelete] },
  fields: [
    { name: "time", type: "text", admin: { description: "Display string, e.g. 08:42." } },
    { name: "city", type: "text" },
    { name: "text", type: "textarea", required: true, maxLength: 200, localized: true },
    { name: "publishedAt", type: "date", defaultValue: () => new Date().toISOString(), admin: { date: { pickerAppearance: "dayAndTime" } } },
    { name: "expiresAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" }, description: "Optional — the drop auto-hides from the public wire after this instant." } },
  ],
};
