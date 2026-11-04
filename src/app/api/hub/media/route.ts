/**
 * POST /api/hub/media?tenant=<slug> — upload ONE image from the hub composer
 * (APCGHub P5.3, T1 / T1b / T2). Same credential as the hub draft routes: a
 * ContentEngines doc with hubRead AND hubAuthor (`authenticateHubAuthorEngine`);
 * kill-switch = untick Hub Author. The browser never calls this route — the hub's
 * own server does, with the token server-side.
 *
 *   multipart/form-data, closed field set, each name at most once:
 *     file (required) · alt (required, 1–300 after trim) · credit (optional, ≤ 300)
 *     articleId (required; a hub-authored manual draft of THIS tenant)
 *     actorRole (admin|editor|marketer) · actorId (optional)   — never an email (D1)
 *
 * Check order (first failure wins): auth (401/403) → `tenant` present (400) →
 * tenant ∈ grant (403 forbidden, logged) → `features.articles` (403
 * feature_disabled) → Content-Length missing (411) / > 4,065,536 (413, before the
 * body is read) → multipart parse + field set (400) → file.size > 4,000,000 (413) →
 * mime allowlist + magic bytes (415) → header size, JPEG SOS ≤ 64 (415) → edge ≤ 4096
 * and ≤ 16.8 MP (422 media_dimensions) → alt (422 alt_required / 400) → credit (400)
 * → articleId: shape / tenant (404), manual draft + hub-authored (422 not_editable)
 * — the SAME helper as PATCH → re-encode with sharp + create (`createTenantMedia`;
 * 415 / 422 / 413 by error class) → ActivityLog `media_uploaded` → 201.
 *
 * Every error body is frozen (`HUB_MEDIA_ERROR_TABLE`). The 201 body (`mediaResponseBody`, in
 * hub-media-validate.ts since hub docx import phase A, unchanged) is an
 * allowlist built by hand (`depth: 0`, never a spread of the document).
 * Logs: an error NAME / CODE only (gap `hub-p5-2-payload-error-log-prints-sql-params`
 * also applies here: a Payload/Drizzle error may still print SQL parameters).
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";
import { authenticateHubAuthorEngine } from "@/lib/hub-author-auth";
import { loadHubEditableArticle, logInternal, resolveTenant } from "@/lib/hub-author-handlers";
import {
  checkContentLength,
  hubMediaFileName,
  mediaError,
  mediaResponseBody,
  mediaTooLarge,
  parseMediaFormEntries,
  validateMediaFile,
} from "@/lib/hub-media-validate";
import { MediaCreateError, createTenantMedia } from "@/lib/media-create";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Doc = Record<string, unknown>;

export async function POST(request: Request): Promise<Response> {
  const payload: Payload = await getPayload({ config });
  const auth = await authenticateHubAuthorEngine({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine;

  try {
    const requested = new URL(request.url).searchParams.get("tenant");
    if (requested == null || requested.trim() === "") return mediaError("bad_request");
    const t = await resolveTenant(payload, auth, requested);
    if (!t.ok) return t.response;
    const tenant = t.tenant;

    const cl = checkContentLength(request.headers.get("content-length"));
    if (!cl.ok) return cl.code === "too_large" ? mediaTooLarge() : mediaError(cl.code);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return mediaError("bad_request");
    }
    const parsed = parseMediaFormEntries(form.entries() as Iterable<[string, unknown]>);
    if (!parsed.ok) return mediaError("bad_request");
    const f = parsed.value;

    const v = await validateMediaFile(f.file, f.alt, f.credit);
    if (!v.ok) return v.code === "too_large" ? mediaTooLarge() : mediaError(v.code);

    const article = await loadHubEditableArticle(payload, tenant, f.articleId);
    if (!article.ok) return article.response;

    let doc: Doc;
    try {
      doc = await createTenantMedia({
        payload,
        tenantId: tenant.id,
        prefix: tenant.slug,
        file: { data: v.bytes, mimetype: v.mime, name: hubMediaFileName(v.mime) },
        data: v.credit !== undefined ? { alt: v.alt, credit: v.credit } : { alt: v.alt },
      });
    } catch (err) {
      if (err instanceof MediaCreateError) return err.code === "too_large" ? mediaTooLarge() : mediaError(err.code);
      throw err;
    }

    await logActivity({
      payload,
      eventType: "media_uploaded",
      tenantId: tenant.id,
      actorType: "engine",
      actorEngineId: engine.id,
      targetCollection: "media",
      targetId: doc.id as number | string,
      detail: {
        via: "hub",
        actor: f.actorId !== undefined ? { role: f.actorRole, id: f.actorId } : { role: f.actorRole },
        articleId: article.articleId,
      },
    });

    return json(mediaResponseBody(doc), 201);
  } catch (err) {
    return logInternal(payload, engine.id, err);
  }
}
