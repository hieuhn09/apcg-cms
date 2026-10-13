/**
 * VowAsia (tenant `vowasia`) taxonomy fixture: the SINGLE source of truth for the
 * vowasia pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-vowasia-taxonomy.ts` (owner script) and
 * `scripts/lib/vowasia-taxonomy.test.ts`. Mirrors `scripts/lib/gtp-taxonomy.ts`
 * (vowasia launch P1). PURE module: no Payload, no DB, no network; only
 * `src/lib/constants.ts` is imported.
 *
 * Exported shapes (a CONTRACT: the content-engine vowasia publication and its
 * taxonomy parity check read VOWASIA_PILLARS, VOWASIA_SUBSECTIONS and
 * VOWASIA_AUTHORS from this file):
 *
 *   interface VowasiaPillar      { slug: string; title: string; heading: string; description: string; order: number;
 *                                  color: string; engineWritable: boolean; singleHome: boolean }
 *   interface VowasiaSubSection  { pillarSlug: string; slug: string; title: string; order: number }
 *                                  // order: 1-based position in the design list, per pillar
 *   interface VowasiaNewsletter  { slug: string; name: string; cadence: string; description: string; order: number; active: true }
 *   interface VowasiaAuthor      { name: string; slug: string; rank?: number; role: string; bio?: string; city?: string }
 *   interface VowasiaTag         { slug: string; title: string }   // Tags has slug + title; there is NO `name` field
 *
 * Sources (code wins over any summary): pillar slugs, titles, descriptions and
 * sub-section labels are verbatim from the approved design as ported to
 * vowasia-web `src/content/pillars.ts` (pillar slug = URL slug = CMS slug).
 * Design `subs` entries that carry an `href` ("Submit your wedding", "Get
 * listed", "Submit a release") are page links, NOT sub-sections. Sub-section
 * slugs follow the gtp convention: the label in kebab-case with `&` and accents
 * dropped (`Hotels & Resorts` -> `hotels-resorts`, `Flowers & Décor` ->
 * `flowers-decor`); slugs are unique across the whole tenant. There is no
 * pillar icon: vowasia-web has no icon set, so the field is left unset.
 *
 * `engineWritable` and `singleHome` are DERIVED from ENGINE_BLOCKED_PILLARS.vowasia /
 * SINGLE_HOME_PILLARS.vowasia, never hand-typed, so the fixture cannot drift from
 * the constants. `press-room` is the only single-home pillar; engine-blocked
 * pillars are `press-room`, `real-weddings` and `directory` (owner 13-10-26).
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const VOWASIA_TENANT_SLUG = "vowasia";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface VowasiaPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface VowasiaSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
}
export interface VowasiaNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface VowasiaAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface VowasiaTag {
  slug: string;
  title: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[VOWASIA_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[VOWASIA_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<VowasiaPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "real-weddings",
    title: "Real Weddings",
    order: 1,
    description:
      "Real celebrations from across Asia, grand and intimate, traditional and modern, told with the couple's blessing and every vendor credited.",
  },
  {
    slug: "venues",
    title: "Venues",
    order: 2,
    description:
      "Where Asia gets married: hotels, resorts, gardens and ballrooms, reported with the details that matter, capacity, style and what it really costs.",
  },
  {
    slug: "directory",
    title: "The Directory",
    order: 3,
    description: "Asia's best wedding professionals, vetted by our editors, searchable by specialty and city, and never pay to play.",
  },
  {
    slug: "destination-weddings",
    title: "Destination Weddings",
    order: 4,
    description: "Getting married away from home, done properly: legal requirements, honest budgets and the destinations worth the journey.",
  },
  {
    slug: "style",
    title: "Style",
    order: 5,
    description: "Gowns, rings, beauty and flowers: wedding style covered with a magazine's eye and a planner's practicality.",
  },
  {
    slug: "planning",
    title: "Planning",
    order: 6,
    description: "Checklists, budgets and expert answers, so the happiest day of your life is also the best organised.",
  },
  {
    slug: "wedding-business",
    title: "The Wedding Business",
    order: 7,
    description: "News, data and people from Asia's wedding industry, for the hotels, planners and brands behind the celebrations.",
  },
  {
    slug: "press-room",
    title: "Press Room",
    order: 8,
    description:
      "Announcements from across the wedding industry, published in full and clearly labelled as press releases, kept separate from our editorial coverage.",
  },
];

export const VOWASIA_PILLARS: readonly VowasiaPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)", // vowasia-web globals.css: --accent #8a5a3c (brand accent)
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string]>): VowasiaSubSection[] =>
  rows.map(([slug, title], i) => ({ pillarSlug, slug, title, order: i + 1 }));

/** All 27 sub-sections (press-room has none: it is single-home). */
export const VOWASIA_SUBSECTIONS: readonly VowasiaSubSection[] = [
  ...SUB("real-weddings", [
    ["grand-celebrations", "Grand Celebrations"],
    ["intimate-elopements", "Intimate & Elopements"],
    ["traditions", "Traditions"],
    ["society-celebrity", "Society & Celebrity"],
  ]),
  ...SUB("venues", [
    ["hotels-resorts", "Hotels & Resorts"],
    ["by-destination", "By Destination"],
    ["venue-spotlights", "Venue Spotlights"],
    ["packages-price-guides", "Packages & Price Guides"],
  ]),
  ...SUB("directory", [
    ["by-category", "By Category"],
    ["by-city", "By City"],
    ["vowasia-vetted", "VowAsia Vetted"],
  ]),
  ...SUB("destination-weddings", [
    ["destination-guides", "Destination Guides"],
    ["legal-logistics", "Legal & Logistics"],
    ["pre-wedding-shoots", "Pre-Wedding Shoots"],
    ["honeymoons", "Honeymoons"],
  ]),
  ...SUB("style", [
    ["gowns-attire", "Gowns & Attire"],
    ["rings-jewellery", "Rings & Jewellery"],
    ["beauty", "Beauty"],
    ["flowers-decor", "Flowers & Décor"],
    ["trend-reports", "Trend Reports"],
  ]),
  ...SUB("planning", [
    ["checklists-timelines", "Checklists & Timelines"],
    ["budgets-real-costs", "Budgets & Real Costs"],
    ["expert-advice", "Expert Advice"],
    ["etiquette-traditions", "Etiquette & Traditions"],
  ]),
  ...SUB("wedding-business", [
    ["industry-news", "Industry News"],
    ["data-insights", "Data & Insights"],
    ["people-planners", "People & Planners"],
  ]),
];

