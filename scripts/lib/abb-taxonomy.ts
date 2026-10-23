/**
 * AsiaBeautyBrief (tenant `abb`) taxonomy fixture: the SINGLE source of truth for
 * the abb pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-abb-taxonomy.ts` (owner script) and
 * `scripts/lib/abb-taxonomy.test.ts`. Mirrors `scripts/lib/vowasia-taxonomy.ts`
 * (abb launch, 22-10-26). PURE module: no Payload, no DB, no network; only
 * `src/lib/constants.ts` is imported.
 *
 * Source: the canonical ABB taxonomy JSON of the content-engine abb-launch task
 * folder (`abb-taxonomy_22-10-26.json`, from the approved AsiaBeautyBrief.html
 * design; design wins). The data is EMBEDDED here as TS; nothing reads that file
 * at runtime. American spelling as written in the design. Sub-section slugs are
 * the design slugs verbatim (NOT always the kebab-case of the title, e.g.
 * `science-of-beauty`). Tags are the design topic lists (57), each remembering
 * the pillar/sub-section it was listed under (informational; Tags has slug +
 * title only). The six Beauty Exhibition halls are the `hall` select options of
 * the `booths` collection (`ABB_EXHIBITION_HALLS`), not taxonomy rows.
 *
 * `engineWritable` and `singleHome` are DERIVED from ENGINE_BLOCKED_PILLARS.abb /
 * SINGLE_HOME_PILLARS.abb, never hand-typed. `pressroom` is the only single-home
 * and the only engine-blocked pillar (owner decision 22-10-26).
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const ABB_TENANT_SLUG = "abb";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface AbbPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface AbbSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
  description: string; // design copy, informational (SubSections has no description field)
}
export interface AbbNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface AbbAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface AbbTag {
  slug: string;
  title: string;
  pillar?: string; // informational: where the design lists the topic
  subSection?: string;
}
export interface AbbExhibitionHall {
  slug: string;
  title: string;
  description: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[ABB_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[ABB_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<AbbPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  { slug: "briefing", title: "Briefing", order: 1, description: "The day's business of Asian beauty, market moves, deals, regulation, and people, reported and checked by our newsroom." },
  { slug: "markets", title: "Markets", order: 2, description: "Asia's beauty markets, country by country, export machines, rising consumers, and the rules of each game." },
  { slug: "supply", title: "Supply Side", order: 3, description: "The factories, ingredient houses, and packaging plants behind the products, Asia's beauty supply chain, covered as news." },
  { slug: "trends", title: "Trends & Consumer", order: 4, description: "What consumers want next, decoded, trends read from the data, science explained without the jargon." },
  { slug: "professional", title: "Professional & Aesthetics", order: 5, description: "The business behind the treatment room, medical aesthetics, spas, and salons across Asia." },
  { slug: "pressroom", title: "Press Room", order: 6, description: "Announcements from the beauty industry, published in full and clearly labeled, separate from our editorial coverage." },
];

export const ABB_PILLARS: readonly AbbPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string, string]>): AbbSubSection[] =>
  rows.map(([slug, title, description], i) => ({ pillarSlug, slug, title, order: i + 1, description }));

/** All 22 sub-sections (pressroom has none: it is single-home). */
export const ABB_SUBSECTIONS: readonly AbbSubSection[] = [
  ...SUB("briefing", [
    ["market-moves", "Market Moves", "Brands, retailers, and platforms, who is launching, expanding, and winning shelf space across Asia."],
    ["deals-money", "Deals & Money", "M&A, funding, IPOs, and earnings, the capital flowing through Asian beauty."],
    ["policy-regulation", "Policy & Regulation", "The rule changes that move markets, checked against official sources."],
    ["people", "People", "Appointments, moves, and conversations with the people building Asian beauty."],
  ]),
  ...SUB("markets", [
    ["korea", "Korea", "The world's beauty export machine, an $11 billion export industry."],
    ["china", "China", "C-beauty's rise, the platforms that make markets, and the regulator that shapes them all."],
    ["japan", "Japan", "Heritage brands, quiet innovation, and a drugstore economy unlike anywhere else."],
    ["southeast-asia", "Southeast Asia", "The fastest-growing beauty region on earth, market by market."],
    ["india-south-asia", "India & South Asia", "A billion consumers meeting modern beauty."],
    ["global-lens", "Global Lens", "Asian beauty abroad, and global beauty in Asia."],
  ]),
  ...SUB("supply", [
    ["ingredients-actives", "Ingredients & Actives", "The molecules behind the marketing, new actives, fragrance, and the houses supplying them."],
    ["manufacturing-oem-odm", "Manufacturing & OEM/ODM", "Inside the plants that make the world's beauty products."],
    ["packaging", "Packaging", "The pack is the product: design, decoration, and the sustainability race."],
    ["beauty-tech", "Beauty Tech", "AI diagnostics, personalization, devices, and the technology changing how beauty is made and sold."],
    ["sustainability", "Sustainability", "ESG, compliance, refill, and recycling, where obligations meet opportunities."],
  ]),
  ...SUB("trends", [
    ["trend-radar", "Trend Radar", "What's moving on TikTok, Douyin, and Xiaohongshu, spotted early, sized honestly."],
    ["science-of-beauty", "The Science of Beauty", "Ingredients decoded and claims tested, what the science actually says."],
    ["new-noteworthy", "New & Noteworthy", "The launches worth knowing, chosen by editors who see hundreds."],
    ["beauty-culture", "Beauty Culture", "The culture behind the category."],
  ]),
  ...SUB("professional", [
    ["medical-aesthetics", "Medical Aesthetics", "Devices, injectables, and the clinic economy, covered with a business lens."],
    ["spa-wellness", "Spa & Wellness", "Hotel spas, retreats, and the brands that supply them, where beauty meets hospitality."],
    ["salon-business", "Salon Business", "Hair, nails, and the distribution networks behind every chair."],
  ]),
];

