/**
 * Hub PUBLISH / SCHEDULE / UNSCHEDULE (APCGHub P5.2 / CMS-B) — one core for the two
 * routes (content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-2-publish-schedule-unpublish_PLAN_30-09-26.md,
 * §4.1 state machine, §4.2 check order, K1–K16).
 *
 *   POST /api/hub/articles/{id}/publish    → handleHubPublish   {tenant, expectedVersion, actor}
 *   POST /api/hub/articles/{id}/schedule   → handleHubSchedule  {…, scheduledFor}                       (schedule)
 *                                                               {…, scheduledFor: null, expectedScheduledFor} (unschedule)
 *
 * Only hub-authored drafts (`isHubAuthoredDoc`), only the SAVED latest version (the hub
 * never sends content), token + `hubWrite` (`authenticateHubWriteEngine`; D1).
 *
 * Check order (first failure wins): 1 auth (401 / 403) → 2 body ≤ 1,000,000 bytes (413),
 * JSON / object / tenant / unknown keys (400), fields incl. the FORMAT of the hours (422)
 * → 3 tenant ∈ grant (403 + log), `features.articles` (403) → 4 id shape + int4 (404) →
 * 5 `withHubArticleLock` (article lock; busy ⇒ 503) and, inside it:
 *   6 latest version + main row of THAT tenant (404); gate: publish / schedule need a
 *     manual DRAFT latest + main (`gateReason`), unschedule needs a manual draft main
 *     and a SCHEDULED latest (own gate) — 422 not_editable; hub-authored (422
 *     not_hub_authored); `expectedVersion` (409 version_conflict);
 *   7 publish / schedule: K4 (a…l) + K13 on the latest version and, for schedule, the
 *     window (`out_of_range`) — ONE 422 `invalid` with every field; unschedule instead:
 *     stored hour ≤ now + 60 s ⇒ 409 schedule_conflict `due`, ≠ expectedScheduledFor ⇒
 *     409 `changed` (no K4 / K13 / slug lock: unscheduling only narrows the risk);
 *   8 publish / schedule: slug lock, then `findSlugConflict` excluding the article itself
 *     (409 slug_conflict + existing.id);
 *   9 the write (K3) with the transaction's `req`, `context.hubWrite` + `engineId`:
 *       publish    = non-draft update {_status, workflowStatus, publishedAt = now} (webhook fires)
 *       schedule   = draft:true {workflowStatus "scheduled", scheduledFor, publishedAt = scheduledFor, _status "draft"}
 *       unschedule = draft:true {workflowStatus "draft", scheduledFor null, publishedAt = now, _status "draft"}
 *     (the last two with `disableRevalidate`: no public cache changes);
 *   10 COMMIT only on success; every error branch returns `{ ok: false }` ⇒ the helper kills.
 * 200 = {ok, id, tenant, workflowStatus, version} + `publishedAt` (publish) or
 * `scheduledFor` (schedule; null for unschedule).
 *
 * Error bodies are the frozen P5.1 ones (functions imported from hub-author-handlers.ts,
 * K14) plus `schedule_conflict` (unschedule only) and 503 `busy` (CMS-A). Logs carry an
 * error NAME and CODE only (shared scope "hub/articles/author", K14 gap). `actor` is only
 * RECORDED (K9). The exported route wrappers never pass `deps`; `…With(…, deps)` exists
 * for `scripts/hub-probe.ts --check7 --unit-only` (fakes + an injected `now`).
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { isHubArticleId } from "@/lib/hub-article-id";
import { isEmptyBody } from "@/lib/hub-article-markdown";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import { scopedFind } from "@/lib/scoped";
import { isEngineBlockedPillar } from "@/lib/constants";
import { authenticateHubWriteEngine } from "@/lib/hub-write-auth";
import { isHubAuthoredDoc } from "@/lib/hub-author-auth";
import { findSlugConflict } from "@/lib/hub-author-refs";
import type { HubFieldCode, HubFieldErrors } from "@/lib/hub-author-limits";
import { parsePublishBody, parseScheduleBody, type HubPublishInput } from "@/lib/hub-author-input";
import { busyResponse, withHubArticleLock, type HubLockCtx, type HubLockResult } from "@/lib/hub-article-lock";
import {
  defaultFindMain,
  gateReason,
  invalid,
  logInternal,
  mapWriteError,
  notEditable,
  notFound,
  parsedResponse,
  readBody,
  resolveTenant,
  slugConflict,
  versionConflict,
} from "@/lib/hub-author-handlers";

type Doc = Record<string, unknown>;
type Id = number | string;

/** Lead time, both ways (D-UNSCH, K7): schedule needs > now + 60 s; unschedule is refused at ≤ now + 60 s. */
export const MIN_LEAD_SECONDS = 60;
/** Farthest schedule (K7). */
export const MAX_SCHEDULE_DAYS = 365;
/** `briefs` maxRows (Articles.ts, K4 l). */
const BRIEFS_MAX_ROWS = 4;
const DAY_MS = 86_400_000;

