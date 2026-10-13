/**
 * GlobalTravelPost (tenant `gtp`) taxonomy fixture: the SINGLE source of truth
 * for the gtp pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-gtp-taxonomy.ts` (owner script), the gated gtp block in
 * `scripts/seed.ts`, `scripts/gtp-probe.ts` and `scripts/lib/gtp-taxonomy.test.ts`.
 * gtp-launch P1 (plan section 3 "slug contract"). PURE module: no Payload, no
 * DB, no network; only `src/lib/constants.ts` is imported.
 *
 * Exported shapes (a CONTRACT: content-engine P2 imports GTP_PILLARS,
 * GTP_SUBSECTIONS and GTP_AUTHORS; change only by amending the P1 plan):
 *
 *   interface GtpPillar      { slug: string; title: string; heading: string; description: string; order: number;
 *                              color: string; icon: string; engineWritable: boolean; singleHome: boolean }
 *   interface GtpSubSection  { pillarSlug: string; slug: string; title: string; order: number; optional?: boolean }
 *                              // order: 1-based position in the plan section 3 list, per pillar
 *   interface GtpNewsletter  { slug: string; name: string; cadence: string; description: string; order: number; active: true }
 *   interface GtpAuthor      { name: string; slug: string; rank?: number; role: string; bio?: string; city?: string }
 *                              // the collective `GTP Newsroom` has no rank (stays off the masthead)
 *   interface GtpTag         { slug: string; title: string }   // Tags has slug + title; there is NO `name` field
 *
 * `engineWritable` and `singleHome` are DERIVED from ENGINE_BLOCKED_PILLARS.gtp /
 * SINGLE_HOME_PILLARS.gtp, never hand-typed, so the fixture cannot drift from
 * the constants. Copy (pillar descriptions, newsletter copy) is verbatim from
 * the GTP prototype (`design/GlobalTravelPost.dc.template.html:399,401,734-739`).
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const GTP_TENANT_SLUG = "gtp";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface GtpPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  icon: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface GtpSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
  optional?: boolean;
}
export interface GtpNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface GtpAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface GtpTag {
  slug: string;
  title: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[GTP_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[GTP_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<GtpPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "news",
    title: "News",
    order: 1,
    icon: "newspaper",
    description: "The day's developments across world travel, reported and checked by our newsroom before they reach you.",
  },
  {
    slug: "destinations",
    title: "Destinations",
    order: 2,
    icon: "globe",
    description: "Reporting and guides on places worth your time, with the practical detail to plan properly.",
  },
  {
    slug: "business-of-travel",
    title: "Business of Travel",
    order: 3,
    icon: "trend-up",
    description: "News and analysis for the people who run travel, from hotel boardrooms to airline route desks.",
  },
  {
    slug: "experiences-luxury",
    title: "Experiences & Luxury",
    order: 4,
    icon: "star",
    description: "Travel at its considered best, for readers who plan carefully and spend deliberately.",
  },
  {
    slug: "press-room",
    title: "Press Room",
    order: 5,
    icon: "feather",
    description:
      "Announcements from the travel industry, published in full and clearly labelled, separate from our editorial coverage.",
  },
  {
    slug: "events-awards",
    title: "Events & Awards",
    order: 6,
    icon: "spark",
    description: "Our own events, the industry's key dates, and the awards we present with the Asia Awards Organisation.",
  },
];

export const GTP_PILLARS: readonly GtpPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--gtp-red)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string, boolean?]>): GtpSubSection[] =>
  rows.map(([slug, title, optional], i) => ({ pillarSlug, slug, title, order: i + 1, ...(optional ? { optional: true } : {}) }));

/** All sub-sections incl. the OPTIONAL `gtp-events` (created only with `--include-gtp-events`). */
export const GTP_SUBSECTIONS: readonly GtpSubSection[] = [
  ...SUB("news", [
    ["aviation", "Aviation"],
    ["hotels", "Hotels & Resorts"],
    ["visa-entry", "Visa & Entry"],
    ["destinations-news", "Destinations in the News"],
    ["travel-tech", "Travel Tech"],
  ]),
  ...SUB("destinations", [
    ["asia", "Asia"],
    ["world", "World"],
    ["guides", "Guides"],
    ["trip-planning", "Trip Planning"],
  ]),
  ...SUB("business-of-travel", [
    ["hospitality-business", "Hospitality Business"],
    ["aviation-business", "Aviation Business"],
    ["destination-marketing", "Destination Marketing"],
    ["people", "People"],
    ["data-insights", "Data & Insights"],
  ]),
  ...SUB("experiences-luxury", [
    ["luxury-stays", "Luxury Stays"],
    ["food-drink", "Food & Drink"],
    ["wellness", "Wellness"],
    ["journeys", "Journeys"],
    ["style", "Style of Travel"],
  ]),
  ...SUB("events-awards", [
    ["industry-calendar", "Industry Calendar"],
    ["gtp-events", "GTP Events", true],
  ]),
];

