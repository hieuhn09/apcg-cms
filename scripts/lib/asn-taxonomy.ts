/**
 * Asianomist (tenant `asn`) taxonomy fixture: the SINGLE source of truth for
 * the ASN pillars, sub-sections, newsletters, authors and tags, consumed by
 * `scripts/audit/add-asn-taxonomy.ts` (owner script) and
 * `scripts/lib/asn-taxonomy.test.ts`. Mirrors `scripts/lib/amb-taxonomy.ts`
 * (asn launch W2, owner decisions and agent defaults 05-11-26), without the
 * amb exhibition halls (Asianomist has no booths).
 * PURE module: no Payload, no DB, no network; only `src/lib/constants.ts` is
 * imported.
 *
 * Exported shapes (a CONTRACT: the content-engine asn publication and its
 * taxonomy parity check read ASN_PILLARS, ASN_SUBSECTIONS and ASN_AUTHORS from
 * this file): same field shapes as the amb fixture (pillar, sub-section,
 * newsletter, author, tag; Tags have slug + title, NO `name`), plus an
 * informational sub-section `description` (the design's copy; SubSections has
 * no description field, so it is never written to Central, like amb).
 *
 * Source: the asn-launch plan delta §2 (content-engine
 * process/features/asn-launch/active/asn-launch_05-11-26/), taken from the
 * approved Claude Design "Asianomist Website.dc.html" (`SEC`: `t` = title,
 * `d` = description; the design wins over the .docx proposal). Pillar order =
 * design menu order (The Brief, Economies, Markets, Banking & Fintech,
 * Industries, Wealth, Columns, Explainers), then Press Room (footer). Pillar
 * slugs reuse the old site's URLs where they exist (`/economies`, `/markets`,
 * ...); the legacy combined `columns-explainers` pillar is split in two.
 * Pillar and sub-section titles and descriptions = the design's text,
 * verbatim, EXCEPT that the design's typographic apostrophe (U+2019) is
 * written as the ASCII apostrophe, like every other fixture in this folder
 * (British spelling: "neighbours", "licences", "centre", "labelled"; the design
 * uses commas and colons, no em/en dash). Sub-section slugs are unique across
 * the tenant.
 *
 * `engineWritable` and `singleHome` are DERIVED from the constants. ASN's one
 * single-home pillar is `press-room` (hyphenated, like gtp/vowasia/agr/amb),
 * so it has NO sub-sections. Engine-blocked: `the-brief`, `columns`,
 * `explainers`, `press-room` (agent default from the old site's
 * `taxonomy_ai_excluded`, split per the design). Unlike amb there is no
 * engine-excluded sub-section.
 */
import { ENGINE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS } from "../../src/lib/constants";

export const ASN_TENANT_SLUG = "asn";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface AsnPillar {
  slug: string;
  title: string;
  heading: string;
  description: string;
  order: number;
  color: string;
  engineWritable: boolean;
  singleHome: boolean;
}
export interface AsnSubSection {
  pillarSlug: string;
  slug: string;
  title: string;
  order: number;
  description: string; // design copy, informational (SubSections has no description field)
}
export interface AsnNewsletter {
  slug: string;
  name: string;
  cadence: string;
  description: string;
  order: number;
  active: true;
}
export interface AsnAuthor {
  name: string;
  slug: string;
  rank?: number;
  role: string;
  bio?: string;
  city?: string;
}
export interface AsnTag {
  slug: string;
  title: string;
}

/* ── Fixture data ───────────────────────────────────────────────────────── */

const blocked = (slug: string) => (ENGINE_BLOCKED_PILLARS[ASN_TENANT_SLUG] ?? []).includes(slug);
const singleHome = (slug: string) => (SINGLE_HOME_PILLARS[ASN_TENANT_SLUG] ?? []).includes(slug);

