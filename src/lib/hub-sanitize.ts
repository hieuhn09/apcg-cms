/**
 * Response allowlists for the read-only `/api/hub/tenants` and
 * `/api/hub/taxonomy` routes (APCGHub P4 / CMS-2).
 *
 * Two independent barriers, same pattern as `/api/hub/articles`:
 *   1. a `*_SELECT` sent to Payload that names only `true` fields, so anything
 *      not listed is never read from the DB;
 *   2. a `sanitizeHub*` function that builds a FRESH object field by field and
 *      never spreads the source document, so anything not listed can never reach
 *      the wire even if the select were widened by mistake.
 * Default is DENY: a new field on Tenants/Pillars/Authors is invisible here until
 * someone names it on purpose.
 *
 * FIELDS EMITTED
 *   Tenant: id, name, slug, status, domain, additionalDomains[] (strings),
 *     frontendUrl, logoMediaId, brandColor, brand.{faviconUrl,
 *     ogImageDefaultMediaId}, defaultLanguage, supportedLanguages[], timezone,
 *     seo.{titleSuffix, defaultMetaDescription, defaultOgImageMediaId,
 *     twitterHandle}, socials[].{platform,url}, features.{11 flags}
 *   Pillar: id, slug, title, navLabel, heading, color, icon, order, description
 *   Author: id, name, rank, slug, role, city, avatarMediaId, bio
 *
 * SENSITIVE / WITHHELD FIELDS, each absent by construction (not selected AND
 * not copied):
 *   Tenants.readTokens (tokenHash, tokenPrefix) — secrets. `defaultPopulate`
 *     on Tenants does NOT protect a direct find, so the select is what matters.
 *   Tenants.allowedEngines — relationship to ContentEngines (token hashes).
 *   Tenants.contact.* — contact e-mail addresses (owner decision 24-09-26).
 *   Tenants.autoPublishEngineDrafts, brand.themeTokens (unbounded JSON),
 *     dashboards.* — withheld (owner decision 24-09-26, gap
 *     `cms2-settings-fields-withheld`).
 *   Authors.user — relationship to Users (e-mail).
 *   tenant / createdAt / updatedAt on every collection.
 *
 * Uploads (`logo`, `brand.ogImageDefault`, `seo.defaultOgImage`, `avatar`) are
 * read at depth 0 and emitted as a bare media id — never a Media document or a
 * URL (media is P5, gap `cms2-media-url-deferred-p5`).
 */

export const TENANT_SELECT = {
  name: true,
  slug: true,
  status: true,
  domain: true,
  additionalDomains: { domain: true },
  frontendUrl: true,
  logo: true,
  brandColor: true,
  brand: { faviconUrl: true, ogImageDefault: true },
  defaultLanguage: true,
  supportedLanguages: true,
  timezone: true,
  seo: { titleSuffix: true, defaultMetaDescription: true, defaultOgImage: true, twitterHandle: true },
  socials: { platform: true, url: true },
  features: {
    articles: true,
    newsletters: true,
    podcasts: true,
    marketData: true,
    sponsorSlots: true,
    wireDrops: true,
    corrections: true,
    translations: true,
    dashboards: true,
    citiesMap: true,
    video: true,
  },
} as const;

export const PILLAR_SELECT = {
  slug: true,
  title: true,
  navLabel: true,
  heading: true,
  color: true,
  icon: true,
  order: true,
  description: true,
} as const;

export const AUTHOR_SELECT = {
  name: true,
  rank: true,
  slug: true,
  role: true,
  city: true,
  avatar: true,
  bio: true,
} as const;

const FEATURE_KEYS = [
  "articles",
  "newsletters",
  "podcasts",
  "marketData",
  "sponsorSlots",
  "wireDrops",
  "corrections",
  "translations",
  "dashboards",
  "citiesMap",
  "video",
] as const;

type Doc = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function obj(v: unknown): Doc {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
}

function arr(v: unknown): Doc[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Doc[]) : [];
}

