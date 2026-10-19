/**
 * POST /api/hub/articles/{id}/preview — mint a signed, 10-minute preview link for ONE
 * article of a tenant in the hub AUTHOR key's grant (APCGHub P5.6). Body EXACTLY
 * {tenant, actor} (≤ 4,096 bytes). 200 = {ok, id, tenant, url, expiresAt}. Writes
 * nothing. Everything lives in src/lib/hub-author-preview-core.ts. Internal route: no CORS.
 */

import { handleHubPreviewMint } from "@/lib/hub-author-preview-core";

/** Same budget as every sibling hub JSON route. */
export const maxDuration = 30;

export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubPreviewMint(request, ctx);
