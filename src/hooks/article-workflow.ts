/**
 * Article workflow + provenance enforcement — the real implementation of what
 * brief-asia left aspirational ("Phase E4 … once live").
 *
 *   beforeValidate: status authority — a contributor without publish rights may
 *     only target draft / pending_review; only editor+ may set published/scheduled.
 *   beforeChange: bookkeeping — bump `version` on every write; flip
 *     `editedByHuman = true` on human writes (req.user present); record engine
 *     provenance on engine writes (context.engineWrite); mark stale translations
 *     when source content changes.
 *   afterChange: write the ActivityLog event stream (create / publish / status).
 *
 * The per-field NO-OVERWRITE enforcement (locked fields, human-edited content)
 * lives in the engine intake handler, which inspects `lockedFields` /
 * `editedByHuman` BEFORE building the update payload (see src/app/api/engine/intake).
 * This hook handles the bookkeeping side that must hold for ALL writes.
 */

import type {
  CollectionBeforeChangeHook,
  CollectionBeforeValidateHook,
  CollectionAfterChangeHook,
} from "payload";
import {
  CONTRIBUTOR_ALLOWED_STATUSES,
  PROTECTED_TRANSLATION_STATES,
  type ArticleStatus,
} from "@/lib/constants";
import { canPublishInTenant, isSystemAdmin, membershipForTenant, toId } from "@/access/helpers";
import { logActivity } from "@/lib/activity";

interface EngineContext {
  engineWrite?: boolean;
  engineId?: number | string;
  processingVersion?: string;
}

function engineCtx(context: unknown): EngineContext {
  return (context as EngineContext | undefined) ?? {};
}

/** Status the article is moving to (or current). */
function statusOf(data: Record<string, unknown>, fallback?: unknown): ArticleStatus | undefined {
  const v = (data.workflowStatus ?? fallback) as ArticleStatus | undefined;
  return v;
}

export const enforceStatusAuthority: CollectionBeforeValidateHook = ({
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data;
  if (isSystemAdmin(req)) return data;
  // Engine writes (no req.user) are governed by the intake handler, not here.
  if (!req.user) return data;

  const next = statusOf(data, originalDoc?.workflowStatus);
  if (!next) return data;

  const tenantId = toId(data.tenant ?? originalDoc?.tenant);
  const m = membershipForTenant(req, tenantId);
  if (!m) return data; // no membership → other access rules will deny

  const roles = m.roles ?? [];
  const isContributor =
    roles.includes("contributor") && !roles.includes("editor") && !roles.includes("websiteAdmin");

  if (isContributor && !canPublishInTenant(req, tenantId)) {
    if (!CONTRIBUTOR_ALLOWED_STATUSES.includes(next)) {
      throw new Error(
        `Contributors without publish rights may only set status to ${CONTRIBUTOR_ALLOWED_STATUSES.join(" or ")}.`,
      );
    }
  }
  return data;
};

export const articleBookkeeping: CollectionBeforeChangeHook = ({
  data,
  originalDoc,
  req,
  operation,
}) => {
  // Translation writes touch one locale's content + the status sidecar only;
  // they must NOT bump version, flip editedByHuman, or mark siblings outdated.
  if ((req.context as { translationWrite?: boolean })?.translationWrite) return data;

  const ctx = engineCtx(req.context);
  const isHuman = Boolean(req.user);

  // version monotonic counter (optimistic lock)
  const prevVersion = typeof originalDoc?.version === "number" ? originalDoc.version : 0;
  data.version = prevVersion + 1;

  if (isHuman) {
    data.editedByHuman = true;
    data.lastEditedBy = req.user?.id;
  } else if (ctx.engineWrite) {
    // engine write: never flip editedByHuman; stamp provenance
    if (operation === "create") data.editedByHuman = false;
    if (ctx.engineId != null) data.lastEngine = ctx.engineId;
    if (ctx.processingVersion) data.processingVersion = ctx.processingVersion;
  }

  // translation stale-on-source-change: if a content field changed, flag every
  // non-protected target translation as outdated (best-effort; the translation
  // engine re-checks state before writing).
  const contentChanged =
    operation === "update" &&
    (data.title !== originalDoc?.title ||
      data.dek !== originalDoc?.dek ||
      JSON.stringify(data.body) !== JSON.stringify(originalDoc?.body));
  if (contentChanged && Array.isArray(data.translationStatus)) {
    data.translationStatus = (data.translationStatus as Array<Record<string, unknown>>).map(
      (row) => {
        const state = row.state as string;
        if (PROTECTED_TRANSLATION_STATES.includes(state as never)) return row;
        if (state === "none" || state === "pending") return row;
        return { ...row, state: "outdated" };
      },
    );
  }

  return data;
};

export const articleActivity: CollectionAfterChangeHook = async ({
  doc,
  previousDoc,
  req,
  operation,
}) => {
  const ctx = engineCtx(req.context);
  const actorType = req.user ? "human" : ctx.engineWrite ? "engine" : "system";
  const tenantId = toId(doc.tenant);

  const prev = previousDoc?.workflowStatus as string | undefined;
  const next = doc.workflowStatus as string | undefined;

  if (operation === "create") {
    await logActivity({
      payload: req.payload,
      eventType: "article_created",
      tenantId,
      actorType,
      actorUserId: req.user?.id ?? null,
      actorEngineId: ctx.engineId ?? null,
      targetCollection: "articles",
      targetId: doc.id,
      toStatus: next,
    });
  } else if (prev !== next) {
    await logActivity({
      payload: req.payload,
      eventType:
        next === "published"
          ? "article_published"
          : next === "archived"
            ? "article_archived"
            : prev === "published" && next !== "published"
              ? "article_unpublished"
              : "status_changed",
      tenantId,
      actorType,
      actorUserId: req.user?.id ?? null,
      actorEngineId: ctx.engineId ?? null,
      targetCollection: "articles",
      targetId: doc.id,
      fromStatus: prev,
      toStatus: next,
    });
  }
  return doc;
};
