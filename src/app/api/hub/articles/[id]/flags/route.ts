/**
 * POST /api/hub/articles/{id}/flags — set "Độc quyền" (`exclusive`) and "Ghim lên Mới nhất"
 * (`pinnedToLatest` + `pinnedUntil`) on ONE published article of any origin, from the hub
 * (content-engine plan hub-pin-exclusive-flags_PLAN_28-10-26.md, D6). Body EXACTLY
 * `{tenant, actor, expected, set}`. Auth: a ContentEngines token with hubRead + hubWrite (an
 * engine that also carries hubAuthor is refused). Off unless the CMS tenant is on the switch
 * HUB_EDITORIAL_FLAGS_TENANTS (src/lib/hub-author-flags.ts). Everything lives in
 * src/lib/hub-article-flags-core.ts (check order, gate, lock + row lock, write, post-write
 * assertion). Internal route: no CORS.
 */

import { handleHubFlags } from "@/lib/hub-article-flags-core";

/** Lock wait (≤ 3 s) + the revalidate webhook (≤ 5 s). */
export const maxDuration = 30;

export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubFlags(request, ctx);
