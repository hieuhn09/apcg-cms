import type { CollectionConfig } from "payload";
import { readOwnTenants } from "@/access/helpers";
import { isSystemAdmin } from "@/access/helpers";
import { tenantIdsWithRole } from "@/access/helpers";
import { LOCALE_CODES, LOCALE_LABELS } from "@/lib/locales";
import { TRANSLATION_JOB_STATUSES } from "@/lib/constants";

const localeOptions = LOCALE_CODES.map((code) => ({ label: LOCALE_LABELS[code], value: code }));

/**
 * TranslationJobs — per-tenant translation queue, feature-gated (`translations`).
 * Source create/update enqueues jobs (queued); a translation engine claims them
 * and posts results back to /api/engine/translation. The `tenant` field is added
 * by the plugin. Jobs are created by hooks/handlers (overrideAccess); editors can
 * read/cancel within their tenant.
 */
export const TranslationJobs: CollectionConfig = {
  slug: "translationJobs",
  admin: {
    useAsTitle: "id",
    defaultColumns: ["article", "targetLocale", "status", "attempts"],
    group: "System",
    description: "Per-language translation queue.",
  },
  access: {
    read: ({ req }) => readOwnTenants(req),
    create: ({ req }) => isSystemAdmin(req),
    update: ({ req }) => {
      if (isSystemAdmin(req)) return true;
      const ids = tenantIdsWithRole(req, ["websiteAdmin", "editor"]);
      return ids.length ? { tenant: { in: ids } } : false;
    },
    delete: ({ req }) => isSystemAdmin(req),
  },
  fields: [
    { name: "article", type: "relationship", relationTo: "articles", required: true, index: true },
    { name: "sourceLocale", type: "select", required: true, options: localeOptions },
    { name: "targetLocale", type: "select", required: true, index: true, options: localeOptions },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "queued",
      index: true,
      options: TRANSLATION_JOB_STATUSES.map((s) => ({ label: s.replace(/_/g, " "), value: s })),
    },
    { name: "engine", type: "relationship", relationTo: "content-engines" },
    { name: "attempts", type: "number", defaultValue: 0 },
    { name: "lastError", type: "textarea" },
    { name: "sourceVersion", type: "number", admin: { description: "article.version this job targets (detect superseded jobs)." } },
  ],
  timestamps: true,
};
