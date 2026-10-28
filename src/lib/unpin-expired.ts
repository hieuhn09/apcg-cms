/**
 * The conditional sweep of ONE expired pin for `GET /api/cron/unpin-expired` (review L3 of the
 * hub-pin-exclusive-flags change, content-engine plan
 * process/features/apcg-hub/active/hub-pin-exclusive-flags_PLAN_28-10-26.md).
 *
 * Before: the cron found the expired pins, then updated each one UNCONDITIONALLY — a pin re-set
 * in between (the hub draft PATCH, the hub flags route, a CMS admin save) was cleared anyway.
 * Now each write is a compare-and-set under the SAME locks the hub writes take:
 *   `withHubArticleLock({tenantId, articleId})` (the hub advisory lock: hub draft PATCH, publish
 *   / schedule, live edit, flags) → `FOR NO KEY UPDATE` on the row (`defaultLockRow`: every
 *   non-draft UPDATE of the row — CMS admin, intake, other crons) → the LATEST version re-read
 *   on the transaction → still `pinnedToLatest` with `pinnedUntil <= now`? → the same write as
 *   before (`systemWrite` + `skipTranslationEnqueue` + `disableRevalidate`, `draft` when the
 *   latest version is a draft), on the transaction. Otherwise nothing is written ("skipped").
 *
 * Residual (accepted): a CMS admin DRAFT save inserts a version row and is not blocked by either
 * lock; one landing in the milliseconds between the re-read and the write can still be unpinned.
 * Busy (lock_timeout 3 s) ⇒ "skipped", the next hourly run retries.
 */

import type { Payload, PayloadRequest } from "payload";
import { toId } from "@/access/helpers";
import { json } from "@/lib/http";
import { defaultLockRow, withHubArticleLock } from "@/lib/hub-article-lock";

type Doc = Record<string, unknown>;
type Id = number | string;

/** The pin is still expired on this version: ticked, with an expiry at or before `nowMs`. */
export function isStillExpired(doc: Doc | null | undefined, nowMs: number): boolean {
  if (!doc || doc.pinnedToLatest !== true || doc.pinnedUntil == null) return false;
  const t = new Date(doc.pinnedUntil as string).getTime();
  return !Number.isNaN(t) && t <= nowMs;
}

export type UnpinOutcome =
  | { kind: "unpinned"; draft: boolean; pinnedUntil: unknown }
  | { kind: "skipped"; reason: "not_expired" | "missing" | "busy" };

export interface UnpinDeps {
  lock?: typeof withHubArticleLock;
  lockRow?: (payload: Payload, id: Id, req: PayloadRequest | undefined) => Promise<void>;
}

/** Re-check and unpin ONE article found by the cron's search (`raw` = its id + tenant). Throws on a write error. */
export async function unpinIfStillExpired(payload: Payload, raw: { id: Id; tenant?: unknown }, nowMs: number, deps?: UnpinDeps): Promise<UnpinOutcome> {
  const articleId = Number(raw.id);
  const tenantId = (toId(raw.tenant) ?? "none") as Id;
  let outcome: UnpinOutcome = { kind: "skipped", reason: "missing" };
  const res = await (deps?.lock ?? withHubArticleLock)({ tenantId, articleId }, async (lk) => {
    await (deps?.lockRow ?? defaultLockRow)(payload, articleId, lk.req);
    const latest = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req: lk.req,
    })) as unknown as Doc | null;
    if (!latest) {
      outcome = { kind: "skipped", reason: "missing" };
      return { ok: false, value: json({ ok: true }, 200) };
    }
    if (!isStillExpired(latest, nowMs)) {
      outcome = { kind: "skipped", reason: "not_expired" };
      return { ok: false, value: json({ ok: true }, 200) };
    }
    const draft = latest._status === "draft";
    await payload.update({
      collection: "articles",
      id: articleId,
      req: lk.req,
      overrideAccess: true,
      // systemWrite: bookkeeping (version / lastEditedBy) unchanged; skipTranslationEnqueue: an
      // unpin changes no content; disableRevalidate: `pinnedUntil` is enforced at READ time by
      // the public articles route (see the scope note in src/app/api/cron/unpin-expired/route.ts).
      context: { systemWrite: true, skipTranslationEnqueue: true, disableRevalidate: true },
      data: { pinnedToLatest: false, pinnedUntil: null } as never,
      // Draft-safe sweep: a non-draft update base-merges from the LATEST version, so a pending
      // draft would be published as a side effect; sweep the draft surface instead.
      draft,
    });
    outcome = { kind: "unpinned", draft, pinnedUntil: latest.pinnedUntil };
    return { ok: true, value: json({ ok: true }, 200) };
  });
  if (res.status === 503) return { kind: "skipped", reason: "busy" };
  return outcome;
}
