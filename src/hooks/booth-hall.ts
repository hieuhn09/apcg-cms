/**
 * Booths `hall` field validate (amb launch W2, 27-10-26): Payload's own select
 * check first, then the per-tenant hall allowlist (src/lib/booth-halls.ts,
 * BOOTH_HALLS_BY_TENANT: abb and amb each use six of the halls). Booths has no
 * drafts, so this runs on every write path (admin, REST, GraphQL, Local API).
 */
import { select as selectValidate } from "payload/shared";
import { boothHallDecision } from "@/lib/booth-halls";

type SelectValidate = typeof selectValidate;

/**
 * `hall` validate: Payload's own select check first, then the per-tenant hall
 * allowlist (BOOTH_HALLS_BY_TENANT: abb and amb each use six of the halls).
 * No tenant on the row yet: pass (the tenant field's own required check
 * answers). Tenant lookup error: FAIL CLOSED.
 */
export function makeBoothHallValidate(base: SelectValidate = selectValidate) {
  return async (value: Parameters<SelectValidate>[0], options: Parameters<SelectValidate>[1]): Promise<string | true> => {
    const baseResult = await base(value, options);
    if (baseResult !== true) return baseResult;
    if (value === null || value === undefined || (value as unknown) === "") return true;
    const o = options as unknown as { data?: Record<string, unknown>; siblingData?: Record<string, unknown> };
    const t = o.data?.tenant ?? o.siblingData?.tenant;
    const tenantId = t !== null && typeof t === "object" ? (t as { id?: unknown }).id : t;
    if (tenantId === null || tenantId === undefined || tenantId === "") return true;
    let slug = t !== null && typeof t === "object" && typeof (t as { slug?: unknown }).slug === "string" ? (t as { slug: string }).slug : null;
    if (!slug) {
      try {
        const doc = (await options.req.payload.findByID({
          collection: "tenants",
          id: tenantId as number | string,
          depth: 0,
          overrideAccess: true,
          req: options.req,
          select: { slug: true },
        } as never)) as unknown as { slug?: unknown } | null;
        slug = typeof doc?.slug === "string" ? doc.slug : null;
      } catch {
        return "Hall check: the booth's tenant could not be resolved.";
      }
      if (!slug) return "Hall check: the booth's tenant could not be resolved.";
    }
    return boothHallDecision(slug, value);
  };
}

export const boothHallValidate = makeBoothHallValidate();
