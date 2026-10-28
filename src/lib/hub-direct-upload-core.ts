/**
 * Hub direct image upload — the two route handlers (hub docx import, phase A;
 * content-engine plan process/features/apcg-hub/active/hub-docx-ai-import-pa-cms-media_PLAN_28-10-26.md).
 *
 *   POST /api/hub/media/sign?tenant=<slug>      → handleHubMediaSign(request)
 *   POST /api/hub/media/register?tenant=<slug>  → handleHubMediaRegister(request)
 *
 * Same credential as the multipart `POST /api/hub/media`: hubRead + hubAuthor
 * (`authenticateHubAuthorEngine`). The hub's SERVER calls both; the browser only PUTs
 * the bytes to the presigned URL `sign` returns. OFF unless env
 * `HUB_DIRECT_UPLOAD_TENANTS` lists the tenant (PA-2), read on every call.
 *
 * Common check order (first failure wins): auth (401/403) → `tenant` query present
 * (400) → tenant ∈ grant (403 forbidden, logged) → `features.articles` (403
 * feature_disabled) → switch (403 feature_disabled, "direct upload disabled") →
 * Content-Length missing (411) / not digits (400) / > 4,096 (413) → JSON read capped at
 * 4,096 bytes (413 / 400) → closed body (400).
 *
 * sign: mime ∈ JPEG/PNG/WebP/GIF (415) → size ≤ 20 MiB (413) → `loadHubEditableArticle`
 *   (404 / 422 not_editable) → staging configured (503) → key
 *   `<prefix><tenant>/<articleId>/<uuid>` + `uploadId` (HMAC, 900 s) + presigned PUT
 *   (300 s) → 200. Writes nothing; no ActivityLog row (PA-1).
 *
 * register: `uploadId` (422 upload_invalid / 410 upload_expired) → token tenant = the
 *   requested tenant (422 upload_invalid) → `loadHubEditableArticle(token article)` →
 *   staging configured (503) → token key under `<prefix><tenant>/<article>/` (422
 *   upload_invalid) → HEAD (absent 409 object_missing; size ≠ signed size or type ≠ signed mime
 *   ⇒ delete + 422 upload_invalid) → read with a hard cap = signed size (over ⇒ delete
 *   + 413; vanished ⇒ 409) → `validateMediaFile` with the direct limits, GIF allowed,
 *   caption (415 / 422 media_dimensions ⇒ delete; 422 alt_required / 400 ⇒ object
 *   KEPT so the hub can fix the text and retry within the token's life) → deterministic
 *   name (PA-9) → an existing `media` of THIS tenant with that filename ⇒ update
 *   alt / caption / credit only (absent caption / credit ⇒ cleared), 200
 *   `deduped:true`; else `createTenantMedia` with the PA-7 ladder (413 / 415 / 422,
 *   staging deleted best-effort) → 201 → staging deleted (best-effort) → ActivityLog
 *   `media_uploaded` with `detail.via = "hub-direct"`.
 *
 * Never logs a token, an uploadId, a URL, a key, bytes, alt/caption/credit text — an
 * error NAME / CODE only. Unexpected errors ⇒ 500 `internal_error` + an
 * `integration_error` row. The exported wrappers never pass `deps`.
 */

import { randomUUID } from "node:crypto";
import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { logActivity } from "@/lib/activity";
import { authenticateHubAuthorEngine } from "@/lib/hub-author-auth";
import { loadHubEditableArticle, resolveTenant } from "@/lib/hub-author-handlers";
import { readSmallBody } from "@/lib/hub-author-preview-pure";
import { pgErrorCode } from "@/lib/hub-article-lock";
import { scopedFind, scopedUpdate } from "@/lib/scoped";
import { validateMediaFile, type DirectMediaMime } from "@/lib/hub-media-validate";
import { MediaCreateError, createTenantMedia } from "@/lib/media-create";
import { r2Staging, type StagingStore } from "@/lib/r2";
import {
  HUB_DIRECT_UPLOAD_LIMITS,
  deterministicMediaName,
  directError,
  directUploadTenants,
  isDirectMime,
  isDirectUploadTenant,
  newNonce,
  parseRegisterBody,
  parseSignBody,
  registerResponse,
  signResponse,
  signUploadId,
  stagingConfig,
  stagingKey,
  stagingKeyStem,
  verifyUploadId,
} from "@/lib/hub-direct-upload-pure";
import type { TenantDoc } from "@/lib/tenant";

