/**
 * POST /api/hub/articles/{id}/publish — publish ONE hub-authored draft now
 * (APCGHub P5.2 / CMS-B). Body EXACTLY {tenant, expectedVersion, actor}; the CMS
 * publishes the SAVED latest version (the hub sends no content). Auth: a
 * ContentEngines token with hubRead + hubWrite. Everything lives in
 * src/lib/hub-author-publish-core.ts (check order, K4 / K13, lock, write). Internal
 * route: no CORS.
 */

import { handleHubPublish } from "@/lib/hub-author-publish-core";

/** Lock wait (≤ 3 s) + webhooks (≤ 5 s each) + translation fan-out on a translated tenant. */
export const maxDuration = 30;

export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubPublish(request, ctx);
