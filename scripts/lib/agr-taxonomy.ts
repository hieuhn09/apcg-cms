/**
 * AsiaGolfReview (tenant `agr`) taxonomy fixture: the SINGLE source of truth
 * for the AGR pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-agr-taxonomy.ts` (owner script) and
 * `scripts/lib/agr-taxonomy.test.ts`. Mirrors `scripts/lib/aer-taxonomy.ts`
 * (agr launch W2, owner decisions 23-10-26).
 * PURE module: no Payload, no DB, no network; only `src/lib/constants.ts` is
 * imported.
 *
 * Exported shapes (a CONTRACT: the content-engine agr publication and its
 * taxonomy parity check read AGR_PILLARS, AGR_SUBSECTIONS and AGR_AUTHORS from
 * this file): same field shapes as the aer fixture (pillar, sub-section,
 * newsletter, author, tag; Tags have slug + title, NO `name`).
 *
 * Source: the agr-launch plan delta §2 (content-engine
 * process/features/agr-launch/active/agr-launch_23-10-26/), taken from the
 * approved Claude Design "AsiaGolfReview Website.dc.html" (the design wins
 * over the .docx proposal). Pillar order = design menu order. Pillar
 * descriptions = the proposal's section-descriptions, American spelling, with
 * dashes replaced by a colon (the fixture forbids em/en dashes). Sub-section
 * slugs reuse the old site's slugs where the name matches (fewer redirects)
 * and are unique across the tenant.
 *
 * `engineWritable` and `singleHome` are DERIVED from the constants. AGR's one
 * single-home pillar is `press-room` (hyphenated, like gtp/vowasia), so it has
 * NO sub-sections (the design's Press Room chips filter by TAG); engine-blocked
 * pillars are `course-reviews`, `rankings`, `press-room`.
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const AGR_TENANT_SLUG = "agr";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface AgrPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface AgrSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
}
export interface AgrNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface AgrAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface AgrTag {
  slug: string;
  title: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[AGR_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[AGR_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<AgrPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "course-reviews",
    title: "Course Reviews",
    order: 1,
    description: "Independent reviews written from on-site play, with a standardized fact file and an AGR Score against published criteria.",
  },
  {
    slug: "rankings",
    title: "Rankings",
    order: 2,
    description: "Asia's Top 100 and country Top 10s, judged by a named panel to a published methodology.",
  },
  {
    slug: "golf-travel",
    title: "Golf Travel",
    order: 3,
    description: "Where to play, where to stay and how to plan it: the practical craft of the Asian golf trip.",
  },
  {
    slug: "the-game",
    title: "The Game",
    order: 4,
    description: "Selected tournament coverage with an Asian vantage point: the tours, the opens and the players who matter here.",
  },
  {
    slug: "gear-style",
    title: "Gear & Style",
    order: 5,
    description: "Equipment and apparel reviewed in the conditions you'll actually play in: Asia's heat, humidity and rain.",
  },
  {
    slug: "golf-business",
    title: "Golf Business",
    order: 6,
    description: "The industry behind the game: development, management, people and data, reported for professionals.",
  },
  {
    slug: "press-room",
    title: "Press Room",
    order: 7,
    description: "Announcements from the golf industry, published in full and clearly labeled, separate from our editorial coverage.",
  },
];

export const AGR_PILLARS: readonly AgrPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string]>): AgrSubSection[] =>
  rows.map(([slug, title], i) => ({ pillarSlug, slug, title, order: i + 1 }));

/** All 29 sub-sections (press-room has none: single-home rule; its design chips are tags). */
export const AGR_SUBSECTIONS: readonly AgrSubSection[] = [
  ...SUB("course-reviews", [
    ["vietnam", "Vietnam"],
    ["thailand", "Thailand"],
    ["japan", "Japan"],
    ["south-korea", "South Korea"],
    ["malaysia", "Malaysia"],
    ["indonesia", "Indonesia"],
    ["philippines", "Philippines"],
    ["china-hainan", "China & Hainan"],
    ["singapore", "Singapore"],
  ]),
  ...SUB("rankings", [
    ["asia-top-100", "Asia Top 100"],
    ["country-top-10", "Country Top 10s"],
    ["best-new-courses", "Best New Courses"],
  ]),
  ...SUB("golf-travel", [
    ["destinations", "Destinations"],
    ["itineraries", "Itineraries"],
    ["resorts-stays", "Resorts & Stays"],
    ["the-practical-game", "The Practical Game"],
  ]),
  ...SUB("the-game", [
    ["tournament-news", "Tournament News"],
    ["players", "Players"],
    ["watch-prize-money", "Watch & Prize Money"],
    ["national-opens", "National Opens"],
  ]),
  ...SUB("gear-style", [
    ["clubs", "Clubs"],
    ["balls", "Balls"],
    ["apparel", "Apparel"],
    ["shoes", "Shoes"],
    ["bags-accessories", "Bags & Accessories"],
  ]),
  ...SUB("golf-business", [
    ["development-design", "Development & Design"],
    ["club-management", "Club Management"],
    ["people", "People"],
    ["data-insights", "Data & Insights"],
  ]),
];

