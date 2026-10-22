/**
 * Read-only Central lookups shared by the VowAsia phase-B tools. Every lookup
 * carries tenant `vowasia` (another tenant's look-alike rows are never used).
 *
 * Taxonomy presence (Amendment 4 §4.3 step 2, C13): before any write, and in
 * dry-run too, tenant `vowasia` must hold the 5 C8 pillars, the 17 target
 * sub-sections (each under its own pillar), the 4 tags Q10 uses and the 6
 * authors (by name AND slug, E5). Anything missing -> STOP with the full list.
 * The importer never creates taxonomy or authors.
 */
import { VOWASIA_AUTHORS } from "../../../lib/vowasia-taxonomy";
import { MARKER_ORIGIN, MARKER_SOURCE_NAME, TENANT_SLUG } from "./vowasia-constants";
import { C8_LEGACY_PAIRS, C8_PILLARS, C8_SUBSECTION_RENAMES } from "./vowasia-mapping";
import { findAll, findOne, relId, type CentralPort, type Doc, type Id } from "./vowasia-port";
import { TAG_BY_SUBSECTION } from "./vowasia-transform";

export class TaxonomyStop extends Error {
  override name = "TaxonomyStop";
}

/** The 17 C8 target sub-sections as `pillar/sub-section`. */
export function requiredSubSections(): string[] {
  const out: string[] = [];
  for (const p of C8_PILLARS) {
    for (const legacy of C8_LEGACY_PAIRS[p]) {
      const target = Object.prototype.hasOwnProperty.call(C8_SUBSECTION_RENAMES, legacy) ? (C8_SUBSECTION_RENAMES[legacy] as string) : legacy;
      out.push(`${p}/${target}`);
    }
  }
  return out;
}

export const REQUIRED_TAGS: readonly string[] = Object.freeze([...new Set(Object.values(TAG_BY_SUBSECTION))].sort());

export interface CentralTaxonomy {
  tenantId: Id;
  pillarId: Map<string, Id>;
  /** key `pillar/sub-section` */
  subId: Map<string, Id>;
  tagId: Map<string, Id>;
  /** author name -> id */
  authorId: Map<string, Id>;
}

export async function loadTenantId(port: CentralPort): Promise<Id> {
  const t = await findOne(port, "tenants", { slug: { equals: TENANT_SLUG } });
  if (!t) throw new TaxonomyStop(`taxonomy: tenant ${TENANT_SLUG} not found in Central (created by hand in /admin, OB1); STOP, nothing written.`);
  return t.id as Id;
}

export async function checkTaxonomy(port: CentralPort, tenantId: Id): Promise<CentralTaxonomy> {
  const missing: string[] = [];
  const tenant = { tenant: { equals: tenantId } };
  const pillars = await findAll(port, "pillars", tenant);
  const pillarId = new Map(pillars.map((p) => [String(p.slug), p.id as Id]));
  const pillarSlugById = new Map(pillars.map((p) => [String(p.id), String(p.slug)]));
  for (const p of C8_PILLARS) if (!pillarId.has(p)) missing.push(`pillar ${p}`);
  const subId = new Map<string, Id>();
  for (const s of await findAll(port, "subsections", tenant)) subId.set(`${pillarSlugById.get(relId(s.pillar) ?? "") ?? "?"}/${String(s.slug)}`, s.id as Id);
  for (const k of requiredSubSections()) if (!subId.has(k)) missing.push(`sub-section ${k}`);
  const tagId = new Map((await findAll(port, "tags", tenant)).map((t) => [String(t.slug), t.id as Id]));
  for (const t of REQUIRED_TAGS) if (!tagId.has(t)) missing.push(`tag ${t}`);
  const authorId = new Map<string, Id>();
  for (const a of VOWASIA_AUTHORS) {
    const doc = await findOne(port, "authors", { and: [tenant, { name: { equals: a.name } }, { slug: { equals: a.slug } }] });
    if (!doc) missing.push(`author ${a.name} (${a.slug})`);
    else authorId.set(a.name, doc.id as Id);
  }
  if (missing.length) throw new TaxonomyStop(`taxonomy: tenant ${TENANT_SLUG} is missing ${missing.length} required row(s): ${missing.join("; ")}. Run OB1 (audit:add-vowasia-taxonomy) first; the importer never creates taxonomy or authors. STOP, nothing written.`);
  return { tenantId, pillarId, subId, tagId, authorId };
}

export function isMarker(d: Doc): boolean {
  return d.origin === MARKER_ORIGIN && d.engineSourceName === MARKER_SOURCE_NAME;
}

/** Every tenant-vowasia article (all statuses, draft versions included), slug + marker flag. */
export async function tenantArticles(port: CentralPort, tenantId: Id): Promise<Doc[]> {
  return findAll(port, "articles", { tenant: { equals: tenantId } }, { draft: true });
}

export async function markerArticles(port: CentralPort, tenantId: Id): Promise<Doc[]> {
  return findAll(port, "articles", { and: [{ tenant: { equals: tenantId } }, { origin: { equals: MARKER_ORIGIN } }, { engineSourceName: { equals: MARKER_SOURCE_NAME } }] }, { draft: true });
}
