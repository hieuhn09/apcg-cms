/**
 * Hub status transitions — the ONLY `workflowStatus` changes the hub write
 * route (`POST /api/hub/articles/{id}/status`, APCGHub P4 / CMS-3) may make.
 *
 *   "Ẩn" (hide)        published → archived
 *   "Đăng lại" (repub) hidden    → published   (article taken down natively in the CMS)
 *                      archived  → published   (article hidden by the hub)
 *
 * Hide writes `archived`, not `hidden`, on purpose (owner decision 25-09-26):
 * `syncNativePublish` (article-workflow.ts) revives a `hidden` article when a
 * human clicks Publish in /admin, but deliberately NOT an `archived` one — so a
 * hub-hidden article stays hidden until someone republishes it on purpose.
 *
 * Every other pair (incl. X → X, anything from/to draft, published → hidden,
 * hidden → archived) is rejected. Pure: no I/O, so it can be checked in isolation.
 */

import type { ArticleStatus } from "@/lib/constants";

/** Statuses the hub may ask for (`to` in the request body). */
export const HUB_TARGET_STATUSES = ["archived", "published"] as const;
export type HubTargetStatus = (typeof HUB_TARGET_STATUSES)[number];

const HUB_TRANSITIONS: Readonly<Partial<Record<ArticleStatus, readonly ArticleStatus[]>>> = {
  hidden: ["published"],
  archived: ["published"],
  published: ["archived"],
};

export function isHubTargetStatus(v: unknown): v is HubTargetStatus {
  return typeof v === "string" && (HUB_TARGET_STATUSES as readonly string[]).includes(v);
}

export function isValidTransition(from: ArticleStatus, to: ArticleStatus): boolean {
  return HUB_TRANSITIONS[from]?.includes(to) ?? false;
}
