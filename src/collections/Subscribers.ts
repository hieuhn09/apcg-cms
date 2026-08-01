import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";

/**
 * Subscribers — newsletter email capture, one row per (tenant, email).
 *
 * Ported from world-travel-brief's `subscribers` collection, which its /account
 * page reads. It is deliberately NOT reader-account data: there is no link to
 * better-auth users, no bookmarks, no history — just an opt-in email plus the
 * newsletters it selected. That is editorial-side data, so it moves to Central
 * with the rest of the publication's content rather than staying behind in the
 * frontend's Drizzle tables.
 *
 * Email is unique WITHIN a tenant (the source site had it globally unique —
 * wrong here, two publications may legitimately share a subscriber address).
 *
 * Writes come from the frontend's /api/subscribe via the scoped helpers with
 * overrideAccess; the access rules below govern admin-UI traffic only.
 */
export const Subscribers: CollectionConfig = {
  slug: "subscribers",
  admin: {
    useAsTitle: "email",
    defaultColumns: ["email", "status", "subscribedAt"],
    group: "Audience",
    description: "Newsletter opt-ins. Not reader accounts — those stay in each site's own database.",
  },
  access: tenantManagedAccess,
  fields: [
    {
      name: "email",
      type: "email",
      required: true,
      index: true,
      hooks: { beforeValidate: [uniqueWithinTenant("email")] },
    },
    {
      name: "newsletters",
      type: "relationship",
      relationTo: "newsletters",
      hasMany: true,
      admin: { description: "Newsletters this subscriber opted into." },
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "subscribed",
      index: true,
      options: [
        { label: "Subscribed", value: "subscribed" },
        { label: "Unsubscribed", value: "unsubscribed" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "token",
      type: "text",
      index: true,
      admin: {
        position: "sidebar",
        readOnly: true,
        description: "Token behind the one-click unsubscribe link. Preserved on import so links already in inboxes keep working.",
      },
    },
    {
      name: "locale",
      type: "text",
      admin: { position: "sidebar", readOnly: true, description: "Locale the visitor was reading when they subscribed." },
    },
    {
      name: "subscribedAt",
      type: "date",
      admin: { position: "sidebar", readOnly: true },
    },
  ],
};
