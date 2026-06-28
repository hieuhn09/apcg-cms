/**
 * Shared platform constants: tenant feature flags, roles, engine actions,
 * article statuses, translation states. Centralized so collections, access
 * functions, and route handlers all read the same source of truth.
 */

// ── Per-tenant feature flags ────────────────────────────────────────────────
// Each key gates a content type / module. Stored on Tenants.features as a group
// of booleans. Used by: admin visibility, public API exposure, engine intake.
export const FEATURE_KEYS = [
  "articles",
  "newsletters",
  "podcasts",
  "marketData", // MarketSnapshots / FxRates / TrendingBlocks
  "sponsorSlots",
  "wireDrops",
  "corrections",
  "translations",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

// ── Top-level user role (global identity) ───────────────────────────────────
// Tenant-scoped roles live on TenantMemberships, not here.
export const USER_ROLES = ["systemAdmin", "standard"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// ── Per-tenant membership role ──────────────────────────────────────────────
export const MEMBERSHIP_ROLES = ["websiteAdmin", "editor", "contributor"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

// ── Article workflow statuses ───────────────────────────────────────────────
// This is the editorial workflow status. It is SEPARATE from Payload's native
// draft/published `_status` (which we still enable for version history). The
// `workflowStatus` field below carries the full editorial lifecycle.
export const ARTICLE_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "scheduled",
  "published",
  "hidden",
  "archived",
] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/** Statuses a contributor WITHOUT publish rights may set. */
export const CONTRIBUTOR_ALLOWED_STATUSES: ArticleStatus[] = ["draft", "pending_review"];

/** Statuses that mean "live to the public". */
export const PUBLIC_VISIBLE_STATUSES: ArticleStatus[] = ["published"];

// ── Content origin ──────────────────────────────────────────────────────────
export const CONTENT_ORIGINS = ["engine", "manual", "import"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

// ── Content-engine actions ──────────────────────────────────────────────────
// Granted per engine on ContentEngines.allowedActions. The intake/translation
// handlers map an incoming operation to one of these and check membership.
export const ENGINE_ACTIONS = [
  "create_article",
  "update_article",
  "create_translation",
  "update_translation",
  "upload_media",
  "create_podcast",
  "update_market_data",
  "import",
] as const;
export type EngineAction = (typeof ENGINE_ACTIONS)[number];

export const ENGINE_TYPES = [
  "crawler",
  "writer",
  "translator",
  "finance",
  "podcast",
  "importer",
  "other",
] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

// ── Translation states (per article × locale) ───────────────────────────────
export const TRANSLATION_STATES = [
  "none",
  "pending",
  "translating",
  "machine_translated",
  "needs_review",
  "approved",
  "locked",
  "outdated",
  "failed",
] as const;
export type TranslationState = (typeof TRANSLATION_STATES)[number];

/** States whose stored translation must NEVER be auto-overwritten by an engine. */
export const PROTECTED_TRANSLATION_STATES: TranslationState[] = ["approved", "locked"];

export const TRANSLATION_JOB_STATUSES = [
  "queued",
  "claimed",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TranslationJobStatus = (typeof TRANSLATION_JOB_STATUSES)[number];

// ── Activity-log event types ────────────────────────────────────────────────
export const ACTIVITY_EVENTS = [
  "article_created",
  "article_published",
  "article_unpublished",
  "article_archived",
  "status_changed",
  "human_edit",
  "engine_write_accepted",
  "engine_write_skipped",
  "conflict_logged",
  "translation_queued",
  "translation_completed",
  "translation_failed",
  "engine_auth_failed",
  "engine_tenant_denied",
  "engine_action_denied",
  "media_uploaded",
  "membership_changed",
  "integration_error",
] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

// ── Collections gated by a feature flag ─────────────────────────────────────
// Maps a feature key to the collection slugs it controls. Used to hide nav +
// block API for tenants that disabled the feature.
export const FEATURE_COLLECTIONS: Record<FeatureKey, string[]> = {
  articles: ["articles"],
  newsletters: ["newsletters"],
  podcasts: ["podcasts"],
  marketData: ["marketSnapshots", "fxRates", "trendingBlocks"],
  sponsorSlots: ["sponsorSlots"],
  wireDrops: ["wireDrops"],
  corrections: ["corrections"],
  translations: ["translationJobs"],
};
