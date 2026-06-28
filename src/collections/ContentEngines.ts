import type { CollectionConfig } from "payload";
import { isSystemAdmin } from "@/access/helpers";
import { hashToken } from "@/lib/crypto";
import { ENGINE_ACTIONS, ENGINE_TYPES } from "@/lib/constants";

/**
 * ContentEngines — GLOBAL machine identities. Each engine (news crawler, AI
 * writer, translation engine, finance feed, podcast generator, importer) has its
 * OWN credential, its own allowed tenants, and its own allowed actions. There is
 * no shared all-powerful token: suspend or revoke one engine without touching
 * the others.
 *
 * Tokens are HASHED at rest (sha-256). On create, set `rawToken` once; the
 * beforeChange hook hashes it into `tokenHash` + stores `tokenPrefix` for
 * identification, then clears the raw value. The raw token is shown to the admin
 * exactly once (in the API response / mint script output) and never persisted.
 */
export const ContentEngines: CollectionConfig = {
  slug: "content-engines",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "engineType", "status", "tokenPrefix", "lastSeenAt"],
    group: "System",
    description: "Machine identities allowed to push content. System Admin only.",
  },
  access: {
    read: ({ req }) => isSystemAdmin(req),
    create: ({ req }) => isSystemAdmin(req),
    update: ({ req }) => isSystemAdmin(req),
    delete: ({ req }) => isSystemAdmin(req),
  },
  hooks: {
    beforeChange: [
      ({ data }) => {
        const raw = (data as { rawToken?: unknown }).rawToken;
        if (typeof raw === "string" && raw.trim().length >= 16) {
          const { hash, prefix } = hashToken(raw.trim());
          data.tokenHash = hash;
          data.tokenPrefix = prefix;
        }
        // Never persist the raw token.
        delete (data as { rawToken?: unknown }).rawToken;
        return data;
      },
    ],
  },
  fields: [
    { name: "name", type: "text", required: true },
    {
      name: "engineType",
      type: "select",
      required: true,
      defaultValue: "writer",
      options: ENGINE_TYPES.map((t) => ({ label: t, value: t })),
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "active",
      options: [
        { label: "Active", value: "active" },
        { label: "Suspended", value: "suspended" },
        { label: "Revoked", value: "revoked" },
      ],
    },
    {
      name: "rawToken",
      type: "text",
      virtual: true,
      admin: {
        description:
          "Paste a freshly generated token (≥16 chars) to set/rotate the credential. It is hashed on save and never stored. Copy it now — it cannot be retrieved.",
      },
    },
    { name: "tokenHash", type: "text", index: true, admin: { readOnly: true } },
    { name: "tokenPrefix", type: "text", admin: { readOnly: true, description: "First 8 chars, for identifying the token in logs." } },
    {
      name: "allowedTenants",
      type: "relationship",
      relationTo: "tenants",
      hasMany: true,
      required: true,
      admin: { description: "Tenants this engine may write to. A request for any other tenant is rejected + logged." },
    },
    {
      name: "allowedActions",
      type: "select",
      hasMany: true,
      required: true,
      options: ENGINE_ACTIONS.map((a) => ({ label: a, value: a })),
      admin: { description: "Operations this engine may perform." },
    },
    { name: "rateLimitPerMin", type: "number", admin: { description: "Optional. Empty = unlimited." } },
    { name: "lastSeenAt", type: "date", admin: { readOnly: true } },
    { name: "lastSeenIp", type: "text", admin: { readOnly: true } },
    { name: "notes", type: "textarea" },
  ],
};
