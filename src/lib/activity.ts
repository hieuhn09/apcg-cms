/**
 * logActivity — single entry point for writing the append-only ActivityLog. Used
 * by hooks and route handlers so the monitoring event stream is consistent and
 * easy to disable in tests. Never throws into the caller (logging must not break
 * a write); failures are logged and swallowed.
 */

import type { Payload } from "payload";
import type { ActivityEvent } from "@/lib/constants";

export interface ActivityInput {
  payload: Payload;
  eventType: ActivityEvent;
  tenantId?: number | string | null;
  actorType: "human" | "engine" | "system";
  actorUserId?: number | string | null;
  actorEngineId?: number | string | null;
  targetCollection?: string;
  targetId?: number | string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: Record<string, unknown>;
}

export async function logActivity(input: ActivityInput): Promise<void> {
  const {
    payload,
    eventType,
    tenantId,
    actorType,
    actorUserId,
    actorEngineId,
    targetCollection,
    targetId,
    fromStatus,
    toStatus,
    detail,
  } = input;
  try {
    await payload.create({
      collection: "activityLog",
      overrideAccess: true,
      data: {
        eventType,
        tenant: tenantId ?? undefined,
        actorType,
        actorUser: actorUserId ?? undefined,
        actorEngine: actorEngineId ?? undefined,
        targetCollection,
        targetId: targetId != null ? String(targetId) : undefined,
        fromStatus: fromStatus ?? undefined,
        toStatus: toStatus ?? undefined,
        detail: detail ?? undefined,
      },
    });
  } catch (err) {
    payload.logger.error(
      `[activity] failed to log ${eventType}: ${(err as Error).message}`,
    );
  }
}
