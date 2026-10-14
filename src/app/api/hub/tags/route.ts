/**
 * POST /api/hub/tags — create (or reuse) ONE tag for one tenant in the hub AUTHOR key's
 * grant (APCGHub P5.6). Body EXACTLY {tenant, title, actor} (≤ 4,096 bytes).
 * 201 created / 200 already there = {ok, created, tag: {id, slug, title}}.
 * Everything lives in src/lib/hub-taxonomy-create-core.ts. Internal route: no CORS.
 */

import { handleHubTagCreate } from "@/lib/hub-taxonomy-create-core";

/** Same budget as every sibling hub JSON route. */
export const maxDuration = 30;

export const POST = (request: Request) => handleHubTagCreate(request);