const PILLAR_ROWS: Array<Omit<AsnPillar, "engineWritable" | "singleHome" | "heading" | "color">> = [
  {
    slug: "the-brief",
    title: "The Brief",
    order: 1,
    description: "Our flagship daily newsletter, archived here in full. Asia's economy in five minutes, every weekday morning.",
  },
  {
    slug: "economies",
    title: "Economies",
    order: 2,
    description: "Growth, inflation and economic policy across Asia, reported country by country and connected region-wide.",
  },
  {
    slug: "markets",
    title: "Markets",
    order: 3,
    description: "The Asian trading day as it happens: currencies, stocks, bonds and deals, with context.",
  },
  {
    slug: "banking-fintech",
    title: "Banking & Fintech",
    order: 4,
    description: "Banks, digital lenders and payments across Asia, and the technology behind them.",
  },
  {
    slug: "industries",
    title: "Industries",
    order: 5,
    description: "Asia's real economy, sector by sector: manufacturing, energy, retail and property.",
  },
  {
    slug: "wealth",
    title: "Wealth",
    order: 6,
    description: "Personal finance for professionals in Asia, covering investing, saving, property and pay, reported to the same standards as our news.",
  },
  {
    slug: "columns",
    title: "Columns",
    order: 7,
    description: "Signed opinion on Asia's economy and markets, sourced and clearly labelled.",
  },
  {
    slug: "explainers",
    title: "Explainers",
    order: 8,
    description: "Short guides to how Asia's economies and markets work, each readable in five minutes.",
  },
  {
    slug: "press-room",
    title: "Press Room",
    order: 9,
    description: "Announcements from companies and institutions, published in full and clearly labelled, separate from our editorial coverage.",
  },
];

export const ASN_PILLARS: readonly AsnPillar[] = PILLAR_ROWS.map((p) => ({
  ...p,
  heading: p.title,
  color: "var(--accent)",
  engineWritable: !blocked(p.slug),
  singleHome: singleHome(p.slug),
}));

const SUB = (pillarSlug: string, rows: Array<[string, string, string]>): AsnSubSection[] =>
  rows.map(([slug, title, description], i) => ({ pillarSlug, slug, title, order: i + 1, description }));

/**
 * All 17 sub-sections (banking-fintech, wealth, columns, explainers and
 * press-room have none; press-room by the single-home rule). The Brief's
 * Morning Brief edition is an article in `the-brief` with NO sub-section.
 */
export const ASN_SUBSECTIONS: readonly AsnSubSection[] = [
  ...SUB("the-brief", [
    ["week-ahead", "The Week Ahead", "The Sunday edition: the data releases, central-bank meetings and earnings that will shape the week in Asia."],
    ["weekend-read", "Weekend Read", "One story worth your Saturday: the week's best analysis, chosen and introduced by our editors."],
  ]),
  ...SUB("economies", [
    ["southeast-asia", "Southeast Asia", "Our home beat: Indonesia, Vietnam, Thailand, the Philippines, Malaysia and Singapore, covered with the depth the region rarely gets in English."],
    ["china", "China", "The region's largest economy, covered for what it means to business: demand, supply chains, policy and prices."],
    ["japan-korea", "Japan & Korea", "North Asia's industrial economies: the yen, the won and the companies built on both."],
    ["india-south-asia", "India & South Asia", "The fastest-growing large economy and its neighbours, from manufacturing incentives to market flows."],
    ["asia-world", "Asia & the World", "Trade, investment and capital flows between Asia and the rest of the world, measured in costs and volumes."],
  ]),
  ...SUB("markets", [
    ["markets-today", "Markets Today", "The daily close across Asia's markets: what moved, why, and what to watch tomorrow."],
    ["central-banks-currencies", "Central Banks & Currencies", "Every rate decision and major currency in the region, from the MAS to the BOJ, previewed, reported and explained."],
    ["stocks-bonds", "Stocks & Bonds", "Asia's equity and debt markets: the movers, the flows and the numbers behind them."],
    ["ipo-deals", "IPO & Deals", "Listings, mergers and funding rounds across the region, with the terms of each deal."],
    ["crypto-digital-assets", "Crypto & Digital Assets", "Digital assets covered like any other market: prices, regulation, licences and the businesses being built."],
  ]),
  ...SUB("industries", [
    ["supply-chain", "Supply Chain & the China+1 Shift", "Where factories, orders and investment are moving across Asia, tracked through company announcements, incentives and costs."],
    ["tech-semiconductors", "Tech & Semiconductors", "The chips, hardware and technology companies at the centre of Asia's economy and the world's."],
    ["energy-commodities", "Energy & Commodities", "The fuels, metals and crops that power the region, and the prices that discipline them."],
    ["consumer-retail", "Consumer & Retail", "Consumer companies, e-commerce and spending data across Asia."],
    ["real-estate-infrastructure", "Real Estate & Infrastructure", "Property markets and infrastructure projects: offices, housing, logistics parks, ports and power."],
  ]),
];