/** The ActivityLog `detail.reason` per operation (the hook writes it from `context.hubWrite`). */
export const HUB_PUBLISH_REASONS = {
  publish: "hub composer publish",
  schedule: "hub composer schedule",
  unschedule: "hub composer unschedule",
} as const;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubPublishDeps {
  authenticate?: typeof authenticateHubWriteEngine;
  /** The CMS-A lock + transaction (default: `withHubArticleLock`). */
  lock?: typeof withHubArticleLock;
  /** Read the MAIN table row (default: `defaultFindMain`). */
  findMain?: (payload: Payload, id: Id) => Promise<Doc | null>;
  getPayload?: () => Promise<Payload>;
  /** Server clock in ms (default `Date.now`): the window, `due`, and `publishedAt` of publish / unschedule. */
  now?: () => number;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** K7 window on a normalised instant: `out_of_range` unless now + 60 s < t ≤ now + 365 d. */
export function scheduleWindowCode(iso: string, nowMs: number): "out_of_range" | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "out_of_range";
  const lead = t - nowMs;
  return lead > MIN_LEAD_SECONDS * 1000 && lead <= MAX_SCHEDULE_DAYS * DAY_MS ? null : "out_of_range";
}

/** A stored date (string / Date) → `YYYY-MM-DDTHH:mm:ss.fffZ`; null stays null; an unparseable value is kept as text. */
export function normalizeStoredUtc(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** D-UNSCH: the stored hour is due (or about to be) ⇒ the cron may already be publishing it. Null = no hour ⇒ never due. */
export function isUnscheduleDue(current: string | null, nowMs: number): boolean {
  if (current === null) return false;
  const t = Date.parse(current);
  return Number.isNaN(t) || t <= nowMs + MIN_LEAD_SECONDS * 1000;
}

const scheduleConflict = (reason: "due" | "changed", currentScheduledFor: string | null) =>
  json({ ok: false, status: "schedule_conflict", reason, currentScheduledFor }, 409);

/** Unschedule gate: main row manual + draft (`gateReason`), latest manual + SCHEDULED. */
function unscheduleGate(main: Doc, latest: Doc): "origin" | "status" | null {
  const m = gateReason(main);
  if (m) return m;
  if (latest.origin !== "manual") return "origin";
  if (latest.workflowStatus !== "scheduled") return "status";
  return null;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const unique = (ids: Id[]): Id[] => [...new Map(ids.map((x) => [String(x), x])).values()];

/** Tenant-scoped, bounded (`id in […]`, depth 0) lookup → map by id. Throws on a DB error (⇒ 500, never a guess). */
async function byIds(payload: Payload, collection: "pillars" | "subsections", tenantId: Id, ids: Id[]): Promise<Map<string, Doc>> {
  if (ids.length === 0) return new Map();
  const res = await scopedFind({ payload, collection, tenantId, where: { id: { in: ids } }, depth: 0, limit: ids.length + 1, page: 1 });
  return new Map((res.docs as unknown as Doc[]).map((d) => [String(d.id), d]));
}

/**
 * K4 (a…l) + K13 on the LATEST version — every validator the cron's non-draft update runs
 * (PB-7a) plus the route-only rules (non-empty body, D-SUB, engine-blocked pillars, no
 * single-home author exemption). Collects every field; field names as in the request.
 * Taxonomy: ONE `id in […]` lookup for pillars (primary + secondary rows), ONE for
 * sub-sections, and ONE `limit 1` count of the primary pillar's sub-sections; tenant-scoped
 * (an id of another tenant / a deleted id ⇒ `invalid`).
 */
export async function checkPublishable(args: { payload: Payload; tenant: { id: Id; slug: string }; latest: Doc }): Promise<HubFieldErrors> {
  const { payload, tenant, latest } = args;
  const fields: HubFieldErrors = {};
  const set = (k: string, c: HubFieldCode) => {
    if (!(k in fields)) fields[k] = c;
  };
  // (a) title, (b) body, (g) slug, (h) readMin
  if (!text(latest.title)) set("title", "required");
  if (isEmptyBody(latest.body)) set("bodyMarkdown", "required");
  if (!text(latest.slug)) set("slug", "required");
  if (typeof latest.readMin !== "number" || !(latest.readMin >= 1)) set("readMin", "out_of_range");
  // (e) author — required, no single-home exemption (K13)
  if (toId(latest.author) == null) set("authorId", "required");
  // (f) sponsor when sponsored
  if (latest.sponsored === true && !text(latest.sponsor)) set("sponsor", "required");
  // (j) a video needs a hero image (poster) and a description
  if (toId(latest.video) != null) {
    if (toId(latest.heroImage) == null) set("heroImage", "required");
    if (!text(latest.videoDescription)) set("videoDescription", "required");
  }
  // (l) briefs: ≤ 4 rows, each with label / value / source
  const briefs = Array.isArray(latest.briefs) ? (latest.briefs as unknown[]) : [];
  const fullRow = (r: unknown) => {
    const o = (r && typeof r === "object" ? r : {}) as Doc;
    return Boolean(text(o.label) && text(o.value) && text(o.source));
  };
  if (briefs.length > BRIEFS_MAX_ROWS || !briefs.every(fullRow)) set("briefs", "invalid");

  // (c) (d) (i) (k) taxonomy
  const pillarId = toId(latest.pillar);
  const subId = toId(latest.subSection);
  const rows = (Array.isArray(latest.secondarySections) ? latest.secondarySections : []) as unknown[];
  const rowPillar = rows.map((r) => toId((r as Doc | null)?.pillar));
  const rowSub = rows.map((r) => toId((r as Doc | null)?.subSection));
  const nonNull = (x: Id | null | undefined): x is Id => x != null;
  const pillars = await byIds(payload, "pillars", tenant.id, unique([pillarId, ...rowPillar].filter(nonNull)));
  const subs = await byIds(payload, "subsections", tenant.id, unique([subId, ...rowSub].filter(nonNull)));
  const blocked = (p: Doc) => isEngineBlockedPillar(tenant.slug, String(p.slug ?? ""));

  // (c) + (k) primary pillar
  const primary = pillarId != null ? pillars.get(String(pillarId)) : undefined;
  if (pillarId == null) set("pillarSlug", "required");
  else if (!primary) set("pillarSlug", "invalid");
  else if (blocked(primary)) set("pillarSlug", "blocked_pillar");
  // (d) sub-section: of THIS pillar; REQUIRED when the pillar has sub-sections (D-SUB)
  if (subId != null) {
    const s = subs.get(String(subId));
    if (!s || pillarId == null || String(toId(s.pillar)) !== String(pillarId)) set("subSectionSlug", "invalid");
  } else if (primary) {
    const own = await scopedFind({ payload, collection: "subsections", tenantId: tenant.id, where: { pillar: { equals: pillarId } }, depth: 0, limit: 1, page: 1 });
    if (own.docs.length >= 1) set("subSectionSlug", "required");
  }
  // (i) + (k) secondary rows
  for (let i = 0; i < rows.length; i++) {
    const rp = rowPillar[i];
    const p = rp != null ? pillars.get(String(rp)) : undefined;
    if (rp == null || !p) {
      set("secondary", "invalid");
      continue;
    }
    if (blocked(p)) {
      set("secondary", "blocked_pillar");
      continue;
    }
    const rs = rowSub[i];
    if (rs != null) {
      const s = subs.get(String(rs));
      if (!s || String(toId(s.pillar)) !== String(rp)) set("secondary", "invalid");
    }
  }
  return fields;
}

// ── handlers ─────────────────────────────────────────────────────────────────

const defaultGetPayload = () => getPayload({ config });

export function handleHubPublish(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubPublishWith(request, ctx);
}

export function handleHubSchedule(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubScheduleWith(request, ctx);
}

export function handleHubPublishWith(request: Request, ctx: { params: Promise<{ id: string }> }, deps?: HubPublishDeps): Promise<Response> {
  return handle("publish", request, ctx, deps);
}

export function handleHubScheduleWith(request: Request, ctx: { params: Promise<{ id: string }> }, deps?: HubPublishDeps): Promise<Response> {
  return handle("schedule", request, ctx, deps);
}

async function handle(route: "publish" | "schedule", request: Request, ctx: { params: Promise<{ id: string }> }, deps?: HubPublishDeps): Promise<Response> {
  const { id } = await ctx.params;
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubWriteEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engineId = auth.engine.id;
  const now = deps?.now ?? Date.now;
  const findMain = deps?.findMain ?? defaultFindMain;

  try {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const parsed = route === "publish" ? parsePublishBody(body.raw) : parseScheduleBody(body.raw);
    if (!parsed.ok) return parsedResponse(parsed);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = { id: t.tenant.id as Id, slug: t.tenant.slug as string };

    if (!isHubArticleId(id)) return notFound();
    const articleId = Number(id);
    return await (deps?.lock ?? withHubArticleLock)({ tenantId: tenant.id, articleId }, (lk) => inLock(lk, { v, tenant, articleId }));
  } catch (err) {
    return logInternal(payload, engineId, err);
  }

  /** Steps 6–9, inside the article lock; every error branch returns `{ ok: false }` (⇒ kill). */
  async function inLock(lk: HubLockCtx, s: { v: HubPublishInput; tenant: { id: Id; slug: string }; articleId: number }): Promise<HubLockResult> {
    const { v, tenant, articleId } = s;
    const fail = (value: Response): HubLockResult => ({ ok: false, value });
    // 6. The latest version (PATCH's read: no locale, through the transaction) + the main row, in THAT tenant.
    const latest = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req: lk.req,
    })) as unknown as Doc | null;
    const main = await findMain(payload, articleId);
    if (!latest || String(toId(latest.tenant)) !== String(tenant.id)) return fail(notFound());
    if (!main || String(toId(main.tenant)) !== String(tenant.id)) return fail(notFound());
    const reason = v.op === "unschedule" ? unscheduleGate(main, latest) : (gateReason(main) ?? gateReason(latest));
    if (reason) return fail(notEditable(reason));
    if (!(await isHubAuthoredDoc(payload, latest))) return fail(notEditable("not_hub_authored"));
    const currentVersion = typeof latest.version === "number" ? latest.version : 0;
    if (v.expectedVersion !== currentVersion) return fail(versionConflict(currentVersion));

    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const slug = typeof latest.slug === "string" ? latest.slug : "";

    if (v.op === "unschedule") {
      // 7'. D-UNSCH: refuse when due (the cron may be publishing it) or when the hour changed.
      const current = normalizeStoredUtc(latest.scheduledFor);
      if (isUnscheduleDue(current, nowMs)) return fail(scheduleConflict("due", current));
      if (current !== v.expectedScheduledFor) return fail(scheduleConflict("changed", current));
    } else {
      // 7. K4 + K13 (+ the schedule window) in ONE 422.
      const fields = await checkPublishable({ payload, tenant, latest });
      if (v.op === "schedule") {
        const w = scheduleWindowCode(v.scheduledFor as string, nowMs);
        if (w && !("scheduledFor" in fields)) fields.scheduledFor = w;
      }
      if (Object.keys(fields).length) return fail(invalid(fields));
      // 8. Slug lock, then the slug check against every OTHER article (main table or latest draft).
      await lk.lockSlug(slug);
      const twin = await findSlugConflict({ payload, tenantId: tenant.id, slug, excludeId: articleId });
      if (twin) return fail(slugConflict(twin.id));
    }

    // 9. The write (K3).
    const context: Doc = { hubWrite: { actor: v.actor, reason: HUB_PUBLISH_REASONS[v.op] }, engineId };
    let data: Doc;
    let publishedAt: string | null = null;
    if (v.op === "publish") {
      publishedAt = nowIso;
      data = { _status: "published", workflowStatus: "published", publishedAt };
    } else if (v.op === "schedule") {
      context.disableRevalidate = true;
      data = { workflowStatus: "scheduled", scheduledFor: v.scheduledFor, publishedAt: v.scheduledFor, _status: "draft" };
    } else {
      context.disableRevalidate = true;
      data = { workflowStatus: "draft", scheduledFor: null, publishedAt: nowIso, _status: "draft" };
    }
    let updated: Doc;
    try {
      updated = (await payload.update({
        collection: "articles",
        id: articleId,
        req: lk.req,
        ...(v.op === "publish" ? {} : { draft: true }),
        data: data as never,
        depth: 0,
        overrideAccess: true,
        context,
      })) as unknown as Doc;
    } catch (err) {
      return fail(await writeError(payload, engineId, tenant.id, slug, articleId, err));
    }

    const done = {
      ok: true,
      id: updated.id ?? articleId,
      tenant: tenant.slug,
      workflowStatus: data.workflowStatus,
      version: typeof updated.version === "number" ? updated.version : currentVersion,
    };
    return {
      ok: true,
      value: json(v.op === "publish" ? { ...done, publishedAt } : { ...done, scheduledFor: v.op === "schedule" ? v.scheduledFor : null }, 200),
    };
  }
}

/**
 * The write failed. Busy ⇒ 503; a Payload ValidationError / class 22 ⇒ 422 `invalid`; a
 * slug-class failure ⇒ 409 ONLY when another article really holds the slug, else 500 (a
 * class-23 error that is not a slug twin — e.g. a foreign key — is not a slug conflict,
 * R4C-15; POST / PATCH keep their frozen behaviour); anything else ⇒ 500 (logged, name +
 * code only).
 */
async function writeError(payload: Payload, engineId: Id, tenantId: Id, slug: string, articleId: number, err: unknown): Promise<Response> {
  const m = mapWriteError(err);
  if (m.kind === "busy") return busyResponse();
  if (m.kind === "invalid") return invalid(m.fields);
  if (m.kind === "slug_conflict" && slug) {
    const twin = await findSlugConflict({ payload, tenantId, slug, excludeId: articleId });
    if (twin) return slugConflict(twin.id);
  }
  return logInternal(payload, engineId, err);
}
