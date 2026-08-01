import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/**
 * Authors — per-tenant bylines. Separate from Users so published bylines can
 * outlive accounts and external contributors are supported. The `tenant` field
 * is added by the multi-tenant plugin. Find-or-create by name during engine
 * intake (scoped to the tenant).
 */
export const Authors: CollectionConfig = {
  slug: "authors",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["rank", "name", "role", "city"],
    group: "Editorial",
  },
  access: tenantManagedAccess,
  fields: [
    { name: "name", type: "text", required: true },
    {
      // Masthead order on the site's /about page (WTB feedback round 2, m15):
      // 1 = Editor-in-Chief, lower number = higher up.
      //
      // Deliberately NOT required and unique only WITHIN a tenant: authors the
      // engine creates are byline-only and never appear on the masthead, so they
      // keep rank NULL — Postgres allows many NULLs alongside a unique index. And
      // each publication has its own masthead, so two tenants may both have a #1.
      name: "rank",
      type: "number",
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("rank")] },
      admin: {
        position: "sidebar",
        description: "Masthead position on /about (1 = top). Leave empty for bylines that are not on the masthead.",
      },
    },
    // Optional — BA/DTW authors were imported by `name` (no slug); WTB carries a
    // slug. The uniqueWithinTenant hook short-circuits on null.
    {
      name: "slug",
      type: "text",
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
      admin: { description: "URL slug. Unique within this tenant (optional)." },
    },
    { name: "role", type: "text", admin: { description: "e.g. Asia Bureau Chief, Staff Writer." } },
    { name: "city", type: "text" },
    { name: "avatar", type: "upload", relationTo: "media", admin: { description: "Byline headshot (WTB)." } },
    { name: "bio", type: "textarea", localized: true },
    {
      name: "user",
      type: "relationship",
      relationTo: "users",
      admin: { description: "Optional link to a CMS user (auto-fills byline when they publish)." },
    },
  ],
};
