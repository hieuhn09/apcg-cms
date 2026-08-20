import type { CollectionConfig, PayloadRequest } from "payload";
import { editorialContentAccess } from "@/access/collections";
import { featureGatedAccess, featureGatedReadVersions } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { revalidateHooks } from "@/hooks/revalidate";
import {
  articleBookkeeping,
  articleActivity,
  enforceStatusAuthority,
  syncNativePublish,
} from "@/hooks/article-workflow";
import { enqueueTranslations } from "@/hooks/translation";
import {
  ARTICLE_STATUSES,
  CONTENT_ORIGINS,
  CONTENT_TYPES,
  TRANSLATION_STATES,
} from "@/lib/constants";
import { LOCALE_CODES, LOCALE_LABELS } from "@/lib/locales";

const { afterChange: revalidate, afterDelete } = revalidateHooks(["articles:all"]);
const localeOptions = LOCALE_CODES.map((code) => ({ label: LOCALE_LABELS[code], value: code }));

/** Relationship value → id (Payload hands us either the id or the populated doc). */
const relId = (v: unknown): unknown =>
  v != null && typeof v === "object" ? (v as { id?: unknown }).id : v;

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
  access: {
    ...featureGatedAccess("articles", editorialContentAccess),
    readVersions: featureGatedReadVersions("articles"),
  },
  hooks: {
    // Order matters: syncNativePublish may raise workflowStatus to "published";
    // enforceStatusAuthority must then judge that raised value.
    beforeValidate: [syncNativePublish, enforceStatusAuthority],
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
              name: "section",
              type: "text",
              admin: {
                hidden: true,
                description: "Deprecated free-text kicker — replaced by the Sub-section dropdown (Taxonomy tab). Kept for legacy import fidelity.",
              },
            },
            {
              name: "takeaways",
              type: "textarea",
              admin: { description: "Key takeaways — one bullet per line. Source language; empty hides the box." },
            },
            { name: "readMin", type: "number", required: true, defaultValue: 5, min: 1, label: "Read time (minutes)" },
            { name: "metric", type: "text", admin: { description: "Card kicker figure, e.g. +18%, 2026 (WTB)." } },
            {
              name: "tone",
              type: "select",
              options: [
                { label: "Up", value: "up" },
                { label: "Down", value: "dn" },
                { label: "Delay", value: "dl" },
                { label: "Flat", value: "flat" },
              ],
              admin: { description: "Colour of the metric kicker (WTB)." },
            },
            {
              name: "briefs",
              type: "array",
              maxRows: 4,
              admin: { initCollapsed: true, description: "Structured stat block: label + value + source (WTB \"The Briefs\")." },
              fields: [
                { name: "label", type: "text", required: true },
                { name: "value", type: "text", required: true },
                { name: "source", type: "text", required: true },
              ],
            },
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
            {
              name: "subSection",
              type: "relationship",
              relationTo: "subsections",
              filterOptions: ({ data }) => {
                const p = (data as { pillar?: unknown })?.pillar;
                if (p == null || p === "") return false;
                return { pillar: { equals: p } };
              },
              // filterOptions only narrows the admin dropdown — API writes (engine
              // intake, scripts) bypass it. Hard-validate so a subSection from a
              // different pillar can never be saved; readers derive every label from
              // pillar/subSection, so a mismatch here mislabels the whole site.
              validate: async (
                value: unknown,
                { data, req }: { data?: { pillar?: unknown }; req: PayloadRequest },
              ) => {
                const subId = relId(value);
                if (subId == null) return true; // subSection is optional
                const primaryId = relId(data?.pillar);
                if (primaryId == null) return "Pick the Pillar before picking a sub-section.";
                const sub = await req.payload.findByID({
                  collection: "subsections",
                  id: subId as number | string,
                  depth: 0,
                  overrideAccess: true,
                });
                if (relId(sub?.pillar) !== primaryId) {
                  return "Sub-section must belong to this article's Pillar. Change the Pillar or pick another sub-section.";
                }
                return true;
              },
              admin: { description: "Sub-section of the PRIMARY pillar (e.g. Finance → Markets). Pick the Pillar first." },
            },
            {
              name: "secondarySections",
              type: "array",
              label: "Also appears in (secondary sections)",
              labels: { singular: "Secondary section", plural: "Secondary sections" },
              admin: {
                initCollapsed: true,
                description:
                  "Cross-posts. Each row = one EXTRA pillar this story also appears on, optionally filed under one of that pillar's sub-sections. Do NOT re-add the primary Pillar here.",
              },
              fields: [
                {
                  type: "row",
                  fields: [
                    {
                      name: "pillar",
                      type: "relationship",
                      relationTo: "pillars",
                      required: true,
                      admin: { width: "50%", description: "Extra pillar (hub) this story appears on." },
                    },
                    {
                      name: "subSection",
                      type: "relationship",
                      relationTo: "subsections",
                      filterOptions: ({ siblingData }) => {
                        const p = (siblingData as { pillar?: unknown })?.pillar;
                        if (p == null || p === "") return false;
                        return { pillar: { equals: p } };
                      },
                      // Same hard guard as the primary subSection: the row's sub-tab
                      // must belong to the row's pillar, whatever the write path.
                      validate: async (
                        value: unknown,
                        { siblingData, req }: { siblingData?: { pillar?: unknown }; req: PayloadRequest },
                      ) => {
                        const subId = relId(value);
                        if (subId == null) return true;
                        const rowPillarId = relId(siblingData?.pillar);
                        if (rowPillarId == null) return "Pick this row's pillar before picking a sub-tab.";
                        const sub = await req.payload.findByID({
                          collection: "subsections",
                          id: subId as number | string,
                          depth: 0,
                          overrideAccess: true,
                        });
                        if (relId(sub?.pillar) !== rowPillarId) {
                          return "Sub-tab must belong to this row's pillar.";
                        }
                        return true;
                      },
                      admin: { width: "50%", description: "Optional sub-tab within this row's pillar. Pick the pillar first." },
                    },
                  ],
                },
              ],
            },
            { name: "country", type: "relationship", relationTo: "countries", admin: { description: "Primary country (global reference data)." } },
            { name: "countries", type: "relationship", relationTo: "countries", hasMany: true },
            { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
            { name: "sectors", type: "relationship", relationTo: "sectors", hasMany: true },
            { name: "author", type: "relationship", relationTo: "authors", required: true },
            { name: "coAuthors", type: "relationship", relationTo: "authors", hasMany: true },
            {
              name: "cities",
              type: "relationship",
              relationTo: "cities",
              hasMany: true,
              admin: { description: "Destination cities; each may drop a map pin (WTB)." },
            },
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
            {
              name: "pinnedUntil",
              type: "date",
              label: "Pinned until",
              admin: {
                date: { pickerAppearance: "dayAndTime" },
                condition: (data) => Boolean(data?.pinnedToLatest),
                description: "Optional expiry. Empty = pinned until manually unticked.",
              },
            },
            { name: "breaking", type: "checkbox", defaultValue: false, admin: { description: "Marks the story for the breaking-news treatment on the frontend." } },
            { name: "translationAssisted", type: "checkbox", defaultValue: false },
            { name: "longHaul", type: "checkbox", defaultValue: false, admin: { description: "\"The Long Haul\" weekly franchise flag (WTB)." } },
          ],
        },
        {
          label: "Engine contract",
          description: "Provenance + conflict-resolution. Mostly engine/system managed.",
          fields: [
            {
              // Nature of the content, not its provenance — `origin` says WHO wrote it,
              // this says WHAT it is. Engine-set; absent on every manual article, which is
              // why the DB column is NOT NULL DEFAULT 'article' (see the migration): a
              // nullable column would force every consumer to write null-safe filters.
              // Deliberately NOT localized — one article has one nature in every language.
              // Unrelated to the `briefs` array field on the Content tab (key-figures block).
              name: "contentType",
              type: "select",
              required: true,
              defaultValue: "article",
              options: CONTENT_TYPES.map((c) => ({ label: c.label, value: c.value })),
              admin: {
                readOnly: true,
                description:
                  "Set by the engine. 'Daily brief' = a machine-composed digest of our own reporting, not a news story. Reader sites filter on it.",
              },
            },
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
            { name: "views", type: "number", defaultValue: 0, admin: { readOnly: true, description: "Cumulative view counter (Most-Read). Non-localized." } },
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
            { name: "leadImageCaption", type: "text", localized: true, admin: { description: "Caption shown under the lead image (WTB)." } },
            { name: "imageUrl", type: "text", admin: { description: "Deprecated external-URL fallback." } },
          ],
        },
      ],
    },
  ],
};
