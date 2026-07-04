/**
 * Per-tenant feature gating for the Payload admin + authenticated REST API.
 *
 * Composes with (never replaces) the existing access bundles and the
 * multi-tenant plugin's own scoping: the gate is ANDed on top, so it can only
 * narrow access. Returning literal `false` from `read` is what hides a
 * collection from the admin nav, dashboard, and direct URLs.
 *
 * Tenant selection comes from the plugin's `payload-tenant` cookie (the tenant
 * picked in the admin selector). Machine/public traffic runs with
 * `overrideAccess: true`, so these functions never execute for it — feature
 * enforcement for those paths stays in the route handlers (featureEnabled).
 */

import type { Access, PayloadRequest, Where } from "payload";
import { getTenantFromCookie } from "@payloadcms/plugin-multi-tenant/utilities";
import type { FeatureKey } from "@/lib/constants";
import { featureEnabled, type TenantDoc } from "@/lib/tenant";
import { asUser, isSystemAdmin, memberTenantIds } from "@/access/helpers";

/** Gate verdict: true = no extra restriction; false = deny the op entirely;
 *  { tenantIds } = restrict the op to rows of these tenants (ANDed with base). */
export type FeatureGateResult = boolean | { tenantIds: (number | string)[] };

const CTX_KEY = "featureGateTenantMap";

/** One `tenants` find per request, shared by ALL gated collections. The
 *  in-flight Promise MUST be stored synchronously: Payload computes admin
 *  permissions for every collection concurrently (Promise.all in
 *  getAccessResults), so an awaited-then-cached value would fan out one query
 *  per gated collection. */
function getTenantMap(req: PayloadRequest): Promise<Map<string, TenantDoc>> {
  const ctx = req.context as Record<string, unknown>;
  if (!ctx[CTX_KEY]) {
    ctx[CTX_KEY] = req.payload
      .find({ collection: "tenants", depth: 0, pagination: false, overrideAccess: true })
      .then((res) => new Map(res.docs.map((d) => [String(d.id), d as unknown as TenantDoc])));
  }
  return ctx[CTX_KEY] as Promise<Map<string, TenantDoc>>;
}

export async function featureGate(
  req: PayloadRequest,
  key: FeatureKey,
): Promise<FeatureGateResult> {
  if (!asUser(req)) return false; // anonymous: base access denies anyway

  const tenantMap = await getTenantMap(req);
  const cookieId = getTenantFromCookie(req.headers, req.payload.db.defaultIDType);
  const selected = cookieId != null ? tenantMap.get(String(cookieId)) : undefined;

  if (isSystemAdmin(req)) {
    // No selection OR stale cookie → global context → see everything.
    return selected ? featureEnabled(selected, key) : true;
  }

  const memberIds = memberTenantIds(req);
  if (memberIds.length === 0) return false;

  // Working set: the selected tenant IF the user is a member of it; otherwise
  // (no cookie / stale cookie / foreign tenant) all member tenants. A stale
  // cookie can only fall back to the member set — it never widens access.
  const memberIdSet = new Set(memberIds.map(String));
  const relevant: TenantDoc[] =
    selected && memberIdSet.has(String(selected.id))
      ? [selected]
      : memberIds.flatMap((id) => tenantMap.get(String(id)) ?? []);

  const enabled = relevant.filter((t) => featureEnabled(t, key));
  if (enabled.length === 0) return false;
  if (enabled.length === relevant.length) return true;
  return { tenantIds: enabled.map((t) => t.id) };
}

/** AND the feature gate with a base access function. Never widens the base. */
export function withFeature(key: FeatureKey, base: Access): Access {
  return async (args) => {
    const gate = await featureGate(args.req, key);
    if (gate === false) return false;
    const baseResult = await base(args);
    if (gate === true || baseResult === false) return baseResult;
    const limit: Where = { tenant: { in: gate.tenantIds } };
    return baseResult === true ? limit : { and: [baseResult, limit] };
  };
}

interface AccessBundle {
  read: Access;
  create: Access;
  update: Access;
  delete: Access;
}

/** Wrap all four ops of an access bundle. Returns a NEW object — the shared
 *  bundles (tenantManagedAccess is also used by ungated collections) are never
 *  mutated. */
export function featureGatedAccess(key: FeatureKey, bundle: AccessBundle): AccessBundle {
  return {
    read: withFeature(key, bundle.read),
    create: withFeature(key, bundle.create),
    update: withFeature(key, bundle.update),
    delete: withFeature(key, bundle.delete),
  };
}

/** readVersions for versioned collections (Articles). Payload defaults this op
 *  to Boolean(req.user); the multi-tenant plugin then ANDs
 *  `version.tenant in [member tenants]`. Where results MUST use the `version.`
 *  prefix — versions are queried against the versions table (parent, version.*). */
export function featureGatedReadVersions(key: FeatureKey): Access {
  return async ({ req }) => {
    const gate = await featureGate(req, key);
    if (gate === false) return false;
    if (gate === true) return Boolean(req.user); // preserve the current default exactly
    return { "version.tenant": { in: gate.tenantIds } };
  };
}
