/**
 * Loosely-typed Payload Local API wrappers for migration/seed scripts. The
 * generated collection types don't exist until `payload generate:types` runs and
 * scripts move data between schemas, so we intentionally relax typing here (and
 * ONLY here) rather than scattering casts. All calls use overrideAccess.
 */
import type { Payload } from "payload";

type AnyArgs = Record<string, unknown>;

export async function pFind(payload: Payload, collection: string, args: AnyArgs = {}) {
  return payload.find({ collection: collection as never, overrideAccess: true, depth: 0, ...args } as never);
}

export async function pCreate(payload: Payload, collection: string, data: AnyArgs, args: AnyArgs = {}) {
  return payload.create({ collection: collection as never, data: data as never, overrideAccess: true, ...args } as never);
}

export async function pUpdate(payload: Payload, collection: string, id: number | string, data: AnyArgs, args: AnyArgs = {}) {
  return payload.update({ collection: collection as never, id, data: data as never, overrideAccess: true, ...args } as never);
}
