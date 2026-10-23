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
  "dashboards", // FundingRows / AiLeaderboardRows (DTW dashboards)
  "citiesMap", // Cities (WTB "The Map" / /place directory)
  "video", // VideoMedia + the Articles video fields (short-form article video)
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

// ── Pillars the content engine may NOT write into ───────────────────────────
// Tenant-slug-keyed so the same pillar slug on a DIFFERENT tenant is unaffected.
// Hardcoded on purpose: a code constant cannot be accidentally un-ticked by an
// admin, and this needs no schema field / migration.
//
// NOTE: GCV's `exclusive` here is a PILLAR slug (the hand-curated Exclusive
// pillar) — it is NOT and must never be confused with BriefAsia's unrelated
// `Articles.exclusive` disclosure boolean.
//
// BriefAsia `pressroom` (owner decision 05-10-26): the content engine may not
// create or refresh Pressroom articles; they come only from editors (admin /
// Console) and the owner's scripts. GCV `pressroom` (owner decision 05-10-26,
// GCV Pressroom parity) is blocked the same way: editor-only. WAD `pressroom`
// (owner decision 20-10-26, WAD Pressroom parity) is blocked the same way too:
// editor-only.
//
// GTP (GlobalTravelPost, tenant `gtp`, gtp-launch P1): `press-room` (hyphenated
// slug; single-home too, see below) and `events-awards` are editor-only. The
// engine block checks the PRIMARY pillar only; `events-awards` is NOT
// single-home, so it keeps sub-sections, secondary sections and a REQUIRED
// author. The four other gtp pillars stay engine-writable.
//
// VowAsia (tenant `vowasia`, vowasia launch P1, owner decision 13-10-26):
// `press-room` (hyphenated slug, like gtp; single-home too, see below) is
// editor-only. Owner decision 13-10-26: `real-weddings` and `directory` are
// also engine-blocked (editor-only) but NOT single-home (like gtp
// `events-awards`). VowAsia has no `events-awards` pillar; its five other
// pillars stay engine-writable.
//
// Asia Economic Review (tenant `aer`, aer launch W2, owner
// decision 19-10-26): `long-view`, `interviews` and `in-focus` are editor-only.
// AER has NO single-home pillar (it publishes no press releases), so it has no
// SINGLE_HOME_PILLARS entry; the blocked pillars keep sub-sections, secondary
// sections and a REQUIRED author. `asia-watch`, `briefings` and
// `corporate-asia` stay engine-writable.
export const ENGINE_BLOCKED_PILLARS: Record<string, string[]> = {
  gcv: ["exclusive", "pressroom"],
  "brief-asia": ["pressroom"],
  gtp: ["press-room", "events-awards"],
  vowasia: ["press-room", "real-weddings", "directory"],
  wad: ["pressroom"],
  aer: ["long-view", "interviews", "in-focus"],
};

/** Normalised slug used by the engine-blocked gate (trim + lower-case). */
export function normalizeEngineBlockedSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * True when the engine may not write into `pillarSlug` for `tenantSlug`.
 * Case/whitespace-insensitive on both sides (a safe superset: ` PRESSROOM `
 * is blocked too, so a case-variant primary cannot slip past on refresh).
 */
export function isEngineBlockedPillar(tenantSlug: string | undefined | null, pillarSlug: string): boolean {
  if (!tenantSlug) return false;
  const want = normalizeEngineBlockedSlug(pillarSlug);
  if (!want) return false;
  return (ENGINE_BLOCKED_PILLARS[tenantSlug] ?? []).some((s) => normalizeEngineBlockedSlug(s) === want);
}

// ── Single-home pillars ─────────────────────────────────────────────────────
// A single-home pillar's articles belong to nothing else: no secondary
// sections, no sub-section, never added as another article's secondary section,
// no sub-sections of its own, and (BriefAsia) never flagged `exclusive`.
// Tenant-slug-keyed like ENGINE_BLOCKED_PILLARS: BriefAsia, (since 05-10-26)
// GCV and (since 20-10-26, owner decision) WAD `pressroom` are single-home, each
// with an optional author. The same slug on any other tenant is unaffected.
// Code constant on purpose: no schema field, no
// migration. Enforced by src/lib/single-home-pillars.ts + its hooks; the slug is
// protected from rename / tenant move / in-use delete by the Pillars guards.
// GTP `press-room` (hyphenated, exact slug; gtp-launch P1) is single-home with
// an optional author, like the Pressroom pillars; GTP `events-awards` is NOT
// (it is only engine-blocked, above).
// VowAsia `press-room` (vowasia launch P1, owner decision 13-10-26: "pressroom
// is a pillar and has no secondary pillar") is single-home with an optional
// author, exactly like GTP `press-room`.
export const SINGLE_HOME_PILLARS: Record<string, string[]> = {
  "brief-asia": ["pressroom"],
  gcv: ["pressroom"],
  gtp: ["press-room"],
  vowasia: ["press-room"],
  wad: ["pressroom"],
};

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

// ── Content type ────────────────────────────────────────────────────────────
// WHAT a document is, as opposed to `origin` (WHO produced it). Only the daily
// brief is marked; everything else — engine-written and hand-written alike — is
// an ordinary article. The column carries a NOT NULL DEFAULT so consumers can
// filter with a plain positive match instead of null-safe gymnastics.
export const CONTENT_TYPES = [
  { label: "Article", value: "article" },
  { label: "Daily brief", value: "daily-brief" },
] as const;
export type ContentTypeValue = (typeof CONTENT_TYPES)[number]["value"];
export const CONTENT_TYPE_VALUES: readonly ContentTypeValue[] = CONTENT_TYPES.map((c) => c.value);

/** Narrow an untrusted string to a ContentTypeValue. Anything else → null. */
export function toContentTypeValue(raw: unknown): ContentTypeValue | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return (CONTENT_TYPE_VALUES as readonly string[]).includes(v) ? (v as ContentTypeValue) : null;
}

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
  "pin_expired",
] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

// ── Collections gated by a feature flag ─────────────────────────────────────
// Maps a feature key to the collection slugs it controls. Reference map: the
// admin gate lives in src/access/features.ts and each gated collection applies
// its key in its own file (featureGatedAccess/withFeature); the public API and
// engine intake check featureEnabled in their route handlers. Keep this map in
// sync when adding or re-keying a gated collection.
export const FEATURE_COLLECTIONS: Record<FeatureKey, string[]> = {
  articles: ["articles", "subsections"],
  newsletters: ["newsletters"],
  podcasts: ["podcasts", "podcastSeries"],
  marketData: ["marketSnapshots", "fxRates", "trendingBlocks"],
  sponsorSlots: ["sponsorSlots"],
  wireDrops: ["wireDrops"],
  corrections: ["corrections"],
  translations: ["translationJobs"],
  dashboards: ["fundingRows", "aiLeaderboardRows"],
  citiesMap: ["cities"],
  video: ["videoMedia"],
};
