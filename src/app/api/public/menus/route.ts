/**
 * GET /api/public/menus?type=header|footer&locale= — the token's tenant menus.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedFind } from "@/lib/scoped";
import { supportedLanguages } from "@/lib/tenant";
import { clampLocale } from "@/lib/locales";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);

  const url = new URL(request.url);
  const locale = clampLocale(url.searchParams.get("locale"), supportedLanguages(tenant), tenant.defaultLanguage);
  const type = url.searchParams.get("type");

  const where = type ? { type: { equals: type } } : undefined;
  const result = await scopedFind({ payload, collection: "menus", tenantId: tenant.id, where, locale, limit: 10, depth: 0 });
  return jsonPublic(request, { menus: result.docs }, 200);
}
