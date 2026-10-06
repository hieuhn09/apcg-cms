/**
 * Hub AUTHOR authentication (APCGHub P5.1) — the permission check for the two
 * draft write routes `POST /api/hub/articles` and `PATCH /api/hub/articles/{id}`.
 *
 * Same shape as `hub-write-auth.ts` (CMS-3), which is reused, not modified:
 * `authenticateHubEngine()` runs the whole bearer → sha256 → active engine →
 * `hubRead` → allowed-tenant handshake, then exactly one more check on top:
 * `engine.hubAuthor === true` (strict — the column is nullable; NULL, false and
 * absent all deny). A denial is logged with the existing `engine_action_denied`
 * event (`action: "hub_author"`).
 *
 * The author credential is a SEPARATE engine record (D4): it holds `hubRead` +
 * `hubAuthor` only — no `hubWrite`, no `create_article` / `update_article` — so it
 * can neither change a status through `/status` nor push through
 * `/api/engine/intake`. Tenant resolution is ONE explicit tenant
 * (`resolveHubWriteTenant`), never the read-path `narrowHubTenants`.
 */

import type { Payload } from "payload";
import { authenticateHubEngine, type HubEngineDoc, type HubTenantRef } from "@/lib/hub-auth";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";

export { resolveHubWriteTenant } from "@/lib/hub-write-auth";

export interface HubAuthorEngineDoc extends HubEngineDoc {
  hubAuthor?: boolean | null;
}

export type HubAuthorAuthResult =
  | { ok: true; engine: HubAuthorEngineDoc; tenants: HubTenantRef[] }
  | { ok: false; response: Response };

export async function authenticateHubAuthorEngine(args: {
  payload: Payload;
  request: Request;
}): Promise<HubAuthorAuthResult> {
  const auth = await authenticateHubEngine(args);
  if (!auth.ok) return auth;

  const engine = auth.engine as HubAuthorEngineDoc;
  if (engine.hubAuthor !== true) {
    await logActivity({
      payload: args.payload,
      eventType: "engine_action_denied",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { action: "hub_author", reason: "hubAuthor not enabled on this engine" },
    });
    return {
      ok: false,
      response: json({ ok: false, status: "forbidden", reason: "hub author not allowed for this engine" }, 403),
    };
  }
  return { ok: true, engine, tenants: auth.tenants };
}

/** Minimal Payload surface `isHubAuthoredDoc` needs (a fake can stand in for unit checks). */
export interface EngineLookup {
  findByID: Payload["findByID"];
}

/**
 * Was this article (version) created by the hub? = its `lastEngine` points at an
 * engine whose `hubAuthor` is true. A missing / deleted engine, or `lastEngine`
 * null (a draft a CMS admin user created), ⇒ false.
 */
export async function isHubAuthoredDoc(payload: EngineLookup, doc: { lastEngine?: unknown } | null | undefined): Promise<boolean> {
  const engineId = toId(doc?.lastEngine);
  if (engineId == null) return false;
  try {
    const engine = (await payload.findByID({
      collection: "content-engines",
      id: engineId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as unknown as { hubAuthor?: boolean | null } | null;
    return engine?.hubAuthor === true;
  } catch {
    return false;
  }
}
