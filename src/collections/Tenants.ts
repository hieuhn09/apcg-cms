import type { CollectionConfig } from "payload";
import { LOCALE_CODES, LOCALE_LABELS } from "@/lib/locales";
import { isSystemAdmin, memberTenantIds, adminTenantIds } from "@/access/helpers";

/**
 * Tenants — one row per publication (DTW, Brief Asia, …). This IS the site
 * registry and the per-tenant configuration. The multi-tenant plugin uses this
 * collection as its `tenantsSlug`.
 *
 * Provisioning (create/delete, domain, status, languages, features, engines) is
 * a System Admin act. A Website Admin may edit a curated subset of their own
 * tenant (brand, SEO, contact, socials, menus) — enforced by field-level access
 * on the protected fields.
 *
 * `readTokens` holds HASHED per-tenant read tokens used by that tenant's public
 * frontend(s). Raw tokens are shown once on creation (managed by System Admin /
 * a token-mint script); only the hash + prefix live here.
 */

const localeOptions = LOCALE_CODES.map((code) => ({ label: LOCALE_LABELS[code], value: code }));

export const Tenants: CollectionConfig = {
  slug: "tenants",
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "slug", "status", "defaultLanguage"],
    group: "System",
    description: "Publications managed by the Central CMS. One row = one website.",
  },
  access: {
    read: ({ req }) => {
      if (isSystemAdmin(req)) return true;
      const ids = memberTenantIds(req);
      return ids.length ? { id: { in: ids } } : false;
    },
    create: ({ req }) => isSystemAdmin(req),
    // Website admins may open their own tenant; protected fields are read-only to
    // them via field-level access below.
    update: ({ req }) => {
      if (isSystemAdmin(req)) return true;
      const ids = adminTenantIds(req);
      return ids.length ? { id: { in: ids } } : false;
    },
    delete: ({ req }) => isSystemAdmin(req),
  },
  fields: [
    // ── Identity (system-managed) ──
    { name: "name", type: "text", required: true },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      index: true,
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: {
        description: "Stable publicationId (e.g. brief-asia, dtw). Must match the content-engine registry id. Never change after launch.",
      },
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "active",
      options: [
        { label: "Active", value: "active" },
        { label: "Suspended", value: "suspended" },
        { label: "Archived", value: "archived" },
      ],
      access: { update: ({ req }) => isSystemAdmin(req) },
    },
    {
      name: "domain",
      type: "text",
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Primary public hostname (e.g. briefasia.com)." },
    },
    {
      name: "additionalDomains",
      type: "array",
      fields: [{ name: "domain", type: "text" }],
      access: { update: ({ req }) => isSystemAdmin(req) },
    },
    {
      name: "frontendUrl",
      type: "text",
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Base URL the revalidate webhook POSTs to (e.g. https://briefasia.com)." },
    },

    // ── Brand (website-admin editable) ──
    { name: "logo", type: "upload", relationTo: "media" },
    { name: "brandColor", type: "text", admin: { description: "Primary brand color (hex or CSS var)." } },
    {
      name: "brand",
      type: "group",
      fields: [
        { name: "faviconUrl", type: "text" },
        { name: "ogImageDefault", type: "upload", relationTo: "media" },
        { name: "themeTokens", type: "json", admin: { description: "Optional design tokens passed to the frontend." } },
      ],
    },

    // ── Language (system-managed) ──
    {
      name: "defaultLanguage",
      type: "select",
      required: true,
      defaultValue: "en",
      options: localeOptions,
      access: { update: ({ req }) => isSystemAdmin(req) },
    },
    {
      name: "supportedLanguages",
      type: "select",
      hasMany: true,
      required: true,
      defaultValue: ["en"],
      options: localeOptions,
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Subset of platform locales this site uses. Translation jobs + public API clamp to this list." },
    },
    {
      name: "timezone",
      type: "text",
      defaultValue: "Asia/Singapore",
      access: { update: ({ req }) => isSystemAdmin(req) },
    },

    // ── SEO defaults (website-admin editable) ──
    {
      name: "seo",
      type: "group",
      fields: [
        { name: "titleSuffix", type: "text", admin: { description: "Appended to page titles, e.g. \"— BriefAsia\"." } },
        { name: "defaultMetaDescription", type: "textarea", localized: true },
        { name: "defaultOgImage", type: "upload", relationTo: "media" },
        { name: "twitterHandle", type: "text" },
      ],
    },

    // ── Contact + socials (website-admin editable) ──
    {
      name: "contact",
      type: "group",
      fields: [
        { name: "generalEmail", type: "text" },
        { name: "editorialEmail", type: "text" },
        { name: "advertisingEmail", type: "text" },
        { name: "partnershipsEmail", type: "text" },
      ],
    },
    {
      name: "socials",
      type: "array",
      fields: [
        { name: "platform", type: "text" },
        { name: "url", type: "text" },
      ],
    },

    // ── Feature flags (system-managed) ──
    {
      name: "features",
      type: "group",
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Per-tenant content modules. Disabled types are hidden in admin, 404 in the public API, and rejected by engine intake." },
      fields: [
        { name: "articles", type: "checkbox", defaultValue: true },
        { name: "newsletters", type: "checkbox", defaultValue: false },
        { name: "podcasts", type: "checkbox", defaultValue: false },
        { name: "marketData", type: "checkbox", defaultValue: false },
        { name: "sponsorSlots", type: "checkbox", defaultValue: false },
        { name: "wireDrops", type: "checkbox", defaultValue: false },
        { name: "corrections", type: "checkbox", defaultValue: true },
        { name: "translations", type: "checkbox", defaultValue: true },
      ],
    },

    // ── Engine governance (system-managed) ──
    {
      name: "allowedEngines",
      type: "relationship",
      relationTo: "content-engines",
      hasMany: true,
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Convenience list. Source of truth is ContentEngines.allowedTenants." },
    },

    // ── Public read tokens (system-managed, hashed) ──
    {
      name: "readTokens",
      type: "array",
      access: { update: ({ req }) => isSystemAdmin(req) },
      admin: { description: "Hashed per-tenant read tokens for the public frontend(s). Mint via scripts/mint-token.ts; raw shown once." },
      fields: [
        { name: "label", type: "text" },
        { name: "tokenHash", type: "text", required: true, admin: { readOnly: true } },
        { name: "tokenPrefix", type: "text", admin: { readOnly: true } },
        { name: "status", type: "select", defaultValue: "active", options: [
          { label: "Active", value: "active" },
          { label: "Revoked", value: "revoked" },
        ] },
      ],
    },
  ],
};
