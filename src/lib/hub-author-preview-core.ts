/**
 * POST /api/hub/articles/{id}/preview — mint a signed preview link for ONE article
 * (APCGHub P5.6, chặng 1; content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-6-preview-taxonomy-cms-exit_PLAN_30-09-26.md,
 * D1–D10, Public Contract C-PV).
 *
 * Auth = the hub AUTHOR key (hubRead + hubAuthor, `authenticateHubAuthorEngine`, D2).
 * Check order (first failure wins): auth (401 / 403 hub read / 403 hub author) → body
 * ≤ 4,096 bytes (413, `readSmallBody`) → JSON (400) → shape / unknown keys (400) and
 * `actor` (422) → tenant ∈ grant (403 + `engine_tenant_denied`) → `features.articles`
 * (403) → id shape + int4 (404) → the LATEST version (`draft: true`) of that article in
 * THAT tenant, any status / origin / engine (D9; 404 with the same body as an unknown
 * id) → tenant `frontendUrl` (409) → slug of the latest version (409) → sign → 200.
 *
 * The article is read with `payload.findByID({draft: true, depth: 0, overrideAccess:
 * true, disableErrors: true})` at the tenant's default locale — never through the
 * hub-draft edit loader, which refuses published / non-hub articles (D9).
 *
 * Writes nothing: no article, no ActivityLog row on success (D8; the key check still
 * stamps the engine's last-seen fields, as every hub route does). Denials and errors
 * reuse existing events. Logs carry an error NAME and CODE only — never the token,
 * the URL, the secret or a title. The exported route wrapper never passes `deps`.
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { isHubArticleId } from "@/lib/hub-article-id";
import { signPayload } from "@/lib/crypto";
import { clampLocale } from "@/lib/locales";
import { supportedLanguages } from "@/lib/tenant";
import { toId } from "@/access/helpers";
import { authenticateHubAuthorEngine } from "@/lib/hub-author-auth";
import { logInternal, notFound, parsedResponse, resolveTenant } from "@/lib/hub-author-handlers";
import {
  buildPreviewUrl,
  checkFrontendUrl,
  hasPreviewSlug,
  parsePreviewBody,
  previewClaims,
  previewResponse,
  previewUnavailable,
  readSmallBody,
} from "@/lib/hub-author-preview-pure";

type Doc = Record<string, unknown>;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubPreviewDeps {
  getPayload?: () => Promise<Payload>;
  /** Signer (default: `signPayload` of src/lib/crypto.ts). */
  sign?: typeof signPayload;
  /** Server clock in ms (default `Date.now`). */
  now?: () => number;
}

const defaultGetPayload = () => getPayload({ config });

export function handleHubPreviewMint(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubPreviewMintWith(request, ctx);
}

export async function handleHubPreviewMintWith(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  deps: HubPreviewDeps = {},
): Promise<Response> {
  const payload = await (deps.getPayload ?? defaultGetPayload)();
  const auth = await authenticateHubAuthorEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const body = await readSmallBody(request);
  if (!body.ok) return body.response;
  const parsed = parsePreviewBody(body.raw);
  if (!parsed.ok) return parsedResponse(parsed);

  const t = await resolveTenant(payload, auth, parsed.value.tenant);
  if (!t.ok) return t.response;
  const tenant = t.tenant;

  const { id } = await ctx.params;
  if (typeof id !== "string" || !isHubArticleId(id)) return notFound();

  try {
    const locale = clampLocale(null, supportedLanguages(tenant), tenant.defaultLanguage);
    const doc = (await payload.findByID({
      collection: "articles",
      id,
      draft: true,
      depth: 0,
      locale,
      overrideAccess: true,
      disableErrors: true,
      select: { slug: true, tenant: true },
    } as never)) as unknown as Doc | null;
    if (!doc || String(toId(doc.tenant)) !== String(tenant.id)) return notFound();

    const front = checkFrontendUrl(tenant.frontendUrl);
    if (!front.ok) return previewUnavailable(front.reason);
    if (!hasPreviewSlug(doc.slug)) return previewUnavailable("no_slug");

    const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
    const claims = previewClaims(tenant.slug, doc.slug, nowSeconds);
    const token = (deps.sign ?? signPayload)(claims);
    return previewResponse({ id: Number(id), tenant: tenant.slug, url: buildPreviewUrl(front.url, token, doc.slug), exp: claims.exp });
  } catch (err) {
    return logInternal(payload, auth.engine.id, err);
  }
}
