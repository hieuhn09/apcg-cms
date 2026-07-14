/**
 * Seed the Central CMS: one System Admin, global Countries, the two MVP tenants
 * (Brief Asia + DTW) with their taxonomy (full fidelity — colors, icons, vi/id
 * titles, sub-sections) and per-tenant modules (DTW newsletters/podcasts/
 * dashboards), and a sample content engine.
 *
 * Idempotent (upsert by slug/email/code). Taxonomy fixtures are treated as the
 * source of truth on re-run (existing rows are updated) — this matters because
 * the migration importer skips docs whose natural key already exists, so seeded
 * rows must carry the same fidelity the source sites have.
 *
 * Prints the raw engine token + read tokens ONCE — copy them; they are stored
 * hashed and cannot be retrieved.
 *
 *   npm run db:seed
 */
import "./lib/env";
import { randomBytes } from "node:crypto";
import { getPayload } from "payload";
import config from "../payload.config";
import { hashToken } from "../src/lib/crypto";
import { LOCALE_CODES, type LocaleCode } from "../src/lib/locales";

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "change-me-now";

const COUNTRIES = [
  { code: "sg", name: "Singapore", slug: "singapore", region: "southeast-asia" },
  { code: "vn", name: "Vietnam", slug: "vietnam", region: "southeast-asia" },
  { code: "id", name: "Indonesia", slug: "indonesia", region: "southeast-asia" },
  { code: "my", name: "Malaysia", slug: "malaysia", region: "southeast-asia" },
  { code: "th", name: "Thailand", slug: "thailand", region: "southeast-asia" },
  { code: "ph", name: "Philippines", slug: "philippines", region: "southeast-asia" },
  { code: "cn", name: "China", slug: "china", region: "east-asia" },
  { code: "jp", name: "Japan", slug: "japan", region: "east-asia" },
  { code: "kr", name: "South Korea", slug: "south-korea", region: "east-asia" },
  { code: "tw", name: "Taiwan", slug: "taiwan", region: "east-asia" },
  { code: "hk", name: "Hong Kong", slug: "hong-kong", region: "east-asia" },
  { code: "in", name: "India", slug: "india", region: "south-asia" },
  { code: "bd", name: "Bangladesh", slug: "bangladesh", region: "south-asia" },
  { code: "lk", name: "Sri Lanka", slug: "sri-lanka", region: "south-asia" },
  { code: "pk", name: "Pakistan", slug: "pakistan", region: "south-asia" },
] as const;

interface PillarFixture {
  slug: string;
  title: string;
  titleVi?: string;
  titleId?: string;
  heading?: string;
  color?: string;
  icon?: string;
  order: number;
  description?: string;
}

interface SectorFixture {
  slug: string;
  title: string;
  titleVi?: string;
  order: number;
}

interface SubSectionFixture {
  slug: string;
  title: string;
  titleVi?: string;
  pillarSlug: string;
  order: number;
}

interface TenantFixture {
  slug: string;
  name: string;
  defaultLanguage: LocaleCode;
  supportedLanguages: LocaleCode[];
  features: Record<string, boolean>;
  pillars: PillarFixture[];
  sectors: SectorFixture[];
  subsections?: SubSectionFixture[];
}

