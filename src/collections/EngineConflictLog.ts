import type { CollectionConfig } from "payload";
import { isSystemAdmin, memberTenantIds } from "@/access/helpers";

/**
 * EngineConflictLog — per-tenant detailed record of every skipped engine write
 * (the field-level "no-overwrite" audit). Populated by the intake handler when a
 * write is refused because a field is locked or human-edited, or on a version
 * mismatch. Read-only in admin. The `tenant` field is added by the plugin.
 *
 * ActivityLog carries the coarse rollup; this is the per-field detail.
 */
export const EngineConflictLog: CollectionConfig = {
  slug: "engineConflictLog",
  admin: {
    useAsTitle: "field",
    defaultColumns: ["article", "field", "reason", "occurredAt"],
    group: "System",
    description: "Read-only. Populated automatically when an engine write is refused.",
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
    { name: "article", type: "relationship", relationTo: "articles", required: true },
    { name: "engine", type: "relationship", relationTo: "content-engines" },
    { name: "field", type: "text", required: true },
    { name: "engineValue", type: "json" },
    { name: "currentValue", type: "json" },
    {
      name: "reason",
      type: "select",
      required: true,
      options: [
        { label: "Locked field", value: "locked" },
        { label: "Edited by human", value: "human_edited" },
        { label: "Version mismatch", value: "version_mismatch" },
      ],
    },
    { name: "occurredAt", type: "date", required: true, defaultValue: () => new Date(), admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
