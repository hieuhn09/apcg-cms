/**
 * GET /api/hub/articles/{id}?tenant=<slug> — READ-ONLY full view of ONE article
 * for the APCGHub "view article" page (APCGHub P4 / CMS-4).
 *
 *   Auth:   Authorization: Bearer <token of a ContentEngines doc with hubRead:true>
 *           (hubWrite is NOT required — viewing is a read).
 *   Query:  tenant  REQUIRED, exactly one slug from the engine's grant.
 *
 * Order of checks (first failure wins; mirrors CMS-1/2/3):
 *   1. auth (401 / 403)                    5. findByID in THAT tenant (404 — the SAME
 *   2. tenant present & non-blank (400)       body whether missing or in another tenant)
 *   3. tenant ∈ engine grant (403 +        6. body → Markdown (never fails the request:
 *      allowedTenants, logged)                bodyState "ok" | "empty" | "error")
 *   4. id shape + int4 range (404, same    7. fresh-object sanitizer → 200
 *      body as 5; `isHubArticleId`)
 *
 * Tenant: resolved as ONE slug via `resolveHubWriteTenant` (a pure lookup,
 * imported, not modified). Never `narrowHubTenants`: it reads an empty value as
 * "every allowed tenant", which is wrong for a single-article route.
 *
 * Every workflowStatus is returned (hidden / archived included) — the page
 * exists so an operator can see a hidden article and decide to republish it.
 *
 * WRITES: none on success (same convention as the CMS-1/CMS-2 read routes).
 * ActivityLog rows only for `engine_tenant_denied` and `integration_error`
 * (read failure, or a body withheld as bodyState "error" — detail carries the
 * article id, tenant, a kind and an error NAME; never body text or a token).
 * Internal route: no CORS. No rate limit (`cms1-hub-route-has-no-rate-limit`).
 *
 * APCGHub P5.1 additions (the default response above is unchanged byte for byte):
 *   - `?view=edit` (any other value is ignored): adds an `edit` block beside
 *     `article` (src/lib/hub-article-edit-select.ts). The main read also selects
 *     `origin`; only when the main row is a manual draft is the LATEST draft read,
 *     and only then do `article.*` and `bodyMarkdown` come from that latest read.
 *   - `PATCH` — update one hub-authored draft (src/lib/hub-author-handlers.ts).
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateHubEngine } from "@/lib/hub-auth";
import { resolveHubWriteTenant } from "@/lib/hub-write-auth";
import { hubArticleBodyToMarkdown, loadHubEditorConfig } from "@/lib/hub-article-markdown";
import {
  HUB_ARTICLE_DETAIL_DEPTH,
  HUB_ARTICLE_DETAIL_SELECT,
  sanitizeHubArticleDetail,
} from "@/lib/hub-article-detail-select";
import { json } from "@/lib/http";
import { isHubArticleId } from "@/lib/hub-article-id";
import { logActivity } from "@/lib/activity";
import { toId } from "@/access/helpers";
import { HUB_ARTICLE_EDIT_MAIN_SELECT, loadHubArticleEdit, type HubArticleEdit } from "@/lib/hub-article-edit-select";
import { handleHubDraftUpdate } from "@/lib/hub-author-handlers";

/** Two conversions at most per PATCH (stored body round trip + new body), each ≤ T. */
export const maxDuration = 30;

export const PATCH = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubDraftUpdate(request, ctx);

const SCOPE = "hub/articles/detail";

// One body for "malformed id", "no such article" and "article in another
// tenant" — the response must not reveal which.
const notFound = () => json({ ok: false, status: "not_found", reason: "article not found for tenant" }, 404);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const payload = await getPayload({ config });

  // 1. Auth: hub handshake, hubRead === true.
  const auth = await authenticateHubEngine({ payload, request });
  if (!auth.ok) return auth.response;

  // 2. tenant is required BEFORE any lookup: an empty scope must never mean "all".
  const claimed = new URL(request.url).searchParams.get("tenant")?.trim() ?? "";
  if (!claimed) return json({ ok: false, status: "bad_request", reason: "tenant is required" }, 400);

  // 3. Exactly one tenant, from the engine's grant.
  const tenant = resolveHubWriteTenant(auth.tenants, claimed);
  if (!tenant) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: SCOPE, requested: claimed },
    });
    return json(
      {
        ok: false,
        status: "forbidden",
        reason: "tenant not in allowed scope",
        allowedTenants: auth.tenants.map((t) => t.slug),
      },
      403,
    );
  }

  const wantEdit = new URL(request.url).searchParams.get("view") === "edit";

  // 4. Ids are int4 serials: a malformed or out-of-range id cannot exist, and
  //    gets the same 404 without reaching Postgres (src/lib/hub-article-id.ts).
  if (!isHubArticleId(id)) return notFound();

  let doc: Record<string, unknown> | null;
  try {
    // 5. The article, in THAT tenant only. No workflowStatus filter on purpose.
    doc = (await payload.findByID({
      collection: "articles",
      id: Number(id),
      depth: HUB_ARTICLE_DETAIL_DEPTH,
      locale: "en",
      overrideAccess: true,
      select: wantEdit ? HUB_ARTICLE_EDIT_MAIN_SELECT : HUB_ARTICLE_DETAIL_SELECT,
      disableErrors: true,
    })) as unknown as Record<string, unknown> | null;
  } catch (err) {
    payload.logger.error(`[${SCOPE}] read failed: ${(err as Error).name}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: SCOPE, articleId: id, tenant: tenant.slug, message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
  if (!doc || String(toId(doc.tenant)) !== String(tenant.id)) return notFound();

  // 5b. `view=edit` only: the editable gate; when editable, every field comes from the latest draft.
  let edit: HubArticleEdit | null = null;
  if (wantEdit) {
    try {
      const r = await loadHubArticleEdit({ payload, mainDoc: doc, tenantId: tenant.id });
      edit = r.edit;
      if (r.latest) doc = r.latest;
    } catch (err) {
      payload.logger.error(`[${SCOPE}] edit read failed: ${(err as Error).name}`);
      await logActivity({
        payload,
        eventType: "integration_error",
        actorType: "engine",
        actorEngineId: auth.engine.id,
        detail: { scope: SCOPE, articleId: id, tenant: tenant.slug, name: (err as Error).name },
      });
      return json({ ok: false, status: "internal_error" }, 500);
    }
  }

  // 6. Body → Markdown. Never throws; a body problem never fails the request.
  const body = await hubArticleBodyToMarkdown(doc.body, {
    loadEditorConfig: () => loadHubEditorConfig(payload.config),
  });
  if (body.error) {
    payload.logger.warn(
      `[${SCOPE}] body withheld: article=${String(doc.id)} tenant=${tenant.slug} kind=${body.error.kind} error=${body.error.name}`,
    );
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: SCOPE, articleId: doc.id, tenant: tenant.slug, ...body.error },
    });
  }

  // 7. Fresh object, allowlisted fields only.
  return json(
    edit
      ? { ok: true, article: sanitizeHubArticleDetail(doc, tenant.slug, { bodyMarkdown: body.bodyMarkdown, bodyState: body.bodyState }), edit }
      : { ok: true, article: sanitizeHubArticleDetail(doc, tenant.slug, { bodyMarkdown: body.bodyMarkdown, bodyState: body.bodyState }) },
    200,
  );
}
