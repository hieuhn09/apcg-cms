/**
 * Declarative config for the simple per-tenant collections the console manages
 * with a generic list + create + delete manager (taxonomy, authors, and gated
 * flat modules). Bespoke surfaces (articles, media, settings, corrections, menus)
 * are NOT here. Plain data only — safe to import from both server and client.
 *
 * The `slug` values are the allowlist enforced by the generic server actions.
 */
export type FieldType = "text" | "textarea" | "number" | "select" | "relation";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  /** Choices for `select`/`relation` fields. For relations the page injects them (id → label). */
  options?: { value: string; label: string }[];
}

export interface CollectionDef {
  slug: string;
  singular: string;
  plural: string;
  titleField: string;
  localized: boolean;
  fields: FieldDef[];
}

export const MANAGED_COLLECTIONS = {
  pillars: {
    slug: "pillars",
    singular: "Pillar",
    plural: "Pillars",
    titleField: "title",
    localized: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from title" },
      { name: "color", label: "Color", type: "text", placeholder: "#a60f2d" },
      { name: "order", label: "Order", type: "number" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  sectors: {
    slug: "sectors",
    singular: "Sector",
    plural: "Sectors",
    titleField: "title",
    localized: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from title" },
      { name: "order", label: "Order", type: "number" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  tags: {
    slug: "tags",
    singular: "Tag",
    plural: "Tags",
    titleField: "title",
    localized: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from title" },
    ],
  },
  subsections: {
    slug: "subsections",
    singular: "Sub-section",
    plural: "Sub-sections",
    titleField: "title",
    localized: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from title" },
      // options are injected by the page (pillar list for the tenant).
      { name: "pillar", label: "Pillar", type: "relation", required: true, options: [] },
      { name: "order", label: "Order", type: "number" },
    ],
  },
  authors: {
    slug: "authors",
    singular: "Author",
    plural: "Authors",
    titleField: "name",
    localized: false,
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "role", label: "Role", type: "text", placeholder: "Staff Writer" },
      { name: "city", label: "City", type: "text" },
      { name: "bio", label: "Bio", type: "textarea" },
    ],
  },
  newsletters: {
    slug: "newsletters",
    singular: "Newsletter",
    plural: "Newsletters",
    titleField: "name",
    localized: true,
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from name" },
      { name: "cadence", label: "Cadence", type: "text", placeholder: "weekly" },
      { name: "subscribers", label: "Subscribers", type: "text", placeholder: "48,200" },
      { name: "order", label: "Order", type: "number" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  podcasts: {
    slug: "podcasts",
    singular: "Podcast",
    plural: "Podcasts",
    titleField: "title",
    localized: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", placeholder: "auto from title" },
      { name: "show", label: "Show", type: "text" },
      { name: "episode", label: "Episode #", type: "text", placeholder: "018" },
      { name: "host", label: "Host", type: "text" },
      { name: "audioUrl", label: "Audio URL", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  fundingRows: {
    slug: "fundingRows",
    singular: "Funding row",
    plural: "Funding tracker",
    titleField: "ticker",
    localized: false,
    fields: [
      { name: "ticker", label: "Ticker", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "country", label: "Country", type: "text" },
      { name: "sector", label: "Sector", type: "text" },
      { name: "px", label: "Price", type: "number" },
      { name: "chg", label: "Change %", type: "number" },
      { name: "mcap", label: "Market cap", type: "text", placeholder: "4.1B" },
      { name: "funding", label: "Funding", type: "text", placeholder: "Series C · 210M" },
      { name: "order", label: "Order", type: "number" },
    ],
  },
  aiLeaderboardRows: {
    slug: "aiLeaderboardRows",
    singular: "Leaderboard row",
    plural: "AI leaderboard",
    titleField: "model",
    localized: false,
    fields: [
      { name: "rank", label: "Rank", type: "number", required: true },
      { name: "model", label: "Model", type: "text", required: true },
      { name: "maker", label: "Maker", type: "text" },
      { name: "reasoning", label: "Reasoning", type: "number" },
      { name: "coding", label: "Coding", type: "number" },
      { name: "speed", label: "Speed (tok/s)", type: "number" },
      { name: "price", label: "Price ($/1M)", type: "number" },
      { name: "ctx", label: "Context", type: "text", placeholder: "1M" },
    ],
  },
} satisfies Record<string, CollectionDef>;

export function getCollectionDef(slug: string): CollectionDef | undefined {
  return (MANAGED_COLLECTIONS as Record<string, CollectionDef>)[slug];
}
