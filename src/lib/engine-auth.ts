/**
 * Engine authentication + authorization for machine traffic (intake,
 * translation). Resolves the bearer token → ContentEngine → target Tenant →
 * permission, with no Payload user involved. The bearer check is the trust
 * boundary; all subsequent DB writes use overrideAccess + an explicit tenant.
 */

import type { Payload } from "payload";
import { bearerToken, sha256Hex } from "@/lib/crypto";
import { findTenantBySlug, findTenantById, tenantIsActive, type TenantDoc } from "@/lib/tenant";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import type { EngineAction } from "@/lib/constants";

export interface EngineDoc {
  id: number | string;
  name: string;
  status: "active" | "suspended" | "revoked";
  allowedTenants?: (number | string | { id: number | string })[];
  allowedActions?: EngineAction[];
  rateLimitPerMin?: number | null;
}

export type EngineAuthResult =
  | { ok: true; engine: EngineDoc; tenant: TenantDoc }
  | { ok: false; response: Response };

interface AuthArgs {
  payload: Payload;
  request: Request;
  /** The action this request needs (mapped from the operation). */
  action: EngineAction;
  /** Optional explicit publicationId (tenant slug) from the request body. */
  publicationId?: string;
}

function clientIp(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    undefined
  );
}

export async function authenticateEngine(args: AuthArgs): Promise<EngineAuthResult> {
  const { payload, request, action, publicationId } = args;

  // 1. Bearer token → engine by token hash.
  const raw = bearerToken(request.headers.get("authorization"));
  if (!raw) {
    return { ok: false, response: json({ ok: false, status: "unauthorized" }, 401) };
  }
  const tokenHash = sha256Hex(raw);
  const engineRes = await payload.find({
    collection: "content-engines",
    where: { tokenHash: { equals: tokenHash } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const engine = engineRes.docs[0] as EngineDoc | undefined;
  if (!engine || engine.status !== "active") {
    await logActivity({
      payload,
      eventType: "engine_auth_failed",
      actorType: "engine",
      actorEngineId: engine?.id ?? null,
      detail: { reason: engine ? `status:${engine.status}` : "unknown token", tokenPrefix: raw.slice(0, 8) },
    });
    return { ok: false, response: json({ ok: false, status: "unauthorized" }, 401) };
  }

  // 2. Resolve target tenant.
  const allowedTenantIds = (engine.allowedTenants ?? [])
    .map(toId)
    .filter((id): id is number | string => id != null);

  let tenant: TenantDoc | null = null;
  if (publicationId) {
    tenant = await findTenantBySlug(payload, publicationId);
  } else if (allowedTenantIds.length === 1) {
    tenant = await findTenantById(payload, allowedTenantIds[0] as number | string);
  } else {
    return {
      ok: false,
      response: json(
        { ok: false, status: "bad_request", reason: "publicationId required (engine has multiple allowed tenants)" },
        400,
      ),
    };
  }

  if (!tenant) {
    return { ok: false, response: json({ ok: false, status: "bad_request", reason: "unknown publicationId" }, 400) };
  }

  // 3. Engine must be allowed on this tenant.
  if (!allowedTenantIds.includes(tenant.id)) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      tenantId: tenant.id,
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { publicationId: tenant.slug },
    });
    return { ok: false, response: json({ ok: false, status: "forbidden", reason: "engine not allowed for this tenant" }, 403) };
  }

  // 4. Action must be granted.
  if (!(engine.allowedActions ?? []).includes(action)) {
    await logActivity({
      payload,
      eventType: "engine_action_denied",
      tenantId: tenant.id,
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { action },
    });
    return { ok: false, response: json({ ok: false, status: "forbidden", reason: `action not allowed: ${action}` }, 403) };
  }

  // 5. Tenant must be active.
  if (!tenantIsActive(tenant)) {
    return { ok: false, response: json({ ok: false, status: "forbidden", reason: `tenant ${tenant.status}` }, 403) };
  }

  // 6. Stamp last-seen (best effort, non-blocking).
  try {
    await payload.update({
      collection: "content-engines",
      id: engine.id,
      data: { lastSeenAt: new Date().toISOString(), lastSeenIp: clientIp(request) },
      overrideAccess: true,
    });
  } catch {
    /* non-fatal */
  }

  return { ok: true, engine, tenant };
}
