/**
 * Hub DELETE DRAFT (10-11-26) — permanently delete ONE hub-authored draft that was
 * never published.
 *
 *   POST /api/hub/articles/{id}/delete → handleHubDraftDelete   {tenant, expectedVersion, actor}
 *
 * Auth: the hub AUTHOR credential (`hubRead` + `hubAuthor`, the same as PATCH): deleting
 * a draft is the inverse of creating it. The body is the publish body (`parsePublishBody`),
 * so the hub sends nothing new.
 *
 * Check order (first failure wins): 1 auth (401 / 403) → 2 body ≤ 1,000,000 bytes (413),
 * JSON / object / tenant / unknown keys (400), fields (422) → 3 tenant ∈ grant (403 + log),
 * `features.articles` (403) → 4 id shape + int4 (404) → 5 `withHubArticleLock` and, inside:
 *   6 latest version + main row of THAT tenant (404); `deleteGate`: main AND latest are a
 *     manual `workflowStatus: "draft"` and the main row was never published (`_status` not
 *     "published") — else 422 not_editable origin|status; hub-authored latest (422
 *     not_hub_authored); `expectedVersion` (409 version_conflict);
 *   7 delete the article's `translationJobs` rows first (`translation_jobs.article_id` is
 *     NOT NULL with ON DELETE SET NULL, so a leftover row would fail the article delete),
 *     then the article (Payload also removes its versions); both on the transaction's `req`;
 *   8 COMMIT; then ONE ActivityLog row (`status_changed`, draft → deleted, detail
 *     {via:"hub", actor, action:"delete", slug, title}) — written AFTER the commit so a
 *     rolled-back delete never leaves a "deleted" row.
 * 200 = {ok, id, tenant, deleted: true}.
 *
 * Not deleted: media the draft uploaded (Media rows are shared, never owned by one article).
 * A draft has no public page, so `context.disableRevalidate` (no webhook).
 * Logs carry an error NAME and CODE only (shared scope "hub/articles/author").
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { isHubArticleId } from "@/lib/hub-article-id";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import { logActivity } from "@/lib/activity";
import { authenticateHubAuthorEngine, isHubAuthoredDoc } from "@/lib/hub-author-auth";
import { parsePublishBody, type HubActor } from "@/lib/hub-author-input";
import { busyResponse, withHubArticleLock, type HubLockCtx, type HubLockResult } from "@/lib/hub-article-lock";
import {
  defaultFindMain,
  gateReason,
  logInternal,
  mapWriteError,
  notEditable,
  notFound,
  parsedResponse,
  readBody,
  resolveTenant,
  versionConflict,
} from "@/lib/hub-author-handlers";

type Doc = Record<string, unknown>;
type Id = number | string;

export interface HubDeleteDeps {
  authenticate?: typeof authenticateHubAuthorEngine;
  lock?: typeof withHubArticleLock;
  findMain?: (payload: Payload, id: Id) => Promise<Doc | null>;
  getPayload?: () => Promise<Payload>;
}

/**
 * Pure: may this (main, latest) pair be deleted? Both a manual draft (the P5.1 gate) AND
 * the main row never published — a published-then-unpublished article keeps
 * `_status: "published"` history on its main row and is never deletable from the hub.
 */
export function deleteGate(main: Doc | null | undefined, latest: Doc | null | undefined): "origin" | "status" | null {
  const r = gateReason(main ?? null) ?? gateReason(latest ?? null);
  if (r) return r;
  if (main?._status === "published") return "status";
  return null;
}

const defaultGetPayload = () => getPayload({ config });

export function handleHubDraftDelete(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubDraftDeleteWith(request, ctx);
}

export async function handleHubDraftDeleteWith(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  deps?: HubDeleteDeps,
): Promise<Response> {
  const { id } = await ctx.params;
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubAuthorEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engineId = auth.engine.id;
  const findMain = deps?.findMain ?? defaultFindMain;

  try {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const parsed = parsePublishBody(body.raw);
    if (!parsed.ok) return parsedResponse(parsed);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = { id: t.tenant.id as Id, slug: t.tenant.slug as string };

    if (!isHubArticleId(id)) return notFound();
    const articleId = Number(id);

    let deleted: { slug: string | null; title: string | null } | null = null;
    const res = await (deps?.lock ?? withHubArticleLock)({ tenantId: tenant.id, articleId }, async (lk) => {
      const r = await inLock(lk, { actor: v.actor, expectedVersion: v.expectedVersion, tenant, articleId });
      if (r.ok) deleted = r.info;
      return r.result;
    });

    if (deleted && res.status === 200) {
      const d = deleted as { slug: string | null; title: string | null };
      await logActivity({
        payload,
        eventType: "status_changed",
        tenantId: tenant.id,
        actorType: "engine",
        actorEngineId: engineId,
        targetCollection: "articles",
        targetId: articleId,
        fromStatus: "draft",
        toStatus: "deleted",
        detail: { via: "hub", actor: v.actor, action: "delete", slug: d.slug, title: d.title },
      });
    }
    return res;
  } catch (err) {
    return logInternal(payload, engineId, err);
  }

  async function inLock(
    lk: HubLockCtx,
    s: { actor: HubActor; expectedVersion: number; tenant: { id: Id; slug: string }; articleId: number },
  ): Promise<{ ok: true; result: HubLockResult; info: { slug: string | null; title: string | null } } | { ok: false; result: HubLockResult }> {
    const { tenant, articleId } = s;
    const fail = (value: Response) => ({ ok: false as const, result: { ok: false as const, value } });
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
    const reason = deleteGate(main, latest);
    if (reason) return fail(notEditable(reason));
    if (!(await isHubAuthoredDoc(payload, latest))) return fail(notEditable("not_hub_authored"));
    const currentVersion = typeof latest.version === "number" ? latest.version : 0;
    if (s.expectedVersion !== currentVersion) return fail(versionConflict(currentVersion));

    try {
      await payload.delete({
        collection: "translationJobs",
        where: { article: { equals: articleId } },
        req: lk.req,
        overrideAccess: true,
        depth: 0,
      });
      await payload.delete({
        collection: "articles",
        id: articleId,
        req: lk.req,
        overrideAccess: true,
        depth: 0,
        context: { disableRevalidate: true, engineId },
      });
    } catch (err) {
      const m = mapWriteError(err);
      if (m.kind === "busy") return fail(busyResponse());
      return fail(await logInternal(payload, engineId, err));
    }

    const str = (x: unknown) => (typeof x === "string" && x ? x : null);
    return {
      ok: true,
      info: { slug: str(latest.slug), title: str(latest.title) },
      result: { ok: true, value: json({ ok: true, id: articleId, tenant: tenant.slug, deleted: true }, 200) },
    };
  }
}
