import type { CollectionConfig } from "payload";
import { isSystemAdmin } from "@/access/helpers";

/**
 * Countries — GLOBAL shared reference data (ISO country list). Universal, so it
 * lives once rather than being duplicated per tenant. Editors reference it;
 * System Admin maintains it. NOT a tenant-scoped collection.
 */
export const Countries: CollectionConfig = {
  slug: "countries",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "code", "region"],
    group: "Reference",
    description: "Shared ISO country reference data (all tenants).",
  },
  access: {
    read: () => true, // reference data; readable by any authenticated context
    create: ({ req }) => isSystemAdmin(req),
    update: ({ req }) => isSystemAdmin(req),
    delete: ({ req }) => isSystemAdmin(req),
  },
  fields: [
    { name: "name", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, unique: true, index: true },
    {
      name: "code",
      type: "text",
      required: true,
      unique: true,
      index: true,
      admin: { description: "ISO-3166 alpha-2, lowercase (engine sends these)." },
    },
    {
      name: "region",
      type: "select",
      options: [
        { label: "Southeast Asia", value: "southeast-asia" },
        { label: "East Asia", value: "east-asia" },
        { label: "South Asia", value: "south-asia" },
      ],
    },
    { name: "description", type: "textarea", localized: true },
    { name: "order", type: "number", defaultValue: 0 },
  ],
};
