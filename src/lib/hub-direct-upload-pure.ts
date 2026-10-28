/**
 * hub-direct-upload-pure — the PURE half of the hub direct image upload (hub docx
 * import, phase A; content-engine plan
 * process/features/apcg-hub/active/hub-docx-ai-import-pa-cms-media_PLAN_28-10-26.md,
 * decisions PA-1..PA-12). No I/O: limits, the env switch, the staging config, the
 * stateless `uploadId` token, the deterministic file name, the two closed JSON
 * bodies and the frozen error table. The route logic is `hub-direct-upload-core.ts`.
 *
 *   POST /api/hub/media/sign?tenant=<slug>      → a 300 s presigned PUT into R2 staging
 *   POST /api/hub/media/register?tenant=<slug>  → re-check the object, create `media`
 *
 * Nothing here ever logs; nothing here reads a key except `directUploadTenants` and
 * `stagingConfig`, which read the env they are GIVEN (default `process.env`).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { json } from "@/lib/http";
import { ACTOR_ID_MAX, ACTOR_ROLES } from "@/lib/hub-author-limits";
import { checkStr } from "@/lib/hub-author-input";
import { mediaResponseBody, storedExt, type DirectMediaMime } from "@/lib/hub-media-validate";

// ── Limits (PA-4 / PA-5) ─────────────────────────────────────────────────────

export const HUB_DIRECT_UPLOAD_LIMITS = {
  /** Largest object accepted, before AND after re-encoding (20 MiB). */
  fileBytes: 20 * 1024 * 1024,
  /** Longest accepted edge, from the header, before any decode. */
  maxEdge: 12_000,
  /**
   * Pixel cap, from the header before any decode and as sharp's `limitInputPixels`.
   * Held at the plan's FLOOR (12 MP) pending an owner decision: spike A2 (content-engine
   * report `hub-docx-ai-import-pa_REPORT_28-10-26.md`) found no level of {12, 24, 36, 50}
   * MP that passes for EVERY format under the plan's assumed 1024 MB function (pass =
   * p95 ≤ 40 s AND peak RSS ≤ 614 MB): WebP peaked at 711 MB already at 12 MP. JPEG and
   * PNG passed up to 36 MP. Raise only after the owner's Preview run / memory setting.
   */
  maxPixels: 12_000_000,
  /** Lifetime of the presigned PUT URL. */
  putTtlSeconds: 300,
  /** Lifetime of the `uploadId` (sign → register). */
  uploadIdTtlSeconds: 900,
  /** Cap on the JSON body of both routes. */
  bodyBytes: 4096,
  /** Longest `uploadId` string accepted before any decode. */
  uploadIdMaxChars: 2048,
  /** Largest decoded `uploadId` JSON (PA-4). */
  uploadIdJsonMaxBytes: 1024,
  /** PA-7: no further re-encode step starts later than this after `register` began. */
  reencodeBudgetMs: 45_000,
} as const;

