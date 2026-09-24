/**
 * findHubTenants — read the Tenants documents behind `GET /api/hub/tenants`
 * (APCGHub P4 / CMS-2).
 *
 * WHY `payload.find` DIRECTLY, not `scopedFind`: `scopedFind` forces a
 * `tenant: { equals }` condition (scoped.ts), and the Tenants collection has no
 * `tenant` field — a tenant IS the scope. The precedent is `findTenantById` in
 * `hub-auth.ts`, which reads Tenants the same way.
 *
 * TRUST BOUNDARY: `ids` must come ONLY from `narrowHubTenants(auth.tenants, …)`
 * — i.e. tenants the authenticated hub engine is granted. Never pass ids taken
 * from the query string. `status` is not re-checked here: authentication already
 * dropped every tenant that is not `active`.
 *
 * EMPTY `ids` ⇒ `[]` WITHOUT a query. With Payload, `limit: 0` means "no limit",
 * and an empty `in` is not a shape worth trusting; either would risk reading
 * every tenant. The limit is always explicit (`ids.length`), never Payload's
 * default of 10.
 *
 * Output is raw Payload documents restricted by `TENANT_SELECT`; the caller must
 * still pass each one through `sanitizeHubTenant`.
 */

import type { Payload } from "payload";
import { TENANT_SELECT } from "@/lib/hub-sanitize";

export async function findHubTenants(
  payload: Payload,
  ids: (number | string)[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const res = await payload.find({
    collection: "tenants",
    where: { id: { in: ids } },
    select: TENANT_SELECT,
    depth: 0,
    locale: "en",
    limit: ids.length,
    overrideAccess: true,
  });
  return res.docs as unknown as Record<string, unknown>[];
}
