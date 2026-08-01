import { getPayload } from "payload";
import config from "@payload-config";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";

/**
 * Scheduled-publish cron — GET /api/cron/publish-scheduled.
 *
 * Central owns the content after cutover, so it has to own the scheduled → live
 * transition too. Without this route an editor could set `workflowStatus:
 * scheduled` + `scheduledFor` in the console and the article would simply never
 * go live: the status exists in the model, nothing ever flips it. The source
 * sites each had their own cron (see world-travel-brief
 * src/app/api/cron/publish-scheduled/route.ts) and lose it when their Payload is
 * removed — this is the multi-tenant replacement.
 *
 * Runs across ALL tenants in one pass; there is no per-tenant schedule to keep
 * in sync and a single Vercel Cron entry covers every publication.
 *
 * Auth (same NODE_ENV-gated policy the source sites used, so behaviour does not
 * change on cutover):
 *   - CRON_SECRET set (any environment) → `Authorization: Bearer <secret>` required, else 401.
 *   - CRON_SECRET unset + production   → 503, fail CLOSED. A missing secret must
 *     never silently degrade into an unauthenticated publish endpoint.
 *   - CRON_SECRET unset + non-production → open, for local `curl`.
 *
 * Cache invalidation is NOT done here: `payload.update` fires the Articles
 * afterChange hook, which posts the signed revalidate webhook to the owning
 * tenant's frontend (src/hooks/revalidate.ts). Doing it again here would double-post.
 */

interface DueArticle {
  id: number | string;
  tenant?: unknown;
  slug?: string;
  publishedAt?: string | null;
  scheduledFor?: string | null;
}

export async function GET(request: Request): Promise<Response> {
  // 1. Authenticate.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error("[cron/publish-scheduled] CRON_SECRET is not set in production — refusing to serve.");
    return json({ ok: false, error: "server misconfigured" }, 503);
  }

  let payload;
  try {
    payload = await getPayload({ config });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }

  // 2. Find everything due, across every tenant.
  const now = new Date().toISOString();
  const due = await payload.find({
    collection: "articles",
    where: {
      and: [
        { workflowStatus: { equals: "scheduled" } },
        { scheduledFor: { exists: true } },
        { scheduledFor: { less_than_equal: now } },
      ],
    },
    overrideAccess: true,
    depth: 0,
    limit: 200,
    // Drafts are a separate axis from workflowStatus — a scheduled article is
    // still an unpublished draft row, so it must be included in the query.
    draft: true,
  });

  // 3. Publish one at a time. One bad row must not take the whole batch down —
  //    a required field missing on a single article would otherwise silently
  //    block every later publication in the same run.
  const published: { id: number | string; slug?: string }[] = [];
  const failed: { id: number | string; error: string }[] = [];

  for (const raw of due.docs as unknown as DueArticle[]) {
    try {
      await payload.update({
        collection: "articles",
        id: raw.id,
        overrideAccess: true,
        data: {
          _status: "published",
          workflowStatus: "published",
          // Keep an explicitly-set publishedAt; otherwise the scheduled time IS
          // the publication time (matches the source sites' behaviour).
          publishedAt: raw.publishedAt ?? raw.scheduledFor ?? now,
        },
      });
      published.push({ id: raw.id, slug: raw.slug });
      await logActivity({
        payload,
        eventType: "article_published",
        tenantId: toId(raw.tenant) as number | string | undefined,
        actorType: "system",
        targetCollection: "articles",
        targetId: raw.id,
        fromStatus: "scheduled",
        toStatus: "published",
        detail: { via: "cron/publish-scheduled", scheduledFor: raw.scheduledFor },
      });
    } catch (err) {
      const message = (err as Error).message;
      failed.push({ id: raw.id, error: message });
      payload.logger.error(`[cron/publish-scheduled] article ${raw.id} failed: ${message}`);
      await logActivity({
        payload,
        eventType: "integration_error",
        tenantId: toId(raw.tenant) as number | string | undefined,
        actorType: "system",
        targetCollection: "articles",
        targetId: raw.id,
        detail: { via: "cron/publish-scheduled", error: message },
      });
    }
  }

  // `failed` is reported rather than swallowed so a monitoring check can alert
  // on it; the run itself is still a 200 because partial progress is real progress.
  return json({ ok: true, count: published.length, published, failed }, 200);
}
