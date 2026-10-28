/**
 * AsiaMaterialsBrief (tenant `amb`) legacy exhibition booths: the six
 * `amb_booths` rows of the old site (read-only inspection 27-10-26,
 * `scripts/migrate/network/sql/01b-inspect-amb-booths.sql`), embedded as data,
 * plus the PURE mapping onto Central's `booths` collection
 * (src/collections/Booths.ts). Used by the OWNER-RUN
 * `scripts/audit/add-amb-booths.ts`. No Payload import: unit-tested by
 * `scripts/lib/amb-legacy-booths.test.ts` (npm run test:booths).
 *
 * The rows are public company information compiled by the old site from each
 * company's own website (`source_url`); they hold no personal data. The one
 * legacy booth APPLICATION (it has personal contact data) is NOT here and is
 * not migrated (owner, 27/28-10-26).
 *
 * Owner-approved mapping (27/28-10-26):
 *   - all six are created with the legacy `slug` kept (so `/exhibition/<slug>`
 *     survives) and `published: true`;
 *   - hall: legacy `studios` -> `design-studios`; `services`, `brands`,
 *     `manufacturers` unchanged (must be in BOOTH_HALLS_BY_TENANT.amb);
 *   - `tier: "basic"`, `verified: false` for all;
 *   - content: name, summary, typeLine (derived: the first two categories,
 *     sentence case, joined with " & "), city, country, one capabilities row
 *     (category = categories joined ", "; formats = project_types joined ", "
 *     when non-empty; moq / leadTime = legacy values, null left empty),
 *     atAGlance (founded, employees, certifications joined, marketsServed
 *     joined), website, about = Lexical doc with the legacy `capabilities`
 *     paragraph and, when present, the `notable_projects` paragraph;
 *   - no logo, no catalog, no inquiryEmail (the site falls back to info@), no
 *     related articles.
 */
import { AMB_BOOTH_HALLS, type BoothHall } from "../../src/lib/booth-halls";

export const AMB_BOOTHS_TENANT_SLUG = "amb";

/** One legacy `amb_booths` row, exactly as the old site stored it. */
export interface AmbLegacyBooth {
  slug: string;
  name: string;
  hall: "studios" | "services" | "brands" | "manufacturers";
  city: string | null;
  country: string | null;
  country_code: string | null;
  founded: string | null;
  employees: string | null;
  moq: string | null;
  lead_time: string | null;
  summary: string | null;
  website: string | null;
  categories: string[];
  capabilities: string | null;
  project_types: string[];
  certifications: string[];
  markets_served: string[];
  notable_projects: string | null;
  tier: string;
  active: boolean;
  verified_at: string | null;
  source_url: string | null;
  profile_checked_at: string | null;
}