export const ABB_NEWSLETTERS: readonly AbbNewsletter[] = [
  { slug: "the-beauty-brief", name: "The Beauty Brief", cadence: "Weekly", description: "Asia's beauty week in five minutes, every Monday: the news that mattered, the deal to know, the rule that changed, and one thing worth reading slowly.", order: 1, active: true },
  { slug: "regulatory-radar", name: "Regulatory Radar", cadence: "Monthly", description: "The rule changes that move markets, monthly: what changed, where, who is affected, and by when.", order: 2, active: true },
  { slug: "trend-pulse", name: "Trend Pulse", cadence: "Twice a month", description: "What consumers want next, twice a month: the trends rising on Asia's platforms, the launches worth knowing, and the science behind the claims.", order: 3, active: true },
];

/**
 * Bylines (5, from the design). Must stay char-for-char identical to the
 * content-engine abb byline pool (intake matches `authors.name` with `equals`).
 * General roles; bios from the design; NO city/country on purpose.
 */
export const ABB_AUTHORS: readonly AbbAuthor[] = [
  { name: "Joanne Lau", slug: "joanne-lau", rank: 1, role: "Editor", bio: "Joanne Lau edits AsiaBeautyBrief and oversees its daily coverage of the business of beauty. Most days start with the overnight filings and end with the next morning's lead." },
  { name: "Kim Seo-yeon", slug: "kim-seo-yeon", rank: 2, role: "Senior Reporter", bio: "Kim Seo-yeon reports on brands, retailers and the deals that reshape them. Conversations with founders and buyers are where most of those stories begin." },
  { name: "Kavita Rao", slug: "kavita-rao", rank: 3, role: "Senior Writer", bio: "Kavita Rao writes features and analysis on where the beauty industry is heading. The work usually starts with a number that does not quite add up." },
  { name: "Emi Fujita", slug: "emi-fujita", rank: 4, role: "Contributing Editor", bio: "Emi Fujita contributes reporting on ingredients, formulation and the science behind product claims, with a habit of asking for the study behind the slogan." },
  { name: "Nathan Leong", slug: "nathan-leong", rank: 5, role: "Reporter", bio: "Nathan Leong covers the news desk, from launches and appointments to regulatory updates, and keeps the day's briefing moving." },
];

