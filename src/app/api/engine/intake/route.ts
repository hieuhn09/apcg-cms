/**
 * Multi-engine, multi-tenant draft intake.
 *
 *   POST /api/engine/intake
 *   Authorization: Bearer <engine token>
 *
 * Accepts the live brief-asia/DTW engine contract (title, pillarSlug,
 * body_markdown, dek, tags[], takeaways[]?, byline, slug?, heroImageUrl?,
 * sourceProvenance{url,name,...}, publishedAt, sections[]?, countries[]?), PLUS
 * optional `publicationId` (tenant slug — required only when the engine is
 * allowed on >1 tenant) and `engineDraftId` (idempotency key) and
 * `expectedVersion` (optimistic lock).
 *
 * Site-specific extensions the live engine already sends (see
 * content-engine/admin/src/lib/{briefasia,wtb,dtw}-intake-client.ts). Central
 * MUST accept these or the fields are lost on cutover:
 *   - `secondarySubSections[{pillarSlug, subSectionSlug}]` (brief-asia) —
 *     ENRICH-ONLY: annotates a cross-post row that `sections[]` already carries.
 *   - `subSectionSlugs[]` (WTB) — fallback list for the primary sub-pillar; the
 *     first entry belonging to the primary pillar wins, the rest are dropped.
 *   - `citySlugs[]` (WTB) — resolved to the `cities` relationship, lenient.
 *   - `secondaryPillarSlugs[]` (WTB) — accepted and DELIBERATELY IGNORED. WTB
 *     feedback round 2 (m01) settled that an article has exactly one pillar;
 *     honouring these would re-introduce the "one article in two pillars" bug
 *     the source site already fixed. Logged, never 4xx (the engine still sends
 *     them and must not break).
 *
 * Behavior (aligned with the client brief — the engine does NOT publish directly):
 *   - Auth: token → engine → tenant → permission (see engine-auth).
 *   - Feature gate: tenant must have `articles` enabled.
 *   - Idempotency: dedup per tenant on engineDraftId, else engineSourceUrl.
 *   - No-overwrite: a human-edited article is never overwritten (409 conflict);
 *     on refresh of an engine-owned draft, locked fields are skipped + logged.
 *   - New drafts are created in `pending_review` (NOT published) so an editor
 *     reviews before go-live.
 *   - Retry-safe: 5xx for transient faults (engine retries), 4xx terminal.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateEngine } from "@/lib/engine-auth";
import { scopedCreate, scopedUpdate, scopedFind } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";
import { markdownToLexical } from "@/lib/markdown";
import { logActivity } from "@/lib/activity";
import { json, slugify, isNonEmptyString } from "@/lib/http";

const WORDS_PER_MINUTE = 220;
const DEFAULT_READ_MIN = 5;
const DEFAULT_AUTHOR_ROLE = "Staff Writer";

interface SourceProvenance {
  url?: unknown;
  name?: unknown;
  author?: unknown;
  accessedAt?: unknown;
}
interface IntakeBody {
  publicationId?: unknown;
  engineDraftId?: unknown;
  expectedVersion?: unknown;
  title?: unknown;
  dek?: unknown;
  pillarSlug?: unknown;
  body_markdown?: unknown;
  tags?: unknown;
  takeaways?: unknown;
  heroImageUrl?: unknown;
  imageCredit?: unknown;
  byline?: unknown;
  slug?: unknown;
  sections?: unknown;
  subSectionSlug?: unknown;
  countries?: unknown;
  sourceProvenance?: SourceProvenance;
  publishedAt?: unknown;
  // Site-specific extensions — see the header note.
  secondarySubSections?: unknown;
  subSectionSlugs?: unknown;
  citySlugs?: unknown;
  secondaryPillarSlugs?: unknown;
}

function estimateReadMin(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? DEFAULT_READ_MIN : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export async function POST(request: Request): Promise<Response> {
  let body: IntakeBody;
  try {
    body = (await request.json()) as IntakeBody;
  } catch {
    return json({ ok: false, status: "bad_request", reason: "invalid JSON body" }, 400);
  }

  const publicationId = isNonEmptyString(body.publicationId) ? body.publicationId.trim() : undefined;

  let payload;
  try {
    payload = await getPayload({ config });
  } catch (err) {
    // Misconfiguration / DB unreachable — transient; let the engine retry.
    return json({ ok: false, status: "error", reason: (err as Error).message }, 500);
  }

  // 1. Authenticate engine → tenant (action: create_article).
  const auth = await authenticateEngine({ payload, request, action: "create_article", publicationId });
  if (!auth.ok) return auth.response;
  const { engine, tenant } = auth;

  // 2. Feature gate.
  if (!featureEnabled(tenant, "articles")) {
    await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { reason: "articles feature disabled" } });
    return json({ ok: false, status: "unprocessable", reason: "articles feature disabled for tenant" }, 422);
  }

  // 3. Validate required fields.
  const title = body.title;
  const pillarSlug = body.pillarSlug;
  const bodyMarkdown = body.body_markdown;
  const missing: string[] = [];
  if (!isNonEmptyString(title)) missing.push("title");
  if (!isNonEmptyString(pillarSlug)) missing.push("pillarSlug");
  if (!isNonEmptyString(bodyMarkdown)) missing.push("body_markdown");
  if (missing.length) return json({ ok: false, status: "bad_request", reason: `missing: ${missing.join(", ")}` }, 400);

  const titleStr = title as string;
  const pillarSlugStr = pillarSlug as string;
  const bodyMarkdownStr = bodyMarkdown as string;
  const slug = isNonEmptyString(body.slug) ? slugify(body.slug) : slugify(titleStr);
  if (!slug) return json({ ok: false, status: "bad_request", reason: "could not derive slug" }, 400);
  const dek = isNonEmptyString(body.dek) ? body.dek.trim() : titleStr.slice(0, 200);
  const byline = isNonEmptyString(body.byline) ? body.byline.trim() : "";
  const tags = Array.isArray(body.tags) ? body.tags.filter(isNonEmptyString).map((t) => t.trim()) : [];
  const takeaways = Array.isArray(body.takeaways)
    ? body.takeaways.filter(isNonEmptyString).map((t) => t.trim()).join("\n") || undefined
    : undefined;
  const heroImageUrl = isNonEmptyString(body.heroImageUrl) ? body.heroImageUrl : null;
  const imageCredit = isNonEmptyString(body.imageCredit) ? body.imageCredit.trim() : null;
  const provenance = body.sourceProvenance ?? {};
  const sourceUrl = isNonEmptyString(provenance.url) ? provenance.url : null;
  const sourceName = isNonEmptyString(provenance.name) ? provenance.name : null;
  const engineDraftId = isNonEmptyString(body.engineDraftId) ? body.engineDraftId.trim() : null;
  const publishedAt = isNonEmptyString(body.publishedAt) ? body.publishedAt : new Date().toISOString();
  const expectedVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : null;

  try {
    // 4. Idempotency lookup (per tenant) by engineDraftId, then engineSourceUrl.
    let existing: Record<string, unknown> | undefined;
    if (engineDraftId) {
      const r = await scopedFind({ payload, collection: "articles", tenantId: tenant.id, where: { engineDraftId: { equals: engineDraftId } }, limit: 1, depth: 0 });
      existing = r.docs[0] as Record<string, unknown> | undefined;
    }
    if (!existing && sourceUrl) {
      const r = await scopedFind({ payload, collection: "articles", tenantId: tenant.id, where: { engineSourceUrl: { equals: sourceUrl } }, limit: 1, depth: 0 });
      existing = r.docs[0] as Record<string, unknown> | undefined;
    }

    if (existing) {
      return await refreshExisting({ payload, tenant, engine, existing, titleStr, dek, bodyMarkdownStr, takeaways, sourceUrl, sourceName, expectedVersion });
    }

    // 5. CREATE path — resolve taxonomy scoped to tenant.
    const pillarId = await resolveOne(payload, "pillars", tenant.id, { slug: { equals: pillarSlugStr } });
    if (pillarId == null) return json({ ok: false, status: "unprocessable", reason: `unknown pillar: ${pillarSlugStr}` }, 422);

    const tagIds = await resolveOrCreateTags(payload, tenant.id, tags);
    // `subSectionSlug` first, then the WTB `subSectionSlugs[]` fallback list.
    const subSectionId = await resolveSubSection(payload, tenant.id, [body.subSectionSlug, ...toArray(body.subSectionSlugs)], pillarId);
    const secondarySections = await resolveSecondarySections(payload, tenant.id, body.sections, body.secondarySubSections, pillarId);
    const countryIds = await resolveCountries(payload, body.countries);
    const cityIds = await resolveCities(payload, tenant.id, body.citySlugs);
    const ignoredPillars = toArray(body.secondaryPillarSlugs).filter(isNonEmptyString);
    if (ignoredPillars.length) {
      // Not an error: WTB settled on one pillar per article (m01). Logged so the
      // drop is visible rather than silent.
      payload.logger.info(`[intake] ignoring secondaryPillarSlugs (one pillar per article): ${ignoredPillars.join(", ")}`);
    }

    if (!byline) return json({ ok: false, status: "bad_request", reason: "missing byline (required author)" }, 400);
    const authorId = await resolveOrCreateAuthor(payload, tenant.id, byline, tenant.timezone as string | undefined);

    let heroImageId: number | string | undefined;
    // Never fall back to the source publication's name as a photo credit (GCV audit item 1).
    if (heroImageUrl) heroImageId = await uploadHero(payload, tenant.id, heroImageUrl, titleStr, slug, imageCredit);

    const lexicalBody = await markdownToLexical(payload, bodyMarkdownStr);

    // Per-tenant publish authority. Default OFF (the brief's "human owns
    // publish"); tenants migrating off a source site that auto-published keep
    // their cadence by turning this ON, so the cutover is not also an editorial
    // process change.
    const autoPublish = tenant.autoPublishEngineDrafts === true;
    const landedStatus = autoPublish ? "published" : "pending_review";

    const created = await scopedCreate({
      payload,
      collection: "articles",
      tenantId: tenant.id,
      context: { engineWrite: true, engineId: engine.id },
      data: {
        _status: autoPublish ? "published" : "draft",
        workflowStatus: landedStatus,
        origin: "engine",
        editedByHuman: false,
        aiAssisted: true,
        sourceLanguage: tenant.defaultLanguage,
        title: titleStr,
        slug,
        dek,
        takeaways,
        body: lexicalBody,
        pillar: pillarId,
        subSection: subSectionId,
        secondarySections,
        country: countryIds[0],
        countries: countryIds,
        cities: cityIds,
        tags: tagIds,
        author: authorId,
        heroImage: heroImageId,
        publishedAt,
        readMin: estimateReadMin(bodyMarkdownStr),
        version: 1,
        engineDraftId: engineDraftId ?? undefined,
        engineSourceUrl: sourceUrl ?? undefined,
        engineSourceName: sourceName ?? undefined,
      },
    });

    const id = (created as { id: number | string }).id;
    await logActivity({ payload, eventType: "engine_write_accepted", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: id, toStatus: landedStatus });
    // `id` duplicates `articleId`: the live engine clients read `id` (or
    // `doc.id`) off the response to store cmsPostId. Dropping it would silently
    // break the engine's article↔CMS link on cutover.
    return json({ ok: true, id, articleId: id, status: landedStatus, engineDraftId }, 201);
  } catch (err) {
    await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { error: (err as Error).message } });
    // Internal/DB error — transient; engine may retry.
    return json({ ok: false, status: "error", reason: (err as Error).message }, 500);
  }
}

// ── Refresh an engine-owned draft (no-overwrite enforcement) ─────────────────
async function refreshExisting(args: {
  payload: Awaited<ReturnType<typeof getPayload>>;
  tenant: { id: number | string };
  engine: { id: number | string };
  existing: Record<string, unknown>;
  titleStr: string;
  dek: string;
  bodyMarkdownStr: string;
  takeaways?: string;
  sourceUrl: string | null;
  sourceName: string | null;
  expectedVersion: number | null;
}): Promise<Response> {
  const { payload, tenant, engine, existing, titleStr, dek, bodyMarkdownStr, takeaways, sourceUrl, sourceName, expectedVersion } = args;
  const articleId = existing.id as number | string;

  // Human-owned content is never overwritten.
  if (existing.editedByHuman === true) {
    await logActivity({ payload, eventType: "engine_write_skipped", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId, detail: { reason: "human_edited" } });
    return json({ ok: false, status: "conflict", reason: "human_edited_content_not_overwritten", articleId }, 409);
  }

  // Engine must hold update_article to refresh an existing draft.
  const engineActions = (engine as { allowedActions?: string[] }).allowedActions ?? [];
  if (!engineActions.includes("update_article")) {
    await logActivity({ payload, eventType: "engine_action_denied", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId, detail: { action: "update_article", reason: "refresh requires update_article" } });
    return json({ ok: false, status: "forbidden", reason: "action not allowed: update_article", articleId }, 403);
  }

  // Optimistic lock.
  const currentVersion = typeof existing.version === "number" ? existing.version : 0;
  if (expectedVersion != null && expectedVersion !== currentVersion) {
    await payload.create({
      collection: "engineConflictLog",
      overrideAccess: true,
      data: { tenant: tenant.id, article: articleId, engine: engine.id, field: "version", engineValue: expectedVersion, currentValue: currentVersion, reason: "version_mismatch" } as never,
    });
    return json({ ok: false, status: "conflict", reason: "version_mismatch", articleId, currentVersion }, 409);
  }

  // Per-field no-overwrite: skip any locked field, logging each.
  const locked = new Set(
    Array.isArray(existing.lockedFields)
      ? (existing.lockedFields as { field?: string }[]).map((f) => f.field).filter(Boolean)
      : [],
  );
  const candidates: Record<string, unknown> = {
    title: titleStr,
    dek,
    body: await markdownToLexical(payload, bodyMarkdownStr),
    takeaways,
    engineSourceUrl: sourceUrl ?? undefined,
    engineSourceName: sourceName ?? undefined,
  };
  const data: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(candidates)) {
    if (locked.has(field)) {
      await payload.create({
        collection: "engineConflictLog",
        overrideAccess: true,
        data: { tenant: tenant.id, article: articleId, engine: engine.id, field, engineValue: typeof value === "string" ? value : "[richtext]", currentValue: existing[field] ?? null, reason: "locked" } as never,
      });
      continue;
    }
    data[field] = value;
  }

  await scopedUpdate({
    payload,
    collection: "articles",
    tenantId: tenant.id,
    id: articleId,
    context: { engineWrite: true, engineId: engine.id },
    data,
  });
  await logActivity({ payload, eventType: "engine_write_accepted", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId, detail: { refreshed: true, skipped: [...locked] } });
  // `id` alias — see the note on the create-path response.
  return json({ ok: true, id: articleId, articleId, status: "refreshed", skippedLockedFields: [...locked] }, 200);
}

// ── Taxonomy resolution (all tenant-scoped) ─────────────────────────────────
async function resolveOne(
  payload: Awaited<ReturnType<typeof getPayload>>,
  collection: "pillars",
  tenantId: number | string,
  where: Record<string, unknown>,
): Promise<number | string | undefined> {
  const r = await scopedFind({ payload, collection, tenantId, where: where as never, limit: 1, depth: 0 });
  return (r.docs[0] as { id: number | string } | undefined)?.id;
}

async function resolveOrCreateTags(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  tags: string[],
): Promise<(number | string)[]> {
  const ids: (number | string)[] = [];
  for (const raw of tags) {
    const tagSlug = slugify(raw);
    if (!tagSlug) continue;
    const found = await scopedFind({ payload, collection: "tags", tenantId, where: { slug: { equals: tagSlug } }, limit: 1, depth: 0 });
    if (found.docs.length) {
      ids.push((found.docs[0] as { id: number | string }).id);
      continue;
    }
    const created = await scopedCreate({ payload, collection: "tags", tenantId, data: { slug: tagSlug, title: raw } });
    ids.push((created as { id: number | string }).id);
  }
  return ids;
}

/** Narrow an unknown wire value to an array without throwing on scalars/null. */
function toArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/**
 * Resolve the sub-section from an ordered list of hints, scoped to tenant +
 * pillar. The FIRST hint that resolves under the primary pillar wins; the rest
 * are dropped (an article carries at most one sub-pillar). A stray hint never
 * fails the publish.
 */