// PENDING OWNER: check the slugs against the old site's newsletter form at the discovery step.
// Names, cadences and descriptions = the design's Newsletters page (apostrophes ASCII).
export const ASN_NEWSLETTERS: readonly AsnNewsletter[] = [
  {
    slug: "the-brief",
    name: "The Brief",
    cadence: "Every weekday morning",
    description: "Asia's economy in five minutes, every weekday morning: what moved overnight, what it means, and one chart worth your attention. Written for people who make decisions about Asia before lunch.",
    order: 1,
    active: true,
  },
  {
    slug: "the-week-ahead",
    name: "The Week Ahead",
    cadence: "Sunday evenings",
    description: "The Sunday edition: every data release, central-bank meeting and earnings date that matters in Asia next week, with a line on why.",
    order: 2,
    active: true,
  },
];

/**
 * Bylines: char-for-char identical to the content-engine asn byline pool
 * (intake matches `authors.name` with `equals`; Mark Chen first). Names and
 * roles from the design's Team page (owner 05-11-26); bios written for the
 * launch (1-2 plain sentences, British spelling, no achievements, no
 * country/pillar beat). No city, no shared "Asianomist Desk" / newsroom byline.
 */
// PENDING OWNER: bio wording (owner to review; editable in /admin or with --authors-file)
export const ASN_AUTHORS: readonly AsnAuthor[] = [
  {
    name: "Mark Chen",
    slug: "mark-chen",
    rank: 1,
    role: "Editor",
    bio: "Mark Chen is the editor of Asianomist. He decides what the publication covers each day and reads every story before it goes out.",
  },
  {
    name: "Anna Lee",
    slug: "anna-lee",
    rank: 2,
    role: "Deputy Editor",
    bio: "Anna Lee is deputy editor at Asianomist. She runs the daily news list and edits The Brief.",
  },
  {
    name: "Linh Tran",
    slug: "linh-tran",
    rank: 3,
    role: "Senior Reporter",
    bio: "Linh Tran is a senior reporter at Asianomist. She writes about the economies, companies and markets that shape business across the region.",
  },
  {
    name: "Ken Mori",
    slug: "ken-mori",
    rank: 4,
    role: "Senior Reporter",
    bio: "Ken Mori is a senior reporter at Asianomist. He reports on markets, deals and the data behind them.",
  },
  {
    name: "Grace Ong",
    slug: "grace-ong",
    rank: 5,
    role: "Reporter",
    bio: "Grace Ong is a reporter at Asianomist. She covers daily news across the region and the numbers that come with it.",
  },
  {
    name: "Ryan Cruz",
    slug: "ryan-cruz",
    rank: 6,
    role: "Copy Editor",
    bio: "Ryan Cruz is a copy editor at Asianomist. He checks every figure, name and headline before a story is published.",
  },
];

