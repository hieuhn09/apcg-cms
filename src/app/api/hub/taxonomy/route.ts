/**
 * GET /api/hub/taxonomy — READ-ONLY pillars + authors per publication for
 * APCGHub (APCGHub P4 / CMS-2; Newsroom screen).
 *
 *   Auth:   Authorization: Bearer <token of a ContentEngines doc with hubRead:true>
 *   Query:  tenants  CSV of tenant slugs, SUBSET of the engine's grant; outside
 *                    it ⇒ 403. Absent ⇒ every allowed tenant.
 *           kinds    CSV ⊆ {pillars, authors, subsections, tags, countries, cities};
 *                    absent ⇒ pillars + authors (unchanged). Unknown ⇒ 400.
 *
 * APCGHub P5.1 composer kinds (each block `{items, count, totalDocs, truncated}`,
 * locale `en`, order ends in `id`): subsections `{id, slug, title, pillarId, order}`
 * (cap 500), tags `{id, slug, title}` (cap 3000), countries `{id, slug, name, code}`
 * (GLOBAL reference data — not tenant-filtered; cap 300), cities `{id, slug, name,
 * country}` (cap 1000; a tenant without `citiesMap` gets an empty block with
 * `disabled: true`).
 *
 * Empty/absent tenants|pillar|kinds means ALL allowed — callers must never send
 * an empty scope by accident (Hub-1 lesson D0).
 *
 * NEVER SILENTLY CUT: Payload's default page size is 10, so every query carries
 * an explicit `limit: CAP + 1`. More than CAP rows ⇒ the list is cut to CAP and
 * `truncated: true`; `totalDocs` is the true count Payload reports.
 * Pillars/Authors are not feature-gated (plain `tenantManagedAccess`), so no
 * `features.*` check is needed here. Output is an allowlist (`hub-sanitize.ts`);
 * `Authors.user` (→ Users e-mail) is never selected. Localized text is `en`.
 *
 * WRITES: none in this route. `authenticateHubEngine` (as in CMS-1) updates the
 * engine's lastSeenAt/lastSeenIp and writes ActivityLog on auth failures; this
 * route adds ActivityLog rows only for `engine_tenant_denied` / `integration_error`.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateHubEngine, narrowHubTenants } from "@/lib/hub-auth";
import { scopedFind } from "@/lib/scoped";
import { parseKinds } from "@/lib/hub-query";
import {
  AUTHOR_SELECT,
  PILLAR_SELECT,
  sanitizeHubAuthor,
  sanitizeHubPillar,
  type HubAuthor,
  type HubPillar,
} from "@/lib/hub-sanitize";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";
import { featureEnabled, findTenantById } from "@/lib/tenant";
import { disabledBlock, hubBlock, type HubBlock } from "@/lib/hub-taxonomy-blocks";
import {
  CITY_SELECT,
  COUNTRY_SELECT,
  SUBSECTION_SELECT,
  TAG_SELECT,
  sanitizeHubCity,
  sanitizeHubCountry,
  sanitizeHubSubsection,
  sanitizeHubTag,
  type HubCity,
  type HubCountry,
  type HubSubsection,
  type HubTag,
} from "@/lib/hub-sanitize";

const PILLARS_CAP = 200;
const AUTHORS_CAP = 1000;
const SUBSECTIONS_CAP = 500;
const TAGS_CAP = 3000;
const COUNTRIES_CAP = 300;
const CITIES_CAP = 1000;

interface Block<T> {
  items: T[];
  count: number;
  totalDocs: number;
  truncated: boolean;
}

function block<T>(docs: Record<string, unknown>[], totalDocs: number, cap: number, sanitize: (d: Record<string, unknown>) => T): Block<T> {
  const items = docs.slice(0, cap).map(sanitize);
  return { items, count: items.length, totalDocs, truncated: docs.length > cap || totalDocs > cap };
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });

  const auth = await authenticateHubEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const narrowed = narrowHubTenants(auth.tenants, url.searchParams.get("tenants"));
  if (!narrowed.ok) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/taxonomy", requested: narrowed.unknown },
    });
    return json(
      { ok: false, status: "forbidden", reason: "tenant not allowed for this engine", tenants: narrowed.unknown },
      403,
    );
  }
  const tenants = narrowed.tenants;

  const kinds = parseKinds(url.searchParams.get("kinds"));
  if (!kinds.ok) {
    return json({ ok: false, status: "bad_request", reason: kinds.reason, values: kinds.values }, 400);
  }
  const wantPillars = kinds.kinds.includes("pillars");
  const wantAuthors = kinds.kinds.includes("authors");
  const wantSubsections = kinds.kinds.includes("subsections");
  const wantTags = kinds.kinds.includes("tags");
  const wantCountries = kinds.kinds.includes("countries");
  const wantCities = kinds.kinds.includes("cities");

  try {
    // Countries are global: read once, the same block for every tenant.
    const countries = wantCountries
      ? await payload.find({
          collection: "countries",
          select: COUNTRY_SELECT,
          depth: 0,
          locale: "en",
          limit: COUNTRIES_CAP + 1,
          page: 1,
          sort: ["slug", "id"],
          overrideAccess: true,
        })
      : null;
    const countriesBlock = countries
      ? hubBlock(countries.docs as unknown as Record<string, unknown>[], countries.totalDocs, COUNTRIES_CAP, sanitizeHubCountry)
      : null;
    const out = await Promise.all(
      tenants.map(async (t) => {
        const [pillars, authors] = await Promise.all([
          wantPillars
            ? scopedFind({
                payload,
                collection: "pillars",
                tenantId: t.id,
                select: PILLAR_SELECT,
                depth: 0,
                locale: "en",
                limit: PILLARS_CAP + 1,
                page: 1,
                sort: ["order", "slug", "id"],
              })
            : null,
          wantAuthors
            ? scopedFind({
                payload,
                collection: "authors",
                tenantId: t.id,
                select: AUTHOR_SELECT,
                depth: 0,
                locale: "en",
                limit: AUTHORS_CAP + 1,
                page: 1,
                sort: ["rank", "name", "id"],
              })
            : null,
        ]);
        const entry: {
          tenant: string;
          pillars?: Block<HubPillar>;
          authors?: Block<HubAuthor>;
          subsections?: HubBlock<HubSubsection>;
          tags?: HubBlock<HubTag>;
          countries?: HubBlock<HubCountry>;
          cities?: HubBlock<HubCity>;
        } = { tenant: t.slug };
        if (pillars) {
          entry.pillars = block(pillars.docs as unknown as Record<string, unknown>[], pillars.totalDocs, PILLARS_CAP, sanitizeHubPillar);
        }
        if (authors) {
          entry.authors = block(authors.docs as unknown as Record<string, unknown>[], authors.totalDocs, AUTHORS_CAP, sanitizeHubAuthor);
        }
        const citiesOn = wantCities ? featureEnabled(await findTenantById(payload, t.id), "citiesMap") : false;
        const [subsections, tags, cities] = await Promise.all([
          wantSubsections
            ? scopedFind({ payload, collection: "subsections", tenantId: t.id, select: SUBSECTION_SELECT, depth: 0, locale: "en", limit: SUBSECTIONS_CAP + 1, page: 1, sort: ["order", "slug", "id"] })
            : null,
          wantTags
            ? scopedFind({ payload, collection: "tags", tenantId: t.id, select: TAG_SELECT, depth: 0, locale: "en", limit: TAGS_CAP + 1, page: 1, sort: ["slug", "id"] })
            : null,
          citiesOn
            ? scopedFind({ payload, collection: "cities", tenantId: t.id, select: CITY_SELECT, depth: 0, locale: "en", limit: CITIES_CAP + 1, page: 1, sort: ["slug", "id"] })
            : null,
        ]);
        if (subsections) {
          entry.subsections = hubBlock(subsections.docs as unknown as Record<string, unknown>[], subsections.totalDocs, SUBSECTIONS_CAP, sanitizeHubSubsection);
        }
        if (tags) entry.tags = hubBlock(tags.docs as unknown as Record<string, unknown>[], tags.totalDocs, TAGS_CAP, sanitizeHubTag);
        if (countriesBlock) entry.countries = countriesBlock;
        if (wantCities) {
          entry.cities = cities
            ? hubBlock(cities.docs as unknown as Record<string, unknown>[], cities.totalDocs, CITIES_CAP, sanitizeHubCity)
            : disabledBlock<HubCity>();
        }
        return entry;
      }),
    );
    return json({ ok: true, locale: "en", tenants: out }, 200);
  } catch (err) {
    payload.logger.error(`[hub/taxonomy] read failed: ${(err as Error).message}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/taxonomy", message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
}
