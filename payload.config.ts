import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { s3Storage } from "@payloadcms/storage-s3";
import { multiTenantPlugin } from "@payloadcms/plugin-multi-tenant";
import sharp from "sharp";

import { PAYLOAD_LOCALES } from "@/lib/locales";
import { MEMBERSHIP_ROLES } from "@/lib/constants";

// Global / config collections (NOT tenant-scoped).
import { Tenants } from "@/collections/Tenants";
import { Users } from "@/collections/Users";
import { Countries } from "@/collections/Countries";
import { ContentEngines } from "@/collections/ContentEngines";
import { ActivityLog } from "@/collections/ActivityLog";

// Tenant-scoped collections (the plugin injects a `tenant` field into each).
import { Media } from "@/collections/Media";
import { Authors } from "@/collections/Authors";
import { Pillars } from "@/collections/Pillars";
import { Sectors } from "@/collections/Sectors";
import { Tags } from "@/collections/Tags";
import { Articles } from "@/collections/Articles";
import { Newsletters } from "@/collections/Newsletters";
import { Podcasts } from "@/collections/Podcasts";
import { Corrections } from "@/collections/Corrections";
import { SponsorSlots } from "@/collections/SponsorSlots";
import { MarketSnapshots } from "@/collections/MarketSnapshots";
import { FxRates } from "@/collections/FxRates";
import { TrendingBlocks } from "@/collections/TrendingBlocks";
import { WireDrops } from "@/collections/WireDrops";
import { Menus } from "@/collections/Menus";
import { EngineConflictLog } from "@/collections/EngineConflictLog";
import { TranslationJobs } from "@/collections/TranslationJobs";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
const payloadSecret = process.env.PAYLOAD_SECRET;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Payload (set in .env.local).");
}
if (!payloadSecret) {
  throw new Error(
    "PAYLOAD_SECRET is required. Generate with `openssl rand -hex 32` and put in .env.local.",
  );
}

// Cloudflare R2 (S3-compatible) — gated on R2_* env vars. Falls back to local
// disk in dev when unset (NOT viable on serverless; required in deployed envs).
const r2Configured = Boolean(
  process.env.R2_BUCKET &&
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY,
);

const allowedOrigins = (process.env.PUBLIC_API_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export default buildConfig({
  admin: {
    user: Users.slug,
    meta: { titleSuffix: "— Central CMS" },
  },
  localization: {
    locales: PAYLOAD_LOCALES,
    defaultLocale: "en",
    fallback: true,
  },
  collections: [
    // global / config
    Tenants,
    Users,
    Countries,
    ContentEngines,
    ActivityLog,
    // tenant-scoped
    Media,
    Authors,
    Pillars,
    Sectors,
    Tags,
    Articles,
    Newsletters,
    Podcasts,
    Corrections,
    SponsorSlots,
    MarketSnapshots,
    FxRates,
    TrendingBlocks,
    WireDrops,
    Menus,
    EngineConflictLog,
    TranslationJobs,
  ],
  editor: lexicalEditor(),
  secret: payloadSecret,
  typescript: {
    outputFile: path.resolve(dirname, "src/payload-types.ts"),
  },
  db: postgresAdapter({
    pool: { connectionString: databaseUrl },
    // Schema is managed by migrations in deployed environments (push stays off).
    // For local dev against the docker Postgres (no committed migrations yet),
    // set PAYLOAD_DB_PUSH=true to let Payload sync the schema on boot.
    push: process.env.PAYLOAD_DB_PUSH === "true",
    migrationDir: path.resolve(dirname, "src/migrations"),
  }),
  sharp,
  cors: allowedOrigins.length ? allowedOrigins : ["http://localhost:3001", "http://localhost:3002"],
  plugins: [
    multiTenantPlugin({
      // The Tenants collection IS the tenant registry.
      tenantsSlug: "tenants",
      // System admins implicitly have access to every tenant.
      userHasAccessToAllTenants: (user) =>
        (user as { role?: string } | null)?.role === "systemAdmin",
      // Per-tenant membership lives on the array the plugin adds to Users; each
      // row carries the tenant's role(s) + a publish grant (see access/helpers).
      tenantsArrayField: {
        includeDefaultField: true,
        rowFields: [
          {
            name: "roles",
            type: "select",
            hasMany: true,
            required: true,
            options: MEMBERSHIP_ROLES.map((r) => ({ label: r, value: r })),
          },
          { name: "canPublish", type: "checkbox", defaultValue: false },
        ],
      },
      // Every per-tenant collection. The plugin adds a required `tenant`
      // relationship + scopes admin list/edit views by the selected tenant.
      collections: {
        media: {},
        authors: {},
        pillars: {},
        sectors: {},
        tags: {},
        articles: {},
        newsletters: {},
        podcasts: {},
        corrections: {},
        sponsorSlots: {},
        marketSnapshots: {},
        fxRates: {},
        trendingBlocks: {},
        wireDrops: {},
        menus: {},
        engineConflictLog: {},
        translationJobs: {},
      },
    }),
    ...(r2Configured
      ? [
          s3Storage({
            collections: { media: true },
            clientUploads: true,
            bucket: process.env.R2_BUCKET as string,
            config: {
              endpoint: process.env.R2_ENDPOINT,
              region: "auto",
              credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
              },
              forcePathStyle: true,
            },
          }),
        ]
      : []),
  ],
});