// Pillar/sector/sub-section fixtures ported from the source sites' seeds so the
// central rows carry the same fidelity (the importer skips existing slugs).
const TENANTS: TenantFixture[] = [
  {
    slug: "brief-asia",
    name: "BriefAsia",
    defaultLanguage: "en",
    supportedLanguages: [...LOCALE_CODES],
    features: { articles: true, newsletters: true, podcasts: true, marketData: true, sponsorSlots: true, wireDrops: true, corrections: true, translations: true, dashboards: false },
    pillars: [
      { slug: "asia", title: "Asia", titleVi: "Châu Á", titleId: "Asia", heading: "Asia", color: "var(--asia)", icon: "asia", order: 1, description: "Regional front page for markets, policy, trade, companies, infrastructure, and environment across Asia." },
      { slug: "finance", title: "Finance", titleVi: "Tài chính", titleId: "Keuangan", heading: "Finance", color: "var(--finance)", icon: "dollar", order: 2, description: "Banking, fintech, markets, listings, funds, payments, crypto, and consequential regional deals." },
      { slug: "technology", title: "Technology", titleVi: "Công nghệ", titleId: "Teknologi", heading: "Technology", color: "var(--technology)", icon: "spark", order: 3, description: "AI, startups, platforms, chips, developer tools, product-market shifts, and technology regulation." },
      { slug: "real-estate", title: "Real Estate", titleVi: "Bất động sản", titleId: "Properti", heading: "Real Estate", color: "var(--real-estate)", icon: "product", order: 4, description: "Homes, offices, hotels, proptech, land, city development, and infrastructure across Asian property markets." },
      { slug: "travel-dining", title: "Travel & Dining", titleVi: "Du lịch & Ẩm thực", titleId: "Travel & Dining", heading: "Travel & Dining", color: "var(--travel-dining)", icon: "globe", order: 5, description: "Premium travel, destination intelligence, hotels, retreats, restaurants, and regional spending shifts." },
      { slug: "lifestyle", title: "Lifestyle", titleVi: "Phong cách sống", titleId: "Gaya Hidup", heading: "Lifestyle", color: "var(--lifestyle)", icon: "star", order: 6, description: "Luxury, fashion, art, culture, health, wellness, and Asia's changing consumer class." },
      { slug: "sustainability", title: "Sustainability", titleVi: "Bền vững", titleId: "Keberlanjutan", heading: "Sustainability", color: "var(--sustainability)", icon: "trend-up", order: 7, description: "Green finance, energy transition, climate policy, mobility, nature, and circular economy." },
      { slug: "perspectives", title: "Perspectives", titleVi: "Góc nhìn", titleId: "Perspektif", heading: "Perspectives", color: "var(--perspectives)", icon: "feather", order: 8, description: "Opinion, founder stories, analysis, interviews, and essays explaining the forces shaping Asia." },
    ],
    sectors: [
      { slug: "markets", title: "Markets", titleVi: "Thị trường", order: 1 },
      { slug: "banking", title: "Banking", titleVi: "Ngân hàng", order: 2 },
      { slug: "capital-markets-ipo", title: "Capital Markets / IPO", titleVi: "Thị trường vốn / IPO", order: 3 },
      { slug: "ma-deals", title: "M&A / Deals", titleVi: "M&A / Thương vụ", order: 4 },
      { slug: "fintech", title: "Fintech", titleVi: "Fintech", order: 5 },
      { slug: "semiconductors", title: "Semiconductors", titleVi: "Bán dẫn", order: 6 },
      { slug: "ai", title: "AI", titleVi: "AI", order: 7 },
      { slug: "startups-vc", title: "Startups / VC", titleVi: "Startup / VC", order: 8 },
      { slug: "energy", title: "Energy", titleVi: "Năng lượng", order: 9 },
      { slug: "commodities", title: "Commodities", titleVi: "Hàng hóa", order: 10 },
      { slug: "property", title: "Property", titleVi: "Bất động sản", order: 11 },
      { slug: "infrastructure", title: "Infrastructure", titleVi: "Hạ tầng", order: 12 },
      { slug: "logistics-supply-chain", title: "Logistics / Supply Chain", titleVi: "Logistics / Chuỗi cung ứng", order: 13 },
      { slug: "trade-policy", title: "Trade & Policy", titleVi: "Thương mại & Chính sách", order: 14 },
      { slug: "consumer-luxury", title: "Consumer / Luxury", titleVi: "Tiêu dùng / Xa xỉ", order: 15 },
      { slug: "tourism", title: "Tourism", titleVi: "Du lịch", order: 16 },
    ],
    subsections: [
      // Finance
      { slug: "banking", title: "Banking", titleVi: "Ngân hàng", pillarSlug: "finance", order: 1 },
      { slug: "fintech", title: "Fintech", titleVi: "Fintech", pillarSlug: "finance", order: 2 },
      { slug: "markets", title: "Markets", titleVi: "Thị trường", pillarSlug: "finance", order: 3 },
      { slug: "deals", title: "Deals", titleVi: "Thương vụ", pillarSlug: "finance", order: 4 },
      { slug: "crypto", title: "Crypto", titleVi: "Crypto", pillarSlug: "finance", order: 5 },
      // Technology
      { slug: "ai", title: "AI", titleVi: "AI", pillarSlug: "technology", order: 1 },
      { slug: "startups", title: "Startups", titleVi: "Startup", pillarSlug: "technology", order: 2 },
      { slug: "dev", title: "Dev", titleVi: "Lập trình", pillarSlug: "technology", order: 3 },
      { slug: "products", title: "Products", titleVi: "Sản phẩm", pillarSlug: "technology", order: 4 },
      { slug: "policy", title: "Policy", titleVi: "Chính sách", pillarSlug: "technology", order: 5 },
      // Real Estate
      { slug: "homes", title: "Homes", titleVi: "Nhà ở", pillarSlug: "real-estate", order: 1 },
      { slug: "offices", title: "Offices", titleVi: "Văn phòng", pillarSlug: "real-estate", order: 2 },
      { slug: "hotels", title: "Hotels", titleVi: "Khách sạn", pillarSlug: "real-estate", order: 3 },
      { slug: "proptech", title: "Proptech", titleVi: "Proptech", pillarSlug: "real-estate", order: 4 },
      { slug: "land", title: "Land", titleVi: "Đất đai", pillarSlug: "real-estate", order: 5 },
      // Travel & Dining
      { slug: "trends", title: "Trends", titleVi: "Xu hướng", pillarSlug: "travel-dining", order: 1 },
      { slug: "style", title: "Style", titleVi: "Phong cách", pillarSlug: "travel-dining", order: 2 },
      { slug: "destinations", title: "Destinations", titleVi: "Điểm đến", pillarSlug: "travel-dining", order: 3 },
      { slug: "retreat", title: "Retreat", titleVi: "Nghỉ dưỡng", pillarSlug: "travel-dining", order: 4 },
      { slug: "dining", title: "Dining", titleVi: "Ẩm thực", pillarSlug: "travel-dining", order: 5 },
      // Lifestyle
      { slug: "luxury", title: "Luxury", titleVi: "Xa xỉ", pillarSlug: "lifestyle", order: 1 },
      { slug: "fashion", title: "Fashion", titleVi: "Thời trang", pillarSlug: "lifestyle", order: 2 },
      { slug: "art", title: "Art", titleVi: "Nghệ thuật", pillarSlug: "lifestyle", order: 3 },
      { slug: "culture", title: "Culture", titleVi: "Văn hóa", pillarSlug: "lifestyle", order: 4 },
      { slug: "health", title: "Health", titleVi: "Sức khỏe", pillarSlug: "lifestyle", order: 5 },
      // Sustainability
      { slug: "energy", title: "Energy", titleVi: "Năng lượng", pillarSlug: "sustainability", order: 1 },
      { slug: "climate", title: "Climate", titleVi: "Khí hậu", pillarSlug: "sustainability", order: 2 },
      { slug: "esg", title: "ESG", titleVi: "ESG", pillarSlug: "sustainability", order: 3 },
      { slug: "mobility", title: "Mobility", titleVi: "Di chuyển", pillarSlug: "sustainability", order: 4 },
      { slug: "nature", title: "Nature", titleVi: "Thiên nhiên", pillarSlug: "sustainability", order: 5 },
      // Perspectives
      { slug: "opinion", title: "Opinion", titleVi: "Bình luận", pillarSlug: "perspectives", order: 1 },
      { slug: "founders", title: "Founders", titleVi: "Nhà sáng lập", pillarSlug: "perspectives", order: 2 },
      { slug: "analysis", title: "Analysis", titleVi: "Phân tích", pillarSlug: "perspectives", order: 3 },
      { slug: "interviews", title: "Interviews", titleVi: "Phỏng vấn", pillarSlug: "perspectives", order: 4 },
      { slug: "essays", title: "Essays", titleVi: "Tiểu luận", pillarSlug: "perspectives", order: 5 },
      // Asia (assignable article sub-sections; hub tab bar stays code-rendered)
      { slug: "business", title: "Business", titleVi: "Kinh doanh", pillarSlug: "asia", order: 1 },
      { slug: "politics", title: "Politics", titleVi: "Chính trị", pillarSlug: "asia", order: 2 },
      { slug: "trade", title: "Trade", titleVi: "Thương mại", pillarSlug: "asia", order: 3 },
      { slug: "environment", title: "Environment", titleVi: "Môi trường", pillarSlug: "asia", order: 4 },
      { slug: "trending", title: "Trending", titleVi: "Xu hướng", pillarSlug: "asia", order: 5 },
    ],
  },
  {
    slug: "dtw",
    name: "DailyTechWire",
    defaultLanguage: "en",
    supportedLanguages: ["en", "vi", "id"],
    features: { articles: true, newsletters: true, podcasts: true, marketData: false, sponsorSlots: true, wireDrops: true, corrections: true, translations: true, dashboards: true },
    pillars: [
      { slug: "ai", title: "AI", titleVi: "AI", titleId: "AI", heading: "Artificial Intelligence", color: "var(--ai)", icon: "spark", order: 1, description: "Frontier models, infrastructure, and the policy that shapes them. Reported across Seoul, Singapore, Bengaluru, and Hangzhou." },
      { slug: "startups", title: "Startups", titleVi: "Khởi nghiệp", titleId: "Startup", heading: "Startups & Capital", color: "var(--startups)", icon: "trend-up", order: 2, description: "Term sheets, IPOs, layoffs, and the operators building the next wave across ASEAN, India, and Greater China." },
      { slug: "latest", title: "Latest", titleVi: "Mới nhất", titleId: "Terbaru", heading: "Latest", color: "var(--latest)", icon: "clock", order: 3, description: "The newest reporting across every beat — AI, startups, policy, developers, and products, freshest first, with a sharp eye on Asia's tech economy." },
      { slug: "dev", title: "Dev", titleVi: "Lập trình", titleId: "Pengembang", heading: "Developers", color: "var(--dev)", icon: "code", order: 4, description: "Engineering practice. Tools, frameworks, and the trade-offs teams are actually making in production." },
      { slug: "products", title: "Products", titleVi: "Sản phẩm", titleId: "Produk", heading: "Products & Reviews", color: "var(--products)", icon: "product", order: 5, description: "Independent reviews of phones, laptops, audio, and wearables. Affiliate-disclosed. Manufacturers do not approve our copy." },
      { slug: "policy", title: "Policy", titleVi: "Chính sách", titleId: "Kebijakan", heading: "Policy & Regulation", color: "var(--policy)", icon: "policy", order: 6, description: "Trade rules, export controls, central-bank decisions, and the regulators who write them — covered as the technology beat they have become." },
    ],
    sectors: [
      { slug: "ai", title: "AI", order: 1 },
      { slug: "funding", title: "Funding", order: 2 },
      { slug: "semiconductors", title: "Semiconductors", order: 3 },
      { slug: "cloud", title: "Cloud", order: 4 },
      { slug: "security", title: "Security", order: 5 },
      { slug: "policy", title: "Policy", order: 6 },
    ],
  },
  {
    slug: "world-travel-brief",
    name: "WorldTravelBrief",
    defaultLanguage: "en",
    supportedLanguages: [...LOCALE_CODES],
    // Taxonomy (pillars + sub-sections), cities, authors, articles, podcasts and
    // corrections are DATA-MIGRATED from the WTB production DB (migrate:import), so
    // they are deliberately NOT seeded here — the importer creates them from source
    // with the correct slugs, which avoids hardcoding a taxonomy that must
    // byte-match the source. Only newsletters are seeded (WTB defines its 5 in code,
    // not data — see WTB_NEWSLETTERS below). `sponsorSlots` is ON — WTB has
    // editor-created promo cards, migrated as slot=promo_card.
    features: { articles: true, newsletters: true, podcasts: true, marketData: false, sponsorSlots: true, wireDrops: false, corrections: true, translations: true, dashboards: false, citiesMap: true },
    pillars: [],
    sectors: [],
  },
];