async function resolveSubSection(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  hints: unknown[],
  pillarId: number | string,
): Promise<number | string | undefined> {
  const seen = new Set<string>();
  for (const raw of hints) {
    if (!isNonEmptyString(raw)) continue;
    const slug = raw.trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    const r = await scopedFind({
      payload,
      collection: "subsections",
      tenantId,
      where: { and: [{ slug: { equals: slug } }, { pillar: { equals: pillarId } }] },
      limit: 1,
      depth: 0,
    });
    const id = (r.docs[0] as { id: number | string } | undefined)?.id;
    if (id != null) return id;
  }
  return undefined;
}

/**
 * Cross-posts. `sections[]` items are pillar slugs (the live engine contract) or
 * `{ pillar, subSection }` objects. The PRIMARY pillar is excluded (it is not a
 * cross-post — mirrors the source sites); unknown slugs are skipped.
 *
 * `enrichment` is brief-asia's `secondarySubSections[{pillarSlug, subSectionSlug}]`:
 * it never ADDS a cross-post row, it only supplies the sub-section for a pillar
 * `sections[]` already listed. A pair naming a pillar that is absent from
 * `sections[]` is ignored, matching the source site.
 */
async function resolveSecondarySections(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  raw: unknown,
  enrichment: unknown,
  primaryPillarId: number | string,
): Promise<{ pillar: number | string; subSection: number | string | null }[]> {
  if (!Array.isArray(raw)) return [];

  const subSectionByPillarSlug = new Map<string, string>();
  for (const pair of toArray(enrichment)) {
    const p = pair as { pillarSlug?: unknown; subSectionSlug?: unknown };
    if (!isNonEmptyString(p?.pillarSlug) || !isNonEmptyString(p?.subSectionSlug)) continue;
    const key = p.pillarSlug.trim();
    if (!subSectionByPillarSlug.has(key)) subSectionByPillarSlug.set(key, p.subSectionSlug.trim());
  }

  const rows: { pillar: number | string; subSection: number | string | null }[] = [];
  const seen = new Set<number | string>([primaryPillarId]);
  for (const item of raw) {
    const pillarSlug = isNonEmptyString(item)
      ? item.trim()
      : isNonEmptyString((item as { pillar?: unknown })?.pillar)
        ? ((item as { pillar: string }).pillar).trim()
        : null;
    if (!pillarSlug) continue;
    const r = await scopedFind({ payload, collection: "pillars", tenantId, where: { slug: { equals: pillarSlug } }, limit: 1, depth: 0 });
    const pillarId = (r.docs[0] as { id: number | string } | undefined)?.id;
    if (pillarId == null || seen.has(pillarId)) continue;
    seen.add(pillarId);
    const subSectionHint = isNonEmptyString((item as { subSection?: unknown })?.subSection)
      ? (item as { subSection: string }).subSection
      : subSectionByPillarSlug.get(pillarSlug);
    const subSectionId = await resolveSubSection(payload, tenantId, [subSectionHint], pillarId);
    rows.push({ pillar: pillarId, subSection: subSectionId ?? null });
  }
  return rows;
}

