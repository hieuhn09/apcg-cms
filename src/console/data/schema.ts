/**
 * Minimal READ-ONLY Drizzle schema mirroring the Payload-managed Postgres tables
 * the console aggregates for dashboards. Payload owns the real schema (created via
 * migrations / dev push); this file declares only the columns we read.
 *
 * Postgres enum columns (workflow_status, origin, status, event_type, …) are
 * declared as `text` here — on read they come back as strings, and we only ever
 * GROUP BY / SELECT them (never compare an enum column to a bound text param,
 * which Postgres would reject). Integer/timestamp columns are safe to filter.
 *
 * If Payload's schema changes, update the touched columns here (or regenerate
 * with `drizzle-kit pull`).
 */
import { pgTable, integer, varchar, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: integer("id").primaryKey(),
  name: varchar("name"),
  slug: varchar("slug"),
  status: text("status"),
  defaultLanguage: text("default_language"),
  featuresArticles: boolean("features_articles"),
  featuresNewsletters: boolean("features_newsletters"),
  featuresPodcasts: boolean("features_podcasts"),
  featuresMarketData: boolean("features_market_data"),
  featuresSponsorSlots: boolean("features_sponsor_slots"),
  featuresWireDrops: boolean("features_wire_drops"),
  featuresCorrections: boolean("features_corrections"),
  featuresTranslations: boolean("features_translations"),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const articles = pgTable("articles", {
  id: integer("id").primaryKey(),
  tenantId: integer("tenant_id"),
  workflowStatus: text("workflow_status"),
  origin: text("origin"),
  editedByHuman: boolean("edited_by_human"),
  aiAssisted: boolean("ai_assisted"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const contentEngines = pgTable("content_engines", {
  id: integer("id").primaryKey(),
  name: varchar("name"),
  engineType: text("engine_type"),
  status: text("status"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const translationJobs = pgTable("translation_jobs", {
  id: integer("id").primaryKey(),
  tenantId: integer("tenant_id"),
  articleId: integer("article_id"),
  targetLocale: text("target_locale"),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const activityLog = pgTable("activity_log", {
  id: integer("id").primaryKey(),
  eventType: text("event_type"),
  tenantId: integer("tenant_id"),
  actorType: text("actor_type"),
  actorUserId: integer("actor_user_id"),
  actorEngineId: integer("actor_engine_id"),
  targetCollection: varchar("target_collection"),
  targetId: varchar("target_id"),
  fromStatus: varchar("from_status"),
  toStatus: varchar("to_status"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }),
});
