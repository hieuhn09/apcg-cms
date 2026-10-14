/**
 * POST /api/hub/authors — create (or reuse) ONE pen name for one tenant in the hub AUTHOR
 * key's grant (APCGHub P5.6). Body EXACTLY {tenant, name, role?, actor} (≤ 4,096 bytes).
 * 201 created / 200 already there = {ok, created, author: {id, name, role}}.
 * Everything lives in src/lib/hub-taxonomy-create-core.ts. Internal route: no CORS.
 */

import { handleHubAuthorCreate } from "@/lib/hub-taxonomy-create-core";

/** Same budget as every sibling hub JSON route. */
export const maxDuration = 30;

export const POST = (request: Request) => handleHubAuthorCreate(request);