// DTW modules — ported from dtw-web/apps/web/src/lib/data.ts (static fixtures
// on the site; central makes them manageable).
const DTW_NEWSLETTERS = [
  { slug: "am", name: "AM Brief", cadence: "Daily · 07:00", description: "What broke overnight across Asia tech, in 5 minutes.", subscribers: "48,200", pillarSlug: "latest", order: 1 },
  { slug: "pm", name: "PM Brief", cadence: "Daily · 18:00", description: "The day in three stories, plus what to read tonight.", subscribers: "41,700", pillarSlug: "latest", order: 2 },
  { slug: "ai", name: "AI Weekly", cadence: "Weekly · Tue", description: "Models, papers, and the geopolitics underneath them.", subscribers: "36,400", pillarSlug: "ai", order: 3 },
  { slug: "fund", name: "Asia Funding Weekly", cadence: "Weekly · Thu", description: "Every term sheet that closed in ASEAN this week.", subscribers: "22,900", pillarSlug: "startups", order: 4 },
  { slug: "dev", name: "Dev Digest", cadence: "Weekly · Fri", description: "What practitioners are actually shipping.", subscribers: "19,300", pillarSlug: "dev", order: 5 },
  { slug: "prod", name: "Products & Deals", cadence: "Bi-weekly", description: "Reviews and buy-or-skip calls. Affiliate-disclosed.", subscribers: "14,100", pillarSlug: "products", order: 6 },
  { slug: "deep", name: "Deep Dive", cadence: "Weekly · Sun", description: "One long-form investigation or data story, in full, every weekend.", subscribers: "17,600", pillarSlug: "policy", order: 7 },
  { slug: "awards", name: "DTW Awards", cadence: "Occasional", description: "Updates on the upcoming DTW Awards, plus nominations and winners when they land.", subscribers: "3,100", pillarSlug: "latest", order: 8 },
] as const;

