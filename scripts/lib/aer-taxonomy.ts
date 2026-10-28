/**
 * Asia Economic Review (tenant `aer`) taxonomy fixture: the SINGLE
 * source of truth for the AER pillars, sub-sections, newsletter, authors and
 * tags, consumed by `scripts/audit/add-aer-taxonomy.ts` (owner
 * script) and `scripts/lib/aer-taxonomy.test.ts`. Mirrors
 * `scripts/lib/vowasia-taxonomy.ts` (aer launch W2, owner decisions 19-10-26).
 * PURE module: no Payload, no DB, no network; only `src/lib/constants.ts` is
 * imported.
 *
 * Exported shapes (a CONTRACT: the content-engine aer
 * publication and its taxonomy parity check read AER_PILLARS,
 * AER_SUBSECTIONS and AER_AUTHORS from this file):
 * same field shapes as the vowasia fixture (pillar, sub-section, newsletter,
 * author, tag; Tags have slug + title, NO `name`).
 *
 * Source: the aer-launch plan delta §2 (content-engine
 * process/features/aer-launch/active/aer-launch_19-10-26/), taken from the
 * approved Claude Design "Asia Economic Review.html". Pillar order = design
 * menu order. Sub-section slugs follow the gtp convention (kebab-case label,
 * `&` dropped) and are unique across the tenant.
 *
 * `engineWritable` and `singleHome` are DERIVED from the constants. AER has NO
 * single-home pillar (no SINGLE_HOME_PILLARS entry: it publishes no press
 * releases); engine-blocked pillars are `long-view`, `interviews`, `in-focus`.
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const AER_TENANT_SLUG = "aer";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface AerPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface AerSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
}
export interface AerNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface AerAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface AerTag {
  slug: string;
  title: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[AER_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[AER_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<AerPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "asia-watch",
    title: "Asia Watch",
    order: 1,
    description:
      "News and reporting on policy, trade, finance, industry and energy, and on the people and places behind the numbers.",
  },
  {
    slug: "briefings",
    title: "Briefings",
    order: 2,
    description: "One question, one evidenced answer, published through the week.",
  },
  {
    slug: "corporate-asia",
    title: "Corporate Asia",
    order: 3,
    description: "The companies that move the region's economy, analysed at strategy level.",
  },
  {
    slug: "interviews",
    title: "The Review Interview",
    order: 4,
    description: "Extended conversations, on the record, with the people running Asia's economy.",
  },
  {
    slug: "long-view",
    title: "The Long View",
    order: 5,
    description: "Long-form analysis of Asia's economy: one argument, made well, with the evidence to check it.",
  },
  {
    slug: "in-focus",
    title: "In Focus",
    order: 6,
    description:
      "Quarterly files that examine one country or industry properly, built essay by essay into a durable reference.",
  },
];

export const AER_PILLARS: readonly AerPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string]>): AerSubSection[] =>
  rows.map(([slug, title], i) => ({ pillarSlug, slug, title, order: i + 1 }));

/** All 12 sub-sections (interviews, long-view, in-focus have none; editors add In Focus files by hand). */
export const AER_SUBSECTIONS: readonly AerSubSection[] = [
  ...SUB("asia-watch", [
    ["growth-policy", "Growth & Policy"],
    ["trade-supply-chains", "Trade & Supply Chains"],
    ["money-finance", "Money & Finance"],
    ["technology-industry", "Technology & Industry"],
    ["energy-climate", "Energy & Climate"],
  ]),
  ...SUB("briefings", [
    ["policy", "Policy"],
    ["markets", "Markets"],
    ["industry", "Industry"],
    ["companies", "Companies"],
  ]),
  ...SUB("corporate-asia", [
    ["capital", "Capital"],
    ["strategy", "Strategy"],
    ["leadership", "Leadership"],
  ]),
];

export const AER_NEWSLETTERS: readonly AerNewsletter[] = [
  {
    slug: "weekly-review",
    name: "The Weekly Review",
    cadence: "Every Sunday",
    description: "The week in Asia's economy, read and explained.", // PENDING OWNER: wording
    order: 1,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to the content-engine aer
 * byline pool (intake matches `authors.name` with `equals`). Names from the old
 * site's Team page (owner 19-10-26). General roles, no city, no shared
 * "editorial team" byline.
 */
// Bio wording and roles confirmed by the owner 28-10-26 (editable in /admin or with --authors-file).
export const AER_AUTHORS: readonly AerAuthor[] = [
  {
    name: "Lena Ho",
    slug: "lena-ho",
    rank: 1,
    role: "Editor",
    bio: "Lena Ho is an editor at Asia Economic Review. She looks at how decisions on interest rates, regulation and trade change the costs and choices facing businesses in the region.",
  },
  {
    name: "Arjun Menon",
    slug: "arjun-menon",
    rank: 2,
    role: "Senior Writer",
    bio: "Arjun Menon is a senior writer at Asia Economic Review. He writes about companies, capital and the business decisions that sit behind the region's economic data.",
  },
  {
    name: "Mei Fong Chua",
    slug: "mei-fong-chua",
    rank: 3,
    role: "Senior Writer",
    bio: "Mei Fong Chua is a senior writer at Asia Economic Review. She writes about the slower forces that shape Asia's economies, from ageing populations to changing cities and workforces.",
  },
  {
    name: "Rahul Sethi",
    slug: "rahul-sethi",
    rank: 4,
    role: "Contributing Editor",
    bio: "Rahul Sethi is a contributing editor at Asia Economic Review. He writes about growth, trade and industrial policy, and about the evidence behind the region's big economic debates.",
  },
];

// PENDING OWNER: tag set may change (D6)
export const AER_TAGS: readonly AerTag[] = [
  { slug: "china", title: "China" },
  { slug: "india", title: "India" },
  { slug: "japan", title: "Japan" },
  { slug: "south-korea", title: "South Korea" },
  { slug: "indonesia", title: "Indonesia" },
  { slug: "vietnam", title: "Vietnam" },
];

/** Tenant field sheet, as data (the owner enters it by hand in /admin; this file never creates the tenant). */
export const AER_TENANT_FIELDS = {
  name: "Asia Economic Review",
  slug: AER_TENANT_SLUG,
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
    titleSuffix: "- Asia Economic Review",
    // PENDING OWNER: wording
    defaultMetaDescription: "Independent reporting and analysis on Asia's economy: policy, trade, markets and the companies that move the region.",
  },
  contact: {
    editorial: "editor@asiaeconomicreview.com",
    general: "info@asiaeconomicreview.com",
    advertising: "info@asiapresscentre.com",
    partnerships: "info@asiapresscentre.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface AerFixture {
  pillars: AerPillar[];
  subSections: AerSubSection[];
  newsletters: AerNewsletter[];
  authors: AerAuthor[];
  tags: AerTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildAerFixture(opts: { authorOverrides?: AuthorOverrides } = {}): AerFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: AER_PILLARS.map((p) => ({ ...p })),
    subSections: AER_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: AER_NEWSLETTERS.map((n) => ({ ...n })),
    authors: AER_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: AER_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateAerFixture(f: AerFixture = buildAerFixture()): string[] {
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
  for (const slug of [...(SINGLE_HOME_PILLARS[AER_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[AER_TENANT_SLUG] ?? [])]) {
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
  row: AerPillar | AerSubSection | AerNewsletter | AerAuthor | AerTag;
}

type Row = Record<string, unknown>;
export interface AerExisting {
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
export function planAer(fixture: AerFixture, existing: AerExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = AER_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
