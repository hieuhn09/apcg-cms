/**
 * Seed the SYNTHETIC legacy GTP database (gtp-launch P4, A4, 8.1). FAKE DATA
 * ONLY: titles start with "[FIXTURE]", e-mails end in @example.invalid, site
 * ids are the neutral fixture uuids `...f001` (slug gtp) and `...f002` (slug
 * wtb, the twin that must never be read). Deterministic (seeded PRNG).
 *
 *   npx tsx scripts/migrate/fixtures/gtp-legacy/seed-gtp-legacy-fixture.ts [--rows 300 | --full | --small]
 *
 * Env: LEGACY_FIXTURE_ADMIN_URL (default postgres://postgres:password@127.0.0.1:54327/gtp_legacy),
 * GTP_FIXTURE_IMAGES_DIR (default scripts/migrate/out/fixture-images). Local hosts only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { assertLocalDb } from "../../../lib/local-db-guard";
import { assertOutDirSafe, repoRoot } from "../../lib/out-dir";

export const GTP_SITE = "00000000-0000-0000-0000-00000000f001";
export const WTB_SITE = "00000000-0000-0000-0000-00000000f002";
export const IMAGE_HOST = "images.fixture.invalid";
export const OLD_ORIGIN = "https://www.globaltravelpost.com";

const ADMIN_URL = process.env.LEGACY_FIXTURE_ADMIN_URL ?? "postgres://postgres:password@127.0.0.1:54327/gtp_legacy";
const IMAGES_DIR = process.env.GTP_FIXTURE_IMAGES_DIR ?? path.join(repoRoot(), "scripts/migrate/out/fixture-images");

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(n: number, prefix = "a"): string {
  const h = n.toString(16).padStart(12, "0");
  return `${prefix.repeat(8)}-0000-4000-8000-${h}`;
}

const SUBS: [string, string, number][] = [
  ["news", "aviation", 403], ["news", "hotels", 100], ["news", "destinations-news", 99], ["news", "travel-tech", 95], ["news", "visa-entry", 86],
  ["business-of-travel", "hospitality-business", 190], ["business-of-travel", "aviation-business", 144], ["business-of-travel", "data-insights", 124],
  ["business-of-travel", "destination-marketing", 91], ["business-of-travel", "people", 41],
  ["experiences-luxury", "luxury-stays", 54], ["experiences-luxury", "food-drink", 28], ["experiences-luxury", "style", 26], ["experiences-luxury", "journeys", 24], ["experiences-luxury", "wellness", 13],
  ["destinations", "guides", 29], ["destinations", "asia", 24], ["destinations", "world", 17], ["destinations", "trip-planning", 14],
];
const BYLINES = ["Daniel Cheong", "Priya Nair", "Marcus Tan", "Clara Widjaja", "Yuki Hamada"];
const FOREIGN = ["Simon Ng", "Ryan Ng", "Valerie Nguyen", "BriefAsia", ""];
const FORMATS: [string, number][] = [["news", 1497], ["guide", 80], ["analysis", 35], ["review", 13], ["interview", 4], ["none", 8]];
const WORDS = ["harbour", "runway", "lounge", "visa", "island", "summit", "rail", "market", "season", "resort", "skyline", "festival", "corridor", "monsoon", "atelier"];

export interface FixtureExpected {
  gtpArticles: number;
  byStatus: Record<string, number>;
  rejectedOrInvalid: number;
  importable: number;
  heroWithImage: number;
  heroBroken: string[];
  events: { total: number; duplicates: number; near: number; inactive: number; importable: number };
  wtbArticles: number;
  internalLinkFrom: string;
  internalLinkTo: string;
  xssLegacyIds: string[];
  slugsShared: string[];
  calendar: number;
}

function pickWeighted<T>(r: () => number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    if ((x -= w) < 0) return v;
  }
  return (items[items.length - 1] as [T, number])[0];
}

function iso(d: Date): string {
  return d.toISOString();
}

async function makeImage(file: string, seed: number): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const color = { r: (seed * 37) % 255, g: (seed * 91) % 255, b: (seed * 53) % 255 };
  const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg({ quality: 70 }).toBuffer();
  writeFileSync(file, buf);
}

async function main() {
  const argv = process.argv.slice(2);
  const full = argv.includes("--full");
  const small = argv.includes("--small");
  const ri = argv.indexOf("--rows");
  const rows = full ? 1637 : small ? 60 : ri >= 0 ? Number(argv[ri + 1]) : 300;
  const wtbRows = full ? 400 : small ? 20 : 80;
  assertLocalDb(ADMIN_URL);
  assertOutDirSafe(IMAGES_DIR);
  const r = rng(20261012);
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  const schemaSql = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "schema.sql"), "utf8");
  await client.query(schemaSql);

  await client.query("INSERT INTO sites (id, slug, name, domain, config) VALUES ($1,'gtp','[FIXTURE] Global Travel Post','gtp.fixture.invalid','{}'), ($2,'wtb','[FIXTURE] World Travel Brief','wtb.fixture.invalid','{}')", [GTP_SITE, WTB_SITE]);

  // ── Status plan (real ratios 1157/411/68/1 plus one invalid value) ──
  const nRej = 1;
  const nInvalid = 1;
  const nDraft = Math.max(2, Math.round((rows * 68) / 1637));
  const nArch = Math.max(3, Math.round((rows * 411) / 1637));
  const nPub = rows - nDraft - nArch - nRej - nInvalid;
  // The first 52 rows (special cases) are published; the rest are shuffled deterministically.
  const rest: string[] = [...Array(nPub - 52).fill("published"), ...Array(nArch).fill("archived"), ...Array(nDraft).fill("draft"), "rejected", "deleted"];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [rest[i], rest[j]] = [rest[j] as string, rest[i] as string];
  }
  const statuses: string[] = [...Array(52).fill("published"), ...rest];

  // ── Taxonomy plan: specials first ──
  const tax: [string, string][] = [];
  for (let i = 0; i < 16; i++) tax.push(["events-awards", "industry-calendar"]);
  tax.push(["news", ""], ["destinations", ""], ["business-of-travel", ""], ["experiences-luxury", ""]);
  tax.push(["news", "destination-marketing"], ["news", "aviation-business"], ["business-of-travel", "travel-tech"]);
  while (tax.length < rows) tax.push(pickWeighted(r, SUBS.map(([s, sub, w]) => [[s, sub] as [string, string], w])));

  const expected: FixtureExpected = {
    gtpArticles: rows, byStatus: {}, rejectedOrInvalid: 2, importable: rows - 2, heroWithImage: 0, heroBroken: [],
    events: { total: 15, duplicates: 2, near: 1, inactive: 1, importable: 12 }, wtbArticles: wtbRows, internalLinkFrom: "", internalLinkTo: "",
    xssLegacyIds: [], slugsShared: [], calendar: 16,
  };
  const base = Date.UTC(2026, 6, 25, 1, 0, 0); // 2026-07-25 (site launch)
  const articleRows: Record<string, unknown>[] = [];
  const calendar: { title: string; date: string }[] = [];
  for (let i = 0; i < rows; i++) {
    const id = uuidFrom(i + 1);
    const st = statuses[i] as string;
    const [section] = tax[i] as [string, string];
    const created = new Date(base + i * 3_600_000 * 7);
    const published = st === "published" || st === "archived" ? new Date(created.getTime() + 600_000) : null;
    const updated = new Date(created.getTime() + 86_400_000 * (1 + (i % 9)));
    const w = WORDS[i % WORDS.length] as string;
    const title = section === "events-awards" ? `[FIXTURE] Calendar ${w} expo ${i}` : `[FIXTURE] ${w} ${WORDS[(i * 7) % WORDS.length]} story ${i}`;
    let slug: string | null = `fixture-${w}-story-${i}`;
    if (i === 30) slug = "Upper-Case-Slug-30";
    if (i === 31 || i === 32) slug = null; // derive from title
    if (i === 33) slug = "news"; // reserved word
    if (i === 34) slug = "under_score_34";
    if (i === 35 || i === 36) slug = "fixture-shared-slug"; // duplicate slug, different sections (old URLs differ)
    if (i === 36) tax[i] = ["destinations", "asia"];
    const [sec2, sub2] = tax[i] as [string, string];
    const bylinePool = i % 11 === 0 ? FOREIGN[i % FOREIGN.length] : BYLINES[i % BYLINES.length];
    const format = i < 5 ? (["guide", "analysis", "review", "interview", "none"][i] as string) : pickWeighted(r, FORMATS);
    const noImage = i % 33 === 7;
    // Failing images are spread out so no 50-image window exceeds the 2% media failure budget.
    const broken = i === 37 || (rows > 150 && i === 150);
    const evil = rows > 260 && i === 260;
    let featured: string | null = null;
    if (!noImage) {
      const p = broken ? `/storage/v1/object/public/media/featured/missing-${i}.jpg` : evil ? "/special/redirect-evil.jpg" : `/storage/v1/object/public/media/featured/${id}.jpg`;
      featured = `https://${IMAGE_HOST}${p}`;
      if (!broken && !evil) {
        await makeImage(path.join(IMAGES_DIR, "storage/v1/object/public/media/featured", `${id}.jpg`), i + 1);
        expected.heroWithImage++;
      } else expected.heroBroken.push(id);
    }
    const sections: unknown[] = [
      { heading: { en: i % 4 === 0 ? "" : `Why ${w} matters` }, body: { en: `Paragraph one about ${w}.\nSame paragraph continues.\n\nParagraph two with figures ${i}.` } },
    ];
    if (i === 10) {
      sections.push({ heading: { en: "Escapes" }, body: { en: "Tags <script>alert(1)</script> & an <img src=x onerror=alert(2)> stay text; 5 < 6 & 7 > 3." } });
      expected.xssLegacyIds.push(id);
    }
    if (i === 11) sections.push({ heading: { en: "" }, body: { en: "  " } }); // dropped section
    if (i === 12) {
      expected.internalLinkFrom = id;
      expected.internalLinkTo = uuidFrom(51);
      const [t50sec] = tax[50] as [string, string];
      sections.push({ heading: { en: "Related" }, body: { en: `Read more at ${OLD_ORIGIN}/${t50sec}/fixture-${WORDS[50 % WORDS.length]}-story-50 and ${OLD_ORIGIN}/news/deleted-story.` } });
    }
    sections.push({ heading: { en: "Asian perspective" }, body: { en: `What this means for travellers in Asia (${i}).` } });
    const sourceUrl = i % 17 === 5 ? null : i === 20 || i === 21 || i === 22 ? "https://source.fixture.invalid/shared-story" : `https://source.fixture.invalid/story-${i}`;
    const countries = i % 5 === 0 ? ["SG", "jp", "XX"] : i % 5 === 1 ? ["japan"] : [];
    if (section === "events-awards" && published) calendar.push({ title, date: published.toISOString().slice(0, 10) });
    articleRows.push({
      id, site_id: GTP_SITE, slug, title: { en: title }, excerpt: { en: `[FIXTURE] Excerpt ${i}` }, kicker: { en: "Fixture" },
      body_sections: sections, seo: i % 9 === 0 ? { title: "custom" } : {}, citations: [], takeaways: i % 6 === 0 ? ["First takeaway", "Second takeaway"] : [],
      status: st, section: sec2, subsection: sub2, tags: i % 3 === 0 ? ["Hong Kong", "visa", "Visa "] : ["airlines"], label: "news", region: "asia", category: null,
      format, featured: i % 13 === 0, read_minutes: i % 8 === 0 ? null : i % 8 === 1 ? 0 : 4, featured_image: featured,
      featured_image_credit: featured ? `Photo: Fixture Photographer ${i % 7} / Pexels` : null, source_id: null, source_url: sourceUrl,
      byline: bylinePool, countries, published_at: i === 25 ? null : published ? iso(published) : null, scheduled_at: null,
      created_at: iso(created), updated_at: iso(updated), is_hero: i % 29 === 0, editor_hold: false, migrate_source: i % 50 === 0 ? "hub-manual" : "scrape_rss",
      ai_model: "fixture-model", ai_score: 70 + (i % 30),
    });
  }
  expected.byStatus = {};
  for (const a of articleRows) expected.byStatus[String(a.status)] = (expected.byStatus[String(a.status)] ?? 0) + 1;
  // WTB twin rows: share some slugs, different byline/section.
  for (let i = 0; i < wtbRows; i++) {
    const shared = i < 10 ? `fixture-${WORDS[i % WORDS.length]}-story-${i}` : `wtb-only-${i}`;
    if (i < 10) expected.slugsShared.push(shared);
    articleRows.push({
      id: uuidFrom(i + 1, "b"), site_id: WTB_SITE, slug: shared, title: { en: `[FIXTURE] WTB twin ${i}` }, excerpt: { en: "wtb" }, kicker: null,
      body_sections: [{ heading: { en: "WTB" }, body: { en: "Must never be read." } }], seo: {}, citations: [], takeaways: [],
      status: "published", section: "world", subsection: "", tags: [], label: "news", region: null, category: null, format: "news", featured: false,
      read_minutes: 3, featured_image: null, featured_image_credit: null, source_id: null, source_url: `https://source.fixture.invalid/wtb-${i}`,
      byline: "WTB Writer", countries: [], published_at: iso(new Date(base)), scheduled_at: null, created_at: iso(new Date(base + i * 1000)),
      updated_at: iso(new Date(base + i * 1000)), is_hero: false, editor_hold: false, migrate_source: "scrape_rss", ai_model: null, ai_score: null,
    });
  }
  const cols = Object.keys(articleRows[0] as object);
  for (const a of articleRows) {
    const vals = cols.map((c) => {
      const v = a[c];
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
      if (Array.isArray(v) && (c === "body_sections" || c === "citations" || c === "takeaways")) return JSON.stringify(v);
      return v;
    });
    await client.query(`INSERT INTO articles (${cols.join(",")}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(",")})`, vals);
  }

  // ── Events: 15 (2 duplicates of calendar articles, 1 near duplicate, 1 inactive) ──
  const evs: Record<string, unknown>[] = [];
  const c0 = calendar[0] as { title: string; date: string };
  const c1 = calendar[1] as { title: string; date: string };
  const c2 = calendar[2] as { title: string; date: string };
  evs.push({ id: "ev-dup-1", title: c0.title, date_start: c0.date, date_end: c0.date, location: "Singapore", category: "Expo", url: "https://events.fixture.invalid/a", note: "dup", active: true });
  evs.push({ id: "ev-dup-2", title: c1.title.toUpperCase() + "!", date_start: c1.date, date_end: null, location: "Tokyo", category: "Expo", url: "", note: "dup", active: true });
  const nearDate = new Date(Date.parse(c2.date) + 86_400_000).toISOString().slice(0, 10);
  evs.push({ id: "ev-near-1", title: `${c2.title}.`.replace("expo", "expos"), date_start: nearDate, date_end: nearDate, location: "Bangkok", category: "Summit", url: "", note: "", active: true });
  evs.push({ id: "ev-inactive", title: "[FIXTURE] Retired Travel Fair", date_start: "2026-08-01", date_end: "2026-08-03", location: "Seoul", category: "Fair", url: "https://events.fixture.invalid/retired", note: "Cancelled.", active: false });
  for (let i = 0; i < 11; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i * 3)).toISOString().slice(0, 10);
    evs.push({ id: `ev-${i}`, title: `[FIXTURE] Industry Event ${WORDS[i]} ${i}`, date_start: d, date_end: i % 2 ? d : new Date(Date.parse(d) + 2 * 86_400_000).toISOString().slice(0, 10), location: i % 3 ? "Hong Kong" : "", category: "Conference", url: i % 2 ? `https://events.fixture.invalid/e${i}` : "", note: i % 4 ? `Note ${i}.` : "", active: true });
  }
  for (const e of evs) {
    await client.query("INSERT INTO events (id, site_id, date_start, date_end, title, location, category, url, note, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)", [e.id, GTP_SITE, e.date_start, e.date_end, e.title, e.location, e.category, e.url, e.note, e.active]);
  }
  await client.query("INSERT INTO events (id, site_id, date_start, title, active) VALUES ('wtb-ev-1', $1, '2026-10-10', '[FIXTURE] WTB event', true)", [WTB_SITE]);

  // ── Side tables ──
  for (let i = 0; i < 30; i++) {
    await client.query("INSERT INTO visa_rules (site_id, country, country_code, region, headline, summary, status, effective_date, verified_at, source_name, source_url, related_slug, active, created_at, updated_at) VALUES ($1,$2,$3,'asia',$4,'[FIXTURE] summary','open','2026-09-01',$5,'Fixture Gov','https://gov.fixture.invalid',NULL,true,$5,$5)", [GTP_SITE, `Country ${i}`, `C${String(i).padStart(2, "0")}`, `[FIXTURE] Visa rule ${i}`, iso(new Date(base + i * 1000))]);
  }
  for (let i = 0; i < 6; i++) {
    await client.query("INSERT INTO press_submissions (site_id, company, contact_name, contact_email, title, body, category, status, created_at) VALUES ($1,$2,$3,$4,$5,'[FIXTURE] body','press','new',$6)", [GTP_SITE, `Fixture Co ${i}`, `Fixture Contact ${i}`, `contact${i}@example.invalid`, `[FIXTURE] Release ${i}`, iso(new Date(base + i * 1000))]);
  }
  for (let i = 0; i < 16; i++) {
    await client.query("INSERT INTO gtp_subscribers (site_id, email, newsletter, source, created_at) VALUES ($1,$2,'the-post','footer',$3)", [GTP_SITE, `sub${i}@example.invalid`, iso(new Date(base + i * 1000))]);
  }
  await client.query("INSERT INTO gtp_subscribers (site_id, email, newsletter, created_at) VALUES ($1,'wtb-sub@example.invalid','wtb',now())", [WTB_SITE]);
  for (const [i, n] of BYLINES.entries()) {
    await client.query("INSERT INTO site_authors_base (site_id, slug, name, bio, beats, email) VALUES ($1,$2,$3,'[FIXTURE] bio',ARRAY['aviation'],$4)", [GTP_SITE, n.toLowerCase().replace(/ /g, "-"), n, `author${i}@example.invalid`]);
  }
  for (let i = 0; i < 5; i++) {
    await client.query("INSERT INTO media_assets (site_id, storage_path, public_url, source, license, credit, used_count) VALUES ($1,$2,$3,'pexels','Pexels','Fixture / Pexels',1)", [GTP_SITE, `media/library/${i}.jpg`, `https://${IMAGE_HOST}/media/library/${i}.jpg`]);
    await client.query("INSERT INTO scraping_sources (site_id, name, feed_url, is_active) VALUES ($1,$2,$3,true)", [GTP_SITE, `Fixture source ${i}`, `https://feeds.fixture.invalid/${i}.xml`]);
  }
  await client.query("INSERT INTO article_review_queue (article_id, status, reviewer_notes) VALUES ($1, 'pending', 'CANARY-SECRET-review')", [uuidFrom(1)]);
  await client.query("INSERT INTO secret_table_a (site_id, payload) VALUES ($1, 'CANARY-SECRET-A')", [GTP_SITE]);
  await client.query("INSERT INTO secret_table_b (token) VALUES ('CANARY-SECRET-B')");
  await client.query("INSERT INTO secret_table_c (refresh_token) VALUES ('CANARY-SECRET-C')");
  await client.query("INSERT INTO secret_table_d (session_secret) VALUES ('CANARY-SECRET-D')");
  await client.end();

  // Special images for the hybrid G36 checks.
  mkdirSync(path.join(IMAGES_DIR, "special"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(IMAGES_DIR, "special", "wrong-magic.jpg"), "this is not an image");
  const outFile = path.join(path.dirname(IMAGES_DIR), "fixture-expected.json");
  writeFileSync(outFile, JSON.stringify(expected, null, 2) + "\n", { mode: 0o600 });
  console.log(`[fixture] seeded ${rows} gtp articles (${JSON.stringify(expected.byStatus)}), ${wtbRows} wtb twins, ${evs.length} events; images in ${IMAGES_DIR}`);
}

main().catch((err) => {
  console.error("[fixture] seed failed:", (err as Error).message);
  process.exit(1);
});
