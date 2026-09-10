import { getPayload } from "payload";
import config from "@payload-config";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";

/**
 * Pin-expiry cron — GET /api/cron/unpin-expired.
 *
 * `pinnedUntil` is enforced at read time (the public articles route filters
 * expired pins out of `?flag=pinnedToLatest`), so this cron is NOT what makes
 * expiry correct. It exists for admin hygiene: without it an expired pin keeps
 * its checkbox ticked forever and the admin list lies to editors about what is
 * actually pinned. Hourly is plenty — readers never see the stale flag.
 *
 * Runs across ALL tenants in one pass, same as publish-scheduled.
 *
 * Auth (same NODE_ENV-gated policy as cron/publish-scheduled):
 *   - CRON_SECRET set (any environment) → `Authorization: Bearer <secret>` required, else 401.
 *   - CRON_SECRET unset + production   → 503, fail CLOSED.
 *   - CRON_SECRET unset + non-production → open, for local `curl`.
 *
 * The update runs with `context.systemWrite` so articleBookkeeping skips its
 * version bump / lastEditedBy stamp — this sweep is metadata-only, nobody
 * edited the article. It also runs with `context.disableRevalidate` so the
 * Articles afterChange hook does NOT post the signed revalidate webhook
 * (src/hooks/revalidate.ts): readers are already covered by the read-time
 * expiry filter, so busting their caches hourly for an invisible change was
 * pure cost. See the inline note on the update call for the per-reader scope
 * this was verified against.
 */

interface ExpiredPin {
  id: number | string;
  tenant?: unknown;
  slug?: string;
  pinnedUntil?: string | null;
  /** From the draft:true find — the LATEST version's status, draft included. */
  _status?: string;
}

export async function GET(request: Request): Promise<Response> {
  // 1. Authenticate.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error("[cron/unpin-expired] CRON_SECRET is not set in production — refusing to serve.");
    return json({ ok: false, error: "server misconfigured" }, 503);
  }

  let payload;
  try {
    payload = await getPayload({ config });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }

  // 2. Find every expired pin, across every tenant. Drafts included: a pinned
  //    draft with a past expiry is just as stale in the admin list.
  const now = new Date().toISOString();
  const expired = await payload.find({
    collection: "articles",
    where: {
      and: [
        { pinnedToLatest: { equals: true } },
        { pinnedUntil: { exists: true } },
        { pinnedUntil: { less_than_equal: now } },
      ],
    },
    overrideAccess: true,
    depth: 0,
    limit: 200,
    draft: true,
  });

  // 3. Unpin one at a time — one bad row must not take the whole batch down.
  const unpinned: { id: number | string; slug?: string }[] = [];
  const failed: { id: number | string; error: string }[] = [];

  for (const raw of expired.docs as unknown as ExpiredPin[]) {
    try {
      await payload.update({
        collection: "articles",
        id: raw.id,
        overrideAccess: true,
        // systemWrite: bookkeeping (version/lastEditedBy) không đổi;
        // skipTranslationEnqueue: unpin không đổi nội dung nên không việc gì
        // phải chạy vòng enqueue dịch (dù nó idempotent).
        //
        // disableRevalidate: this sweep is admin hygiene only. `pinnedUntil` is
        // enforced at READ time — src/app/api/public/articles/route.ts filters
        // expired pins out of `?flag=pinnedToLatest` — so readers never see the
        // stale flag and have nothing to be busted for. Firing the webhook here
        // dropped every reader's whole `articles:all` cache once an hour for a
        // change no reader can observe.
        //
        // SCOPE (plan E7): verified safe for brief-asia-web, wad-web, wtb-web
        // and dtw-web only. brief-asia/wad/dtw request pins with
        // `flag=pinnedToLatest`, so Central's query-time expiry governs.
        // wtb-web instead pulls a raw list and picks the pin in memory; it is
        // safe only because it re-checks `pinnedUntil` at render time AND every
        // Central fetch is `cache: "no-store"`. That margin is one line wide —
        // if wtb-web ever adds `export const revalidate` to its home page, an
        // expired pin would freeze for the whole window with nothing left to
        // bust it. Re-check this before assuming it still holds.
        // GCV is NOT audited (not available to the auditing session) — do not
        // generalize this suppression to it without running the same check.
        context: { systemWrite: true, skipTranslationEnqueue: true, disableRevalidate: true },
        data: { pinnedToLatest: false, pinnedUntil: null },
        // Draft-safe sweep: `payload.update` base-merges from the LATEST
        // version. When the article has a pending draft on top of its live
        // row (raw came from a draft:true find, so raw._status tells us), a
        // plain update would publish that half-written draft as a side effect
        // of clearing a pin flag. Sweep the draft surface instead — readers
        // are already covered by the read-time expiry filter in the public
        // articles route, so the live row's stale flag is harmless until the
        // editor's next publish.
        draft: raw._status === "draft",
      });
      unpinned.push({ id: raw.id, slug: raw.slug });
      await logActivity({
        payload,
        eventType: "pin_expired",
        tenantId: toId(raw.tenant) as number | string | undefined,
        actorType: "system",
        targetCollection: "articles",
        targetId: raw.id,
        detail: { via: "cron/unpin-expired", pinnedUntil: raw.pinnedUntil },
      });
    } catch (err) {
      const message = (err as Error).message;
      failed.push({ id: raw.id, error: message });
      payload.logger.error(`[cron/unpin-expired] article ${raw.id} failed: ${message}`);
      await logActivity({
        payload,
        eventType: "integration_error",
        tenantId: toId(raw.tenant) as number | string | undefined,
        actorType: "system",
        targetCollection: "articles",
        targetId: raw.id,
        detail: { via: "cron/unpin-expired", error: message },
      });
    }
  }

  return json({ ok: true, count: unpinned.length, unpinned, failed }, 200);
}