/** The sub-sections to create: the 20 base rows, plus `gtp-events` when asked. */
export function gtpSubSections(opts: { includeGtpEvents?: boolean } = {}): GtpSubSection[] {
  return GTP_SUBSECTIONS.filter((s) => !s.optional || opts.includeGtpEvents === true);
}

export const GTP_NEWSLETTERS: readonly GtpNewsletter[] = [
  {
    slug: "the-post",
    name: "The Post",
    cadence: "Three mornings a week",
    description: "Travel news, without the noise. For people who travel often and read carefully.",
    order: 1,
    active: true,
  },
  {
    slug: "business-of-travel-weekly",
    name: "Business of Travel Weekly",
    cadence: "Fridays",
    description: "The industry's week, in one brief. For the people who run hotels, airlines and destinations.",
    order: 2,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to content-engine P2's byline pool (intake
 * matches `authors.name` with `equals`). Default slugs are the kebab-case of the
 * name; the owner may override them (and role/bio/city) from the old
 * `site_authors` view with `--authors-file`.
 */
export const GTP_AUTHORS: readonly GtpAuthor[] = [
  { name: "Daniel Cheong", slug: "daniel-cheong", rank: 1, role: "News Editor", city: "Singapore" },
  { name: "Priya Nair", slug: "priya-nair", rank: 2, role: "Hospitality Correspondent", city: "Singapore" },
  { name: "Marcus Tan", slug: "marcus-tan", rank: 3, role: "Business of Travel Correspondent", city: "Singapore" },
  { name: "Natalie Ong", slug: "natalie-ong", rank: 4, role: "Features Writer", city: "Singapore" },
  { name: "Yuki Hamada", slug: "yuki-hamada", rank: 5, role: "Japan Correspondent", city: "Tokyo" },
  { name: "GTP Newsroom", slug: "gtp-newsroom", role: "Newsroom" },
];

/** Press Room is separated by tags (no sub-sections). Slugs are the P3 contract. */
export const GTP_TAGS: readonly GtpTag[] = [
  { slug: "partner-content", title: "Partner Content" },
  { slug: "pr-hotels-hospitality", title: "PR: Hotels & Hospitality" },
  { slug: "pr-aviation", title: "PR: Aviation" },
  { slug: "pr-destinations-dmo", title: "PR: Destinations & DMOs" },
  { slug: "pr-travel-tech-business", title: "PR: Travel Tech & Business" },
  { slug: "pr-people-on-the-move", title: "PR: People on the Move" },
];

/** Plan section 7 tenant field sheet, as data (the owner enters it in /admin). */
export const GTP_TENANT_FIELDS = {
  name: "GlobalTravelPost",
  slug: GTP_TENANT_SLUG,
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
    titleSuffix: "- GlobalTravelPost",
    defaultMetaDescription:
      "Global travel news, destinations and the business of travel, reported daily from an Asian vantage point for readers worldwide.",
  },
  contact: {
    editorial: "editor@globaltravelpost.com",
    general: "info@globaltravelpost.com",
    advertising: "info@globaltravelpost.com",
    partnerships: "info@globaltravelpost.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface GtpFixture {
  pillars: GtpPillar[];
  subSections: GtpSubSection[];
  newsletters: GtpNewsletter[];
  authors: GtpAuthor[];
  tags: GtpTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildGtpFixture(opts: { includeGtpEvents?: boolean; authorOverrides?: AuthorOverrides } = {}): GtpFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: GTP_PILLARS.map((p) => ({ ...p })),
    subSections: gtpSubSections(opts),
    newsletters: GTP_NEWSLETTERS.map((n) => ({ ...n })),
    authors: GTP_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: GTP_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateGtpFixture(f: GtpFixture = buildGtpFixture()): string[] {
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
  for (const slug of [...(SINGLE_HOME_PILLARS[GTP_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[GTP_TENANT_SLUG] ?? [])]) {
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
  row: GtpPillar | GtpSubSection | GtpNewsletter | GtpAuthor | GtpTag;
}

type Row = Record<string, unknown>;
export interface GtpExisting {
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

const PILLAR_FIELDS = ["title", "heading", "description", "order", "color", "icon"];
const SUB_FIELDS = ["title", "order"];
const NEWSLETTER_FIELDS = ["name", "cadence", "description", "order", "active"];
const AUTHOR_FIELDS = ["rank", "role", "bio", "city"];

/**
 * Plan every fixture row against what exists for the tenant: `create`,
 * `exists` (with field diffs, NEVER written) or `refuse` (unsafe state).
 */
export function planGtp(fixture: GtpFixture, existing: GtpExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = GTP_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
