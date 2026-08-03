/**
 * GET /api/public/authors?locale=&slug= — the tenant's masthead / byline directory.
 *
 * `slug` returns a single author; otherwise the whole list. Sorted by `rank` then
 * `name`: WTB's feedback round 2 (m15) added `rank` so a masthead can be ordered
 * editorially rather than alphabetically, and rows without a rank fall to the end
 * instead of jumping to the front.
 *
 * Not feature-gated — every publication has bylines, and an author page that 404s
 * would break article attribution links rather than degrade gracefully.
 *
 * Response: `{ data: { authors: [...] } }`, matching the /cities shape.
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
  const slug = url.searchParams.get("slug");

  const res = await scopedFind({
    payload,
    collection: "authors",
    tenantId: tenant.id,
    locale,
    where: slug ? { slug: { equals: slug } } : undefined,
    sort: "rank",
    limit: slug ? 1 : 200,
    depth: 1,
  });

  return jsonPublic(request, { data: { authors: res.docs } }, 200);
}