/** 57 topic tags from the design topic lists. */
export const ABB_TAGS: readonly AbbTag[] = [
  { slug: "brands-launches", title: "Brands & Launches", pillar: "briefing", subSection: "market-moves" },
  { slug: "retail-e-commerce", title: "Retail & E-commerce", pillar: "briefing", subSection: "market-moves" },
  { slug: "travel-retail-duty-free", title: "Travel Retail & Duty Free", pillar: "briefing", subSection: "market-moves" },
  { slug: "mergers-acquisitions", title: "M&A", pillar: "briefing", subSection: "deals-money" },
  { slug: "funding-ipo", title: "Funding & IPO", pillar: "briefing", subSection: "deals-money" },
  { slug: "earnings", title: "Earnings", pillar: "briefing", subSection: "deals-money" },
  { slug: "regulatory-radar-by-market", title: "Regulatory Radar by Market", pillar: "briefing", subSection: "policy-regulation" },
  { slug: "safety-recalls", title: "Safety & Recalls", pillar: "briefing", subSection: "policy-regulation" },
  { slug: "trade-tariffs", title: "Trade & Tariffs", pillar: "briefing", subSection: "policy-regulation" },
  { slug: "appointments", title: "Appointments", pillar: "briefing", subSection: "people" },
  { slug: "the-founder-brief", title: "The Founder Brief", pillar: "briefing", subSection: "people" },
  { slug: "k-beauty-export-watch", title: "K-beauty Export Watch", pillar: "markets", subSection: "korea" },
  { slug: "seoul-innovation", title: "Seoul Innovation", pillar: "markets", subSection: "korea" },
  { slug: "c-beauty-goes-global", title: "C-beauty Goes Global", pillar: "markets", subSection: "china" },
  { slug: "regulations-nmpa", title: "Regulations & NMPA", pillar: "markets", subSection: "china" },
  { slug: "douyin-tmall-watch", title: "Douyin & Tmall Watch", pillar: "markets", subSection: "china" },
  { slug: "j-beauty-heritage-brands", title: "J-beauty & Heritage Brands", pillar: "markets", subSection: "japan" },
  { slug: "drugstore-economy", title: "Drugstore Economy", pillar: "markets", subSection: "japan" },
  { slug: "indonesia", title: "Indonesia", pillar: "markets", subSection: "southeast-asia" },
  { slug: "thailand", title: "Thailand", pillar: "markets", subSection: "southeast-asia" },
  { slug: "vietnam", title: "Vietnam", pillar: "markets", subSection: "southeast-asia" },
  { slug: "philippines", title: "Philippines", pillar: "markets", subSection: "southeast-asia" },
  { slug: "singapore-malaysia-halal-beauty", title: "Singapore & Malaysia · Halal Beauty", pillar: "markets", subSection: "southeast-asia" },
  { slug: "india-d2c-boom", title: "India D2C Boom", pillar: "markets", subSection: "india-south-asia" },
  { slug: "ayurveda-modernized", title: "Ayurveda Modernized", pillar: "markets", subSection: "india-south-asia" },
  { slug: "asia-brands-abroad", title: "Asia Brands Abroad", pillar: "markets", subSection: "global-lens" },
  { slug: "global-brands-in-asia", title: "Global Brands in Asia", pillar: "markets", subSection: "global-lens" },
  { slug: "ingredient-spotlight", title: "Ingredient Spotlight", pillar: "supply", subSection: "ingredients-actives" },
  { slug: "fragrance-sensorial", title: "Fragrance & Sensorial", pillar: "supply", subSection: "ingredients-actives" },
  { slug: "naturals-fermentation", title: "Naturals & Fermentation", pillar: "supply", subSection: "ingredients-actives" },
  { slug: "inside-the-factory", title: "Inside the Factory", pillar: "supply", subSection: "manufacturing-oem-odm" },
  { slug: "formulation-trends", title: "Formulation Trends", pillar: "supply", subSection: "manufacturing-oem-odm" },
  { slug: "quality-certification", title: "Quality & Certification", pillar: "supply", subSection: "manufacturing-oem-odm" },
  { slug: "sustainable-packaging", title: "Sustainable Packaging", pillar: "supply", subSection: "packaging" },
  { slug: "design-decoration", title: "Design & Decoration", pillar: "supply", subSection: "packaging" },
  { slug: "ai-personalization", title: "AI & Personalization", pillar: "supply", subSection: "beauty-tech" },
  { slug: "devices", title: "Devices", pillar: "supply", subSection: "beauty-tech" },
  { slug: "beauty-retail-tech", title: "Beauty Retail Tech", pillar: "supply", subSection: "beauty-tech" },
  { slug: "esg-compliance", title: "ESG & Compliance", pillar: "supply", subSection: "sustainability" },
  { slug: "refill-recycle-economy", title: "Refill & Recycle Economy", pillar: "supply", subSection: "sustainability" },
  { slug: "social-beauty-watch", title: "Social Beauty Watch", pillar: "trends", subSection: "trend-radar" },
  { slug: "seasonal-cultural-trends", title: "Seasonal & Cultural Trends", pillar: "trends", subSection: "trend-radar" },
  { slug: "ingredient-decoder", title: "Ingredient Decoder", pillar: "trends", subSection: "science-of-beauty" },
  { slug: "derm-approved", title: "Derm-approved", pillar: "trends", subSection: "science-of-beauty" },
  { slug: "product-radar", title: "Product Radar", pillar: "trends", subSection: "new-noteworthy" },
  { slug: "editors-picks", title: "Editor's Picks", pillar: "trends", subSection: "new-noteworthy" },
  { slug: "k-beauty-culture", title: "K-beauty Culture", pillar: "trends", subSection: "beauty-culture" },
  { slug: "mens-grooming", title: "Men's Grooming", pillar: "trends", subSection: "beauty-culture" },
  { slug: "clean-wellness-crossover", title: "Clean & Wellness Crossover", pillar: "trends", subSection: "beauty-culture" },
  { slug: "devices-injectables", title: "Devices & Injectables", pillar: "professional", subSection: "medical-aesthetics" },
  { slug: "clinic-business", title: "Clinic Business", pillar: "professional", subSection: "medical-aesthetics" },
  { slug: "regulation-safety", title: "Regulation & Safety", pillar: "professional", subSection: "medical-aesthetics" },
  { slug: "hotel-resort-spas", title: "Hotel & Resort Spas", pillar: "professional", subSection: "spa-wellness" },
  { slug: "wellness-retreats", title: "Wellness Retreats", pillar: "professional", subSection: "spa-wellness" },
  { slug: "spa-product-brands", title: "Spa Product Brands", pillar: "professional", subSection: "spa-wellness" },
  { slug: "hair-nail-industry", title: "Hair & Nail Industry", pillar: "professional", subSection: "salon-business" },
  { slug: "distribution-education", title: "Distribution & Education", pillar: "professional", subSection: "salon-business" },
];