const DTW_PODCASTS = [
  { slug: "daily", title: "DTW Daily Brief", duration: "6:42", host: "Mei Lin", daysAgo: 0 },
  { slug: "asia", title: "Asia, Decoded", duration: "38:11", host: "Mei Lin & Ravi Kim", daysAgo: 1 },
  { slug: "build", title: "Building in Public, EM", duration: "44:50", host: "Arif Rahman", daysAgo: 2 },
] as const;

const DTW_FUNDING_ROWS = [
  { ticker: "9988.HK", name: "Alibaba", country: "CN", sector: "Cloud/AI", px: 81.2, chg: 2.41, mcap: "$201B", funding: "–" },
  { ticker: "005930.KS", name: "Samsung Elec.", country: "KR", sector: "Semis", px: 78900, chg: -0.82, mcap: "$420B", funding: "–" },
  { ticker: "2330.TW", name: "TSMC", country: "TW", sector: "Foundry", px: 932.0, chg: 1.55, mcap: "$780B", funding: "–" },
  { ticker: "3690.HK", name: "Meituan", country: "CN", sector: "Consumer", px: 114.6, chg: -1.2, mcap: "$74B", funding: "–" },
  { ticker: "GOTO.JK", name: "GoTo Group", country: "ID", sector: "Super-app", px: 73, chg: 3.1, mcap: "$5.4B", funding: "–" },
  { ticker: "GRAB", name: "Grab Holdings", country: "SG", sector: "Super-app", px: 4.18, chg: 0.61, mcap: "$16.1B", funding: "–" },
  { ticker: "SE", name: "Sea Limited", country: "SG", sector: "E-commerce", px: 88.4, chg: -2.05, mcap: "$48B", funding: "–" },
  { ticker: "VNG", name: "VNG (private)", country: "VN", sector: "Internet", px: null, chg: null, mcap: "$2.2B*", funding: "$150M (D)" },
  { ticker: "KKDY", name: "Kakao Pay", country: "KR", sector: "Fintech", px: 34250, chg: 0.41, mcap: "$3.2B", funding: "–" },
  { ticker: "BKKM", name: "Bukalapak", country: "ID", sector: "E-commerce", px: 118, chg: -0.84, mcap: "$1.1B", funding: "–" },
  { ticker: "PYTM.NS", name: "Paytm", country: "IN", sector: "Fintech", px: 412, chg: 1.81, mcap: "$3.0B", funding: "–" },
  { ticker: "OFLA", name: "Ola Krutrim", country: "IN", sector: "AI", px: null, chg: null, mcap: "$1.0B*", funding: "$50M (C)" },
] as const;

