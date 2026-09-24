/**
 * GET /api/hub/articles — READ-ONLY cross-tenant article list for APCGHub.
 * (APCGHub P4 / CMS-1. Umbrella constraint #7: namespace must be `/api/hub/*`.)
 *
 * This is the only machine credential in this repo that reads more than one
 * tenant per call. Every other machine path resolves to exactly one tenant by
 * construction — `authenticateEngine()` (engine-auth.ts:84-92) rejects a
 * multi-tenant engine that did not name a `publicationId`, and
 * `resolveReadToken()` (public.ts:129-171) resolves a single tenant read token.
 * Nothing here changes either of those; this route sits beside them.
 *
 *   Auth:   Authorization: Bearer <token of a ContentEngines doc with hubRead:true>
 *   Query:  tenants  CSV of tenant slugs; must be a SUBSET of the engine's
 *                    allowedTenants. Outside it ⇒ 403 (never a silent drop).
 *                    Absent ⇒ every allowed tenant.
 *           status   CSV of workflowStatus values (default: all).
 *           limit    default 50, hard ceiling 200.
 *           page     1-based.
 *           sort     `-publishedAt` (default) | `publishedAt` | `-views` | `views`.
 *                    Anything else silently falls back to `-publishedAt`
 *                    (CMS-1 contract). Every sort ends in `id`, so offset
 *                    pages never repeat or skip a row.
 *           q        search, case-insensitive substring of title OR dek OR slug
 *                    (locale `en`), 2-200 chars after trim; `%` `_` `\` are
 *                    literal characters (escaped before the ILIKE).
 *           pillar   CSV of pillar slugs (max 20, `^[A-Za-z0-9_-]{1,64}$`);
 *                    resolved to ids PER TENANT, primary pillar only. A slug a
 *                    tenant does not have simply yields 0 rows there.
 *
 * Empty/absent tenants|pillar|kinds means ALL allowed — callers must never send
 * an empty scope by accident (Hub-1 lesson D0).
 *
 * LOCALE: fixed `en` for every localized field (title, slug, dek, pillar.title);
 * an article that only exists in another locale comes back with `title: null`.
 *
 * VISIBILITY CONTRACT — filters `workflowStatus`, NEVER `_status`. About 3,300
 * live articles sit on `_status: "draft"` + `workflowStatus: "published"`
 * (import-created, never natively Published); an `_status` filter would hide
 * most of every publication's archive. See `scoped.ts:36-51`.
 *
 * WRITES: none in this route. `authenticateHubEngine` (as in CMS-1) updates the
 * engine's lastSeenAt/lastSeenIp and writes ActivityLog on auth failures; this
 * route adds ActivityLog rows only for `engine_tenant_denied` / `integration_error`.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import type { Where } from "payload";
import { authenticateHubEngine, narrowHubTenants } from "@/lib/hub-auth";
import {
  scopedFindMultiTenant,
  HUB_TENANT_ID_KEY,
  HUB_MAX_REACHABLE,
  HubPageOutOfRangeError,
} from "@/lib/hub-scoped";
import { scopedFind } from "@/lib/scoped";
import { parseHubQ, parseHubSort, parsePillarSlugs } from "@/lib/hub-query";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";
import { ARTICLE_STATUSES } from "@/lib/constants";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Field selection sent to Payload — an ALLOWLIST (`true` only), deliberately the
 * opposite mode from `LIST_SELECT` in the public articles route.
 *
 * The public route excludes-what-nobody-reads so a new reader-contract field
 * keeps flowing automatically. Here the caller is a single internal console we
 * control, and the risk being managed is the reverse one: a future field on
 * Articles (or a future relationship to a secret-bearing collection) silently
 * joining a cross-tenant response. Allowlist mode means a new field is invisible
 * until someone names it here on purpose.
 *
 * `tenant` is NOT selected: the owning tenant travels as an internal id stamp
 * from `scopedFindMultiTenant` and is emitted as a bare slug, so the Tenants
 * document — which carries `readTokens` — never enters the response path at all.
 */
const HUB_ARTICLE_SELECT = {
  id: true,
  title: true,
  slug: true,
  workflowStatus: true,
  publishedAt: true,
  contentType: true,
  lastEditedBy: true,
  views: true,
  // `pillar` is populated at depth 1 into a Pillars document (text/number fields
  // only; its own `tenant` stays an id at that depth) and reduced to
  // `{slug, title}` by the sanitizer below. `dek` is searched but NOT selected.
  pillar: true,
} as const;

