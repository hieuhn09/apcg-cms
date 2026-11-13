/**
 * Pure shaping helpers for the public booths API (`/api/public/booths*`,
 * AsiaBeautyBrief "The Beauty Exhibition"). ALLOWLIST by construction: a
 * response object is BUILT field by field from the stored doc, so tenant,
 * published, articles, timestamps and any future internal field never reach
 * the public JSON. No Payload import, so it is unit-testable with node:test.
 */

export type MediaRef = { url: string | null; alt: string | null; filename: string | null };
export type MediaMap = Map<string, MediaRef>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean => v === true;

/** Id of a depth-0 upload/relationship value (number, string, or populated object). */
export function refId(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") {
    const id = (v as { id?: unknown }).id;
    return id == null ? null : String(id);
  }
  return String(v);
}

export function mediaIdsOf(docs: Array<Record<string, unknown>>, fields: string[]): (string | number)[] {
  const out = new Set<string>();
  for (const d of docs) for (const f of fields) {
    const id = refId(d[f]);
    if (id) out.add(id);
  }
  return [...out];
}

function atAGlance(v: unknown) {
  const g = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    founded: str(g.founded),
    employees: str(g.employees),
    certifications: str(g.certifications),
    marketsServed: str(g.marketsServed),
    languages: str(g.languages),
  };
}

/** List-row shape (summary). */
export function boothSummary(doc: Record<string, unknown>, media: MediaMap) {
  const logo = media.get(refId(doc.logo) ?? "");
  return {
    slug: str(doc.slug),
    name: str(doc.name),
    hall: str(doc.hall),
    typeLine: str(doc.typeLine),
    city: str(doc.city),
    country: str(doc.country),
    verified: bool(doc.verified),
    tier: str(doc.tier) ?? "basic",
    summary: str(doc.summary),
    logo: logo ? { url: logo.url, alt: logo.alt } : null,
    atAGlance: { certifications: atAGlance(doc.atAGlance).certifications },
  };
}

/** Full-doc shape. `about` is the stored Lexical JSON, exactly as `/api/public/articles/:slug` returns `body`. */
export function boothDetail(doc: Record<string, unknown>, media: MediaMap) {
  const base = boothSummary(doc, media);
  const catalog = media.get(refId(doc.catalog) ?? "");
  const caps = Array.isArray(doc.capabilities) ? (doc.capabilities as Array<Record<string, unknown>>) : [];
  return {
    ...base,
    about: doc.about && typeof doc.about === "object" ? doc.about : null,
    capabilities: caps.map((c) => ({
      category: str(c.category),
      formats: str(c.formats),
      moq: str(c.moq),
      leadTime: str(c.leadTime),
    })),
    atAGlance: atAGlance(doc.atAGlance),
    catalog: catalog ? { url: catalog.url, filename: catalog.filename } : null,
    website: str(doc.website),
    inquiryEmail: str(doc.inquiryEmail),
  };
}

export const EMPTY_BOOTH_LIST = { docs: [], totalDocs: 0, page: 1, totalPages: 0, hasNextPage: false } as const;
