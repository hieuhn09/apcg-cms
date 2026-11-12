/**
 * INDEPENDENT recomputation of what the import should have produced
 * (gtp-launch P4, 7.9 item 2). Deliberately does NOT import the importer's
 * transforms (gtp-transform.ts), so a bug in one is not mirrored in the other.
 */
import type { Mapping } from "./gtp-mapping";

type Row = Record<string, unknown>;

export interface Expected {
  byStatus: Record<string, number>;
  rejected: string[];
  byPillar: Record<string, number>;
  bySub: Record<string, number>;
  sourceUrlById: Map<string, string | null>;
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * `publishedOnly` (gtp default, owner decision 10-11-26): legacy archived/draft rows are
 * expected to be absent from Central, counted with the rejected/skipped rows.
 */
export function expectedFromSource(rows: readonly Row[], m: Pick<Mapping, "status" | "categories">, opts: { publishedOnly?: boolean } = {}): Expected {
  const statusMap = new Map(Object.entries(m.status.map).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Expected = { byStatus: {}, rejected: [], byPillar: {}, bySub: {}, sourceUrlById: new Map() };
  for (const r of rows) {
    const raw = s(r.status).toLowerCase();
    const target = statusMap.get(raw) ?? (m.status.unknown === "draft" ? "draft" : m.status.unknown === "SKIP" ? "SKIP" : "REJECT");
    if (target === "SKIP" || target === "REJECT" || (opts.publishedOnly && target !== "published")) {
      out.rejected.push(String(r.id));
      continue;
    }
    const sec = s(r.section).toLowerCase();
    const sub = s(r.subsection).toLowerCase();
    if (!sec) {
      out.rejected.push(String(r.id));
      continue;
    }
    out.byStatus[target] = (out.byStatus[target] ?? 0) + 1;
    const o = m.categories.map[`${sec}/${sub}`] ?? (sub === "" ? m.categories.map[sec] : undefined) ?? m.categories.map[`${sec}/*`];
    const pillar = o ? o.pillar : sec;
    const subSection = o ? o.subSection ?? "" : sub;
    out.byPillar[pillar] = (out.byPillar[pillar] ?? 0) + 1;
    const sk = `${pillar}/${subSection}`;
    out.bySub[sk] = (out.bySub[sk] ?? 0) + 1;
    const u = s(r.source_url);
    out.sourceUrlById.set(String(r.id), u || null);
  }
  return out;
}