export const AMB_LEGACY_BOOTHS: readonly AmbLegacyBooth[] = [
  {
    slug: "neri-and-hu",
    name: "Neri&Hu Design and Research Office",
    hall: "studios",
    city: "Shanghai",
    country: "China",
    country_code: "CN",
    founded: "2006",
    employees: null,
    moq: null,
    lead_time: null,
    summary: "Architecture and interior design practice working across master planning, interiors, furniture and graphics",
    website: "https://www.neriandhu.com/en",
    categories: ["architecture", "interior design", "furniture design", "branding"],
    capabilities:
      "An inter-disciplinary practice based in Shanghai, working across master planning and architecture, interior design, installation, furniture, product, branding and graphic work. The studio states that its staff speak over 30 different languages.",
    project_types: ["master planning", "architecture", "interior design", "installations", "exhibitions"],
    certifications: [],
    markets_served: [],
    notable_projects: null,
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://www.neriandhu.com/en/about",
    profile_checked_at: "2026-08-09",
  },
  {
    slug: "takenaka-asia",
    name: "Takenaka Corporation",
    hall: "services",
    city: "Bangkok",
    country: "Japan",
    country_code: "JP",
    founded: null,
    employees: null,
    moq: null,
    lead_time: null,
    summary: "Design-build, project management and interior fit-out across seven Asian markets",
    website: "https://takenaka.asia/",
    categories: ["design-build", "interior fit-out", "project management", "special engineering"],
    capabilities:
      "Provides design, design-build, project/program and construction management, special engineering, and interior fitting-out works. The Asia site lists offices in Singapore, Thailand, Indonesia, India, Myanmar, Malaysia and Vietnam.",
    project_types: ["commercial", "retail", "hospitality", "industrial"],
    certifications: [],
    markets_served: ["Singapore", "Thailand", "Indonesia", "India", "Myanmar", "Malaysia", "Vietnam"],
    notable_projects:
      "Named on the company site: Singapore National Gallery, Amada Bangalore Technical Centre (India), Cikarang Hotel Residences Phase 2 (Indonesia), Mitsubishi Electric Thai Auto-Part (Thailand), Aeon Tebrau City Extension (Malaysia).",
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://takenaka.asia/",
    profile_checked_at: "2026-08-10",
  },
  {
    slug: "richards-prestige-lighting",
    name: "Richard's Prestige Lighting & Design",
    hall: "brands",
    city: "Kuala Lumpur",
    country: "Malaysia",
    country_code: "MY",
    founded: "1988",
    employees: null,
    moq: null,
    lead_time: null,
    summary: "Custom decorative lighting for hospitality and palace interiors",
    website: "https://rpldmalaysia.com/",
    categories: ["decorative lighting", "custom fixtures", "chandeliers"],
    capabilities:
      "Makes custom decorative lighting fixtures. The company describes itself as one of the largest custom decorative lighting manufacturers in the Asia-Pacific. Founded 1988 by Dato Richard Teo; address given as 17, Menara HLX, Kuala Lumpur.",
    project_types: ["hospitality", "palaces", "residential"],
    certifications: [],
    markets_served: [],
    notable_projects:
      "Named on the company site: National Palace (Malaysia), Syarqiyyah Palace (Terengganu), Four Seasons Doha (Qatar), Mia Saigon (Vietnam), Flintstones Palace (Johor).",
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://rpldmalaysia.com/",
    profile_checked_at: "2026-08-10",
  },
  {
    slug: "tran-duc-furnishings",
    name: "Tran Duc Furnishings",
    hall: "manufacturers",
    city: "Binh Duong",
    country: "Vietnam",
    country_code: "VN",
    founded: "2001",
    employees: "2,000+",
    moq: null,
    lead_time: null,
    summary: "Hospitality casegoods, metal and upholstered furniture for hotel projects",
    website: "https://tranducfurnishings.com/",
    categories: ["casegoods", "upholstered seating", "metal furniture", "doors"],
    capabilities:
      "Two factories totalling 120,000 m² in Binh Duong province, about 50 minutes from Ho Chi Minh City airport. The company states an export capacity of 240 containers per month and more than 2,000 employees, with in-house wood, veneer, metal, upholstery and finishing lines. It describes itself as a one-stop supplier to the hospitality industry.",
    project_types: [],
    certifications: [],
    markets_served: ["United States", "Europe", "Middle East"],
    notable_projects: "The company states more than 500 completed projects.",
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://tranducfurnishings.com/",
    profile_checked_at: "2026-08-09",
  },
  {
    slug: "naffaro-dawood-indofurni",
    name: "Naffaro Dawood Indofurni",
    hall: "manufacturers",
    city: "Jepara",
    country: "Indonesia",
    country_code: "ID",
    founded: "2008",
    employees: null,
    moq: null,
    lead_time: null,
    summary: "Solid teak and mahogany indoor and outdoor furniture",
    website: "https://www.dawood-indonesia.com/",
    categories: ["outdoor furniture", "casegoods", "teak furniture"],
    capabilities:
      "Manufactures solid teak indoor and outdoor furniture, including living, bedroom, dining and kitchen sets, garden chairs, tables, benches and loungers, in teak, mahogany and other timbers. The company states that all timber is cultivated from government-certified plantations controlled by Perhutani State Forestry. Office in Bekasi, West Java; warehouse in Jepara.",
    project_types: [],
    certifications: ["SVLK"],
    markets_served: [],
    notable_projects: null,
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://www.dawood-indonesia.com/",
    profile_checked_at: "2026-08-09",
  },
  {
    slug: "boho",
    name: "BOHO",
    hall: "manufacturers",
    city: "Ho Chi Minh City",
    country: "Vietnam",
    country_code: "VN",
    founded: null,
    employees: null,
    moq: null,
    lead_time: null,
    summary: "Interior design, construction and furniture manufacturing",
    website: "https://boho.vn/en/",
    categories: ["interior fit-out", "casegoods", "sofas", "doors"],
    capabilities:
      "Provides interior design, construction and furniture manufacturing, with offices in Ha Noi and Ho Chi Minh City and a facility in Tan Duc Industrial Park, Tay Ninh. Operates the member brands NOTAG (retail furniture) and ODDII (interior design).",
    project_types: [],
    certifications: [],
    markets_served: [],
    notable_projects: null,
    tier: "basic",
    active: true,
    verified_at: null,
    source_url: "https://boho.vn/en/",
    profile_checked_at: "2026-08-09",
  },
];

/** Legacy hall -> Central `booths.hall` value (owner 27/28-10-26). */
export const AMB_LEGACY_HALL_MAP: Readonly<Record<AmbLegacyBooth["hall"], BoothHall>> = {
  studios: "design-studios",
  services: "services",
  brands: "brands",
  manufacturers: "manufacturers",
};

/* ── Lexical (minimal valid doc: root > paragraph > text, the shape the abb probe stores) ── */

export interface LexicalText {
  type: "text";
  version: 1;
  text: string;
  format: 0;
  detail: 0;
  mode: "normal";
  style: "";
}
export interface LexicalParagraph {
  type: "paragraph";
  version: 1;
  direction: null;
  format: "";
  indent: 0;
  textFormat: 0;
  children: LexicalText[];
}
export interface LexicalDoc {
  root: { type: "root"; version: 1; direction: null; format: ""; indent: 0; children: LexicalParagraph[] };
}