/** The six halls of The Beauty Exhibition (= `booths.hall` select options). */
export const ABB_EXHIBITION_HALLS: readonly AbbExhibitionHall[] = [
  { slug: "manufacturers", title: "Manufacturers (OEM/ODM)", description: "Contract manufacturers by country, capability, certification, and minimum order." },
  { slug: "ingredients-fragrance", title: "Ingredients & Fragrance", description: "Actives, raw materials, and fragrance houses." },
  { slug: "packaging-machinery", title: "Packaging & Machinery", description: "Packaging suppliers and production equipment." },
  { slug: "brands-for-distribution", title: "Brands for Distribution", description: "Brands seeking distributors, by market and category." },
  { slug: "distributors-retail", title: "Distributors & Retail", description: "Distributors and buyers open to new brands." },
  { slug: "services", title: "Services", description: "Testing, regulatory, logistics, agencies, and training." },
];

/** Tenant field sheet, as data (the owner enters it by hand in /admin; this file never creates the tenant). */
export const ABB_TENANT_FIELDS = {
  name: "AsiaBeautyBrief",
  slug: ABB_TENANT_SLUG,
  status: "active",
  domain: "",
  additionalDomains: [] as string[],
  frontendUrl: "",
  defaultLanguage: "en",
  supportedLanguages: ["en"],
  timezone: "Asia/Singapore",
  features: {
    articles: true,
    newsletters: true,
    corrections: true,
    exhibition: true,
    podcasts: false,
    marketData: false,
    sponsorSlots: false,
    wireDrops: false,
    translations: false,
    dashboards: false,
    citiesMap: false,
    video: false,
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface AbbFixture {
  pillars: AbbPillar[];
  subSections: AbbSubSection[];
  newsletters: AbbNewsletter[];
  authors: AbbAuthor[];
  tags: AbbTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildAbbFixture(opts: { authorOverrides?: AuthorOverrides } = {}): AbbFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: ABB_PILLARS.map((p) => ({ ...p })),
    subSections: ABB_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: ABB_NEWSLETTERS.map((n) => ({ ...n })),
    authors: ABB_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: ABB_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateAbbFixture(f: AbbFixture = buildAbbFixture()): string[] {
  const errs: string[] = [];
  const dup = (label: string, values: string[]) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) errs.push(`duplicate ${label}: ${v}`);
      seen.add(v);
    }
  };
  const pillarSlugs = new Set(f.pillars.map((p) => p.slug));
  dup("pillar slug", f.pillars.map((p) => p.slug));
  dup("pillar order", f.pillars.map((p) => String(p.order)));
  dup("sub-section slug", f.subSections.map((s) => s.slug));
  dup("newsletter slug", f.newsletters.map((n) => n.slug));
  dup("author name", f.authors.map((a) => a.name));
  dup("author slug", f.authors.map((a) => a.slug));
  dup("author rank", f.authors.filter((a) => a.rank !== undefined).map((a) => String(a.rank)));
  dup("tag slug", f.tags.map((t) => t.slug));

  for (const s of f.subSections) {
    if (!pillarSlugs.has(s.pillarSlug)) errs.push(`sub-section ${s.slug}: unknown pillar ${s.pillarSlug}`);
    if (singleHome(s.pillarSlug)) errs.push(`sub-section ${s.slug}: single-home pillar ${s.pillarSlug} cannot have sub-sections`);
  }
  for (const p of f.pillars) {
    const orders = f.subSections.filter((s) => s.pillarSlug === p.slug).map((s) => s.order);
    orders.forEach((o, i) => {
      if (o !== i + 1) errs.push(`sub-section order under ${p.slug} is not 1-based contiguous`);
    });
  }
  for (const slug of [...(SINGLE_HOME_PILLARS[ABB_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[ABB_TENANT_SLUG] ?? [])]) {
    if (!pillarSlugs.has(slug)) errs.push(`constants name pillar ${slug}, absent from the fixture`);
  }
  const allSlugs = [
    ...f.pillars.map((p) => p.slug),
    ...f.subSections.map((s) => s.slug),
    ...f.newsletters.map((n) => n.slug),
    ...f.authors.map((a) => a.slug),
    ...f.tags.map((t) => t.slug),
  ];
  for (const s of allSlugs) if (!SLUG_RE.test(s)) errs.push(`bad slug: ${s}`);
  const strings = JSON.stringify(f);
  if (DASH_RE.test(strings)) errs.push("fixture contains an em or en dash");
  return errs;
}

/* ── Planner (pure) ─────────────────────────────────────────────────────── */

export type Entity = "pillars" | "subsections" | "newsletters" | "authors" | "tags";
export interface FieldDiff {
  field: string;
  current: unknown;
  fixture: unknown;
}
export type PlanAction = { kind: "create" } | { kind: "exists"; diffs: FieldDiff[] } | { kind: "refuse"; reason: string };
export interface PlanItem {
  entity: Entity;
  key: string;
  action: PlanAction;
  row: AbbPillar | AbbSubSection | AbbNewsletter | AbbAuthor | AbbTag;
}

type Row = Record<string, unknown>;
export interface AbbExisting {
  /** Existing tenant pillars; `subSectionCount` / `secondaryRefCount` feed the single-home refusal. */
  pillars: Array<Row & { slug: string; subSectionCount?: number; secondaryRefCount?: number }>;
  subSections: Array<Row & { pillarSlug: string; slug: string }>;
  newsletters: Array<Row & { slug: string }>;
  /** ALL authors of the tenant (rank / slug conflicts are checked against every row). */
  authors: Array<Row & { name: string; slug?: string | null; rank?: number | null }>;
  tags: Array<Row & { slug: string; title?: unknown }>;
}

const blank = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Field differences between a fixture row and an existing row. Only fields the
 * fixture defines with a non-empty value are compared (empty owner inputs such
 * as an author's bio are never reported); empty vs empty is equal.
 */
export function diffFields(fixture: Row, existing: Row, fields: string[]): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const field of fields) {
    const want = fixture[field];
    if (blank(want)) continue;
    const have = existing[field];
    if (JSON.stringify(have ?? null) !== JSON.stringify(want)) out.push({ field, current: have ?? null, fixture: want });
  }
  return out;
}

