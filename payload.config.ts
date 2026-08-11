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
import { SubSections } from "@/collections/SubSections";
import { Cities } from "@/collections/Cities";
import { Sectors } from "@/collections/Sectors";
import { Tags } from "@/collections/Tags";
import { Articles } from "@/collections/Articles";
import { Newsletters } from "@/collections/Newsletters";
import { Podcasts } from "@/collections/Podcasts";
import { Corrections } from "@/collections/Corrections";
import { Subscribers } from "@/collections/Subscribers";
import { SponsorSlots } from "@/collections/SponsorSlots";
import { MarketSnapshots } from "@/collections/MarketSnapshots";
import { FxRates } from "@/collections/FxRates";
import { FundingRows } from "@/collections/FundingRows";
import { AiLeaderboardRows } from "@/collections/AiLeaderboardRows";
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

// Public base URL of the R2 bucket (custom domain or r2.dev), WITHOUT a
// trailing slash — e.g. https://media.apcg.example. When set, media doc URLs
// point STRAIGHT at R2/Cloudflare instead of `/api/media/file/...`, so image
// bytes stop streaming through this deployment's serverless functions (which
// was billed as Vercel fast origin transfer on every reader page view — R2
// egress is free and Cloudflare CDN-caches it). When unset, behavior is
// unchanged: URLs stay on the Payload API path. Object keys are
// `<tenant-prefix>/<filename>`, mirrored by generateFileURL below.
const r2PublicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, "");

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
    SubSections,
    Cities,
    Sectors,
    Tags,
    Articles,
    Newsletters,
    Podcasts,
    Corrections,
    Subscribers,
    SponsorSlots,
    MarketSnapshots,
    FxRates,
    FundingRows,
    AiLeaderboardRows,
    TrendingBlocks,
    WireDrops,
    Menus,
    EngineConflictLog,
    TranslationJobs,
  ],
  editor: lexicalEditor(),
  // Vercel serverless bodies cap at ~4.5MB, so anything larger dies as an
  // opaque 413 before Payload sees it. Capping just below that turns an
  // oversized editor upload into a clear "Exceeded file size limit" error in
  // the admin instead. Editors should resize to ≤1600px anyway (the largest
  // imageSize derivative the reader sites ever request).
  upload: { limits: { fileSize: 4 * 1024 * 1024 } },
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
        subsections: {},
        cities: {},
        sectors: {},
        tags: {},
        articles: {},
        newsletters: {},
        podcasts: {},
        corrections: {},
        subscribers: {},
        sponsorSlots: {},
        marketSnapshots: {},
        fxRates: {},
        fundingRows: {},
        aiLeaderboardRows: {},
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
            // Per-tenant key prefixes come from the `prefix` field on each media
            // doc (set from the tenant slug in collections/Media.ts), NOT from a
            // collection-level prefix — that option is a static string and cannot
            // vary per tenant. Keys land as `<tenant>/<filename>`, matching
            // scripts/migrate/copy-media.ts. Leave useCompositePrefixes off: the
            // doc prefix must win outright.
            collections: {
              media: r2PublicBaseUrl
                ? {
                    // Serve image bytes directly from the R2 public domain.
                    // Access control loss is nil: Media read access is already
                    // `() => true` (published hero images are public bytes).
                    disablePayloadAccessControl: true,
                    generateFileURL: ({ filename, prefix }) =>
                      `${r2PublicBaseUrl}/${prefix ? `${prefix}/` : ""}${encodeURIComponent(filename)}`,
                  }
                : true,
            },
            alwaysInsertFields: true,
            // clientUploads is intentionally OFF. The browser-side presigned PUT
            // signs the RAW file.name while Payload sanitizes the doc filename at
            // create ("...SAC .JPG" → "...SAC.JPG"), so the original strands under
            // a key no lookup ever hits (4 broken editor uploads, 11-08-2026). It
            // buys nothing here anyway: the admin create POST still carries the
            // file bytes for imageSizes, so Vercel's body limit applies either
            // way — and server-side writes need no bucket CORS.
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
