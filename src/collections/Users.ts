import type { CollectionConfig } from "payload";
import { isSystemAdmin } from "@/access/helpers";

/**
 * Users — GLOBAL editorial identity. One account can work across multiple
 * tenants. The top-level `role` only distinguishes a System Admin (cross-tenant
 * superuser) from a standard user; all per-tenant roles live on the `tenants`
 * array that @payloadcms/plugin-multi-tenant adds (configured in payload.config
 * with rowFields `roles` + `canPublish`). See src/access/helpers.ts.
 *
 * Reader accounts (Better-Auth) are NOT here — they stay in each frontend app.
 */
export const Users: CollectionConfig = {
  slug: "users",
  auth: {
    tokenExpiration: 60 * 60 * 24 * 7, // 7 days
    cookies: { sameSite: "Lax" },
    verify: false,
  },
  admin: {
    useAsTitle: "email",
    defaultColumns: ["email", "name", "role"],
    group: "System",
  },
  access: {
    // System admin manages all; a standard user can read the roster of users
    // (so website admins can see who has access) but only edits themselves.
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => isSystemAdmin(req),
    update: ({ req }) =>
      isSystemAdmin(req) ? true : req.user ? { id: { equals: req.user.id } } : false,
    delete: ({ req }) => isSystemAdmin(req),
  },
  fields: [
    { name: "name", type: "text", required: true },
    {
      name: "role",
      type: "select",
      required: true,
      defaultValue: "standard",
      access: {
        // Only a system admin can grant/revoke the global superuser role.
        update: ({ req }) => isSystemAdmin(req),
        create: ({ req }) => isSystemAdmin(req),
      },
      options: [
        { label: "System Admin (all tenants)", value: "systemAdmin" },
        { label: "Standard (tenant-scoped)", value: "standard" },
      ],
      admin: {
        description:
          "System Admin = cross-tenant superuser. Standard = access only via per-tenant grants below.",
      },
    },
  ],
};
