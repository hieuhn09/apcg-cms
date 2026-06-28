import type { CollectionConfig } from "payload";
import { editorialContentAccess } from "@/access/collections";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";
import {
  articleBookkeeping,
  articleActivity,
  enforceStatusAuthority,
} from "@/hooks/article-workflow";
import { enqueueTranslations } from "@/hooks/translation";
import {
  ARTICLE_STATUSES,
  CONTENT_ORIGINS,
  TRANSLATION_STATES,
} from "@/lib/constants";
import { LOCALE_CODES, LOCALE_LABELS } from "@/lib/locales";

const { afterChange: revalidate, afterDelete } = revalidateHooks(["articles:all"]);
const localeOptions = LOCALE_CODES.map((code) => ({ label: LOCALE_LABELS[code], value: code }));

/**
 * Articles — the system of record, now tenant-scoped. The `tenant` field is
 * added by the multi-tenant plugin.
 *
 * This generalizes brief-asia's Articles and makes REAL the version/lock
 * enforcement brief-asia left for "Phase E4":
 *   - workflowStatus: the editorial lifecycle (draft → … → archived). Separate
 *     from Payload's native draft/publish `_status` (kept for version history).
 *   - origin / editedByHuman / lockedFields / version: provenance + optimistic
 *     lock. The intake handler refuses to overwrite locked or human-edited
 *     fields and logs the attempt to EngineConflictLog. The beforeChange hook
 *     bumps version + flips editedByHuman for human writes.
 *   - translationStatus[] / sourceLanguage: per-language workflow state.
 */
