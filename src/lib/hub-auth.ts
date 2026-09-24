/**
 * Hub authentication — the MULTI-tenant machine credential for the read-only
 * `/api/hub/*` routes (APCGHub P4 / CMS-1).
 *
 * WHY A SEPARATE FILE, not a branch inside `src/lib/engine-auth.ts`:
 * `authenticateEngine()` serves live intake + translation traffic for all five
 * publications and deliberately resolves to EXACTLY ONE tenant — an engine with
 * more than one `allowedTenants` entry and no explicit `publicationId` is
 * rejected with 400 (`engine-auth.ts:84-92`). That single-tenant rule is the
 * property the write path depends on, so it is not widened. The hub needs the
 * opposite shape (read every allowed tenant in one call), so it gets its own
 * function, living BESIDE the old one, sharing none of its mutable state. A
 * reviewer of this change sees a new file and an unchanged `engine-auth.ts`.
 *
 * The bearer → sha256 → engine document → `status === "active"` handshake is
 * modelled on `engine-auth.ts:49-72` on purpose: same credential store
 * (`ContentEngines`), same hash-at-rest, same audit events. The divergence
 * starts at permission: instead of `allowedActions` membership, this path
 * checks the dedicated `hubRead` boolean (see the comment on that field in
 * `src/collections/ContentEngines.ts` for why it is not an ENGINE_ACTIONS value).
 *
 * READ ONLY. Nothing here grants or implies a write.
 *
 * KNOWN GAP (not an oversight): `ContentEngines.rateLimitPerMin` is declared but
 * enforced nowhere in this repo — no call site compares it against a request
 * count. The `/api/hub/*` routes therefore have NO rate limit. Tracked as
 * `cms1-hub-route-has-no-rate-limit`; designing real enforcement is a separate
 * piece of work covering every engine credential, not just the hub.
 */

import type { Payload } from "payload";
import { bearerToken, sha256Hex } from "@/lib/crypto";
import { findTenantById, tenantIsActive, type TenantDoc } from "@/lib/tenant";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";

/** The engine fields this path reads. Mirrors `EngineDoc` in engine-auth.ts but
 *  carries `hubRead` and deliberately does NOT carry `allowedActions` — the hub
 *  path must not be able to consult the write-permission array by accident. */
export interface HubEngineDoc {
  id: number | string;
  name: string;
  status: "active" | "suspended" | "revoked";
  allowedTenants?: (number | string | { id: number | string })[];
  hubRead?: boolean | null;
}

/** One tenant the caller is allowed to read, resolved to both id and slug.
 *  Slug is carried so routes can map `?tenants=gcv,wad` without a second trip. */
export interface HubTenantRef {
  id: number | string;
  slug: string;
}

export type HubAuthResult =
  | { ok: true; engine: HubEngineDoc; tenants: HubTenantRef[] }
  | { ok: false; response: Response };

interface HubAuthArgs {
  payload: Payload;
  request: Request;
}

function clientIp(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    undefined
  );
}

/**
 * Authenticate a hub caller and resolve EVERY tenant it may read.
 *
 * Returns the full allowed set; narrowing by a `?tenants=` query parameter is
 * the route's job (see `narrowHubTenants`), so this function stays purely about
 * "who is this and what may they see".
 */
export async function authenticateHubEngine(args: HubAuthArgs): Promise<HubAuthResult> {
  const { payload, request } = args;

  // 1. Bearer token → engine by token hash. (Same handshake as engine-auth.ts:49-72.)
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
  const engine = engineRes.docs[0] as HubEngineDoc | undefined;
  if (!engine || engine.status !== "active") {
    await logActivity({
      payload,
      eventType: "engine_auth_failed",
      actorType: "engine",
      actorEngineId: engine?.id ?? null,
      detail: {
        reason: engine ? `status:${engine.status}` : "unknown token",
        tokenPrefix: raw.slice(0, 8),
        scope: "hub",
      },
    });
    return { ok: false, response: json({ ok: false, status: "unauthorized" }, 401) };
  }

  // 2. Permission. Denials are LOGGED, never silent — same contract as the
  //    action check at engine-auth.ts:112-122, and reusing its existing event
  //    type (`engine_action_denied`) rather than minting a new one, so no change
  //    to ACTIVITY_EVENTS / constants.ts is needed.
  if (engine.hubRead !== true) {
    await logActivity({
      payload,
      eventType: "engine_action_denied",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { action: "hub_read", reason: "hubRead not enabled on this engine" },
    });
    return {
      ok: false,
      response: json({ ok: false, status: "forbidden", reason: "hub read not allowed for this engine" }, 403),
    };
  }

  // 3. Resolve every allowed tenant. Unlike engine-auth.ts:74-92 this does NOT
  //    demand exactly one — resolving many IS the point of this function.
  const allowedTenantIds = (engine.allowedTenants ?? [])
    .map(toId)
    .filter((id): id is number | string => id != null);

  if (allowedTenantIds.length === 0) {
    return {
      ok: false,
      response: json({ ok: false, status: "forbidden", reason: "engine has no allowed tenants" }, 403),
    };
  }

  const resolved = await Promise.all(
    allowedTenantIds.map((id) => findTenantById(payload, id)),
  );

  // Suspended / archived / deleted tenants drop out here, exactly as the single
  // -tenant path refuses them (`tenantIsActive`, engine-auth.ts:125-127). A
  // stale id in `allowedTenants` degrades to "one fewer tenant in the result",
  // never to an error for the other four.
  const tenants: HubTenantRef[] = resolved
    .filter((t): t is TenantDoc => t != null && tenantIsActive(t))
    .map((t) => ({ id: t.id, slug: t.slug }));

  if (tenants.length === 0) {
    return {
      ok: false,
      response: json({ ok: false, status: "forbidden", reason: "no active tenant among allowed tenants" }, 403),
    };
  }

  // 4. Stamp last-seen (best effort, non-blocking) — same as engine-auth.ts:129-139.
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

  return { ok: true, engine, tenants };
}

export type HubNarrowResult =
  | { ok: true; tenants: HubTenantRef[] }
  | { ok: false; unknown: string[] };

/**
 * Narrow an allowed tenant set by an explicit CSV of slugs (`?tenants=gcv,wad`).
 *
 * Asking for a tenant outside the engine's grant is an ERROR (the caller gets a
 * 403 and the offending slugs), never a silent drop: a hub screen that quietly
 * renders four publications when it asked for five is a bug that looks like
 * data. Absent/blank parameter ⇒ the full allowed set.
 */
export function narrowHubTenants(allowed: HubTenantRef[], csv: string | null): HubNarrowResult {
  if (csv == null) return { ok: true, tenants: allowed };
  const wanted = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) return { ok: true, tenants: allowed };

  const bySlug = new Map(allowed.map((t) => [t.slug, t]));
  const unknown = wanted.filter((slug) => !bySlug.has(slug));
  if (unknown.length) return { ok: false, unknown };

  // De-duplicate while preserving the caller's order.
  const seen = new Set<string>();
  const tenants: HubTenantRef[] = [];
  for (const slug of wanted) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    tenants.push(bySlug.get(slug) as HubTenantRef);
  }
  return { ok: true, tenants };
}