const DTW_AI_LEADERBOARD = [
  { rank: 1, model: "GPT-5.1", maker: "OpenAI", reasoning: 92, coding: 88, speed: 84, price: 9.0, ctx: "512k" },
  { rank: 2, model: "Claude Sonnet 4.5", maker: "Anthropic", reasoning: 91, coding: 90, speed: 79, price: 8.4, ctx: "1M" },
  { rank: 3, model: "Gemini 2.5 Pro", maker: "Google", reasoning: 88, coding: 84, speed: 88, price: 6.5, ctx: "2M" },
  { rank: 4, model: "ERNIE-X 350B", maker: "Baidu", reasoning: 84, coding: 80, speed: 82, price: 2.1, ctx: "256k" },
  { rank: 5, model: "Qwen3-Max", maker: "Alibaba", reasoning: 83, coding: 85, speed: 80, price: 1.8, ctx: "256k" },
  { rank: 6, model: "Llama 4 405B", maker: "Meta", reasoning: 80, coding: 78, speed: 74, price: 0.0, ctx: "128k" },
  { rank: 7, model: "Mistral Large 3", maker: "Mistral", reasoning: 78, coding: 77, speed: 86, price: 3.0, ctx: "128k" },
  { rank: 8, model: "DeepSeek-V4", maker: "DeepSeek", reasoning: 82, coding: 83, speed: 81, price: 0.6, ctx: "128k" },
] as const;

