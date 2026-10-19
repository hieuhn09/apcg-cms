/**
 * LOCAL-ONLY synthetic legacy fixture for the AER rehearsal (FAKE DATA).
 *   AER_FIXTURE_ADMIN_URL=postgres://postgres:...@127.0.0.1:<port>/legacy node --import tsx seed-aer-fixture.ts [--delta N]
 * Without --delta: (re)creates the schema and seeds two sites: the AER site
 * (slug deliberately NOT "aer", so the tools must work by id) with ~70 rows, and
 * a decoy site whose rows must never be read. Timestamps carry MICROSECONDS and
 * several rows share the same created_at (the keyset bug of GTP Amendment 5).
 * With --delta N: appends N newer published AER rows (the pre-cutover second run).
 * Images: writes small JPEGs to AER_FIXTURE_IMAGES_DIR for the local image server.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { assertLocalDb } from "../../../../lib/local-db-guard";

export const AER_FIXTURE_SITE_ID = "00000000-0000-0000-0000-0000000ae001";
export const DECOY_SITE_ID = "00000000-0000-0000-0000-0000000de001";
export const AER_LEGACY_SLUG = "asia-economic-review-legacy";
export const IMAGE_HOST = "legacy-storage.fixture.invalid";
const SECTIONS = ["essays", "briefings", "corporate-asia", "the-review-interview", "the-long-view", "in-focus", "data-annual", "partner-insights"];
const STATUSES = ["published", "published", "published", "published", "archived", "draft", "scheduled", "rejected"];
const TAGS = ["china", "india", "Japan", "korea", "trade", "inflation", "vietnam", "semiconductors"];

const uuid = (n: number, prefix = "a") => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Microsecond timestamp text: base + n days, + a micro part; rows 10..12 share one instant. */
function ts(n: number): string {
  const k = n >= 10 && n <= 12 ? 10 : n;
  const d = new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + k * 86_400_000 + (k % 5) * 1000);
  const micro = String(123457 + k * 7).padStart(6, "0").slice(0, 6);
  return d.toISOString().replace(/\.\d{3}Z$/, `.${micro}+00`);
}

async function main(): Promise<void> {
  const url = process.env.AER_FIXTURE_ADMIN_URL;
  assertLocalDb(url);
  const delta = process.argv.includes("--delta") ? Number(process.argv[process.argv.indexOf("--delta") + 1]) : 0;
  const imgDir = process.env.AER_FIXTURE_IMAGES_DIR as string;
  mkdirSync(path.join(imgDir, "storage/v1/object/public/aer"), { recursive: true });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
  const img = (name: string) => {
    writeFileSync(path.join(imgDir, "storage/v1/object/public/aer", name), jpeg);
    return `https://${IMAGE_HOST}/storage/v1/object/public/aer/${name}`;
  };
  const insert = async (n: number, site: string, opts: { status?: string; created?: string } = {}) => {
    const section = SECTIONS[n % SECTIONS.length] as string;
    const status = opts.status ?? (STATUSES[n % STATUSES.length] as string);
    const created = opts.created ?? ts(n);
    const featured = n % 9 === 4 ? null : img(`hero-${site === AER_FIXTURE_SITE_ID ? "aer" : "decoy"}-${n}.jpg`);
    const sections = [
      { heading: { en: `Point ${n}` }, body: { en: `Paragraph one of article ${n} about Asia's economy.\n\nSecond paragraph with evidence ${n}.` } },
      { heading: { en: "" }, body: { en: `Closing thoughts ${n}.` }, ...(n % 4 === 0 ? { image: img(`body-${n}.jpg`) } : {}) },
    ];
    await c.query(
      `INSERT INTO articles (id, site_id, slug, title, excerpt, body_sections, status, section, subsection, tags, featured_image, featured_image_credit, source_url, countries, published_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$16::timestamptz + interval '1 hour')`,
      [
        uuid(n, site === AER_FIXTURE_SITE_ID ? "a" : "d"), site, `aer-fixture-article-${n}`, { en: `Fixture article ${n}` }, { en: `Dek ${n}` },
        JSON.stringify(sections), status, section, n % 3 === 0 ? "policy" : null, [TAGS[n % TAGS.length], TAGS[(n + 3) % TAGS.length]], featured,
        featured ? `Photo: Fixture ${n} / Pexels` : null, `https://source.fixture.invalid/aer-${n}`, n % 2 ? ["CN"] : [],
        n % 11 === 3 ? null : created, created,
      ],
    );
  };
  if (!delta) {
    await c.query(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "schema.sql"), "utf8"));
    await c.query("INSERT INTO sites (id, slug, name, domain) VALUES ($1,$2,'Asia Economic Review','asiaeconomicreview.com'), ($3,'theasiaspotlight','The Asia Spotlight','theasiaspotlight.com')", [AER_FIXTURE_SITE_ID, AER_LEGACY_SLUG, DECOY_SITE_ID]);
    await c.query("INSERT INTO secret_table_a (site_id, payload) VALUES ($1, 'CANARY-SECRET-A')", [AER_FIXTURE_SITE_ID]);
    for (let n = 1; n <= 72; n++) await insert(n, AER_FIXTURE_SITE_ID);
    for (let n = 1; n <= 10; n++) await insert(n, DECOY_SITE_ID);
    console.log("[aer-fixture] seeded 72 AER rows + 10 decoy rows");
  } else {
    const max = Number((await c.query("SELECT count(*) AS n FROM articles WHERE site_id = $1", [AER_FIXTURE_SITE_ID])).rows[0].n);
    for (let i = 1; i <= delta; i++) await insert(max + i, AER_FIXTURE_SITE_ID, { status: "published", created: ts(200 + i) });
    console.log(`[aer-fixture] delta: appended ${delta} published AER rows`);
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