const SCOPE = "hub/media/direct";

type Doc = Record<string, unknown>;
type Id = number | string;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubDirectDeps {
  getPayload?: () => Promise<Payload>;
  authenticate?: typeof authenticateHubAuthorEngine;
  /** The editable-article gate (default `loadHubEditableArticle`). */
  loadArticle?: (payload: Payload, tenant: { id: Id }, id: string) => ReturnType<typeof loadHubEditableArticle>;
  /** Staging storage (default: `r2Staging(stagingConfig(env))`); `null` ⇒ not configured. */
  staging?: StagingStore | null;
  create?: typeof createTenantMedia;
  /** Find a `media` doc of this tenant by exact filename (default: `scopedFind`). */
  findMediaByName?: (payload: Payload, tenantId: Id, filename: string) => Promise<Doc | null>;
  /** Update alt / caption / credit of an existing `media` doc (default: `scopedUpdate`). */
  updateMedia?: (payload: Payload, tenantId: Id, id: Id, data: Doc) => Promise<Doc>;
  env?: Record<string, string | undefined>;
  /** Epoch ms (default `Date.now`). */
  now?: () => number;
  uuid?: () => string;
}

const defaultGetPayload = () => getPayload({ config });

async function defaultFindMediaByName(payload: Payload, tenantId: Id, filename: string): Promise<Doc | null> {
  const r = await scopedFind({ payload, collection: "media", tenantId, where: { filename: { equals: filename } }, limit: 1, depth: 0 });
  return (r.docs[0] as unknown as Doc | undefined) ?? null;
}

async function defaultUpdateMedia(payload: Payload, tenantId: Id, id: Id, data: Doc): Promise<Doc> {
  return (await scopedUpdate({ payload, collection: "media", tenantId, id, data })) as unknown as Doc;
}

function errName(err: unknown): string {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : typeof err;
}

async function internal(payload: Payload, engineId: Id, err: unknown): Promise<Response> {
  const name = errName(err);
  const code = pgErrorCode(err);
  payload.logger.error(`[${SCOPE}] failed: name=${name}${code ? ` code=${code}` : ""}`);
  await logActivity({
    payload,
    eventType: "integration_error",
    actorType: "engine",
    actorEngineId: engineId,
    detail: code ? { scope: SCOPE, name, code } : { scope: SCOPE, name },
  });
  return directError("internal_error");
}

/** Best-effort staging delete: a failure is logged by NAME only and never changes the response. */
async function dropStaging(payload: Payload, staging: StagingStore, key: string): Promise<void> {
  try {
    await staging.delete(key);
  } catch (err) {
    payload.logger.warn(`[${SCOPE}] staging delete failed: name=${errName(err)}`);
  }
}

type Gate =
  | { ok: false; response: Response }
  | { ok: true; payload: Payload; engineId: Id; tenant: TenantDoc; raw: unknown; env: Record<string, string | undefined> };