// WTB newsletters — the 5 hardcoded in world-travel-brief/scripts/seed.ts (DESIGN
// §6.6). Slugs are slugify(name). Seeded (not imported) so they exist even though
// the WTB export excludes `newsletters`.
const WTB_NEWSLETTERS = [
  { slug: "the-daily-brief", name: "The Daily Brief", cadence: "Every weekday · 07:00 SGT", description: "What moved in world travel overnight, read in five minutes. Fares, openings, disruptions and where demand is heading." },
  { slug: "the-long-haul", name: "The Long Haul", cadence: "Weekly · Sunday", description: "One big travel question, audited with the reporting and the numbers behind it. The franchise that proves the name." },
  { slug: "access-alert", name: "Access Alert", cadence: "As it happens (Live)", description: "Visa changes, entry rules and disruption, sent the moment they move. For the traveller who books on the news." },
  { slug: "where-next", name: "Where Next", cadence: "Monthly", description: "The rising map. The places the world is heading before the crowd arrives, with the reporting on why." },
  { slug: "the-table", name: "The Table", cadence: "Fortnightly · Thursday", description: "Where the world is eating now — new tables, chef moves and the reservations worth planning a whole trip around." },
] as const;

type P = Awaited<ReturnType<typeof getPayload>>;
type Coll = Parameters<P["find"]>[0]["collection"];
const ctx = { disableRevalidate: true };

/** Create-or-update by where clause; returns the row id. */
async function upsert(payload: P, collection: Coll, where: Record<string, unknown>, data: Record<string, unknown>): Promise<number | string> {
  const found = await payload.find({ collection, where: where as never, limit: 1, depth: 0, overrideAccess: true } as never);
  const existing = (found as { docs: unknown[] }).docs[0] as { id: number | string } | undefined;
  if (existing) {
    await payload.update({ collection, id: existing.id, data: data as never, context: ctx, overrideAccess: true });
    return existing.id;
  }
  const created = await payload.create({ collection, data: data as never, context: ctx, overrideAccess: true });
  return (created as { id: number | string }).id;
}