/** WTB destination cities (tenant-scoped, hasMany). Unknown slugs are skipped. */
async function resolveCities(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  raw: unknown,
): Promise<(number | string)[]> {
  const slugs = [...new Set(toArray(raw).filter(isNonEmptyString).map((c) => c.trim().toLowerCase()))];
  const ids: (number | string)[] = [];
  for (const slug of slugs) {
    const r = await scopedFind({ payload, collection: "cities", tenantId, where: { slug: { equals: slug } }, limit: 1, depth: 0 });
    const id = (r.docs[0] as { id: number | string } | undefined)?.id;
    if (id != null) ids.push(id);
  }
  return ids;
}

async function resolveCountries(
  payload: Awaited<ReturnType<typeof getPayload>>,
  raw: unknown,
): Promise<(number | string)[]> {
  // Countries are GLOBAL reference data — looked up by ISO code, not tenant-scoped.
  const codes = Array.isArray(raw) ? [...new Set(raw.filter(isNonEmptyString).map((c) => c.trim().toLowerCase()))] : [];
  const ids: (number | string)[] = [];
  for (const code of codes) {
    const r = await payload.find({ collection: "countries", where: { code: { equals: code } }, limit: 1, depth: 0, overrideAccess: true });
    if (r.docs.length) ids.push((r.docs[0] as { id: number | string }).id);
  }
  return ids;
}

