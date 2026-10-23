/** Tenant-scoped media lookup for the public booths API (url / alt / filename only). */
import type { Payload } from "payload";
import { scopedFind } from "@/lib/scoped";
import type { MediaMap } from "@/lib/public-booths";

export async function loadBoothMedia(payload: Payload, tenantId: number | string, ids: (string | number)[]): Promise<MediaMap> {
  const map: MediaMap = new Map();
  if (!ids.length) return map;
  const res = await scopedFind({ payload, collection: "media", tenantId, where: { id: { in: ids } }, limit: ids.length, depth: 0 });
  for (const m of res.docs as unknown as Array<Record<string, unknown>>) {
    map.set(String(m.id), {
      url: typeof m.url === "string" ? m.url : null,
      alt: typeof m.alt === "string" ? m.alt : null,
      filename: typeof m.filename === "string" ? m.filename : null,
    });
  }
  return map;
}