/** An upload at depth 0 is its id. Anything else (a populated doc) ⇒ its id, never the doc. */
export function mediaId(v: unknown): number | string | null {
  if (typeof v === "number" || typeof v === "string") return v;
  if (v && typeof v === "object") {
    const id = (v as Doc).id;
    if (typeof id === "number" || typeof id === "string") return id;
  }
  return null;
}

export interface HubTenant {
  id: number | string;
  slug: string | null;
  name: string | null;
  status: string | null;
  domain: string | null;
  additionalDomains: string[];
  frontendUrl: string | null;
  logoMediaId: number | string | null;
  brandColor: string | null;
  brand: { faviconUrl: string | null; ogImageDefaultMediaId: number | string | null };
  defaultLanguage: string | null;
  supportedLanguages: string[];
  timezone: string | null;
  seo: {
    titleSuffix: string | null;
    defaultMetaDescription: string | null;
    defaultOgImageMediaId: number | string | null;
    twitterHandle: string | null;
  };
  socials: { platform: string | null; url: string | null }[];
  /** A missing flag is `null`, not a guessed default — the real default lives in the DB. */
  features: Record<(typeof FEATURE_KEYS)[number], boolean | null>;
}

export function sanitizeHubTenant(doc: Doc): HubTenant {
  const brand = obj(doc.brand);
  const seo = obj(doc.seo);
  const features = obj(doc.features);
  const flags = {} as HubTenant["features"];
  for (const k of FEATURE_KEYS) flags[k] = typeof features[k] === "boolean" ? (features[k] as boolean) : null;

  return {
    id: doc.id as number | string,
    slug: str(doc.slug),
    name: str(doc.name),
    status: str(doc.status),
    domain: str(doc.domain),
    additionalDomains: arr(doc.additionalDomains)
      .map((d) => str(d.domain))
      .filter((d): d is string => d != null),
    frontendUrl: str(doc.frontendUrl),
    logoMediaId: mediaId(doc.logo),
    brandColor: str(doc.brandColor),
    brand: { faviconUrl: str(brand.faviconUrl), ogImageDefaultMediaId: mediaId(brand.ogImageDefault) },
    defaultLanguage: str(doc.defaultLanguage),
    supportedLanguages: Array.isArray(doc.supportedLanguages)
      ? doc.supportedLanguages.filter((l): l is string => typeof l === "string")
      : [],
    timezone: str(doc.timezone),
    seo: {
      titleSuffix: str(seo.titleSuffix),
      defaultMetaDescription: str(seo.defaultMetaDescription),
      defaultOgImageMediaId: mediaId(seo.defaultOgImage),
      twitterHandle: str(seo.twitterHandle),
    },
    socials: arr(doc.socials).map((s) => ({ platform: str(s.platform), url: str(s.url) })),
    features: flags,
  };
}

export interface HubPillar {
  id: number | string;
  slug: string | null;
  title: string | null;
  navLabel: string | null;
  heading: string | null;
  color: string | null;
  icon: string | null;
  order: number | null;
  description: string | null;
}

export function sanitizeHubPillar(doc: Doc): HubPillar {
  return {
    id: doc.id as number | string,
    slug: str(doc.slug),
    title: str(doc.title),
    navLabel: str(doc.navLabel),
    heading: str(doc.heading),
    color: str(doc.color),
    icon: str(doc.icon),
    order: num(doc.order),
    description: str(doc.description),
  };
}

export interface HubAuthor {
  id: number | string;
  name: string | null;
  rank: number | null;
  slug: string | null;
  role: string | null;
  city: string | null;
  avatarMediaId: number | string | null;
  bio: string | null;
}

export function sanitizeHubAuthor(doc: Doc): HubAuthor {
  return {
    id: doc.id as number | string,
    name: str(doc.name),
    rank: num(doc.rank),
    slug: str(doc.slug),
    role: str(doc.role),
    city: str(doc.city),
    avatarMediaId: mediaId(doc.avatar),
    bio: str(doc.bio),
  };
}
