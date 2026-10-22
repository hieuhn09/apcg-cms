/**
 * LOCAL-ONLY synthetic legacy fixture for the ABB rehearsal (FAKE DATA).
 *   ABB_FIXTURE_ADMIN_URL=postgres://postgres:...@127.0.0.1:<port>/legacy node --import tsx seed-abb-fixture.ts [--delta N]
 * Without --delta: (re)creates the schema and seeds two sites: the ABB site (slug
 * "asiabeautybrief", like the real row) with 64 rows, and a decoy site whose rows
 * must never be read. Same shape as the real ABB rows (discovery 22-10-26): slug on
 * the articles table, tags text[], absolute image URLs, section `supply-side` (new
 * pillar `supply`), sub-section slugs equal to the new taxonomy, a "briefing" row
 * with no sub-section, archived and draft rows, byline "ABB Newsroom" (never kept).
 * Timestamps carry MICROSECONDS and rows 10..12 share one created_at (keyset bug).
 * With --delta N: appends N newer published ABB rows (the pre-cutover second run).
 * Images: writes small JPEGs to ABB_FIXTURE_IMAGES_DIR for the local image server.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { assertLocalDb } from "../../../../lib/local-db-guard";

export const ABB_FIXTURE_SITE_ID = "00000000-0000-0000-0000-0000000ab001";
export const DECOY_SITE_ID = "00000000-0000-0000-0000-0000000de002";
export const ABB_LEGACY_SLUG = "asiabeautybrief";
export const IMAGE_HOST = "legacy-storage.fixture.invalid";
/** [section, subsection] cycle; "" = no sub-section. */
const PLACES: readonly (readonly [string, string])[] = [
  ["briefing", "market-moves"], ["briefing", ""], ["markets", "korea"], ["supply-side", "packaging"],
  ["supply-side", "ingredients-actives"], ["trends", "trend-radar"], ["professional", "medical-aesthetics"], ["briefing", "deals-money"],
];
const STATUSES = ["published", "published", "published", "published", "published", "archived", "draft", "published"];
/** Legacy free-text tags: some slugify to approved tags (Indonesia, K-beauty Culture, devices), the rest are dropped. */
const TAGS = ["Indonesia", "k-beauty culture", "Devices", "skincare", "vietnam", "Earnings", "serum", "Thailand"];

const uuid = (n: number, prefix = "b") => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Microsecond timestamp text: base + n days, + a micro part; rows 10..12 share one instant. */
function ts(n: number): string {
  const k = n >= 10 && n <= 12 ? 10 : n;
  const d = new Date(Date.UTC(2026, 1, 1, 8, 0, 0) + k * 86_400_000 + (k % 5) * 1000);
  const micro = String(234561 + k * 7).padStart(6, "0").slice(0, 6);
  return d.toISOString().replace(/\.\d{3}Z$/, `.${micro}+00`);
}

async function main(): Promise<void> {
  const url = process.env.ABB_FIXTURE_ADMIN_URL;
  assertLocalDb(url);
  const delta = process.argv.includes("--delta") ? Number(process.argv[process.argv.indexOf("--delta") + 1]) : 0;
  const imgDir = process.env.ABB_FIXTURE_IMAGES_DIR as string;
  mkdirSync(path.join(imgDir, "storage/v1/object/public/abb"), { recursive: true });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 120, b: 150 } } }).jpeg().toBuffer();
  const img = (name: string) => {
    writeFileSync(path.join(imgDir, "storage/v1/object/public/abb", name), jpeg);
    return `https://${IMAGE_HOST}/storage/v1/object/public/abb/${name}`;
  };
  const insert = async (n: number, site: string, opts: { status?: string; created?: string } = {}) => {
    const [section, subsection] = PLACES[n % PLACES.length] as readonly [string, string];
    const status = opts.status ?? (STATUSES[n % STATUSES.length] as string);
    const created = opts.created ?? ts(n);
    const featured = n % 9 === 4 ? null : img(`hero-${site === ABB_FIXTURE_SITE_ID ? "abb" : "decoy"}-${n}.jpg`);
    const sections = [
      { heading: { en: `Point ${n}` }, body: { en: `Paragraph one of article ${n} about Asia's beauty industry.\n\nSecond paragraph with evidence ${n}.` } },
      { heading: { en: "" }, body: { en: `Closing thoughts ${n}.` } },
    ];
    await c.query(
      `INSERT INTO articles (id, site_id, slug, title, excerpt, body_sections, seo, status, section, subsection, tags, featured_image, featured_image_credit, source_url, byline, countries, published_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ABB Newsroom',$15,$16,$17::timestamptz,$17::timestamptz + interval '1 hour')`,
      [
        uuid(n, site === ABB_FIXTURE_SITE_ID ? "b" : "d"), site, `abb-fixture-article-${n}`, { en: `Fixture beauty article ${n}` }, { en: `Dek ${n}` },
        JSON.stringify(sections), n % 5 === 0 ? { title: `SEO ${n}` } : null, status, section, subsection || null,
        [TAGS[n % TAGS.length], TAGS[(n + 3) % TAGS.length]], featured,
        featured ? `Photo: Fixture ${n} / Unsplash` : null, `https://source.fixture.invalid/abb-${n}`, n % 2 ? ["KR"] : [],
        status === "draft" ? null : created, created,
      ],
    );
  };
  if (!delta) {
    await c.query(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "schema.sql"), "utf8"));
    await c.query("INSERT INTO sites (id, slug, name, domain) VALUES ($1,$2,'AsiaBeautyBrief','asiabeautybrief.com'), ($3,'theasiaspotlight','The Asia Spotlight','theasiaspotlight.com')", [ABB_FIXTURE_SITE_ID, ABB_LEGACY_SLUG, DECOY_SITE_ID]);
    await c.query("INSERT INTO secret_table_a (site_id, payload) VALUES ($1, 'CANARY-SECRET-A')", [ABB_FIXTURE_SITE_ID]);
    for (let n = 1; n <= 64; n++) await insert(n, ABB_FIXTURE_SITE_ID);
    for (let n = 1; n <= 10; n++) await insert(n, DECOY_SITE_ID);
    console.log("[abb-fixture] seeded 64 ABB rows + 10 decoy rows");
  } else {
    const max = Number((await c.query("SELECT count(*) AS n FROM articles WHERE site_id = $1", [ABB_FIXTURE_SITE_ID])).rows[0].n);
    for (let i = 1; i <= delta; i++) await insert(max + i, ABB_FIXTURE_SITE_ID, { status: "published", created: ts(200 + i) });
    console.log(`[abb-fixture] delta: appended ${delta} published ABB rows`);
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
