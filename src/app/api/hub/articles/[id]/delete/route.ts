/**
 * POST /api/hub/articles/{id}/delete — permanently delete ONE hub-authored draft that
 * was never published (10-11-26). Body EXACTLY {tenant, expectedVersion, actor}. Auth: a
 * ContentEngines token with hubRead + hubAuthor (the hub's author credential). Everything
 * lives in src/lib/hub-author-delete-core.ts. Internal route: no CORS.
 */

import { handleHubDraftDelete } from "@/lib/hub-author-delete-core";

export const maxDuration = 30;

export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubDraftDelete(request, ctx);