const PILLAR_FIELDS = ["title", "heading", "description", "order", "color"];
const SUB_FIELDS = ["title", "order"];
const NEWSLETTER_FIELDS = ["name", "cadence", "description", "order", "active"];
const AUTHOR_FIELDS = ["rank", "role", "bio", "city"];

/**
 * Plan every fixture row against what exists for the tenant: `create`,
 * `exists` (with field diffs, NEVER written) or `refuse` (unsafe state).
 */
export function planAbb(fixture: AbbFixture, existing: AbbExisting): PlanItem[] {
  const items: PlanItem[] = [];

  for (const p of fixture.pillars) {
    const have = existing.pillars.find((e) => e.slug === p.slug);
    let action: PlanAction;
    if (!have) action = { kind: "create" };
    else if (p.singleHome && ((have.subSectionCount ?? 0) > 0 || (have.secondaryRefCount ?? 0) > 0)) {
      action = {
        kind: "refuse",
        reason: `existing single-home pillar ${p.slug} has ${have.subSectionCount ?? 0} sub-section(s) and ${have.secondaryRefCount ?? 0} secondary-section reference(s)`,
      };
    } else action = { kind: "exists", diffs: diffFields(p as unknown as Row, have, PILLAR_FIELDS) };
    items.push({ entity: "pillars", key: p.slug, action, row: p });
  }

  for (const s of fixture.subSections) {
    const key = `${s.pillarSlug}/${s.slug}`;
    let action: PlanAction;
    if (singleHome(s.pillarSlug)) action = { kind: "refuse", reason: `single-home pillar ${s.pillarSlug} cannot have sub-sections` };
    else {
      const have = existing.subSections.find((e) => e.pillarSlug === s.pillarSlug && e.slug === s.slug);
      action = have ? { kind: "exists", diffs: diffFields(s as unknown as Row, have, SUB_FIELDS) } : { kind: "create" };
    }
    items.push({ entity: "subsections", key, action, row: s });
  }

  for (const n of fixture.newsletters) {
    const have = existing.newsletters.find((e) => e.slug === n.slug);
    const action: PlanAction = have ? { kind: "exists", diffs: diffFields(n as unknown as Row, have, NEWSLETTER_FIELDS) } : { kind: "create" };
    items.push({ entity: "newsletters", key: n.slug, action, row: n });
  }

  for (const a of fixture.authors) {
    const byName = existing.authors.find((e) => e.name === a.name);
    const others = existing.authors.filter((e) => e !== byName);
    let action: PlanAction;
    if (byName && (byName.slug ?? null) !== a.slug) {
      action = { kind: "refuse", reason: `author "${a.name}" exists with slug ${JSON.stringify(byName.slug ?? null)}, fixture wants ${a.slug}` };
    } else if (others.some((e) => e.slug === a.slug)) {
      action = { kind: "refuse", reason: `author slug ${a.slug} is owned by a different author` };
    } else if (a.rank !== undefined && others.some((e) => e.rank === a.rank)) {
      action = { kind: "refuse", reason: `author rank ${a.rank} is owned by a different author` };
    } else if (byName) action = { kind: "exists", diffs: diffFields(a as unknown as Row, byName, AUTHOR_FIELDS) };
    else action = { kind: "create" };
    items.push({ entity: "authors", key: a.name, action, row: a });
  }

  for (const t of fixture.tags) {
    const have = existing.tags.find((e) => e.slug === t.slug);
    let action: PlanAction;
    if (!have) action = { kind: "create" };
    else if (have.title !== t.title) action = { kind: "refuse", reason: `tag ${t.slug} exists with title ${JSON.stringify(have.title ?? null)}` };
    else action = { kind: "exists", diffs: [] };
    items.push({ entity: "tags", key: t.slug, action, row: t });
  }

  return items;
}