export const Articles: CollectionConfig = {
  slug: "articles",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "pillar", "workflowStatus", "origin", "version", "publishedAt"],
    listSearchableFields: ["title", "dek", "slug"],
    group: "Editorial",
    preview: (doc) =>
      typeof doc?.slug === "string" ? `/api/preview/mint?slug=${doc.slug}` : null,
  },
  versions: { drafts: true },
  access: editorialContentAccess,
  hooks: {
    beforeValidate: [enforceStatusAuthority],
    beforeChange: [articleBookkeeping],
    afterChange: [revalidate, articleActivity, enqueueTranslations],
    afterDelete: [afterDelete],
  },
  fields: [
    {
      type: "tabs",
      tabs: [
        {
          label: "Content",
          fields: [
            { name: "title", type: "text", required: true, localized: true },
            {
              name: "slug",
              type: "text",
              required: true,
              index: true,
              localized: true,
              hooks: { beforeValidate: [uniqueWithinTenant("slug")] },
              admin: { description: "URL slug. Unique within this tenant." },
            },
            { name: "dek", type: "textarea", required: true, localized: true, label: "Standfirst (dek)" },
            { name: "body", type: "richText", localized: true },
            {
              name: "takeaways",
              type: "textarea",
              admin: { description: "Key takeaways — one bullet per line. Source language; empty hides the box." },
            },
            { name: "readMin", type: "number", required: true, defaultValue: 5, min: 1, label: "Read time (minutes)" },
          ],
        },
        {
          label: "Workflow",
          fields: [
            {
              name: "workflowStatus",
              type: "select",
              required: true,
              defaultValue: "draft",
              index: true,
              options: ARTICLE_STATUSES.map((s) => ({ label: s.replace(/_/g, " "), value: s })),
              admin: { description: "Editorial lifecycle. Publish authority is role-gated (contributors without publish rights are limited to draft / pending review)." },
            },
            {
              name: "publishedAt",
              type: "date",
              required: true,
              defaultValue: () => new Date().toISOString(),
              admin: { date: { pickerAppearance: "dayAndTime", displayFormat: "d MMM yyyy, h:mm a" } },
            },
            {
              name: "scheduledFor",
              type: "date",
              admin: {
                date: { pickerAppearance: "dayAndTime" },
                description: "When status = scheduled, the intended go-live time.",
              },
            },
            {
              name: "assignedTo",
              type: "relationship",
              relationTo: "users",
              admin: { description: "Contributor this draft is assigned to (they may edit it even without tenant-wide edit rights)." },
            },
            {
              name: "lastEditedBy",
              type: "relationship",
              relationTo: "users",
              admin: { readOnly: true },
            },
          ],
        },
        {
          label: "Taxonomy",
          fields: [
            { name: "pillar", type: "relationship", relationTo: "pillars", required: true },
            { name: "sections", type: "relationship", relationTo: "pillars", hasMany: true },
            { name: "country", type: "relationship", relationTo: "countries", admin: { description: "Primary country (global reference data)." } },
            { name: "countries", type: "relationship", relationTo: "countries", hasMany: true },
            { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
            { name: "sectors", type: "relationship", relationTo: "sectors", hasMany: true },
            { name: "author", type: "relationship", relationTo: "authors", required: true },
            { name: "coAuthors", type: "relationship", relationTo: "authors", hasMany: true },
          ],
        },
        {
          label: "Disclosure",
          fields: [
            { name: "aiAssisted", type: "checkbox", defaultValue: false, label: "AI-assisted" },
            { name: "sponsored", type: "checkbox", defaultValue: false },
            {
              name: "sponsor",
              type: "text",
              admin: { condition: (data) => Boolean(data?.sponsored) },
              validate: (value: unknown, { data }: { data?: { sponsored?: boolean } }) =>
                data?.sponsored && !value ? "Sponsor name is required when sponsored is checked." : true,
            },
            { name: "affiliate", type: "checkbox", defaultValue: false },
            { name: "deepDive", type: "checkbox", defaultValue: false },
            { name: "pinnedToLatest", type: "checkbox", defaultValue: false, label: "Pin to top of Latest" },
            { name: "translationAssisted", type: "checkbox", defaultValue: false },
          ],
        },
        {
          label: "Engine contract",
          description: "Provenance + conflict-resolution. Mostly engine/system managed.",
          fields: [
            {
              name: "origin",
              type: "select",
              required: true,
              defaultValue: "manual",
              options: CONTENT_ORIGINS.map((o) => ({ label: o, value: o })),
            },
            {
              name: "editedByHuman",
              type: "checkbox",
              defaultValue: true,
              admin: { readOnly: true, description: "True once any CMS user touches the article. Engine writes set false." },
            },
            {
              name: "lockedFields",
              type: "array",
              fields: [{ name: "field", type: "text" }],
              admin: { description: "Field names the engine must NEVER overwrite (e.g. title, dek, body)." },
            },
            { name: "version", type: "number", defaultValue: 1, required: true, admin: { readOnly: true, description: "Optimistic-lock counter; bumped on every write." } },
            { name: "engineDraftId", type: "text", index: true, admin: { readOnly: true, description: "Engine idempotency key (unique within tenant)." } },
            { name: "engineSourceUrl", type: "text", index: true, admin: { readOnly: true, position: "sidebar" } },
            { name: "engineSourceName", type: "text", admin: { readOnly: true, position: "sidebar" } },
            { name: "engineSourceContext", type: "textarea", admin: { readOnly: true, position: "sidebar" } },
            { name: "lastEngine", type: "relationship", relationTo: "content-engines", admin: { readOnly: true, description: "Which engine last wrote this." } },
            { name: "processingVersion", type: "text", admin: { readOnly: true, description: "Engine pipeline/model version that produced this." } },
          ],
        },
        {
          label: "Translation",
          fields: [
            {
              name: "sourceLanguage",
              type: "select",
              defaultValue: "en",
              options: localeOptions,
              admin: { description: "The locale this article is authored in (source of truth)." },
            },
            {
              name: "translationStatus",
              type: "array",
              admin: { description: "Per-language translation state. Managed by the translation pipeline + editors." },
              fields: [
                { name: "locale", type: "select", required: true, options: localeOptions },
                { name: "state", type: "select", required: true, defaultValue: "none", options: TRANSLATION_STATES.map((s) => ({ label: s.replace(/_/g, " "), value: s })) },
                { name: "engine", type: "relationship", relationTo: "content-engines" },
                { name: "sourceVersionAtTranslation", type: "number", admin: { description: "article.version when this translation was produced." } },
                { name: "updatedAt", type: "date" },
              ],
            },
          ],
        },
        {
          label: "Media",
          fields: [
            { name: "heroImage", type: "upload", relationTo: "media" },
            { name: "imageLabel", type: "text", localized: true, admin: { description: "Label for generative cover art when no hero image." } },
            { name: "imageUrl", type: "text", admin: { description: "Deprecated external-URL fallback." } },
          ],
        },
      ],
    },
  ],
};