/** Copy from vowasia-web `src/content/docs.ts` (newsletters page). The site subscribe route posts `set:["the-vow"]`. */
export const VOWASIA_NEWSLETTERS: readonly VowasiaNewsletter[] = [
  {
    slug: "the-vow",
    name: "The Vow",
    cadence: "Once a week",
    description: "Asia's most beautiful weddings and smartest planning advice. For couples planning weddings in Asia.",
    order: 1,
    active: true,
  },
  {
    slug: "wedding-business-brief",
    name: "The Wedding Business Brief",
    cadence: "Twice a month",
    description: "The wedding industry's fortnight, briefed for professionals. For the people who run venues, plan weddings and build wedding brands.",
    order: 2,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to the content-engine vowasia byline pool
 * (intake matches `authors.name` with `equals`). Slugs are the kebab-case of the
 * name; the owner may override slug/role/bio/city with `--authors-file`.
 *
 * Names confirmed by the owner for use on 13-10-26. Roles and bios were written
 * by us in the gtp style (short, general, no invented facts: no employers,
 * careers, awards, cities or numbers) and stay editable by the owner (in /admin
 * or with `--authors-file`). No city on purpose. Roles are GENERAL (playbook
 * trap g: the engine assigns bylines by daily cap, not by topic).
 */
export const VOWASIA_AUTHORS: readonly VowasiaAuthor[] = [
  { name: "Serene Chia", slug: "serene-chia", rank: 1, role: "Editor", bio: "Serene edits VowAsia, overseeing its coverage of weddings across Asia and the editorial calendar." },
  { name: "Aarti Menon", slug: "aarti-menon", rank: 2, role: "Senior Writer", bio: "Aarti writes about weddings across Asia, from the celebrations themselves to the ideas and traditions couples bring to them." },
  { name: "Danish Iskandar", slug: "danish-iskandar", rank: 3, role: "Senior Reporter", bio: "Danish reports on weddings across Asia, from the places couples choose to celebrate to the people who make the day happen." },
  { name: "Hanna Pang", slug: "hanna-pang", rank: 4, role: "Senior Writer", bio: "Hanna writes about wedding planning and style, with practical ideas for couples getting ready for the day." },
  { name: "Yumi Nakagawa", slug: "yumi-nakagawa", rank: 5, role: "Contributing Editor", bio: "Yumi is a contributing editor covering weddings, style and celebrations across Asia." },
  { name: "Ishaan Bhatt", slug: "ishaan-bhatt", rank: 6, role: "Senior Reporter", bio: "Ishaan reports on weddings and the wedding industry across Asia, from new trends to the businesses behind them." },
];

/** Six simple topic tags (owner decision 13-10-26). No probe tag: the owner creates probe data by hand. */
export const VOWASIA_TAGS: readonly VowasiaTag[] = [
  { slug: "indian-weddings", title: "Indian Weddings" },
  { slug: "elopements", title: "Elopements" },
  { slug: "honeymoons", title: "Honeymoons" },
  { slug: "wedding-venues", title: "Wedding Venues" },
  { slug: "bridal-fashion", title: "Bridal Fashion" },
  { slug: "wedding-industry", title: "Wedding Industry" },
];

/** Tenant field sheet, as data (the owner enters it by hand in /admin; this file never creates the tenant). */
export const VOWASIA_TENANT_FIELDS = {
  name: "VowAsia",
  slug: VOWASIA_TENANT_SLUG,
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
    titleSuffix: "- VowAsia",
    defaultMetaDescription:
      "Asia's premier wedding magazine: real weddings, the best wedding venues, a vetted directory of wedding vendors, destination wedding guides and planning advice.",
  },
  contact: {
    editorial: "editor@vowasia.com",
    general: "info@vowasia.com",
    advertising: "info@asiapresscentre.com",
    partnerships: "info@asiapresscentre.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface VowasiaFixture {
  pillars: VowasiaPillar[];
  subSections: VowasiaSubSection[];
  newsletters: VowasiaNewsletter[];
  authors: VowasiaAuthor[];
  tags: VowasiaTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildVowasiaFixture(opts: { authorOverrides?: AuthorOverrides } = {}): VowasiaFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: VOWASIA_PILLARS.map((p) => ({ ...p })),
    subSections: VOWASIA_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: VOWASIA_NEWSLETTERS.map((n) => ({ ...n })),
    authors: VOWASIA_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: VOWASIA_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateVowasiaFixture(f: VowasiaFixture = buildVowasiaFixture()): string[] {
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
  for (const slug of [...(SINGLE_HOME_PILLARS[VOWASIA_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[VOWASIA_TENANT_SLUG] ?? [])]) {
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
  row: VowasiaPillar | VowasiaSubSection | VowasiaNewsletter | VowasiaAuthor | VowasiaTag;
}

type Row = Record<string, unknown>;
export interface VowasiaExisting {
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
export function planVowasia(fixture: VowasiaFixture, existing: VowasiaExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = VOWASIA_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