export function planCounts(items: PlanItem[]): { create: number; exists: number; refuse: number } {
  const c = { create: 0, exists: 0, refuse: 0 };
  for (const i of items) c[i.action.kind] += 1;
  return c;
}

/* ── --authors-file parser ─────────────────────────────────────────────── */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const AUTHOR_FILE_FIELDS = new Set(["role", "bio", "city", "slug"]);
export const AUTHOR_FIELD_MAX = 2000;

/**
 * Parse `--authors-file` JSON: `{ "<default author slug>": { "role"?, "bio"?, "city"?, "slug"? } }`.
 * Throws on unknown author slugs, unknown fields, non-string / empty / over-long
 * values, a bad replacement slug, and prototype-pollution keys. Returns a
 * null-prototype map.
 */
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = ABB_AUTHORS.map((a) => a.slug)): AuthorOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("authors file: not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("authors file: top level must be an object");
  const out: AuthorOverrides = Object.create(null) as AuthorOverrides;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`authors file: forbidden key ${key}`);
    if (!knownSlugs.includes(key)) throw new Error(`authors file: unknown author slug ${key}`);
    const entry = (raw as Record<string, unknown>)[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`authors file: ${key} must be an object`);
    const clean: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const field of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(field)) throw new Error(`authors file: forbidden key ${field}`);
      if (!AUTHOR_FILE_FIELDS.has(field)) throw new Error(`authors file: ${key}.${field} is not an allowed field`);
      const v = (entry as Record<string, unknown>)[field];
      if (typeof v !== "string") throw new Error(`authors file: ${key}.${field} must be a string`);
      if (v.trim() === "") throw new Error(`authors file: ${key}.${field} is empty`);
      if (v.length > AUTHOR_FIELD_MAX) throw new Error(`authors file: ${key}.${field} is over ${AUTHOR_FIELD_MAX} chars`);
      if (field === "slug" && !SLUG_RE.test(v)) throw new Error(`authors file: ${key}.slug is not a kebab-case slug`);
      clean[field] = v;
    }
    out[key] = clean;
  }
  return out;
}