export const DIRECT_MIME: readonly DirectMediaMime[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export const isDirectMime = (v: unknown): v is DirectMediaMime => typeof v === "string" && (DIRECT_MIME as readonly string[]).includes(v);

// ── The switch (PA-2) ────────────────────────────────────────────────────────

/**
 * `HUB_DIRECT_UPLOAD_TENANTS` — CSV of CMS tenant slugs, default OFF. Read on EVERY
 * call (no cache); split on ",", trim, drop empty items; matched EXACTLY
 * (case-sensitive) by `isDirectUploadTenant`. Same shape as `HUB_LIVE_EDIT_TENANTS`.
 * The multipart route `POST /api/hub/media` never reads it.
 */
export function directUploadTenants(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.HUB_DIRECT_UPLOAD_TENANTS;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isDirectUploadTenant(slug: string, tenants: readonly string[]): boolean {
  return tenants.includes(slug);
}

// ── Staging (PA-3) ───────────────────────────────────────────────────────────

export const DEFAULT_STAGING_PREFIX = "_hub-staging/";
const PREFIX_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/;

export interface StagingConfig {
  bucket: string;
  /** "" for a dedicated staging bucket; `_hub-staging/` (or `R2_STAGING_PREFIX`) inside the main bucket. */
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** True when a dedicated bucket is used (`R2_STAGING_BUCKET` set and ≠ `R2_BUCKET`). */
  dedicated: boolean;
}

/**
 * The staging location, or null (⇒ `sign` 503 `staging_unavailable`).
 * Needs `R2_ENDPOINT` and a key pair (`R2_STAGING_ACCESS_KEY_ID` +
 * `R2_STAGING_SECRET_ACCESS_KEY`, else the main `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`).
 * `R2_STAGING_BUCKET` set and different from `R2_BUCKET` ⇒ that bucket, no prefix.
 * Otherwise, with `R2_BUCKET` set ⇒ the main bucket under `R2_STAGING_PREFIX`
 * (default `_hub-staging/`; must be slash-separated `[A-Za-z0-9_-]` segments ending in
 * "/", else null). Neither ⇒ null.
 */
export function stagingConfig(env: Record<string, string | undefined> = process.env): StagingConfig | null {
  const endpoint = env.R2_ENDPOINT?.trim();
  const ownKey = env.R2_STAGING_ACCESS_KEY_ID?.trim();
  const ownSecret = env.R2_STAGING_SECRET_ACCESS_KEY?.trim();
  const accessKeyId = ownKey && ownSecret ? ownKey : env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = ownKey && ownSecret ? ownSecret : env.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const main = env.R2_BUCKET?.trim();
  const staging = env.R2_STAGING_BUCKET?.trim();
  if (staging && staging !== main) return { bucket: staging, prefix: "", endpoint, accessKeyId, secretAccessKey, dedicated: true };
  if (!main) return null;
  const rawPrefix = env.R2_STAGING_PREFIX?.trim();
  const prefix = rawPrefix ? rawPrefix : DEFAULT_STAGING_PREFIX;
  if (!PREFIX_RE.test(prefix)) return null;
  return { bucket: main, prefix, endpoint, accessKeyId, secretAccessKey, dedicated: false };
}

/** `<prefix><tenantSlug>/<articleId>/<uuid v4>` — built by the server only. */
export function stagingKey(prefix: string, tenantSlug: string, articleId: number, uuid: string): string {
  return `${prefix}${tenantSlug}/${articleId}/${uuid}`;
}

/** The part of a staging key fixed by (prefix, tenant, article) — `register` checks the token's key starts with it. */
export const stagingKeyStem = (prefix: string, tenantSlug: string, articleId: number) => `${prefix}${tenantSlug}/${articleId}/`;

// ── uploadId (PA-4) ──────────────────────────────────────────────────────────

export interface UploadClaims {
  /** tenant id */
  t: number | string;
  /** article id */
  a: number;
  /** staging key */
  k: string;
  /** declared mime */
  m: DirectMediaMime;
  /** declared size in bytes */
  s: number;
  /** expiry, epoch seconds */
  e: number;
  /** nonce, 16 random bytes, base64url */
  n: string;
}

const CLAIM_KEYS = ["t", "a", "k", "m", "s", "e", "n"] as const;
export const UPLOAD_ID_VERSION = "v1";
const KEY_LABEL = "hub-direct-upload-v1";

const b64url = (b: Buffer) => b.toString("base64url");
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** HMAC key = HMAC-SHA256(PAYLOAD_SECRET, "hub-direct-upload-v1") — no new secret (PA-4). */
export function uploadIdKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(KEY_LABEL, "utf8").digest();
}

export const newNonce = (): string => b64url(randomBytes(16));

/** `v1.<b64url(JSON)>.<b64url(HMAC-SHA256)>`; the MAC covers `v1.<json part>`. */
export function signUploadId(claims: UploadClaims, secret: string): string {
  const ordered: Record<string, unknown> = {};
  for (const k of CLAIM_KEYS) ordered[k] = claims[k];
  const body = b64url(Buffer.from(JSON.stringify(ordered), "utf8"));
  const signed = `${UPLOAD_ID_VERSION}.${body}`;
  const mac = createHmac("sha256", uploadIdKey(secret)).update(signed, "utf8").digest();
  return `${signed}.${b64url(mac)}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function claimsShape(v: unknown): UploadClaims | null {
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((k) => keys.includes(k))) return null;
  const { t, a, k, m, s, e, n } = v;
  if (!((typeof t === "number" && Number.isSafeInteger(t)) || (typeof t === "string" && t !== ""))) return null;
  if (typeof a !== "number" || !Number.isSafeInteger(a) || a < 1) return null;
  if (typeof k !== "string" || k === "" || k.length > 512) return null;
  if (!isDirectMime(m)) return null;
  if (typeof s !== "number" || !Number.isSafeInteger(s) || s < 1 || s > HUB_DIRECT_UPLOAD_LIMITS.fileBytes) return null;
  if (typeof e !== "number" || !Number.isSafeInteger(e)) return null;
  if (typeof n !== "string" || !B64URL_RE.test(n)) return null;
  return { t, a, k, m, s, e, n };
}

export type VerifyUploadIdResult = { ok: true; claims: UploadClaims } | { ok: false; code: "upload_invalid" | "upload_expired" };

/**
 * Verify, in this order: string length, exactly 3 parts, version, base64url, decoded
 * JSON ≤ 1 KiB, MAC (constant time, BEFORE any JSON parse), JSON shape (exact keys,
 * types), expiry (`e` < now ⇒ upload_expired). Anything else ⇒ upload_invalid.
 */
export function verifyUploadId(raw: unknown, secret: string, nowSeconds: number): VerifyUploadIdResult {
  const invalid = { ok: false as const, code: "upload_invalid" as const };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HUB_DIRECT_UPLOAD_LIMITS.uploadIdMaxChars) return invalid;
  const parts = raw.split(".");
  if (parts.length !== 3) return invalid;
  const [version, body, mac] = parts as [string, string, string];
  if (version !== UPLOAD_ID_VERSION || !B64URL_RE.test(body) || !B64URL_RE.test(mac)) return invalid;
  const json = Buffer.from(body, "base64url");
  if (json.length > HUB_DIRECT_UPLOAD_LIMITS.uploadIdJsonMaxBytes) return invalid;
  const expected = createHmac("sha256", uploadIdKey(secret)).update(`${version}.${body}`, "utf8").digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    return invalid;
  }
  const claims = claimsShape(parsed);
  if (!claims) return invalid;
  if (claims.e < nowSeconds) return { ok: false, code: "upload_expired" };
  return { ok: true, claims };
}

// ── Deterministic file name (PA-9) ───────────────────────────────────────────

/**
 * `hub-<sha256(String(articleId) + ":" + ORIGINAL bytes)[:32]>.<ext>` — the bytes as
 * uploaded, BEFORE re-encoding; ext of the STORED format (GIF ⇒ png).
 */
export function deterministicMediaName(articleId: number, original: Uint8Array, mime: DirectMediaMime): string {
  const h = createHash("sha256").update(`${String(articleId)}:`, "utf8").update(original).digest("hex");
  return `hub-${h.slice(0, 32)}.${storedExt(mime)}`;
}

// ── Closed JSON bodies ───────────────────────────────────────────────────────

export const HUB_SIGN_KEYS = ["articleId", "mime", "size", "actorRole", "actorId"] as const;
export const HUB_REGISTER_KEYS = ["uploadId", "alt", "caption", "credit", "actorRole", "actorId"] as const;

type ActorRole = (typeof ACTOR_ROLES)[number];

export interface HubSignInput {
  /** Raw string; its SHAPE is checked by `loadHubEditableArticle` (⇒ 404). */
  articleId: string;
  /** Any string here; the list check (415) comes after the parse. */
  mime: string;
  /** Integer ≥ 1; the cap check (413) comes after the parse. */
  size: number;
  actorRole: ActorRole;
  actorId?: string;
}

export interface HubRegisterInput {
  uploadId: string;
  alt: string;
  caption?: string;
  credit?: string;
  actorRole: ActorRole;
  actorId?: string;
}

type Parse<T> = { ok: true; value: T } | { ok: false };

function closedKeys(raw: unknown, allowed: readonly string[], required: readonly string[]): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) return false;
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) return false;
  for (const k of required) if (!(k in raw)) return false;
  return true;
}

function actorOk(raw: Record<string, unknown>): { role: ActorRole; id?: string } | null {
  const role = raw.actorRole;
  if (typeof role !== "string" || !(ACTOR_ROLES as readonly string[]).includes(role)) return null;
  if (raw.actorId === undefined) return { role: role as ActorRole };
  if (typeof raw.actorId !== "string") return null;
  const r = checkStr(raw.actorId, { max: ACTOR_ID_MAX, nonEmpty: true });
  return r.ok ? { role: role as ActorRole, id: raw.actorId } : null;
}

/** EXACTLY {articleId, mime, size, actorRole, actorId?}; any other key or kind ⇒ not ok (400). */
export function parseSignBody(raw: unknown): Parse<HubSignInput> {
  if (!closedKeys(raw, HUB_SIGN_KEYS, ["articleId", "mime", "size", "actorRole"])) return { ok: false };
  const { articleId, mime, size } = raw;
  if (typeof articleId !== "string" || typeof mime !== "string") return { ok: false };
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return { ok: false };
  const actor = actorOk(raw);
  if (!actor) return { ok: false };
  return { ok: true, value: { articleId, mime, size, actorRole: actor.role, ...(actor.id !== undefined ? { actorId: actor.id } : {}) } };
}

/** EXACTLY {uploadId, alt, caption?, credit?, actorRole, actorId?}; strings only (content checks later). */
export function parseRegisterBody(raw: unknown): Parse<HubRegisterInput> {
  if (!closedKeys(raw, HUB_REGISTER_KEYS, ["uploadId", "alt", "actorRole"])) return { ok: false };
  const { uploadId, alt, caption, credit } = raw;
  if (typeof uploadId !== "string" || typeof alt !== "string") return { ok: false };
  if (caption !== undefined && typeof caption !== "string") return { ok: false };
  if (credit !== undefined && typeof credit !== "string") return { ok: false };
  const actor = actorOk(raw);
  if (!actor) return { ok: false };
  const value: HubRegisterInput = { uploadId, alt, actorRole: actor.role };
  if (caption !== undefined) value.caption = caption;
  if (credit !== undefined) value.credit = credit;
  if (actor.id !== undefined) value.actorId = actor.id;
  return { ok: true, value };
}

// ── Frozen error table ───────────────────────────────────────────────────────

export type HubDirectErrorCode =
  | "bad_request"
  | "length_required"
  | "switch_disabled"
  | "upload_invalid"
  | "upload_expired"
  | "object_missing"
  | "too_large"
  | "media_type"
  | "media_dimensions"
  | "alt_required"
  | "staging_unavailable"
  | "internal_error";

const DIRECT_BODIES: Record<HubDirectErrorCode, { http: number; body: Record<string, unknown> }> = {
  bad_request: { http: 400, body: { ok: false, status: "bad_request", reason: "invalid direct upload request" } },
  length_required: { http: 411, body: { ok: false, status: "length_required", reason: "Content-Length header is required" } },
  switch_disabled: { http: 403, body: { ok: false, status: "feature_disabled", reason: "direct upload disabled for tenant" } },
  upload_invalid: { http: 422, body: { ok: false, status: "upload_invalid", reason: "upload is not valid for this request" } },
  upload_expired: { http: 410, body: { ok: false, status: "upload_expired", reason: "upload expired, sign again" } },
  object_missing: { http: 409, body: { ok: false, status: "object_missing", reason: "uploaded object not found" } },
  too_large: { http: 413, body: { ok: false, status: "too_large", reason: `image exceeds ${HUB_DIRECT_UPLOAD_LIMITS.fileBytes} bytes` } },
  media_type: { http: 415, body: { ok: false, status: "media_type", reason: "only JPEG, PNG, WebP or GIF images are accepted" } },
  media_dimensions: {
    http: 422,
    body: {
      ok: false,
      status: "media_dimensions",
      reason: `image exceeds ${HUB_DIRECT_UPLOAD_LIMITS.maxEdge} px per edge or ${HUB_DIRECT_UPLOAD_LIMITS.maxPixels} pixels`,
    },
  },
  alt_required: { http: 422, body: { ok: false, status: "alt_required", reason: "alt text is required" } },
  staging_unavailable: { http: 503, body: { ok: false, status: "staging_unavailable", reason: "direct upload storage is not configured" } },
  internal_error: { http: 500, body: { ok: false, status: "internal_error" } },
};

export function directError(code: HubDirectErrorCode): Response {
  const r = DIRECT_BODIES[code];
  return json(r.body, r.http, { "Cache-Control": "no-store" });
}

/**
 * Every body the two routes can return (the unit test pins this list). Shared rows
 * are the hub helpers' own bodies, written out so a drift there is caught here.
 */
export const HUB_DIRECT_ERROR_TABLE: readonly { http: string; status: string; body: string | null }[] = [
  { http: "401/403", status: "authenticateHubAuthorEngine", body: null },
  { http: "400", status: "bad_request", body: JSON.stringify(DIRECT_BODIES.bad_request.body) },
  { http: "400", status: "bad_request (JSON)", body: JSON.stringify({ ok: false, status: "bad_request", reason: "body must be valid JSON" }) },
  { http: "403", status: "forbidden", body: JSON.stringify({ ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: "<slugs>" }) },
  { http: "403", status: "feature_disabled", body: JSON.stringify({ ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }) },
  { http: "403", status: "feature_disabled (switch)", body: JSON.stringify(DIRECT_BODIES.switch_disabled.body) },
  { http: "404", status: "not_found", body: JSON.stringify({ ok: false, status: "not_found", reason: "article not found for tenant" }) },
  { http: "409", status: "object_missing", body: JSON.stringify(DIRECT_BODIES.object_missing.body) },
  { http: "410", status: "upload_expired", body: JSON.stringify(DIRECT_BODIES.upload_expired.body) },
  { http: "411", status: "length_required", body: JSON.stringify(DIRECT_BODIES.length_required.body) },
  { http: "413", status: "too_large (body)", body: JSON.stringify({ ok: false, status: "too_large", reason: `request body exceeds ${HUB_DIRECT_UPLOAD_LIMITS.bodyBytes} bytes` }) },
  { http: "413", status: "too_large", body: JSON.stringify(DIRECT_BODIES.too_large.body) },
  { http: "415", status: "media_type", body: JSON.stringify(DIRECT_BODIES.media_type.body) },
  { http: "422", status: "not_editable", body: JSON.stringify({ ok: false, status: "not_editable", reason: "<origin|status|not_hub_authored>" }) },
  { http: "422", status: "upload_invalid", body: JSON.stringify(DIRECT_BODIES.upload_invalid.body) },
  { http: "422", status: "media_dimensions", body: JSON.stringify(DIRECT_BODIES.media_dimensions.body) },
  { http: "422", status: "alt_required", body: JSON.stringify(DIRECT_BODIES.alt_required.body) },
  { http: "500", status: "internal_error", body: JSON.stringify(DIRECT_BODIES.internal_error.body) },
  { http: "503", status: "staging_unavailable", body: JSON.stringify(DIRECT_BODIES.staging_unavailable.body) },
];

// ── Success bodies ───────────────────────────────────────────────────────────

export function signResponse(a: { uploadId: string; url: string; mime: DirectMediaMime; expiresAtSeconds: number }): Response {
  return json(
    {
      ok: true,
      uploadId: a.uploadId,
      put: { url: a.url, method: "PUT", headers: { "Content-Type": a.mime }, expiresInSec: HUB_DIRECT_UPLOAD_LIMITS.putTtlSeconds },
      limits: { maxBytes: HUB_DIRECT_UPLOAD_LIMITS.fileBytes, maxPixels: HUB_DIRECT_UPLOAD_LIMITS.maxPixels, maxEdge: HUB_DIRECT_UPLOAD_LIMITS.maxEdge },
      expiresAt: new Date(a.expiresAtSeconds * 1000).toISOString(),
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

/** The multipart route's 201 allowlist + `caption` + `deduped` (201 created / 200 deduped). */
export function registerResponse(doc: Record<string, unknown>, deduped: boolean): Response {
  const base = mediaResponseBody(doc);
  const caption = typeof doc.caption === "string" ? doc.caption : null;
  return json({ ok: true, deduped, media: { ...base.media, caption } }, deduped ? 200 : 201, { "Cache-Control": "no-store" });
}
