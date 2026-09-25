/**
 * Hub WRITE authentication (APCGHub P4 / CMS-3) — the permission check for the
 * one hub write route, `POST /api/hub/articles/{id}/status`.
 *
 * Deliberately a separate file: `hub-auth.ts` declares itself READ ONLY and is
 * left untouched. This file REUSES `authenticateHubEngine()` for the whole
 * bearer → sha256 → active engine → `hubRead` → allowed-tenant handshake, then
 * adds exactly one check on top: `engine.hubWrite === true`. Strict equality on
 * purpose — the column is nullable (same shape as `hub_read`), and NULL, false
 * and absent must all deny.
 *
 * Denials are logged with the existing `engine_action_denied` event, same
 * contract as the `hubRead` check in hub-auth.ts.
 *
 * Tenant resolution for the write path is ONE tenant, named explicitly by the
 * caller (`resolveHubWriteTenant`). It must never reuse `narrowHubTenants()`
 * from hub-auth.ts: that helper treats an empty/absent CSV as "every allowed
 * tenant", which is right for reads and wrong for a write.
 */

import type { Payload } from "payload";
import { authenticateHubEngine, type HubEngineDoc, type HubTenantRef } from "@/lib/hub-auth";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";

export interface HubWriteEngineDoc extends HubEngineDoc {
  hubWrite?: boolean | null;
}

export type HubWriteAuthResult =
  | { ok: true; engine: HubWriteEngineDoc; tenants: HubTenantRef[] }
  | { ok: false; response: Response };

export async function authenticateHubWriteEngine(args: {
  payload: Payload;
  request: Request;
}): Promise<HubWriteAuthResult> {
  const auth = await authenticateHubEngine(args);
  if (!auth.ok) return auth;

  const engine = auth.engine as HubWriteEngineDoc;
  if (engine.hubWrite !== true) {
    await logActivity({
      payload: args.payload,
      eventType: "engine_action_denied",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { action: "hub_write", reason: "hubWrite not enabled on this engine" },
    });
    return {
      ok: false,
      response: json({ ok: false, status: "forbidden", reason: "hub write not allowed for this engine" }, 403),
    };
  }
  return { ok: true, engine, tenants: auth.tenants };
}

/** Exactly one tenant, by slug, from the engine's resolved grant. `null` = not allowed.
 *  The caller has already rejected an empty/blank slug (400) before calling this. */
export function resolveHubWriteTenant(allowed: HubTenantRef[], slug: string): HubTenantRef | null {
  return allowed.find((t) => t.slug === slug) ?? null;
}
