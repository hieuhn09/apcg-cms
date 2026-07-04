import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";

const { afterChange, afterDelete } = revalidateHooks(["subsections:all", "articles:all"]);

/**
 * SubSections — second-level taxonomy nested under a pillar (brief-asia's
 * "Chuyên mục con", e.g. Perspectives → Interviews). Drives pillar-hub sub-tabs
 * and nav dropdowns on the frontends. Slug is unique within tenant + pillar
 * (two pillars may both have an "analysis" sub-section).
 */
export const SubSections: CollectionConfig = {
  slug: "subsections",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "pillar", "order"],
    listSearchableFields: ["slug", "title"],
    group: "Editorial",
  },
  access: featureGatedAccess("articles", tenantManagedAccess),
  hooks: { afterChange: [afterChange], afterDelete: [afterDelete] },
  fields: [
    {
      name: "title",
      type: "text",
      required: true,
      localized: true,
      admin: { description: "Label shown on the tab + nav (e.g. 'Interviews')." },
    },
    {
      name: "slug",
      type: "text",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug", ["pillar"])] },
      admin: { description: "URL slug (lowercase-dashed). Unique within a pillar." },
    },
    {
      name: "pillar",
      type: "relationship",
      relationTo: "pillars",
      required: true,
      index: true,
      admin: { description: "Parent pillar this sub-section belongs to." },
    },
    {
      name: "order",
      type: "number",
      required: true,
      defaultValue: 0,
      min: 0,
      admin: { description: "Lower = earlier in the tab bar and nav dropdown." },
    },
  ],
};
