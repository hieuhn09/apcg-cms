import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/**
 * AiLeaderboardRows — per-tenant, feature-gated (`dashboards`). Rows of the DTW
 * "AI Leaderboard" dashboard (previously static fixtures in the site repo).
 *
 * 04-09-2026: absorbed dtw-web's local `aiModels` collection when local Payload
 * was removed from the sites. The extra columns below come from that collection
 * verbatim; the original four (`speed`, `price`, `ctx`, plus `rank`) predate it
 * and are kept because the seeded rows still carry them.
 *
 * Ownership split, unchanged from dtw-web (AD-4/AD-5 of
 * `ai-leaderboard-llmstats_PLAN_30-07-26.md`):
 *   - `rank` / `model` / `sourceSlugLlmstats` are EDITOR-owned and never
 *     cron-written.
 *   - every other data field is cron-writable UNLESS its name appears in
 *     `editorLocked` — same skip-list shape as `Articles.lockedFields`.
 *   - the weekly cron (`/api/cron/refresh-ai-leaderboard`) never CREATES rows,
 *     only refreshes existing ones matched by `sourceSlugLlmstats`.
 */
export const AiLeaderboardRows: CollectionConfig = {
  slug: "aiLeaderboardRows",
  admin: {
    useAsTitle: "model",
    defaultColumns: ["rank", "model", "maker", "general", "asOfScores"],
    group: "Data",
    description:
      "AI Leaderboard rows. rank/model/sourceSlugLlmstats are editor-owned; every other data field is refreshed weekly by the ai-weekly cron unless listed in editorLocked.",
  },
  defaultSort: "rank",
  access: featureGatedAccess("dashboards", tenantManagedAccess),
  fields: [
    { name: "rank", type: "number", admin: { description: "Editorial override sort key. Never cron-written." } },
    { name: "model", type: "text", required: true, admin: { description: "Editor-owned display name. Never cron-written." } },
    { name: "maker", type: "text", admin: { description: "Cron-writable — LLM Stats /v1/models organization.name." } },
    {
      name: "general",
      type: "number",
      admin: {
        description:
          "Cron-writable — /v1/rankings?category=general conservative_rating (raw ~0-60 TrueSkill scale, not 0-100). Null if the model falls outside the top-50.",
      },
    },
    { name: "reasoning", type: "number", admin: { description: "Cron-writable — /v1/rankings?category=reasoning conservative_rating." } },
    {
      name: "coding",
      type: "number",
      admin: {
        description:
          'Cron-writable — /v1/rankings?category=code conservative_rating (LLM Stats category id is "code"; "coding" is an accepted alias for the same data).',
      },
    },
    { name: "math", type: "number", admin: { description: "Cron-writable — /v1/rankings?category=math conservative_rating." } },
    { name: "search", type: "number", admin: { description: "Cron-writable — /v1/rankings?category=search conservative_rating." } },
    { name: "vision", type: "number", admin: { description: "Cron-writable — /v1/rankings?category=vision conservative_rating." } },
    {
      name: "inputPrice",
      type: "number",
      admin: {
        description:
          "Cron-writable — min non-null providers[].input_price_per_m from /v1/models (USD per million tokens). 0 = free.",
      },
    },
    {
      name: "outputPrice",
      type: "number",
      admin: {
        description:
          "Cron-writable — min non-null providers[].output_price_per_m from /v1/models (USD per million tokens). 0 = free.",
      },
    },
    {
      name: "released",
      type: "date",
      admin: { description: "Cron-writable — /v1/models release_date.", date: { pickerAppearance: "dayOnly" } },
    },
    {
      name: "sourceSlugLlmstats",
      type: "text",
      admin: {
        description:
          'Editor-owned exact join key — the LLM Stats /v1/models id (e.g. "gpt-5.6-sol"). Never cron-written; the cron matches rows by this field.',
      },
    },
    {
      name: "asOfScores",
      type: "date",
      admin: {
        description: "Cron-writable — fetch timestamp of the last successful ai-weekly refresh.",
        date: { pickerAppearance: "dayAndTime" },
      },
    },
    {
      name: "editorLocked",
      type: "array",
      fields: [{ name: "field", type: "text" }],
      admin: {
        description:
          'Field names the ai-weekly cron must NEVER overwrite on this row (e.g. "maker", "general"). Locked fields persist until explicitly released.',
      },
    },
    // ── Pre-DTW-port columns, kept for the rows seeded before 04-09-2026 ──
    { name: "speed", type: "number", admin: { description: "Tokens/sec. Not written by the LLM Stats cron." } },
    { name: "price", type: "number", admin: { description: "USD per 1M tokens. Superseded by inputPrice/outputPrice." } },
    { name: "ctx", type: "text", admin: { description: "Context window display string, e.g. 1M." } },
  ],
};