export function lexicalParagraphs(texts: readonly string[]): LexicalDoc | undefined {
  const kept = texts.map((t) => t.trim()).filter((t) => t !== "");
  if (!kept.length) return undefined;
  return {
    root: {
      type: "root",
      version: 1,
      direction: null,
      format: "",
      indent: 0,
      children: kept.map((text) => ({
        type: "paragraph",
        version: 1,
        direction: null,
        format: "",
        indent: 0,
        textFormat: 0,
        children: [{ type: "text", version: 1, text, format: 0, detail: 0, mode: "normal", style: "" }],
      })),
    },
  };
}

/* ── Mapping ─────────────────────────────────────────────────────────────── */

/** Booths data for one legacy row, WITHOUT `tenant` (the script adds the tenant id). */
export interface AmbBoothData {
  slug: string;
  name: string;
  published: true;
  hall: BoothHall;
  tier: "basic";
  verified: false;
  typeLine?: string;
  city?: string;
  country?: string;
  summary?: string;
  about?: LexicalDoc;
  capabilities?: Array<{ category?: string; formats?: string; moq?: string; leadTime?: string }>;
  atAGlance?: { founded?: string; employees?: string; certifications?: string; marketsServed?: string };
  website?: string;
}

const text = (v: string | null | undefined): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? undefined : t;
};
const joined = (xs: readonly string[] | null | undefined): string | undefined =>
  text((xs ?? []).map((x) => x.trim()).filter((x) => x !== "").join(", "));
const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Short factual type line: the first two categories, sentence case, joined with " & ". */
export function deriveTypeLine(categories: readonly string[]): string | undefined {
  const two = categories.map((c) => c.trim()).filter((c) => c !== "").slice(0, 2);
  return two.length ? sentenceCase(two.join(" & ")) : undefined;
}

/** Drop keys whose value is undefined (so empty legacy values leave the field empty). */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function mapAmbLegacyBooth(row: AmbLegacyBooth): AmbBoothData {
  const hall = AMB_LEGACY_HALL_MAP[row.hall];
  if (!hall) throw new Error(`booth ${row.slug}: unknown legacy hall "${String(row.hall)}"`);
  const cap = compact({
    category: joined(row.categories),
    formats: joined(row.project_types),
    moq: text(row.moq),
    leadTime: text(row.lead_time),
  });
  const glance = compact({
    founded: text(row.founded),
    employees: text(row.employees),
    certifications: joined(row.certifications),
    marketsServed: joined(row.markets_served),
  });
  return compact({
    slug: row.slug,
    name: row.name.trim(),
    published: true as const,
    hall,
    tier: "basic" as const,
    verified: false as const,
    typeLine: deriveTypeLine(row.categories),
    city: text(row.city),
    country: text(row.country),
    summary: text(row.summary),
    about: lexicalParagraphs([row.capabilities ?? "", row.notable_projects ?? ""]),
    capabilities: Object.keys(cap).length ? [cap] : undefined,
    atAGlance: Object.keys(glance).length ? glance : undefined,
    website: text(row.website),
  });
}

/** Problems with the embedded rows (empty list = valid). */
export function validateAmbLegacyBooths(rows: readonly AmbLegacyBooth[] = AMB_LEGACY_BOOTHS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.slug)) problems.push(`booth ${r.slug}: slug is not kebab-case`);
    if (seen.has(r.slug)) problems.push(`booth ${r.slug}: duplicate slug`);
    seen.add(r.slug);
    if (!text(r.name)) problems.push(`booth ${r.slug}: name is empty`);
    const hall = AMB_LEGACY_HALL_MAP[r.hall];
    if (!hall) problems.push(`booth ${r.slug}: unknown legacy hall "${String(r.hall)}"`);
    else if (!AMB_BOOTH_HALLS.includes(hall)) problems.push(`booth ${r.slug}: hall "${hall}" is not an amb hall`);
    if (r.website !== null && !/^https:\/\//.test(r.website)) problems.push(`booth ${r.slug}: website is not https`);
  }
  return problems;
}

export type AmbBoothPlanItem = { slug: string; action: "create" | "exists"; data: AmbBoothData };

/** create / exists plan, matched by slug within tenant amb (existing rows are never overwritten). */
export function planAmbBooths(existingSlugs: Iterable<string>, rows: readonly AmbLegacyBooth[] = AMB_LEGACY_BOOTHS): AmbBoothPlanItem[] {
  const have = new Set(existingSlugs);
  return rows.map((r) => ({ slug: r.slug, action: have.has(r.slug) ? "exists" : "create", data: mapAmbLegacyBooth(r) }));
}

/** Distinct Central hall values the rows need (for the enum preflight). */
export function hallsNeeded(rows: readonly AmbLegacyBooth[] = AMB_LEGACY_BOOTHS): BoothHall[] {
  return [...new Set(rows.map((r) => AMB_LEGACY_HALL_MAP[r.hall]))];
}
