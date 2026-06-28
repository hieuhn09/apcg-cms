import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";

const { afterChange, afterDelete } = revalidateHooks(["pillars:all", "articles:all"]);

/**
 * Pillars — per-tenant top-level taxonomy (verticals/beats). Taxonomy differs
 * per publication (DTW's pillars ≠ Brief Asia's), so this is tenant-scoped. Slug
 * is unique WITHIN a tenant (not globally) — see uniqueWithinTenant.
 *
 * A pillar's color/label is denormalized into article cards, so an edit busts
 * both pillars:all and articles:all on the owning tenant's frontend.
 */
export const Pillars: CollectionConfig = {
  slug: "pillars",
  admin: {
    useAsTitle: "slug",
    defaultColumns: ["slug", "order", "color"],
    group: "Editorial",
  },
  access: tenantManagedAccess,
  hooks: { afterChange: [afterChange], afterDelete: [afterDelete] },
  fields: [
    {
      name: "slug",
      type: "text",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
      admin: { description: "URL slug. Unique within this tenant." },
    },
    { name: "title", type: "text", required: true, localized: true },
    { name: "heading", type: "text", localized: true, admin: { description: "Long H1; falls back to title." } },
    { name: "color", type: "text", admin: { description: "CSS color reference used in nav + cover tints." } },
    { name: "icon", type: "text", admin: { description: "Icon name from the frontend icon set." } },
    { name: "order", type: "number", defaultValue: 0, min: 0 },
    { name: "description", type: "textarea", localized: true },
  ],
};
