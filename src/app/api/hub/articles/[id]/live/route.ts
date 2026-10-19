/**
 * PATCH /api/hub/articles/{id}/live — save an edit of ONE published, hub-authored
 * article straight onto the live row (APCGHub P5.4, "Sửa bài đã đăng"). Body
 * `{tenant, expectedVersion, actor, fields}` (nested; `fields` = the 15 live keys).
 * Auth: a ContentEngines token with hubRead + hubWrite (an engine that also carries
 * hubAuthor is refused). Off unless the CMS tenant is on the live-edit switch
 * (`liveEditTenants`, src/lib/hub-author-live-pure.ts). Everything lives in src/lib/hub-author-live-core.ts (check
 * order, live gate, lock + row lock, write, post-write assertion). Internal route: no CORS.
 */

import { handleHubLiveUpdate } from "@/lib/hub-author-live-core";

/** Lock wait (≤ 3 s) + webhooks (≤ 5 s each) + translation fan-out on a translated tenant. */
export const maxDuration = 30;

export const PATCH = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubLiveUpdate(request, ctx);
