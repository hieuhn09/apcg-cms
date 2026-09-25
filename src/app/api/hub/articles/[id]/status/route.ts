/**
 * POST /api/hub/articles/{id}/status — the ONE hub WRITE route (APCGHub P4 / CMS-3).
 * Changes a single article's public `workflowStatus`; never touches content.
 *
 *   Auth:  Authorization: Bearer <token of a ContentEngines doc with hubRead:true AND hubWrite:true>
 *   Body:  { tenant, to, expectedStatus, reason, actor: { email, role, id? } } — no other keys.
 *
 *   "Ẩn" (hide)       to:"archived"   from published
 *   "Đăng lại"        to:"published"  from hidden | archived
 *
 * Order of checks (each fails closed, first failure wins):
 *   1. auth (401 / 403 no hubWrite)          5. transition table (422)
 *   2. body shape (400; `to` outside set 422) 6. expectedStatus === current (409 + currentStatus)
 *   3. tenant ∈ engine grant (403 + allowed)  7. payload.update(workflowStatus) with context.hubWrite
 *   4. article in THAT tenant (404, identical body whether missing or in another tenant)
 *
 * No separate log call: the update fires `articleActivity`, which writes exactly
 * one ActivityLog row carrying actor + reason in `detail` (article-workflow.ts);
 * `articleBookkeeping` skips hub writes, so `version` does not move and
 * translations are not re-queued.
 *
 * KNOWN GAPS: findByID → update is not atomic (`cms3-toctou-findbyid-then-update`;
 * expectedStatus catches most races); `actor` is hub-asserted, not verified here
 * (`cms3-actor-role-is-hub-asserted`); no rate limit (`cms1-hub-route-has-no-rate-limit`).
 * Internal route: no CORS.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateHubWriteEngine, resolveHubWriteTenant } from "@/lib/hub-write-auth";
import { isHubTargetStatus, isValidTransition } from "@/lib/hub-transition";
import { ARTICLE_STATUSES, type ArticleStatus } from "@/lib/constants";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";
import { toId } from "@/access/helpers";

const BODY_KEYS = new Set(["tenant", "to", "expectedStatus", "reason", "actor"]);
const ACTOR_KEYS = new Set(["email", "role", "id"]);
const REASON_MIN = 5;
const REASON_MAX = 500;

interface HubStatusBody {
  tenant: string;
  to: "archived" | "published";
  expectedStatus: ArticleStatus;
  reason: string;
  actor: { email: string; role: string; id?: number | string };
}

const badRequest = (reason: string) => json({ ok: false, status: "bad_request", reason }, 400);
// One body for "no such article" and "article belongs to another tenant" — the
// response must not reveal which.
const notFound = () => json({ ok: false, status: "not_found", reason: "article not found for tenant" }, 404);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Step 2. Returns the parsed body or the error Response. */
function parseBody(raw: unknown): { ok: true; body: HubStatusBody } | { ok: false; response: Response } {
  if (!isPlainObject(raw)) return { ok: false, response: badRequest("body must be a JSON object") };

  const unknownKeys = Object.keys(raw).filter((k) => !BODY_KEYS.has(k));
  if (unknownKeys.length) return { ok: false, response: badRequest(`unknown field(s): ${unknownKeys.join(", ")}`) };

  // tenant is required BEFORE any narrowing: an empty scope must never mean "all".
  if (!nonEmpty(raw.tenant)) return { ok: false, response: badRequest("tenant is required") };

  if (typeof raw.to !== "string") return { ok: false, response: badRequest("to is required") };
  if (!isHubTargetStatus(raw.to)) {
    return {
      ok: false,
      response: json({ ok: false, status: "invalid_transition", reason: "to must be archived or published" }, 422),
    };
  }

  if (typeof raw.expectedStatus !== "string" || !(ARTICLE_STATUSES as readonly string[]).includes(raw.expectedStatus)) {
    return { ok: false, response: badRequest("expectedStatus must be a valid article status") };
  }

  if (typeof raw.reason !== "string") return { ok: false, response: badRequest("reason is required") };
  const reason = raw.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return { ok: false, response: badRequest(`reason must be ${REASON_MIN}-${REASON_MAX} characters`) };
  }

  const actor = raw.actor;
  if (!isPlainObject(actor)) return { ok: false, response: badRequest("actor is required") };
  const unknownActorKeys = Object.keys(actor).filter((k) => !ACTOR_KEYS.has(k));
  if (unknownActorKeys.length) {
    return { ok: false, response: badRequest(`unknown actor field(s): ${unknownActorKeys.join(", ")}`) };
  }
  if (!nonEmpty(actor.email) || !nonEmpty(actor.role)) {
    return { ok: false, response: badRequest("actor.email and actor.role are required") };
  }
  if (actor.id !== undefined && typeof actor.id !== "string" && typeof actor.id !== "number") {
    return { ok: false, response: badRequest("actor.id must be a string or number") };
  }

  return {
    ok: true,
    body: {
      tenant: raw.tenant.trim(),
      to: raw.to,
      expectedStatus: raw.expectedStatus as ArticleStatus,
      reason,
      actor: {
        email: actor.email.trim(),
        role: actor.role.trim(),
        ...(actor.id !== undefined ? { id: actor.id as number | string } : {}),
      },
    },
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const payload = await getPayload({ config });

  // 1. Auth: hub handshake + hubWrite === true.
  const auth = await authenticateHubWriteEngine({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine;

  // 2. Body.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("body must be valid JSON");
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // 3. Exactly one tenant, from the engine's grant.
  const tenant = resolveHubWriteTenant(auth.tenants, body.tenant);
  if (!tenant) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { scope: "hub/articles/status", requested: body.tenant },
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

  try {
    // 4. The article, in THAT tenant only. Ids are numeric (Postgres serial);
    //    anything else cannot exist, and gets the same 404.
    if (!/^[1-9][0-9]{0,15}$/.test(id)) return notFound();
    const doc = (await payload.findByID({
      collection: "articles",
      id: Number(id),
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as unknown as { id: number | string; tenant?: unknown; workflowStatus?: ArticleStatus } | null;
    if (!doc || String(toId(doc.tenant)) !== String(tenant.id)) return notFound();

    const from = doc.workflowStatus;
    // 5. Transition table.
    if (!from || !isValidTransition(from, body.to)) {
      return json(
        { ok: false, status: "invalid_transition", reason: `cannot change ${from ?? "unknown"} to ${body.to}` },
        422,
      );
    }

    // 6. Optimistic check against what we just read.
    if (body.expectedStatus !== from) {
      return json(
        { ok: false, status: "conflict", reason: "article status changed", currentStatus: from },
        409,
      );
    }

    // 7. Status-only write. context.hubWrite drives articleBookkeeping (skip) and
    //    articleActivity (actor + reason on the one ActivityLog row).
    const updated = (await payload.update({
      collection: "articles",
      id: doc.id,
      data: { workflowStatus: body.to } as never,
      depth: 0,
      overrideAccess: true,
      context: { hubWrite: { actor: body.actor, reason: body.reason }, engineId: engine.id },
    })) as unknown as { id: number | string; workflowStatus?: ArticleStatus };

    // 8. Result.
    return json(
      {
        ok: true,
        id: updated.id,
        tenant: tenant.slug,
        from,
        to: body.to,
        workflowStatus: updated.workflowStatus ?? body.to,
      },
      200,
    );
  } catch (err) {
    payload.logger.error(`[hub/articles/status] write failed: ${(err as Error).message}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { scope: "hub/articles/status", message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
}
