/**
 * Media `afterChange` — refresh the reader after a hero FOCAL POINT change (content-engine plan
 * process/features/apcg-hub/active/hub-hero-focal-point_PLAN_10-11-26.md, P1.5; D11 as corrected
 * by validate C11 / N1: a SEPARATE hook, `revalidateHooks` is not used for Media).
 *
 * Fires ONLY when ALL hold:
 *   - `operation === "update"` (bulk media creates / imports never hit a frontend; the first
 *     focal set is an update from Payload's own 50/50, so it still fires);
 *   - not `context.disableRevalidate`;
 *   - `focalX` or `focalY` really changed vs `previousDoc` (an alt / caption edit does not fire);
 *   - the media's tenant slug ∈ `HUB_FOCAL_TENANTS` (read on every call; empty ⇒ no tenant read).
 * Then ONE signed webhook `{tags: ["articles:all"]}` to that tenant's frontend (same signer and
 * 5 s timeout as every other revalidate; it fires before Payload commits the update, like the
 * Articles hook; the reader's own 60 s window covers the gap). Best-effort: every error is
 * caught and logged by NAME, the media save is never blocked.
 */

import type { CollectionAfterChangeHook, Payload } from "payload";
import { postRevalidate } from "@/hooks/revalidate";
import { findTenantById, type TenantDoc } from "@/lib/tenant";
import { toId } from "@/access/helpers";
import { focalColumnsChanged, focalTenants, isFocalTenant } from "@/lib/hub-hero-focal-pure";

/** The logical tags a focal change refreshes (the frontend prefixes the tenant). */
export const MEDIA_FOCAL_REVALIDATE_TAGS = ["articles:all"] as const;

/** Injectable seams (unit checks only; the collection uses `mediaFocalRevalidate`). */
export interface MediaFocalRevalidateDeps {
  tenants?: () => readonly string[];
  findTenant?: (payload: Payload, id: number | string) => Promise<TenantDoc | null>;
  post?: (payload: Payload, tenant: TenantDoc | null, body: Record<string, unknown>) => Promise<void>;
}

export function makeMediaFocalRevalidate(deps?: MediaFocalRevalidateDeps): CollectionAfterChangeHook {
  return async ({ doc, previousDoc, operation, req }) => {
    try {
      if (operation !== "update") return doc;
      if ((req?.context as { disableRevalidate?: unknown } | undefined)?.disableRevalidate) return doc;
      if (!focalColumnsChanged(doc as Record<string, unknown>, previousDoc as Record<string, unknown>)) return doc;
      const tenants = (deps?.tenants ?? (() => focalTenants()))();
      if (!tenants.length) return doc;
      const tenantId = toId((doc as { tenant?: unknown }).tenant);
      if (tenantId == null) return doc;
      const tenant = await (deps?.findTenant ?? findTenantById)(req.payload, tenantId as number | string);
      if (!tenant || !isFocalTenant(tenant.slug, tenants)) return doc;
      await (deps?.post ?? postRevalidate)(req.payload, tenant, { tags: [...MEDIA_FOCAL_REVALIDATE_TAGS] });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      req?.payload?.logger?.warn(`[revalidate] media focal webhook skipped: name=${typeof name === "string" ? name : typeof err}`);
    }
    return doc;
  };
}

export const mediaFocalRevalidate: CollectionAfterChangeHook = makeMediaFocalRevalidate();