async function resolveOrCreateAuthor(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  byline: string,
  timezone: string | undefined,
): Promise<number | string> {
  const found = await scopedFind({ payload, collection: "authors", tenantId, where: { name: { equals: byline } }, limit: 1, depth: 0 });
  if (found.docs.length) return (found.docs[0] as { id: number | string }).id;
  const created = await scopedCreate({
    payload,
    collection: "authors",
    tenantId,
    data: { name: byline, role: DEFAULT_AUTHOR_ROLE, city: timezone?.split("/")[1]?.replace(/_/g, " ") ?? "" },
  });
  return (created as { id: number | string }).id;
}

async function uploadHero(
  payload: Awaited<ReturnType<typeof getPayload>>,
  tenantId: number | string,
  url: string,
  title: string,
  slug: string,
  credit: string | null,
): Promise<number | string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hero fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const ext = mimetype.split("/")[1] || "jpg";
    const media = await scopedCreate({
      payload,
      collection: "media",
      tenantId,
      data: { alt: title, credit: credit ?? undefined },
      file: { data: buffer, mimetype, name: `${slug}.${ext}`, size: buffer.length },
    });
    return (media as { id: number | string }).id;
  } catch (err) {
    payload.logger.warn(`[intake] hero upload failed (${(err as Error).message}) — publishing without hero`);
    return undefined;
  }
}