/** The shared front half: auth → tenant → grant → feature → switch → Content-Length → capped JSON read. */
async function gate(request: Request, deps: HubDirectDeps): Promise<Gate> {
  const payload = await (deps.getPayload ?? defaultGetPayload)();
  const auth = await (deps.authenticate ?? authenticateHubAuthorEngine)({ payload, request });
  if (!auth.ok) return auth;
  const engineId = auth.engine.id;
  try {
    const requested = new URL(request.url).searchParams.get("tenant");
    if (requested == null || requested.trim() === "") return { ok: false, response: directError("bad_request") };
    const t = await resolveTenant(payload, auth, requested);
    if (!t.ok) return t;
    const env = deps.env ?? process.env;
    if (!isDirectUploadTenant(t.tenant.slug, directUploadTenants(env))) return { ok: false, response: directError("switch_disabled") };

    const cl = request.headers.get("content-length");
    if (cl == null || cl.trim() === "") return { ok: false, response: directError("length_required") };
    if (!/^[0-9]{1,16}$/.test(cl.trim())) return { ok: false, response: directError("bad_request") };
    const body = await readSmallBody(request, HUB_DIRECT_UPLOAD_LIMITS.bodyBytes);
    if (!body.ok) return body;
    return { ok: true, payload, engineId, tenant: t.tenant, raw: body.raw, env };
  } catch (err) {
    return { ok: false, response: await internal(payload, engineId, err) };
  }
}

const stagingFrom = (deps: HubDirectDeps, env: Record<string, string | undefined>): StagingStore | null =>
  deps.staging !== undefined ? deps.staging : r2Staging(stagingConfig(env));

const secretFrom = (env: Record<string, string | undefined>): string => {
  const s = env.PAYLOAD_SECRET;
  if (!s) throw new Error("PAYLOAD_SECRET missing");
  return s;
};

// ── sign ─────────────────────────────────────────────────────────────────────

export function handleHubMediaSign(request: Request): Promise<Response> {
  return handleHubMediaSignWith(request);
}

export async function handleHubMediaSignWith(request: Request, deps: HubDirectDeps = {}): Promise<Response> {
  const g = await gate(request, deps);
  if (!g.ok) return g.response;
  const { payload, engineId, tenant, env } = g;
  try {
    const parsed = parseSignBody(g.raw);
    if (!parsed.ok) return directError("bad_request");
    const v = parsed.value;
    if (!isDirectMime(v.mime)) return directError("media_type");
    if (v.size > HUB_DIRECT_UPLOAD_LIMITS.fileBytes) return directError("too_large");

    const article = await (deps.loadArticle ?? loadHubEditableArticle)(payload, tenant, v.articleId);
    if (!article.ok) return article.response;

    const staging = stagingFrom(deps, env);
    if (!staging) return directError("staging_unavailable");

    const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
    const key = stagingKey(staging.prefix, tenant.slug, article.articleId, (deps.uuid ?? randomUUID)());
    const exp = nowSeconds + HUB_DIRECT_UPLOAD_LIMITS.uploadIdTtlSeconds;
    const uploadId = signUploadId({ t: tenant.id, a: article.articleId, k: key, m: v.mime, s: v.size, e: exp, n: newNonce() }, secretFrom(env));
    const url = await staging.presignPut(key, v.mime, v.size, HUB_DIRECT_UPLOAD_LIMITS.putTtlSeconds);
    return signResponse({ uploadId, url, mime: v.mime, expiresAtSeconds: exp });
  } catch (err) {
    return internal(payload, engineId, err);
  }
}

// ── register ─────────────────────────────────────────────────────────────────

export function handleHubMediaRegister(request: Request): Promise<Response> {
  return handleHubMediaRegisterWith(request);
}

