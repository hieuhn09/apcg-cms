/**
 * Exhibition halls of the `booths` collection (feature `exhibition`), shared by
 * every title that runs a directory: AsiaBeautyBrief "The Beauty Exhibition"
 * (abb launch, 22-10-26) and AsiaMaterialsBrief "The Exhibition" (amb launch
 * W2, 27-10-26). PURE module (no Payload): the select options, the per-tenant
 * allowlist and the decision used by the `hall` field validate in
 * src/collections/Booths.ts.
 *
 * `BOOTH_HALLS` values are a Postgres enum (`enum_booths_hall`): adding a value
 * needs a migration (20261022 created six, 20261027 added four), and a value is
 * never renamed or removed. Labels are admin-only (not stored), so they may
 * change freely. Values whose meaning matches are shared between tenants
 * (`manufacturers`, `services`).
 */
export const BOOTH_HALLS = [
  { label: "Manufacturers (OEM/ODM) & Factories", value: "manufacturers" },
  { label: "Ingredients & Fragrance (AsiaBeautyBrief)", value: "ingredients-fragrance" },
  { label: "Packaging & Machinery (AsiaBeautyBrief)", value: "packaging-machinery" },
  { label: "Brands for Distribution (AsiaBeautyBrief)", value: "brands-for-distribution" },
  { label: "Distributors & Retail (AsiaBeautyBrief)", value: "distributors-retail" },
  { label: "Services", value: "services" },
  { label: "Brands (AsiaMaterialsBrief)", value: "brands" },
  { label: "Design Studios (AsiaMaterialsBrief)", value: "design-studios" },
  { label: "Distributors & Showrooms (AsiaMaterialsBrief)", value: "distributors-showrooms" },
  { label: "Country Pavilions (AsiaMaterialsBrief)", value: "country-pavilions" },
] as const;

export type BoothHall = (typeof BOOTH_HALLS)[number]["value"];

/** AsiaBeautyBrief halls, in the website's order (mirrors ABB_EXHIBITION_HALLS in scripts/lib/abb-taxonomy.ts). */
export const ABB_BOOTH_HALLS: readonly BoothHall[] = [
  "manufacturers",
  "ingredients-fragrance",
  "packaging-machinery",
  "brands-for-distribution",
  "distributors-retail",
  "services",
];

/**
 * AsiaMaterialsBrief halls, in the website's order: Hall 01 Manufacturers &
 * Factories, 02 Brands, 03 Design Studios, 04 Distributors & Showrooms,
 * 05 Services, 06 Country Pavilions (mirrors AMB_EXHIBITION_HALLS in
 * scripts/lib/amb-taxonomy.ts).
 */
export const AMB_BOOTH_HALLS: readonly BoothHall[] = [
  "manufacturers",
  "brands",
  "design-studios",
  "distributors-showrooms",
  "services",
  "country-pavilions",
];

/** Tenant slug -> halls a booth of that tenant may use. A tenant absent from the map may use every hall. */
export const BOOTH_HALLS_BY_TENANT: Readonly<Record<string, readonly BoothHall[]>> = {
  abb: ABB_BOOTH_HALLS,
  amb: AMB_BOOTH_HALLS,
};

/**
 * `true` when `hall` is allowed for the tenant, else the error message shown in
 * admin. An empty hall (the field is optional) and a tenant without an
 * allowlist always pass.
 */
export function boothHallDecision(tenantSlug: string | null | undefined, hall: unknown): true | string {
  if (hall === null || hall === undefined || hall === "") return true;
  if (!tenantSlug) return true;
  const allowed = Object.prototype.hasOwnProperty.call(BOOTH_HALLS_BY_TENANT, tenantSlug) ? BOOTH_HALLS_BY_TENANT[tenantSlug] : undefined;
  if (!allowed) return true;
  if (typeof hall === "string" && (allowed as readonly string[]).includes(hall)) return true;
  return `Hall "${String(hall)}" is not a hall of this title (${tenantSlug}). Allowed: ${allowed.join(", ")}.`;
}
