import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";

/**
 * Menus — per-tenant navigation config (header / footer). Modeled as its own
 * collection (rather than folded into Tenants) so editors can change navigation
 * without touching tenant provisioning. One header doc + one footer doc per
 * tenant by convention. Items support nested children (one level).
 */
export const Menus: CollectionConfig = {
  slug: "menus",
  admin: { useAsTitle: "type", defaultColumns: ["type"], group: "Editorial" },
  access: tenantManagedAccess,
  fields: [
    {
      name: "type",
      type: "select",
      required: true,
      options: [
        { label: "Header", value: "header" },
        { label: "Footer", value: "footer" },
      ],
    },
    {
      name: "items",
      type: "array",
      fields: [
        { name: "label", type: "text", required: true, localized: true },
        { name: "href", type: "text", required: true },
        {
          name: "children",
          type: "array",
          fields: [
            { name: "label", type: "text", required: true, localized: true },
            { name: "href", type: "text", required: true },
          ],
        },
      ],
    },
  ],
};
