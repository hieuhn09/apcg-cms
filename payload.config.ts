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
import { VideoMedia } from "@/collections/VideoMedia";
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
    VideoMedia,
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
  // Admin uploads go straight from the browser to R2 (clientUploads, below), so
  // the file bytes never pass through a Vercel request body and the ~4.5MB
  // serverless body cap no longer binds. This limit is what the presigned-URL
  // handler enforces before it signs anything, so an oversized file still fails
  // fast with "Exceeded file size limit" instead of a mid-upload error.
  //
  // 20MB is sized for editorial photography with headroom; the create request
  // still pulls the object back into memory to generate the imageSizes, so this
  // is also the per-invocation memory floor. Server-side multipart POSTs to
  // /api/media (scripts, not the admin) remain bound by Vercel's ~4.5MB body cap
  // regardless of this number.
  upload: { limits: { fileSize: 20 * 1024 * 1024 } },
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
        videoMedia: {},
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
              // Same treatment for video: same bucket, same per-doc tenant
              // prefix, same public R2 domain. A <video src> cannot carry a
              // Bearer token any more than an <img src> can.
              videoMedia: r2PublicBaseUrl
                ? {
                    disablePayloadAccessControl: true,
                    generateFileURL: ({ filename, prefix }) =>
                      `${r2PublicBaseUrl}/${prefix ? `${prefix}/` : ""}${encodeURIComponent(filename)}`,
                  }
                : true,
            },
            alwaysInsertFields: true,
            /**
             * Upload straight from the browser to R2 via a presigned PUT, so the
             * file bytes skip Vercel's ~4.5MB request body cap. The admin create
             * POST then carries only JSON metadata; the server fetches the object
             * back from R2 to generate the imageSizes.
             *
             * This was OFF between 11-08-2026 and 08-09-2026 because the presigned
             * key and the stored doc filename could diverge (payload signs with
             * `sanitizeFilename`, then re-sanitizes at create with the stricter
             * `sanitize-filename` package — "SAC .JPG" → "SAC.JPG"), stranding the
             * original under a key no lookup ever hit. Still true in 3.85.1, so
             * collections/Media.ts verifies the object landed on the doc's key
             * after every client upload, relocates it when it did not, and fails
             * the create outright if it cannot — no more silently broken media.
             *
             * REQUIRES bucket CORS allowing PUT from the admin origin:
             * `npm run r2:cors`. Note the signed docPrefix comes from the form, so
             * any authenticated CMS user can sign a PUT into another tenant's
             * prefix; acceptable here (all users are internal staff) and the doc's
             * own prefix is still set server-side from its tenant.
             */
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
