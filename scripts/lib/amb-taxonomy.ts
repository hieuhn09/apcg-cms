/**
 * AsiaMaterialsBrief (tenant `amb`) taxonomy fixture: the SINGLE source of truth
 * for the AMB pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-amb-taxonomy.ts` (owner script) and
 * `scripts/lib/amb-taxonomy.test.ts`. Mirrors `scripts/lib/agr-taxonomy.ts`
 * (amb launch W2, owner decisions 27-10-26).
 * PURE module: no Payload, no DB, no network; only `src/lib/constants.ts` is
 * imported.
 *
 * Exported shapes (a CONTRACT: the content-engine amb publication and its
 * taxonomy parity check read AMB_PILLARS, AMB_SUBSECTIONS and AMB_AUTHORS from
 * this file): same field shapes as the agr fixture (pillar, sub-section,
 * newsletter, author, tag; Tags have slug + title, NO `name`), plus an
 * informational sub-section `description` (the design's copy; SubSections has
 * no description field, so it is never written to Central, like abb).
 *
 * Source: the amb-launch plan delta §2 (content-engine
 * process/features/amb-launch/active/amb-launch_27-10-26/), taken from the
 * approved Claude Design "AsiaMaterialsBrief.dc.html" (the design wins over
 * the .docx proposal). Pillar order = design menu order (Intelligence, The
 * Exhibition and Events & Fairs are pages, not pillars). Pillar slugs reuse
 * the old site's URLs (`/briefing`, `/materials`, ...: fewer redirects).
 * Pillar and sub-section descriptions = the design's `desc` / `d` text,
 * verbatim (American spelling; the design uses commas, no em/en dash).
 * Sub-section slugs are unique across the tenant.
 *
 * `engineWritable` and `singleHome` are DERIVED from the constants. AMB's one
 * single-home pillar is `press-room` (hyphenated, like gtp/vowasia/agr), so it
 * has NO sub-sections; it is also the only engine-blocked pillar. The engine
 * must not pick the `projects` sub-sections `specified` and `design-voices`
 * (named suppliers / real interviews): enforced engine-side (content-engine
 * amb publication), Central has no sub-section block.
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const AMB_TENANT_SLUG = "amb";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface AmbPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface AmbSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
  description: string; // design copy, informational (SubSections has no description field)
}
export interface AmbNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface AmbAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface AmbTag {
  slug: string;
  title: string;
}
export interface AmbExhibitionHall {
  slug: string;
  title: string;
  description: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[AMB_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[AMB_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<AmbPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "briefing",
    title: "Briefing",
    order: 1,
    description: "The business of building and furnishing Asia, companies, projects, policy, and people, reported and checked by our newsroom.",
  },
  {
    slug: "materials",
    title: "Materials",
    order: 2,
    description: "The materials Asia builds with, covered with specs, sources, and honest assessment of what's new.",
  },
  {
    slug: "interiors-ffe",
    title: "Interiors & FF&E",
    order: 3,
    description: "Everything a project buys to furnish itself, from Asia's factories and the world's brands.",
  },
  {
    slug: "lighting-tech",
    title: "Lighting & Tech",
    order: 4,
    description: "Lighting, smart systems, and building technology, the layer that turns a structure into a working project.",
  },
  {
    slug: "projects",
    title: "Projects & Inspiration",
    order: 5,
    description: "What got built, what's in it, and who made it, from hotel case studies to the apartment ideas readers take home.",
  },
  {
    slug: "press-room",
    title: "Press Room",
    order: 6,
    description: "Official press releases, published in full, clearly labeled, and kept separate from our editorial coverage.",
  },
];

export const AMB_PILLARS: readonly AmbPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string, string]>): AmbSubSection[] =>
  rows.map(([slug, title, description], i) => ({ pillarSlug, slug, title, order: i + 1, description }));

/** All 18 sub-sections (press-room has none: single-home rule). */
export const AMB_SUBSECTIONS: readonly AmbSubSection[] = [
  ...SUB("briefing", [
    ["industry-news", "Industry News", "Factories, brands, retailers, and showrooms, who is expanding, investing, and winning orders."],
    ["projects-pipeline", "Projects & Pipeline", "The hotels, towers, and communities being built across Asia, and what they will buy."],
    ["policy-trade", "Policy & Trade", "Tariffs, green standards, and timber rules, checked against official sources."],
    ["people-firms", "People & Firms", "Appointments, studio moves, and the people shaping the industry."],
  ]),
  ...SUB("materials", [
    ["surfaces", "Surfaces", "Tile, stone, quartz, and flooring, the surfaces that define a project."],
    ["wood-panels", "Wood & Panels", "Asia's wood economy from forest to finished panel."],
    ["architectural", "Architectural", "The building envelope and what goes on it."],
    ["new-sustainable-materials", "New & Sustainable Materials", "The materials that didn't exist five years ago, assessed honestly, one a week."],
  ]),
  ...SUB("interiors-ffe", [
    ["furniture", "Furniture", "Asia makes the world's furniture. Here is who, where, and what's next."],
    ["soft-ffe", "Soft FF&E", "The soft layer that guests actually touch."],
    ["kitchen-bath", "Kitchen & Bath", "The two rooms that sell every home and rate every hotel."],
    ["decor-ose", "Decor & OS&E", "The finishing layer of hospitality."],
  ]),
  ...SUB("lighting-tech", [
    ["lighting", "Lighting", "From Guzhen's factories to the world's lobbies."],
    ["smart-building-home", "Smart Building & Home", "The connected layer of hotels and homes."],
    ["building-systems", "Building Systems", "The systems specified once and lived with for decades."],
  ]),
  ...SUB("projects", [
    ["specified", "Specified", "A project opens; we tell you what's in it. The suppliers, named."],
    ["home-renovation", "Home & Renovation", "The best of Asia's materials and design, brought home."],
    ["design-voices", "Design Voices", "The architects and interior designers shaping Asia's projects."],
  ]),
];

