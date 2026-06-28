/**
 * Seed the Central CMS: one System Admin, global Countries, the two MVP tenants
 * (Brief Asia + DTW) with their taxonomy, and a sample content engine.
 * Idempotent (upsert by slug/email/code). Prints the raw engine token + read
 * tokens ONCE — copy them; they are stored hashed and cannot be retrieved.
 *
 *   npm run db:seed
 */
import "./lib/env";
import { randomBytes } from "node:crypto";
import { getPayload } from "payload";
import config from "../payload.config";
import { hashToken } from "../src/lib/crypto";

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
  { code: "in", name: "India", slug: "india", region: "south-asia" },
] as const;

const TENANTS = [
  {
    slug: "brief-asia",
    name: "BriefAsia",
    defaultLanguage: "en",
    supportedLanguages: ["en", "vi", "th", "id", "ja", "ko", "zh-hant", "zh-hans"],
    features: { articles: true, newsletters: true, podcasts: true, marketData: true, sponsorSlots: true, wireDrops: true, corrections: true, translations: true },
    pillars: [
      { slug: "asia", title: "Asia", order: 1 },
      { slug: "finance", title: "Finance", order: 2 },
      { slug: "technology", title: "Technology", order: 3 },
      { slug: "real-estate", title: "Real Estate", order: 4 },
      { slug: "travel-dining", title: "Travel & Dining", order: 5 },
      { slug: "lifestyle", title: "Lifestyle", order: 6 },
      { slug: "sustainability", title: "Sustainability", order: 7 },
      { slug: "perspectives", title: "Perspectives", order: 8 },
    ],
    sectors: ["Markets", "Banking", "Fintech", "Semiconductors", "AI", "M&A", "Energy", "Property"],
  },
  {
    slug: "dtw",
    name: "DailyTechWire",
    defaultLanguage: "en",
    supportedLanguages: ["en", "vi", "id"],
    features: { articles: true, newsletters: false, podcasts: false, marketData: false, sponsorSlots: true, wireDrops: true, corrections: true, translations: true },
    pillars: [
      { slug: "ai", title: "AI", order: 1 },
      { slug: "startups", title: "Startups", order: 2 },
      { slug: "latest", title: "Latest", order: 3 },
      { slug: "dev", title: "Dev", order: 4 },
      { slug: "products", title: "Products", order: 5 },
      { slug: "policy", title: "Policy", order: 6 },
    ],
    sectors: ["AI", "Funding", "Semiconductors", "Cloud", "Security", "Policy"],
  },
] as const;

async function main() {
  const payload = await getPayload({ config });
  const ctx = { disableRevalidate: true };

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
    const found = await payload.find({ collection: "countries", where: { code: { equals: c.code } }, limit: 1, overrideAccess: true });
    if (!found.docs.length) {
      await payload.create({ collection: "countries", overrideAccess: true, context: ctx, data: { code: c.code, name: c.name, slug: c.slug, region: c.region } });
    }
  }
  console.log(`[seed] countries ready (${COUNTRIES.length})`);

  // ── Tenants + taxonomy ──
  const engineTenantIds: (number | string)[] = [];
  for (const t of TENANTS) {
    let tenant = (await payload.find({ collection: "tenants", where: { slug: { equals: t.slug } }, limit: 1, overrideAccess: true })).docs[0] as { id: number | string } | undefined;

    // Generate one read token per tenant on first seed.
    const rawReadToken = randomBytes(24).toString("hex");
    const { hash, prefix } = hashToken(rawReadToken);

    if (!tenant) {
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
      console.log(`[seed] tenant ${t.slug} exists (id ${tenant.id})`);
    }
    engineTenantIds.push(tenant.id);

    for (const p of t.pillars) {
      const found = await payload.find({ collection: "pillars", where: { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: p.slug } }] }, limit: 1, overrideAccess: true });
      if (!found.docs.length) {
        await payload.create({ collection: "pillars", overrideAccess: true, context: ctx, data: { tenant: tenant.id, slug: p.slug, title: p.title, order: p.order } });
      }
    }
    for (const [i, name] of t.sectors.entries()) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const found = await payload.find({ collection: "sectors", where: { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: slug } }] }, limit: 1, overrideAccess: true });
      if (!found.docs.length) {
        await payload.create({ collection: "sectors", overrideAccess: true, context: ctx, data: { tenant: tenant.id, slug, title: name, order: i } });
      }
    }
    console.log(`[seed] taxonomy ready for ${t.slug}`);
  }

  // ── Sample content engine (allowed on both tenants) ──
  const existingEngine = await payload.find({ collection: "content-engines", where: { name: { equals: "content-engine" } }, limit: 1, overrideAccess: true });
  if (!existingEngine.docs.length) {
    const rawEngineToken = randomBytes(24).toString("hex");
    await payload.create({
      collection: "content-engines",
      overrideAccess: true,
      data: {
        name: "content-engine",
        engineType: "writer",
        status: "active",
        rawToken: rawEngineToken,
        allowedTenants: engineTenantIds,
        allowedActions: ["create_article", "update_article", "create_translation", "update_translation", "upload_media"],
      },
    });
    console.log(`[seed] created content-engine — ENGINE TOKEN (copy now): ${rawEngineToken}`);
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
