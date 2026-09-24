/**
 * GET /api/hub/tenants — READ-ONLY publication metadata for APCGHub
 * (APCGHub P4 / CMS-2; Settings › Publications).
 *
 *   Auth:   Authorization: Bearer <token of a ContentEngines doc with hubRead:true>
 *   Query:  tenants  CSV of tenant slugs, SUBSET of the engine's grant; outside
 *                    it ⇒ 403 (never a silent drop). Absent ⇒ every allowed tenant.
 *
 * Empty/absent tenants|pillar|kinds means ALL allowed — callers must never send
 * an empty scope by accident (Hub-1 lesson D0).
 *
 * Output is an ALLOWLIST (see `hub-sanitize.ts` for the full emitted-field list
 * and the withheld secrets). Uploads are bare media ids. Localized text is `en`.
 * Order = the order of `?tenants=` (or of the engine's grant). A granted tenant
 * that disappears between auth and read is dropped and listed in `missing`.
 *
 * WRITES: none in this route. `authenticateHubEngine` (as in CMS-1) updates the
 * engine's lastSeenAt/lastSeenIp and writes ActivityLog on auth failures; this
 * route adds ActivityLog rows only for `engine_tenant_denied` / `integration_error`.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateHubEngine, narrowHubTenants } from "@/lib/hub-auth";
import { findHubTenants } from "@/lib/hub-tenants";
import { sanitizeHubTenant } from "@/lib/hub-sanitize";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });

  const auth = await authenticateHubEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const narrowed = narrowHubTenants(auth.tenants, url.searchParams.get("tenants"));
  if (!narrowed.ok) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/tenants", requested: narrowed.unknown },
    });
    return json(
      { ok: false, status: "forbidden", reason: "tenant not allowed for this engine", tenants: narrowed.unknown },
      403,
    );
  }
  const tenants = narrowed.tenants;

  try {
    // ids come ONLY from the narrowed grant — never from the query string.
    const docs = await findHubTenants(
      payload,
      tenants.map((t) => t.id),
    );
    const byId = new Map(docs.map((d) => [String(d.id), d]));
    const out = [];
    const missing: string[] = [];
    for (const t of tenants) {
      const doc = byId.get(String(t.id));
      if (doc) out.push(sanitizeHubTenant(doc));
      else missing.push(t.slug);
    }
    return json({ ok: true, tenants: out, locale: "en", ...(missing.length ? { missing } : {}) }, 200);
  } catch (err) {
    payload.logger.error(`[hub/tenants] read failed: ${(err as Error).message}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/tenants", message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
}