/**
 * Sub-sections the content engine may NOT pick (plan delta §1 Q3): editor-only
 * because they name real suppliers / quote real people. Informational here
 * (Central has no sub-section block); the content-engine amb publication
 * enforces it and its parity check reads this list.
 */
export const AMB_ENGINE_EXCLUDED_SUBSECTIONS: readonly string[] = ["specified", "design-voices"];

// PENDING OWNER: check the slugs against the old site's newsletter form at the discovery step.
export const AMB_NEWSLETTERS: readonly AmbNewsletter[] = [
  {
    slug: "the-materials-brief",
    name: "The Materials Brief",
    cadence: "Every Tuesday",
    description: "The industry's week every Tuesday: the news that mattered, one new material worth knowing, one project worth studying, and the fair dates ahead.",
    order: 1,
    active: true,
  },
  {
    slug: "pipeline-alert",
    name: "Pipeline Alert",
    cadence: "Weekly",
    description: "Projects before they buy, weekly: the hotels and residences approaching procurement across Asia, with scope and timeline where confirmed.",
    order: 2,
    active: true,
  },
  {
    slug: "home-design-ideas",
    name: "Home & Design Ideas",
    cadence: "Twice a month",
    description: "The best of Asian materials and design, brought home, twice a month: apartment ideas, material guides, and the products worth the money.",
    order: 3,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to the content-engine amb byline pool
 * (intake matches `authors.name` with `equals`; Rachel Tan first). Names and
 * roles from the design's Team page (owner 27-10-26), bios from the plan delta
 * §2, American spelling. No city, no shared "AMB Newsroom" byline.
 */
// PENDING OWNER: bio wording (owner to review; editable in /admin or with --authors-file)
export const AMB_AUTHORS: readonly AmbAuthor[] = [
  {
    name: "Rachel Tan",
    slug: "rachel-tan",
    rank: 1,
    role: "Editor",
    bio: "Rachel Tan edits AsiaMaterialsBrief from Singapore. She reads the editorial inbox first and decides what the newsroom covers each day.",
  },
  {
    name: "Marcus Lim",
    slug: "marcus-lim",
    rank: 2,
    role: "Deputy Editor",
    bio: "Marcus Lim is deputy editor at AsiaMaterialsBrief. He runs daily news and the Briefing section, and spends much of the year at the region's trade fairs.",
  },
  {
    name: "Siriporn Chaiyasit",
    slug: "siriporn-chaiyasit",
    rank: 3,
    role: "Senior Reporter",
    bio: "Siriporn Chaiyasit is a senior reporter at AsiaMaterialsBrief. She writes about hotel projects, interiors and the buyers behind them.",
  },
  {
    name: "Dimas Prasetyo",
    slug: "dimas-prasetyo",
    rank: 4,
    role: "Reporter",
    bio: "Dimas Prasetyo is a reporter at AsiaMaterialsBrief. He covers furniture, rattan and timber, from the workshop floor to the export order.",
  },
  {
    name: "Lin Wei",
    slug: "lin-wei",
    rank: 5,
    role: "Reporter",
    bio: "Lin Wei is a reporter at AsiaMaterialsBrief. She covers lighting, ceramics and building products, and the factories that make them.",
  },
  {
    name: "Aisyah Rahman",
    slug: "aisyah-rahman",
    rank: 6,
    role: "Contributing Writer",
    bio: "Aisyah Rahman is a contributing writer at AsiaMaterialsBrief. She writes the Home & Renovation pieces, with an eye on what materials cost and how they wear.",
  },
];

// PENDING OWNER: tag set may change (D6). The home page's Material of the Week block reads the newest `material-of-the-week` article.
export const AMB_TAGS: readonly AmbTag[] = [
  { slug: "material-of-the-week", title: "Material of the Week" },
  { slug: "inside-the-factory", title: "Inside the Factory" },
  { slug: "pipeline-watch", title: "Pipeline Watch" },
  { slug: "sourcing-route", title: "The Sourcing Route" },
  { slug: "fairs", title: "Fairs" },
  { slug: "sustainability", title: "Sustainability" },
];

/**
 * The six halls of The Exhibition (= `booths.hall` values allowed for amb, in
 * the website's order Hall 01..06; mirrors AMB_BOOTH_HALLS in
 * src/lib/booth-halls.ts). Directory data, not taxonomy rows: never created by
 * the owner script. Titles and descriptions = the design's hall cards.
 */
export const AMB_EXHIBITION_HALLS: readonly AmbExhibitionHall[] = [
  { slug: "manufacturers", title: "Manufacturers & Factories", description: "By country, product category, certification (FSC, ISO, BSCI), and OEM/ODM capability." },
  { slug: "brands", title: "Brands", description: "Materials, furniture, lighting, kitchen, and bath brands, Asian and international." },
  { slug: "design-studios", title: "Design Studios", description: "Architecture and interior design studios, by project type and market. Find the studio; see its work." },
  { slug: "distributors-showrooms", title: "Distributors & Showrooms", description: "Importers and showrooms, by city and category." },
  { slug: "services", title: "Services", description: "Project logistics, QC and inspection, certification, and fit-out contractors." },
  { slug: "country-pavilions", title: "Country Pavilions", description: "National industry groups, presented with their trade associations." },
];

/** Tenant field sheet, as data (the owner enters it by hand in /admin; this file never creates the tenant). */
export const AMB_TENANT_FIELDS = {
  name: "AsiaMaterialsBrief",
  slug: AMB_TENANT_SLUG,
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
  seo: {
    titleSuffix: "- AsiaMaterialsBrief",
    // PENDING OWNER: wording (the design's meta description)
    defaultMetaDescription:
      "News and sourcing for building materials, furniture, lighting, and FF&E across Asia, for hotels, developers, designers, and importers. The exhibition that never closes.",
  },
  // PENDING OWNER: mailboxes (the design writes info@asiamaterialsbrief.com for editorial and general matters, info@asiapresscentre.com for partnerships)
  contact: {
    editorial: "info@asiamaterialsbrief.com",
    general: "info@asiamaterialsbrief.com",
    advertising: "info@asiapresscentre.com",
    partnerships: "info@asiapresscentre.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface AmbFixture {
  pillars: AmbPillar[];
  subSections: AmbSubSection[];
  newsletters: AmbNewsletter[];
  authors: AmbAuthor[];
  tags: AmbTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildAmbFixture(opts: { authorOverrides?: AuthorOverrides } = {}): AmbFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: AMB_PILLARS.map((p) => ({ ...p })),
    subSections: AMB_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: AMB_NEWSLETTERS.map((n) => ({ ...n })),
    authors: AMB_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: AMB_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateAmbFixture(f: AmbFixture = buildAmbFixture()): string[] {
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
    if (!s.description.trim()) errs.push(`sub-section ${s.slug}: missing design description`);
  }
  const subSlugs = new Set(f.subSections.map((s) => s.slug));
  for (const s of AMB_ENGINE_EXCLUDED_SUBSECTIONS) if (!subSlugs.has(s)) errs.push(`engine-excluded sub-section ${s} is absent from the fixture`);
  for (const p of f.pillars) {
    const orders = f.subSections.filter((s) => s.pillarSlug === p.slug).map((s) => s.order);
    orders.forEach((o, i) => {
      if (o !== i + 1) errs.push(`sub-section order under ${p.slug} is not 1-based contiguous`);
    });
  }
  for (const slug of [...(SINGLE_HOME_PILLARS[AMB_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[AMB_TENANT_SLUG] ?? [])]) {
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
  row: AmbPillar | AmbSubSection | AmbNewsletter | AmbAuthor | AmbTag;
}

type Row = Record<string, unknown>;
export interface AmbExisting {
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
export function planAmb(fixture: AmbFixture, existing: AmbExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = AMB_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
