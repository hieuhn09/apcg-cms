import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";

/** SponsorSlots — per-tenant, feature-gated (`sponsorSlots`). */
export const SponsorSlots: CollectionConfig = {
  slug: "sponsorSlots",
  admin: { useAsTitle: "slot", defaultColumns: ["slot", "article", "startsAt", "endsAt"], group: "Commercial" },
  access: tenantManagedAccess,
  fields: [
    {
      name: "slot",
      type: "select",
      required: true,
      options: [
        { label: "Homepage strip", value: "homepage_strip" },
        { label: "Dashboard — funding", value: "dashboard_funding" },
        { label: "Dashboard — AI", value: "dashboard_ai" },
      ],
    },
    { name: "article", type: "relationship", relationTo: "articles", admin: { description: "Empty = slot renders nothing." } },
    { name: "startsAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
    { name: "endsAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
