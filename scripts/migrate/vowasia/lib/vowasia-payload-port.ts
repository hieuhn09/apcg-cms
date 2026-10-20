/**
 * The REAL CentralPort: the Payload Local API of this repo (overrideAccess, depth 0),
 * opened only by the phase-B CLI entry files (never by a unit test). Locale `en`
 * for every write (VowAsia supports `en` only). Media uploads go through Payload's
 * upload pipeline, so the R2 key prefix is set by Central's own hook (`prefix`).
 */
import { getPayload } from "payload";
import config from "../../../../payload.config";
import { pCreate, pDelete, pFind, pUpdate } from "../../../lib/payload-loose";
import type { CentralPort, Doc } from "./vowasia-port";

export async function openPayloadPort(): Promise<CentralPort> {
  const payload = await getPayload({ config });
  return {
    async find(collection, where, o = {}) {
      const r = (await pFind(payload, collection, {
        where,
        limit: o.limit ?? 10,
        ...(o.page ? { page: o.page } : {}),
        ...(o.sort ? { sort: o.sort } : {}),
        ...(o.draft ? { draft: true } : {}),
      })) as unknown as { docs: Doc[]; hasNextPage?: boolean; totalDocs?: number };
      return { docs: r.docs, hasNextPage: Boolean(r.hasNextPage), totalDocs: r.totalDocs };
    },
    async create(collection, data, o = {}) {
      return (await pCreate(payload, collection, data, {
        locale: "en",
        ...(o.context ? { context: o.context } : {}),
        ...(o.draft !== undefined ? { draft: o.draft } : {}),
        ...(o.file ? { file: o.file } : {}),
      })) as unknown as Doc;
    },
    async update(collection, id, data, o = {}) {
      return (await pUpdate(payload, collection, id, data, {
        locale: "en",
        ...(o.context ? { context: o.context } : {}),
        ...(o.draft !== undefined ? { draft: o.draft } : {}),
      })) as unknown as Doc;
    },
    async delete(collection, id, o = {}) {
      await pDelete(payload, collection, id, { ...(o.context ? { context: o.context } : {}) });
    },
  };
}