/** Write a localized field value for one non-default locale. */
async function localeUpdate(payload: P, collection: Coll, id: number | string, locale: string, data: Record<string, unknown>): Promise<void> {
  await payload.update({ collection, id, locale: locale as never, data: data as never, context: ctx, overrideAccess: true });
}

async function main() {
  const payload = await getPayload({ config });

  // ── System admin ──
  const existingAdmin = await payload.find({ collection: "users", where: { email: { equals: ADMIN_EMAIL } }, limit: 1, overrideAccess: true });
  if (!existingAdmin.docs.length) {
    await payload.create({ collection: "users", overrideAccess: true, data: { name: "System Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: "systemAdmin" } });
    console.log(`[seed] created system admin ${ADMIN_EMAIL}`);
  } else {
    console.log(`[seed] system admin ${ADMIN_EMAIL} exists`);
  }

  // ── Global countries ──
  for (const c of COUNTRIES) {
    await upsert(payload, "countries", { code: { equals: c.code } }, { code: c.code, name: c.name, slug: c.slug, region: c.region });
  }
  console.log(`[seed] countries ready (${COUNTRIES.length})`);

  // ── Tenants + taxonomy ──
  const engineTenantIds: (number | string)[] = [];
  for (const t of TENANTS) {
    let tenant = (await payload.find({ collection: "tenants", where: { slug: { equals: t.slug } }, limit: 1, overrideAccess: true })).docs[0] as { id: number | string } | undefined;

    if (!tenant) {
      // Generate one read token per tenant on first seed.
      const rawReadToken = randomBytes(24).toString("hex");
      const { hash, prefix } = hashToken(rawReadToken);
      tenant = (await payload.create({
        collection: "tenants",
        overrideAccess: true,
        context: ctx,
        data: {
          slug: t.slug,
          name: t.name,
          status: "active",
          defaultLanguage: t.defaultLanguage,
          supportedLanguages: t.supportedLanguages,
          features: t.features,
          readTokens: [{ label: "frontend", tokenHash: hash, tokenPrefix: prefix, status: "active" }],
        },
      })) as { id: number | string };
      console.log(`[seed] created tenant ${t.slug} — READ TOKEN (copy now): ${rawReadToken}`);
    } else {
      // Provisioning fields are system-managed — keep them at fixture values.
      await payload.update({
        collection: "tenants",
        id: tenant.id,
        overrideAccess: true,
        context: ctx,
        data: { supportedLanguages: t.supportedLanguages, features: t.features },
      });
      console.log(`[seed] tenant ${t.slug} exists (id ${tenant.id}) — languages/features synced`);
    }
    engineTenantIds.push(tenant.id);

    const pillarIds = new Map<string, number | string>();
    for (const p of t.pillars) {
      const id = await upsert(
        payload,
        "pillars",
        { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: p.slug } }] },
        { tenant: tenant.id, slug: p.slug, title: p.title, heading: p.heading, color: p.color, icon: p.icon, order: p.order, description: p.description },
      );
      pillarIds.set(p.slug, id);
      if (p.titleVi) await localeUpdate(payload, "pillars", id, "vi", { title: p.titleVi });
      if (p.titleId) await localeUpdate(payload, "pillars", id, "id", { title: p.titleId });
    }

    for (const s of t.sectors) {
      const id = await upsert(
        payload,
        "sectors",
        { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: s.slug } }] },
        { tenant: tenant.id, slug: s.slug, title: s.title, order: s.order },
      );
      if (s.titleVi) await localeUpdate(payload, "sectors", id, "vi", { title: s.titleVi });
    }

    for (const sub of t.subsections ?? []) {
      const pillarId = pillarIds.get(sub.pillarSlug);
      if (pillarId == null) continue;
      const id = await upsert(
        payload,
        "subsections",
        { and: [{ tenant: { equals: tenant.id } }, { pillar: { equals: pillarId } }, { slug: { equals: sub.slug } }] },
        { tenant: tenant.id, pillar: pillarId, slug: sub.slug, title: sub.title, order: sub.order },
      );
      if (sub.titleVi) await localeUpdate(payload, "subsections", id, "vi", { title: sub.titleVi });
    }
    console.log(`[seed] taxonomy ready for ${t.slug} (${t.pillars.length} pillars, ${t.sectors.length} sectors, ${(t.subsections ?? []).length} sub-sections)`);

    // ── DTW modules (newsletters / podcasts / dashboards) ──
    if (t.slug === "dtw") {
      for (const n of DTW_NEWSLETTERS) {
        await upsert(
          payload,
          "newsletters",
          { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: n.slug } }] },
          { tenant: tenant.id, slug: n.slug, name: n.name, cadence: n.cadence, description: n.description, subscribers: n.subscribers, vertical: pillarIds.get(n.pillarSlug), active: true, order: n.order },
        );
      }
      for (const p of DTW_PODCASTS) {
        await upsert(
          payload,
          "podcasts",
          { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: p.slug } }] },
          { tenant: tenant.id, slug: p.slug, title: p.title, show: "DTW", duration: p.duration, host: p.host, publishedAt: new Date(Date.now() - p.daysAgo * 86_400_000).toISOString() },
        );
      }
      for (const [i, r] of DTW_FUNDING_ROWS.entries()) {
        await upsert(
          payload,
          "fundingRows",
          { and: [{ tenant: { equals: tenant.id } }, { ticker: { equals: r.ticker } }] },
          { tenant: tenant.id, order: i + 1, ticker: r.ticker, name: r.name, country: r.country, sector: r.sector, px: r.px ?? undefined, chg: r.chg ?? undefined, mcap: r.mcap, funding: r.funding },
        );
      }
      for (const r of DTW_AI_LEADERBOARD) {
        await upsert(
          payload,
          "aiLeaderboardRows",
          { and: [{ tenant: { equals: tenant.id } }, { model: { equals: r.model } }] },
          { tenant: tenant.id, ...r },
        );
      }
      console.log(`[seed] dtw modules ready (${DTW_NEWSLETTERS.length} newsletters, ${DTW_PODCASTS.length} podcasts, ${DTW_FUNDING_ROWS.length} funding rows, ${DTW_AI_LEADERBOARD.length} leaderboard rows)`);
    }

    // ── WTB newsletters (5, hardcoded; the rest of WTB is data-migrated) ──
    if (t.slug === "world-travel-brief") {
      for (const [i, n] of WTB_NEWSLETTERS.entries()) {
        await upsert(
          payload,
          "newsletters",
          { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: n.slug } }] },
          { tenant: tenant.id, slug: n.slug, name: n.name, cadence: n.cadence, description: n.description, active: true, order: i + 1 },
        );
      }
      console.log(`[seed] wtb newsletters ready (${WTB_NEWSLETTERS.length})`);
    }
  }

  // ── Sample content engine (allowed on both tenants) ──
  // SEED_ENGINE_TOKEN pins a deterministic token for local dev (docker DB +
  // engine-intake-tester loop). Falls back to a random token otherwise.
  const existingEngine = await payload.find({ collection: "content-engines", where: { name: { equals: "content-engine" } }, limit: 1, overrideAccess: true });
  if (!existingEngine.docs.length) {
    const rawEngineToken = process.env.SEED_ENGINE_TOKEN?.trim() || randomBytes(24).toString("hex");
    await payload.create({
      collection: "content-engines",
      overrideAccess: true,
      data: {
        name: "content-engine",
        engineType: "writer",
        status: "active",
        rawToken: rawEngineToken,
        allowedTenants: engineTenantIds as number[],
        allowedActions: ["create_article", "update_article", "create_translation", "update_translation", "upload_media"],
      },
    });
    const tokenSource = process.env.SEED_ENGINE_TOKEN?.trim() ? "from SEED_ENGINE_TOKEN" : "random — copy now";
    console.log(`[seed] created content-engine — ENGINE TOKEN (${tokenSource}): ${rawEngineToken}`);
  } else {
    console.log("[seed] content-engine exists");
  }

  console.log("[seed] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
