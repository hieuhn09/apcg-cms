/**
 * Tenant-aware revalidation. When editorial content changes, the owning tenant's
 * frontend must refresh its cache. Unlike brief-asia (which used a single global
 * env var), the Central CMS resolves the CHANGED DOC'S tenant and POSTs a SIGNED
 * webhook to THAT tenant's `frontendUrl` + `/api/revalidate`.
 *
 * The webhook body is HMAC-signed with CENTRAL_SIGNING_SECRET so a frontend can
 * trust it. Each frontend exposes a tiny verified route that calls
 * `revalidateTag(...)` on the per-tenant-namespaced tags.
 *
 * Out-of-request callers (seed, import scripts) set `context.disableRevalidate`
 * so bulk writes don't hammer frontends; one explicit warm runs at the end.
 */

import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  Payload,
} from "payload";
import { signPayload } from "@/lib/crypto";
import { findTenantById, type TenantDoc } from "@/lib/tenant";
import { toId } from "@/access/helpers";

function revalidationDisabled(context: unknown): boolean {
  return Boolean(
    (context as { disableRevalidate?: unknown } | undefined)?.disableRevalidate,
  );
}

/** Per-tenant cache tag, e.g. `brief-asia:articles:all`. Frontends bust these. */
export function tenantTag(tenantSlug: string, tag: string): string {
  return `${tenantSlug}:${tag}`;
}

async function postRevalidate(
  payload: Payload,
  tenant: TenantDoc | null,
  body: Record<string, unknown>,
): Promise<void> {
  if (!tenant?.frontendUrl) return;
  if (!process.env.CENTRAL_SIGNING_SECRET) {
    payload.logger.warn("[revalidate] CENTRAL_SIGNING_SECRET unset — skipping webhook");
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  // The token is self-contained: the frontend verifies it and reads `tags` from
  // the claims (no need to trust the outer body). Frontend's REVALIDATE_SECRET
  // must equal Central's CENTRAL_SIGNING_SECRET.
  const token = signPayload({ ...body, tenant: tenant.slug, exp: nowSeconds + 120 });
  const url = `${tenant.frontendUrl.replace(/\/$/, "")}/api/revalidate`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    payload.logger.info(`[revalidate] → ${url} (${JSON.stringify(body)})`);
  } catch (err) {
    // Frontend down / unreachable. The frontend's per-query `revalidate` window
    // is the fallback. Never let this break the editorial write.
    payload.logger.warn(`[revalidate] webhook to ${url} failed: ${(err as Error).message}`);
  }
}

/**
 * Build afterChange/afterDelete hooks for a collection. `tags` are the logical
 * cache tags (without tenant prefix) the frontend uses for this collection.
 */
export function revalidateHooks(tags: readonly string[]): {
  afterChange: CollectionAfterChangeHook;
  afterDelete: CollectionAfterDeleteHook;
} {
  const afterChange: CollectionAfterChangeHook = async ({ doc, req: { payload, context } }) => {
    if (revalidationDisabled(context)) return doc;
    const tenant = await findTenantById(payload, toId(doc.tenant) as number | string);
    await postRevalidate(payload, tenant, {
      tags,
      collection: doc.collection ?? undefined,
      slug: (doc as { slug?: string }).slug,
    });
    return doc;
  };

  const afterDelete: CollectionAfterDeleteHook = async ({ doc, req: { payload, context } }) => {
    if (revalidationDisabled(context)) return doc;
    const tenant = await findTenantById(payload, toId(doc?.tenant) as number | string);
    await postRevalidate(payload, tenant, {
      tags,
      slug: (doc as { slug?: string })?.slug,
      deleted: true,
    });
    return doc;
  };

  return { afterChange, afterDelete };
}
