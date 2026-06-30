/**
 * Dashboard aggregations via Drizzle (read-only). All queries GROUP BY enum
 * columns (never bind an enum to a text param) and filter only by integer
 * tenant_id / timestamp columns, which is param-safe. Counts are wrapped in
 * Number() because postgres returns count(*) as a bigint string.
 */
import "server-only";
import { and, count, desc, gte, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "./db";
import { articles, contentEngines, translationJobs, activityLog } from "./schema";

export interface Scope {
  all: boolean;
  ids: number[];
}

/** Build a tenant filter for a column, or undefined when the user sees all. */
function tenantFilter(column: PgColumn, scope: Scope): SQL | undefined {
  if (scope.all) return undefined;
  return inArray(column, scope.ids.length ? scope.ids : [-1]);
}

function combine(...parts: (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((p): p is SQL => Boolean(p));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

export interface TenantStatusCount {
  tenantId: number;
  status: string;
  n: number;
}

export async function countByTenantStatus(scope: Scope): Promise<TenantStatusCount[]> {
  const rows = await db
    .select({ tenantId: articles.tenantId, status: articles.workflowStatus, n: count() })
    .from(articles)
    .where(tenantFilter(articles.tenantId, scope))
    .groupBy(articles.tenantId, articles.workflowStatus);
  return rows.map((r) => ({ tenantId: Number(r.tenantId), status: r.status ?? "draft", n: Number(r.n) }));
}

export interface LabelCount {
  label: string;
  n: number;
}

export async function countByOrigin(scope: Scope): Promise<LabelCount[]> {
  const rows = await db
    .select({ origin: articles.origin, n: count() })
    .from(articles)
    .where(tenantFilter(articles.tenantId, scope))
    .groupBy(articles.origin);
  return rows.map((r) => ({ label: r.origin ?? "unknown", n: Number(r.n) }));
}

export async function translationBacklog(scope: Scope): Promise<LabelCount[]> {
  const rows = await db
    .select({ status: translationJobs.status, n: count() })
    .from(translationJobs)
    .where(tenantFilter(translationJobs.tenantId, scope))
    .groupBy(translationJobs.status);
  return rows.map((r) => ({ label: r.status ?? "queued", n: Number(r.n) }));
}

export interface EngineHealthRow {
  id: number;
  name: string;
  status: string;
  lastSeenAt: Date | null;
}

/** Engines are global (not tenant-scoped) — system-admin view only. */
export async function engineHealth(): Promise<EngineHealthRow[]> {
  const rows = await db
    .select({
      id: contentEngines.id,
      name: contentEngines.name,
      status: contentEngines.status,
      lastSeenAt: contentEngines.lastSeenAt,
    })
    .from(contentEngines)
    .orderBy(desc(contentEngines.lastSeenAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? String(r.id),
    status: r.status ?? "active",
    lastSeenAt: r.lastSeenAt ?? null,
  }));
}

export async function activityRollup(scope: Scope, since: Date): Promise<LabelCount[]> {
  const rows = await db
    .select({ eventType: activityLog.eventType, n: count() })
    .from(activityLog)
    .where(combine(tenantFilter(activityLog.tenantId, scope), gte(activityLog.createdAt, since)))
    .groupBy(activityLog.eventType);
  return rows.map((r) => ({ label: r.eventType ?? "unknown", n: Number(r.n) })).sort((a, b) => b.n - a.n);
}

export interface ActivityRow {
  id: number;
  eventType: string;
  tenantId: number | null;
  actorType: string | null;
  targetCollection: string | null;
  toStatus: string | null;
  createdAt: Date | null;
}

export async function recentActivity(scope: Scope, limit = 20): Promise<ActivityRow[]> {
  const rows = await db
    .select({
      id: activityLog.id,
      eventType: activityLog.eventType,
      tenantId: activityLog.tenantId,
      actorType: activityLog.actorType,
      targetCollection: activityLog.targetCollection,
      toStatus: activityLog.toStatus,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(tenantFilter(activityLog.tenantId, scope))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType ?? "unknown",
    tenantId: r.tenantId ?? null,
    actorType: r.actorType ?? null,
    targetCollection: r.targetCollection ?? null,
    toStatus: r.toStatus ?? null,
    createdAt: r.createdAt ?? null,
  }));
}
