/**
 * Translation pipeline endpoints (machine traffic).
 *
 *   GET  /api/engine/translation?publicationId=  → list queued jobs for the
 *        engine's tenant(s). The translation engine claims work from here.
 *   POST /api/engine/translation                 → submit a per-locale result.
 *        Body: { publicationId?, articleId, locale, jobId?, fields: { title?, dek?,
 *                body_markdown? } }
 *
 * Writes the localized fields FOR THE TARGET LOCALE ONLY, sets translationStatus
 * to machine_translated, and completes the job. NEVER overwrites an approved or
 * locked translation (409 conflict). The frontend reads the stored translation —
 * translation never happens on a reader request.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateEngine } from "@/lib/engine-auth";
import { featureEnabled, supportedLanguages } from "@/lib/tenant";
import { markdownToLexical } from "@/lib/markdown";
import { logActivity } from "@/lib/activity";
import { json, isNonEmptyString } from "@/lib/http";
import { PROTECTED_TRANSLATION_STATES } from "@/lib/constants";

interface StatusRow {
  locale: string;
  state: string;
  sourceVersionAtTranslation?: number;
  engine?: number | string;
  [k: string]: unknown;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const publicationId = url.searchParams.get("publicationId") ?? undefined;
  const payload = await getPayload({ config });
  const auth = await authenticateEngine({ payload, request, action: "create_translation", publicationId });
  if (!auth.ok) return auth.response;
  const { tenant } = auth;

  const jobs = await payload.find({
    collection: "translationJobs",
    where: { and: [{ tenant: { equals: tenant.id } }, { status: { equals: "queued" } }] },
    limit: 50,
    depth: 0,
    overrideAccess: true,
  });
  return json({ ok: true, jobs: jobs.docs }, 200);
}

export async function POST(request: Request): Promise<Response> {
  let body: {
    publicationId?: unknown;
    articleId?: unknown;
    locale?: unknown;
    jobId?: unknown;
    fields?: { title?: unknown; dek?: unknown; body_markdown?: unknown };
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, status: "bad_request", reason: "invalid JSON" }, 400);
  }

  const publicationId = isNonEmptyString(body.publicationId) ? body.publicationId.trim() : undefined;
  const payload = await getPayload({ config });
  const auth = await authenticateEngine({ payload, request, action: "create_translation", publicationId });
  if (!auth.ok) return auth.response;
  const { engine, tenant } = auth;

  if (!featureEnabled(tenant, "translations")) {
    return json({ ok: false, status: "unprocessable", reason: "translations disabled for tenant" }, 422);
  }

  const articleId = body.articleId;
  const locale = body.locale;
  if (articleId == null || !isNonEmptyString(locale)) {
    return json({ ok: false, status: "bad_request", reason: "articleId and locale required" }, 400);
  }
  if (!supportedLanguages(tenant).includes(locale)) {
    return json({ ok: false, status: "unprocessable", reason: `locale ${locale} not supported by tenant` }, 422);
  }

  // Load the article, scoped to the tenant.
  const articleRes = await payload.find({
    collection: "articles",
    where: { and: [{ tenant: { equals: tenant.id } }, { id: { equals: articleId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const article = articleRes.docs[0] as Record<string, unknown> | undefined;
  if (!article) return json({ ok: false, status: "not_found", reason: "article not found for tenant" }, 404);

  const rows: StatusRow[] = Array.isArray(article.translationStatus) ? [...(article.translationStatus as StatusRow[])] : [];
  const row = rows.find((r) => r.locale === locale);
  if (row && PROTECTED_TRANSLATION_STATES.includes(row.state as never)) {
    await logActivity({ payload, eventType: "engine_write_skipped", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId as number | string, detail: { reason: `translation_${row.state}`, locale } });
    return json({ ok: false, status: "conflict", reason: "approved_or_locked_translation_not_overwritten", locale }, 409);
  }

  // Build localized field payload for THIS locale only.
  const fields = body.fields ?? {};
  const localized: Record<string, unknown> = {};
  if (isNonEmptyString(fields.title)) localized.title = fields.title.trim();
  if (isNonEmptyString(fields.dek)) localized.dek = fields.dek.trim();
  if (isNonEmptyString(fields.body_markdown)) localized.body = await markdownToLexical(payload, fields.body_markdown);

  const version = typeof article.version === "number" ? article.version : 1;
  const newRow: StatusRow = {
    locale,
    state: "machine_translated",
    sourceVersionAtTranslation: version,
    engine: engine.id,
    updatedAt: new Date().toISOString(),
  };
  const nextRows = row ? rows.map((r) => (r.locale === locale ? { ...r, ...newRow } : r)) : [...rows, newRow];

  try {
    // Write the localized content for the target locale.
    if (Object.keys(localized).length) {
      await payload.update({
        collection: "articles",
        id: articleId as number | string,
        locale,
        data: localized,
        context: { translationWrite: true, skipTranslationEnqueue: true },
        overrideAccess: true,
      });
    }
    // Update the non-localized status sidecar.
    await payload.update({
      collection: "articles",
      id: articleId as number | string,
      data: { translationStatus: nextRows },
      context: { translationWrite: true, skipTranslationEnqueue: true },
      overrideAccess: true,
    });

    // Complete the matching job(s).
    const jobWhere = isNonEmptyString(body.jobId)
      ? { id: { equals: body.jobId } }
      : { and: [{ article: { equals: articleId } }, { targetLocale: { equals: locale } }, { status: { in: ["queued", "claimed", "in_progress"] } }] };
    const jobs = await payload.find({ collection: "translationJobs", where: jobWhere as never, limit: 5, depth: 0, overrideAccess: true });
    for (const j of jobs.docs) {
      await payload.update({ collection: "translationJobs", id: (j as { id: number | string }).id, data: { status: "completed", engine: engine.id }, overrideAccess: true });
    }

    await logActivity({ payload, eventType: "translation_completed", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId as number | string, detail: { locale } });
    return json({ ok: true, articleId, locale, state: "machine_translated" }, 200);
  } catch (err) {
    await logActivity({ payload, eventType: "translation_failed", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId as number | string, detail: { locale, error: (err as Error).message } });
    return json({ ok: false, status: "error", reason: (err as Error).message }, 500);
  }
}
