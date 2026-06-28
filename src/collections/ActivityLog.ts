import type { CollectionConfig } from "payload";
import { isSystemAdmin, memberTenantIds } from "@/access/helpers";
import { ACTIVITY_EVENTS } from "@/lib/constants";

/**
 * ActivityLog — append-only event stream. Designed so the monitoring reports in
 * the brief (counts per tenant/status, human vs engine, translation health,
 * engine health, integration errors, publish history, blocked overwrites) can be
 * built later WITHOUT new modeling. Written exclusively via logActivity()
 * (overrideAccess); read-only in admin.
 *
 * `tenant` is a plain optional relationship (NOT plugin-managed) because some
 * events are global (e.g. engine auth failure before a tenant is resolved).
 */
export const ActivityLog: CollectionConfig = {
  slug: "activityLog",
  admin: {
    useAsTitle: "eventType",
    defaultColumns: ["eventType", "tenant", "actorType", "createdAt"],
    group: "System",
    description: "Read-only audit + monitoring event stream.",
  },
  access: {
    read: ({ req }) => {
      if (isSystemAdmin(req)) return true;
      const ids = memberTenantIds(req);
      return ids.length ? { tenant: { in: ids } } : false;
    },
    create: () => false,
    update: () => false,
    delete: ({ req }) => isSystemAdmin(req),
  },
  fields: [
    { name: "eventType", type: "select", required: true, index: true, options: ACTIVITY_EVENTS.map((e) => ({ label: e, value: e })) },
    { name: "tenant", type: "relationship", relationTo: "tenants", index: true },
    {
      name: "actorType",
      type: "select",
      required: true,
      options: [
        { label: "Human", value: "human" },
        { label: "Engine", value: "engine" },
        { label: "System", value: "system" },
      ],
    },
    { name: "actorUser", type: "relationship", relationTo: "users" },
    { name: "actorEngine", type: "relationship", relationTo: "content-engines" },
    { name: "targetCollection", type: "text" },
    { name: "targetId", type: "text" },
    { name: "fromStatus", type: "text" },
    { name: "toStatus", type: "text" },
    { name: "detail", type: "json" },
  ],
  timestamps: true,
};
