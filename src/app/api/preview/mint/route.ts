/**
 * GET /api/preview/mint?slug=&tenant= — admin-only. The Articles "Preview"
 * button hits this. Authenticates the CMS user, verifies they can access the
 * article's tenant, mints a short-lived HMAC preview token, and redirects to the
 * tenant frontend's /preview?token=... The frontend then calls
 * /api/public/preview with that token to fetch the draft. A leaked slug alone is
 * not enough — the signed token is required.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { signPayload } from "@/lib/crypto";
import { findTenantById } from "@/lib/tenant";
import { toId } from "@/access/helpers";
import { json } from "@/lib/http";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const tenantParam = url.searchParams.get("tenant");
  if (!slug || !tenantParam) return json({ ok: false, reason: "slug and tenant required" }, 400);

  const payload = await getPayload({ config });
  const { user } = await payload.auth({ headers: request.headers });
  if (!user) return json({ ok: false, status: "unauthorized" }, 401);

  const tenantId: number | string = isFinite(Number(tenantParam)) ? Number(tenantParam) : tenantParam;
  const u = user as { role?: string; tenants?: { tenant: unknown }[] };
  const allowed =
    u.role === "systemAdmin" || (u.tenants ?? []).some((t) => toId(t.tenant) === tenantId);
  if (!allowed) return json({ ok: false, status: "forbidden" }, 403);

  const tenant = await findTenantById(payload, tenantId);
  if (!tenant?.frontendUrl) return json({ ok: false, reason: "tenant has no frontendUrl" }, 400);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signPayload({ tenant: tenant.slug, slug, draft: true, exp: nowSeconds + 600 });
  const dest = `${tenant.frontendUrl.replace(/\/$/, "")}/preview?token=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}`;
  return Response.redirect(dest, 302);
}