// PENDING OWNER: tag set may change (D6); labels taken from the design.
export const ASN_TAGS: readonly AsnTag[] = [
  { slug: "china-plus-one-tracker", title: "China+1 Tracker" },
  { slug: "chart-of-the-day", title: "Chart of the Day" },
  { slug: "central-banks", title: "Central Banks" },
  { slug: "ipo", title: "IPO" },
  { slug: "supply-chain", title: "Supply Chain" },
  { slug: "asean", title: "ASEAN" },
];

/**
 * Tenant field sheet, as data (the owner enters it by hand in /admin; this file
 * never creates the tenant). `domain` / `frontendUrl` stay empty until the B6
 * cutover (asianomist.com), like every other launch.
 */
export const ASN_TENANT_FIELDS = {
  name: "Asianomist",
  slug: ASN_TENANT_SLUG,
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
    exhibition: false,
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
    titleSuffix: "| Asianomist", // the design's page titles end " | Asianomist"
    // PENDING OWNER: wording (the design's meta description, apostrophe ASCII)
    defaultMetaDescription:
      "Daily news and analysis on Asia's economies, markets and business: central banks, currencies, deals and supply chains, read in five minutes.",
  },
  // PENDING OWNER: mailboxes (the design writes info@asianomist.com for editorial and general matters, info@asiapresscentre.com for partnerships; the old site used editorial@asianomist.com)
  contact: {
    editorial: "info@asianomist.com",
    general: "info@asianomist.com",
    advertising: "info@asiapresscentre.com",
    partnerships: "info@asiapresscentre.com",
  },
  autoPublishEngineDrafts: false,
} as const;

/* ── Fixture assembly ───────────────────────────────────────────────────── */

export interface AsnFixture {
  pillars: AsnPillar[];
  subSections: AsnSubSection[];
  newsletters: AsnNewsletter[];
  authors: AsnAuthor[];
  tags: AsnTag[];
}

export type AuthorOverrides = Record<string, { role?: string; bio?: string; city?: string; slug?: string }>;

export function buildAsnFixture(opts: { authorOverrides?: AuthorOverrides } = {}): AsnFixture {
  const ov = opts.authorOverrides ?? {};
  return {
    pillars: ASN_PILLARS.map((p) => ({ ...p })),
    subSections: ASN_SUBSECTIONS.map((s) => ({ ...s })),
    newsletters: ASN_NEWSLETTERS.map((n) => ({ ...n })),
    authors: ASN_AUTHORS.map((a) => {
      const o = Object.prototype.hasOwnProperty.call(ov, a.slug) ? ov[a.slug] : undefined;
      return { ...a, ...(o ?? {}) };
    }),
    tags: ASN_TAGS.map((t) => ({ ...t })),
  };
}

const DASH_RE = /[–—]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural invariants of a fixture. Returns a list of problems (empty = valid). */
export function validateAsnFixture(f: AsnFixture = buildAsnFixture()): string[] {
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
  for (const p of f.pillars) {
    const orders = f.subSections.filter((s) => s.pillarSlug === p.slug).map((s) => s.order);
    orders.forEach((o, i) => {
      if (o !== i + 1) errs.push(`sub-section order under ${p.slug} is not 1-based contiguous`);
    });
  }
  for (const slug of [...(SINGLE_HOME_PILLARS[ASN_TENANT_SLUG] ?? []), ...(ENGINE_BLOCKED_PILLARS[ASN_TENANT_SLUG] ?? [])]) {
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
  row: AsnPillar | AsnSubSection | AsnNewsletter | AsnAuthor | AsnTag;
}

type Row = Record<string, unknown>;
export interface AsnExisting {
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
export function planAsn(fixture: AsnFixture, existing: AsnExisting): PlanItem[] {
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
export function parseAuthorsFile(json: string, knownSlugs: readonly string[] = ASN_AUTHORS.map((a) => a.slug)): AuthorOverrides {
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
