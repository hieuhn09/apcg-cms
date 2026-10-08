/**
 * POST /api/hub/articles/{id}/schedule — schedule ONE hub-authored draft, or
 * unschedule it (APCGHub P5.2 / CMS-B).
 *   schedule:   {tenant, expectedVersion, actor, scheduledFor}          (UTC, > now + 60 s, ≤ 365 days)
 *   unschedule: {tenant, expectedVersion, actor, scheduledFor: null, expectedScheduledFor}
 * The existing cron `publish-scheduled` publishes the article when due. Auth: a
 * ContentEngines token with hubRead + hubWrite. Everything lives in
 * src/lib/hub-author-publish-core.ts. Internal route: no CORS.
 */

import { handleHubSchedule } from "@/lib/hub-author-publish-core";

export const maxDuration = 30;

export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => handleHubSchedule(request, ctx);