export async function handleHubMediaRegisterWith(request: Request, deps: HubDirectDeps = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const g = await gate(request, deps);
  if (!g.ok) return g.response;
  const { payload, engineId, tenant, env } = g;
  try {
    const parsed = parseRegisterBody(g.raw);
    if (!parsed.ok) return directError("bad_request");
    const f = parsed.value;

    const tok = verifyUploadId(f.uploadId, secretFrom(env), Math.floor(now() / 1000));
    if (!tok.ok) return directError(tok.code);
    const c = tok.claims;
    if (String(c.t) !== String(tenant.id)) return directError("upload_invalid");

    const article = await (deps.loadArticle ?? loadHubEditableArticle)(payload, tenant, String(c.a));
    if (!article.ok) return article.response;
    const staging = stagingFrom(deps, env);
    if (!staging) return directError("staging_unavailable");
    // Defence in depth: the signed key must sit under THIS tenant + article in THIS staging area.
    if (!c.k.startsWith(stagingKeyStem(staging.prefix, tenant.slug, c.a))) return directError("upload_invalid");

    const head = await staging.head(c.k);
    if (!head) return directError("object_missing");
    const headType = (head.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (head.size !== c.s || headType !== c.m) {
      await dropStaging(payload, staging, c.k);
      return directError("upload_invalid");
    }

    const got = await staging.getBytes(c.k, c.s);
    if (!got.ok) {
      if (got.reason === "missing") return directError("object_missing");
      await dropStaging(payload, staging, c.k);
      return directError("too_large");
    }
    if (got.bytes.length !== c.s) {
      await dropStaging(payload, staging, c.k);
      return directError("upload_invalid");
    }

    const bytes = got.bytes;
    const v = await validateMediaFile(
      { size: bytes.length, type: c.m, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer },
      f.alt,
      f.credit,
      {
        maxBytes: HUB_DIRECT_UPLOAD_LIMITS.fileBytes,
        maxEdge: HUB_DIRECT_UPLOAD_LIMITS.maxEdge,
        maxPixels: HUB_DIRECT_UPLOAD_LIMITS.maxPixels,
        allowGif: true,
        caption: f.caption,
      },
    );
    if (!v.ok) {
      // The OBJECT is bad ⇒ drop it; a text-field error keeps it for a corrected retry.
      if (v.code === "too_large" || v.code === "media_type" || v.code === "media_dimensions") await dropStaging(payload, staging, c.k);
      return directError(v.code);
    }

    const mime: DirectMediaMime = v.mime;
    const name = deterministicMediaName(article.articleId, bytes, mime);
    const meta = { alt: v.alt, caption: v.caption ?? null, credit: v.credit ?? null };

    const existing = await (deps.findMediaByName ?? defaultFindMediaByName)(payload, tenant.id, name);
    let doc: Doc;
    let deduped: boolean;
    if (existing) {
      doc = await (deps.updateMedia ?? defaultUpdateMedia)(payload, tenant.id, existing.id as Id, meta);
      deduped = true;
    } else {
      try {
        doc = await (deps.create ?? createTenantMedia)({
          payload,
          tenantId: tenant.id,
          prefix: tenant.slug,
          file: { data: bytes, mimetype: mime, name },
          data: {
            alt: v.alt,
            ...(v.caption !== undefined ? { caption: v.caption } : {}),
            ...(v.credit !== undefined ? { credit: v.credit } : {}),
          },
          capBytes: HUB_DIRECT_UPLOAD_LIMITS.fileBytes,
          maxPixels: HUB_DIRECT_UPLOAD_LIMITS.maxPixels,
          deadlineMs: startedMs + HUB_DIRECT_UPLOAD_LIMITS.reencodeBudgetMs,
        });
      } catch (err) {
        await dropStaging(payload, staging, c.k);
        if (err instanceof MediaCreateError) return directError(err.code);
        throw err;
      }
      deduped = false;
    }

    await dropStaging(payload, staging, c.k);

    await logActivity({
      payload,
      eventType: "media_uploaded",
      tenantId: tenant.id,
      actorType: "engine",
      actorEngineId: engineId,
      targetCollection: "media",
      targetId: doc.id as Id,
      detail: {
        via: "hub-direct",
        actor: f.actorId !== undefined ? { role: f.actorRole, id: f.actorId } : { role: f.actorRole },
        articleId: article.articleId,
        deduped,
      },
    });

    return registerResponse(doc, deduped);
  } catch (err) {
    return internal(payload, engineId, err);
  }
}