/** Slugs match the old site's newsletter form (checked 23-10-26). */
export const AGR_NEWSLETTERS: readonly AgrNewsletter[] = [
  {
    slug: "sunday-round",
    name: "The Sunday Round",
    cadence: "Every Sunday",
    description: "One course, one destination and one story, every week.", // PENDING OWNER: wording
    order: 1,
    active: true,
  },
  {
    slug: "golf-business-brief",
    name: "Asia Golf Business Brief",
    cadence: "Twice a month",
    description: "New projects, market data and people moves in Asia's golf industry.", // PENDING OWNER: wording
    order: 2,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to the content-engine agr byline pool
 * (intake matches `authors.name` with `equals`). Names and bios from the
 * design's Team page (owner 23-10-26), American spelling. General roles, no
 * city, no shared "AGR Editors" byline.
 */
// PENDING OWNER: bio wording (owner to review; editable in /admin or with --authors-file)
export const AGR_AUTHORS: readonly AgrAuthor[] = [
  {
    name: "Rachel Lim",
    slug: "rachel-lim",
    rank: 1,
    role: "Editor",
    bio: "Rachel Lim is an editor at AsiaGolfReview. She plans the trips she writes about and plays the courses on them, often in the first group out.",
  },
  {
    name: "Arjun Mehta",
    slug: "arjun-mehta",
    rank: 2,
    role: "Senior Writer",
    bio: "Arjun Mehta is a senior writer at AsiaGolfReview. He moves between review rounds, tour events and the test bench, often in the same week.",
  },
  {
    name: "Kenji Sato",
    slug: "kenji-sato",
    rank: 3,
    role: "Senior Writer",
    bio: "Kenji Sato is a senior writer at AsiaGolfReview. He writes about how courses are built and run, and about the players and events that fill them.",
  },
  {
    name: "Ha Tran",
    slug: "ha-tran",
    rank: 4,
    role: "Senior Reporter",
    bio: "Ha Tran is a senior reporter at AsiaGolfReview. She follows Vietnam's course boom from groundbreaking to first tee, and the trips that come after.",
  },
  {
    name: "Daniel Wong",
    slug: "daniel-wong",
    rank: 5,
    role: "Contributing Editor",
    bio: "Daniel Wong is a contributing editor at AsiaGolfReview. He writes features and interviews, plus the occasional itinerary when a good story needs a long weekend.",
  },
];

// PENDING OWNER: tag set may change (D6). The Press Room chips filter by these; hidden-gems / new-renovated replace the proposal's sub-sections.
export const AGR_TAGS: readonly AgrTag[] = [
  { slug: "courses", title: "Courses" },
  { slug: "development", title: "Development" },
  { slug: "travel", title: "Travel" },
  { slug: "gear", title: "Gear" },
  { slug: "tournaments", title: "Tournaments" },
  { slug: "hidden-gems", title: "Hidden Gems" },
  { slug: "new-renovated", title: "New & Renovated" },
];

/** Tenant field sheet, as data (the owner enters it by hand in /admin; this file never creates the tenant). */
export const AGR_TENANT_FIELDS = {
  name: "AsiaGolfReview",
  slug: AGR_TENANT_SLUG,
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
    titleSuffix: "- AsiaGolfReview",
    // PENDING OWNER: wording
    defaultMetaDescription:
      "Independent golf course reviews, Asia's Top 100 rankings and practical golf travel guides for Vietnam, Thailand, Japan and beyond, published from Singapore.",
  },
  // PENDING OWNER: editorial/general mailboxes (same pattern as aer)
  contact: {
    editorial: "editor@asiagolfreview.com",
    general: "info@asiagolfreview.com",
    advertising: "info@asiapresscentre.com",
    partnerships: "info@asiapresscentre.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface AgrFixture {
  pillars: AgrPillar[];
  subSections: AgrSubSection[];
  newsletters: AgrNewsletter[];
  authors: AgrAuthor[];
  tags: AgrTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildAgrFixture(opts: { authorOverrides?: AuthorOverrides } = {}): AgrFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: AGR_PILLARS.map((p) => ({ ...p })),
    subSections: AGR_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: AGR_NEWSLETTERS.map((n) => ({ ...n })),
    authors: AGR_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: AGR_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateAgrFixture(f: AgrFixture = buildAgrFixture()): string[] {
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
  for (const slug of [...(SINGLE_HOME_PILLARS[AGR_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[AGR_TENANT_SLUG] ?? [])]) {
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
  row: AgrPillar | AgrSubSection | AgrNewsletter | AgrAuthor | AgrTag;
}

type Row = Record<string, unknown>;
export interface AgrExisting {
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
export function planAgr(fixture: AgrFixture, existing: AgrExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = AGR_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