/** One article as this route emits it. */
export interface HubArticle {
  id: number | string;
  title: string | null;
  slug: string | null;
  workflowStatus: string | null;
  publishedAt: string | null;
  contentType: string | null;
  tenant: { slug: string };
  lastEditedBy: { name: string | null; role: string | null } | null;
  /** Cumulative counter. `null` when the DB holds NULL — not coerced to 0. */
  views: number | null;
  pillar: { slug: string | null; title: string | null } | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * sanitizeHubArticle — the response allowlist, written by hand and applied to
 * every row.
 *
 * It is the SECOND of two independent barriers (the first being
 * `HUB_ARTICLE_SELECT` above): `defaultPopulate` on the related collections is a
 * good default, but a route that does its own `select`/populate is responsible
 * for its own output, and this one merges several tenants so it is exactly the
 * "custom" case that default cannot be trusted to cover.
 *
 * FIELDS EMITTED (the complete list — nothing else can reach the wire, because
 * this function builds a fresh object and never spreads the source doc):
 *   id, title, slug, workflowStatus, publishedAt, contentType,
 *   tenant.slug, lastEditedBy.name, lastEditedBy.role, views,
 *   pillar.slug, pillar.title
 *
 * SENSITIVE FIELDS CHECKED AGAINST THAT LIST, each absent by construction:
 *   Tenants.readTokens        — `tenant` is never populated; only a slug string
 *                               resolved from an internal id stamp is emitted.
 *   ContentEngines.tokenHash  — the engine document is never attached to a row;
 *   ContentEngines.tokenPrefix  `Articles.lastEngine` is not in the select, so
 *                               it is neither fetched nor populated.
 *   ContentEngines.allowedTenants / allowedActions / hubRead / lastSeenIp — same.
 *   Users.email               — `lastEditedBy` is reduced to `{name, role}` here
 *                               regardless of what populate returned.
 *   Articles.body             — not selected; a cross-tenant list has no use for
 *                               it and it is the bulk of any article payload.
 */
export function sanitizeHubArticle(doc: Record<string, unknown>, tenantSlug: string): HubArticle {
  const edited = doc.lastEditedBy;
  const lastEditedBy =
    edited && typeof edited === "object"
      ? {
          name: str((edited as Record<string, unknown>).name),
          role: str((edited as Record<string, unknown>).role),
        }
      : null;

  // An unpopulated relation (id only, e.g. the pillar was deleted) ⇒ null.
  const p = doc.pillar;
  const pillar =
    p && typeof p === "object"
      ? { slug: str((p as Record<string, unknown>).slug), title: str((p as Record<string, unknown>).title) }
      : null;

  return {
    id: doc.id as number | string,
    title: str(doc.title),
    slug: str(doc.slug),
    workflowStatus: str(doc.workflowStatus),
    publishedAt: str(doc.publishedAt),
    contentType: str(doc.contentType),
    tenant: { slug: tenantSlug },
    lastEditedBy,
    views: typeof doc.views === "number" ? doc.views : null,
    pillar,
  };
}

function pageOutOfRange(max: number) {
  return {
    ok: false,
    status: "bad_request",
    reason: `page window starts beyond the ${max} reachable rows across tenants; narrow with ?tenants= (or filter with ?status=) to page deeper`,
    reachable: max,
  };
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });

  const auth = await authenticateHubEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);

  // Tenant narrowing. Asking for something outside the grant is an error, not a
  // quiet filter — a hub that silently renders four of five publications shows a
  // permission bug as if it were data.
  const narrowed = narrowHubTenants(auth.tenants, url.searchParams.get("tenants"));
  if (!narrowed.ok) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub", requested: narrowed.unknown },
    });
    return json(
      {
        ok: false,
        status: "forbidden",
        reason: "tenant not allowed for this engine",
        tenants: narrowed.unknown,
      },
      403,
    );
  }
  const tenants = narrowed.tenants;

  // Integers only: `page=1.5` would otherwise produce a fractional offset.
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") ?? "1")) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT))) || DEFAULT_LIMIT),
  );

  // Offset paging across N tenants is only correct for the union's top
  // HUB_MAX_REACHABLE rows (each tenant is cut at its own top-N). A window that
  // STARTS past it is refused up front — never answered with an empty or
  // mis-ordered page. The helper enforces the same rule on its own (below).
  if ((page - 1) * limit >= HUB_MAX_REACHABLE) {
    return json(pageOutOfRange(HUB_MAX_REACHABLE), 400);
  }
  const sort = parseHubSort(url.searchParams.get("sort"));

  // Every parameter is validated BEFORE any articles/pillars query runs.
  const q = parseHubQ(url.searchParams.get("q"));
  if (!q.ok) return json({ ok: false, status: "bad_request", reason: q.reason }, 400);
  const pillarParam = parsePillarSlugs(url.searchParams.get("pillar"));
  if (!pillarParam.ok) {
    return json(
      { ok: false, status: "bad_request", reason: pillarParam.reason, ...(pillarParam.values ? { values: pillarParam.values } : {}) },
      400,
    );
  }
  const pillarSlugs = pillarParam.slugs;

  // workflowStatus filter. Unrecognised values are rejected rather than ignored:
  // unlike the public feeds (where a typo must not blank a homepage), a hub queue
  // showing zero rows because of a silently-dropped filter is indistinguishable
  // from "there is no work", which is the wrong thing to be ambiguous about.
  const and: Where[] = [];
  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    const wanted = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((s) => !(ARTICLE_STATUSES as readonly string[]).includes(s));
    if (bad.length) {
      return json({ ok: false, status: "bad_request", reason: "unknown workflowStatus", values: bad }, 400);
    }
    // NOTE: `workflowStatus`, never `_status` — see the visibility contract above.
    if (wanted.length) and.push({ workflowStatus: { in: wanted } });
  }

  // Search: title OR dek OR slug (the same three fields as the CMS admin's
  // `listSearchableFields`). `contains` keeps the phrase whole (`like` would split
  // on spaces); the value is pre-escaped because Payload does not escape it.
  if (q.escaped != null) {
    and.push({
      or: [{ title: { contains: q.escaped } }, { dek: { contains: q.escaped } }, { slug: { contains: q.escaped } }],
    });
  }

  const slugById = new Map(tenants.map((t) => [String(t.id), t.slug]));
  const echo = { sort: sort.public, q: q.q, pillar: pillarSlugs };

  try {
    if (pillarSlugs.length) {
      // Resolve slug → id separately for EACH tenant (the tenant filter stays in
      // `scopedFind`); ids are global primary keys, so one merged list is safe.
      // `limit: 100` is explicit (Payload's default is 10) and ≥ the 20-slug cap;
      // slug uniqueness is only a hook (`uniqueWithinTenant`), not a DB constraint.
      const lookups = await Promise.all(
        tenants.map((t) =>
          scopedFind({
            payload,
            collection: "pillars",
            tenantId: t.id,
            where: { slug: { in: pillarSlugs } },
            select: { slug: true },
            depth: 0,
            limit: 100,
          }),
        ),
      );
      const pillarIds: (number | string)[] = [];
      lookups.forEach((res, i) => {
        if (res.totalDocs > res.docs.length) {
          payload.logger.warn(
            `[hub/articles] pillar slug lookup truncated for tenant ${tenants[i]?.slug}: ${res.docs.length}/${res.totalDocs}`,
          );
        }
        for (const d of res.docs as unknown as { id: number | string }[]) pillarIds.push(d.id);
      });

      // No tenant has any of these slugs: answer 0 rows without querying
      // articles (and without sending Drizzle an empty `in`).
      if (pillarIds.length === 0) {
        return json(
          {
            ok: true,
            articles: [],
            totalDocs: 0,
            page,
            limit,
            totalPages: 0,
            hasNextPage: false,
            truncated: false,
            reachable: 0,
            tenants: tenants.map((t) => t.slug),
            totalsByTenant: tenants.map((t) => ({ tenant: t.slug, totalDocs: 0 })),
            ...echo,
          },
          200,
        );
      }
      and.push({ pillar: { in: pillarIds } });
    }

    const res = await scopedFindMultiTenant({
      payload,
      collection: "articles",
      tenantIds: tenants.map((t) => t.id),
      where: and.length ? { and } : undefined,
      limit,
      page,
      sort: sort.keys,
      locale: "en",
      // depth 1 populates `lastEditedBy` into `{name, role}` via the Users
      // collection's own `defaultPopulate`, and `pillar` into a Pillars doc
      // (reduced to {slug, title} by the sanitizer). No other relationship is
      // selected, so depth 1 cannot reach any other collection.
      depth: 1,
      select: HUB_ARTICLE_SELECT,
    });

    const articles = (res.docs as Record<string, unknown>[]).map((doc) =>
      sanitizeHubArticle(doc, slugById.get(String(doc[HUB_TENANT_ID_KEY])) ?? ""),
    );

    return json(
      {
        ok: true,
        articles,
        totalDocs: res.totalDocs,
        page: res.page,
        limit: res.limit,
        totalPages: res.totalPages,
        hasNextPage: res.hasNextPage,
        // totalDocs stays the TRUE count; totalPages/hasNextPage only advertise
        // pages that can actually be served. `truncated` says the gap exists.
        truncated: res.truncated,
        reachable: res.reachable,
        tenants: tenants.map((t) => t.slug),
        totalsByTenant: res.totalsByTenant.map((t) => ({
          tenant: slugById.get(String(t.tenantId)) ?? "",
          totalDocs: t.totalDocs,
        })),
        ...echo,
      },
      200,
    );
  } catch (err) {
    if (err instanceof HubPageOutOfRangeError) {
      return json(pageOutOfRange(err.maxOverFetch), 400);
    }
    // A read failure is a 5xx with a clear body, never a 200 with an empty list:
    // the hub has to be able to tell "nothing to show" from "I could not look",
    // so it can hide the CMS block instead of claiming the queue is empty.
    payload.logger.error(`[hub/articles] read failed: ${(err as Error).message}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/articles", message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
}
