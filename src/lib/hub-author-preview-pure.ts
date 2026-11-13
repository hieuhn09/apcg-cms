/**
 * Hub PREVIEW mint — pure helpers (APCGHub P5.6, chặng 1; content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-6-preview-taxonomy-cms-exit_PLAN_30-09-26.md,
 * D1–D11, Public Contract C-PV).
 *
 * No I/O, no Payload, no `@payload-config`. Imported ONE WAY by
 * `hub-author-preview-core.ts` (and, from chặng 2, by the taxonomy-create core for
 * `readSmallBody`).
 *
 *   PREVIEW_TTL_SECONDS  600, a constant (D3): never read from env, never from the request.
 *   readSmallBody        the ≤ 4,096-byte body reader shared by the three P5.6 routes (D11):
 *                        `Content-Length` checked first, then the stream is read and STOPPED
 *                        at byte 4,097 (a lying or absent `Content-Length` cannot make it read
 *                        more than one chunk past the cap). 413 before any JSON parse.
 *   parsePreviewBody     EXACTLY {tenant, actor}; the `actor` block is a COPY of the publish
 *                        body's (`parsePublishBody`, hub-author-input.ts), kept in step by P04.
 *   previewClaims        EXACTLY {tenant, slug, draft: true, exp} (D4) — what the existing
 *                        verifier at /api/public/preview reads.
 *   checkFrontendUrl     D6: string-level refusal of `?`, `#`, `\`, whitespace and control
 *                        characters (URL.search / .hash miss `https://x.com?`), then a parse:
 *                        https, or http on localhost / 127.0.0.1 / [::1] only; no user:pass.
 *   buildPreviewUrl      D5: built from the PARSED url (origin + pathname, trailing "/" cut),
 *                        same shape as /api/preview/mint, both values percent-encoded.
 *   previewResponse      EXACTLY {ok, id, tenant, url, expiresAt}; `Cache-Control: no-store`.
 *
 * The response never carries the signing secret, the token on its own, or article content.
 */

import { json } from "@/lib/http";
import { ACTOR_EMAIL_MAX, ACTOR_ID_MAX, ACTOR_ROLES, type HubFieldCode, type HubFieldErrors } from "@/lib/hub-author-limits";
import { HUB_ACTOR_KEYS, checkStr, invalidBody, isActorEmailShape, unknownFieldsReason, type HubActor } from "@/lib/hub-author-input";

/** Token lifetime in seconds (D3) — equal to the admin mint route's. */
export const PREVIEW_TTL_SECONDS = 600;
/** Body cap of the three P5.6 routes (D11). */
export const SMALL_BODY_MAX_BYTES = 4096;
/** Exact root keys of the preview body. */
export const HUB_PREVIEW_KEYS: readonly string[] = ["tenant", "actor"];
/** The only hosts on which a plain-http frontend URL is accepted (D6; probes only). */
export const LOCAL_HTTP_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

type Obj = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type SmallBodyResult = { ok: true; raw: unknown } | { ok: false; response: Response };

export const smallTooLarge = (max: number = SMALL_BODY_MAX_BYTES) =>
  json({ ok: false, status: "too_large", reason: `request body exceeds ${max} bytes` }, 413);
const badJson = () => json({ ok: false, status: "bad_request", reason: "body must be valid JSON" }, 400);

/**
 * Read at most `max` bytes of the request body, then JSON-parse it (D11).
 * `Content-Length` > max ⇒ 413 without reading; the stream is cancelled as soon as
 * more than `max` bytes arrived. Bytes are joined BEFORE decoding, so a multi-byte
 * UTF-8 character split across chunks decodes correctly.
 */
export async function readSmallBody(request: Request, max: number = SMALL_BODY_MAX_BYTES): Promise<SmallBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared.trim()) > max) {
    return { ok: false, response: smallTooLarge(max) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return { ok: false, response: smallTooLarge(max) };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return { ok: true, raw: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: badJson() };
  }
}

export interface HubPreviewInput {
  tenant: string;
  actor: HubActor;
}

export type HubPreviewParseResult =
  | { ok: true; value: HubPreviewInput }
  | { ok: false; status: 400 | 422; body: Record<string, unknown> };

const badRequest = (reason: string): HubPreviewParseResult => ({ ok: false, status: 400, body: { ok: false, status: "bad_request", reason } });

/** Exactly {tenant, actor} (already JSON-parsed). 400 = shape / unknown key; 422 = `fields.actor.*`. */
export function parsePreviewBody(raw: unknown): HubPreviewParseResult {
  if (!isPlainObject(raw)) return badRequest("body must be a JSON object");
  if (typeof raw.tenant !== "string" || raw.tenant.trim() === "") return badRequest("tenant is required");

  const unknown: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!HUB_PREVIEW_KEYS.includes(k)) {
      unknown.push(k);
      continue;
    }
    if (k === "actor" && isPlainObject(raw.actor)) {
      for (const ak of Object.keys(raw.actor)) if (!HUB_ACTOR_KEYS.includes(ak)) unknown.push(`actor.${ak}`);
    }
  }
  if (unknown.length) return badRequest(unknownFieldsReason(unknown));

  const errors: HubFieldErrors = {};
  const fail = (name: string, code: HubFieldCode) => {
    if (!(name in errors)) errors[name] = code;
  };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  let actor: HubActor = { email: "", role: "editor" };

  // actor (required; only RECORDED, never used for permission) — copy of parsePublishBody's block
  if (!has("actor")) fail("actor", "required");
  else if (!isPlainObject(raw.actor)) fail("actor", "type");
  else {
    const a = raw.actor;
    let email = "";
    if (!Object.prototype.hasOwnProperty.call(a, "email")) fail("actor.email", "required");
    else if (typeof a.email !== "string") fail("actor.email", "type");
    else {
      const r = checkStr(a.email, { nonEmpty: true });
      if (!r.ok) fail("actor.email", r.code);
      else if (a.email.length > ACTOR_EMAIL_MAX) fail("actor.email", "too_long");
      else if (!isActorEmailShape(a.email)) fail("actor.email", "format");
      else email = a.email;
    }
    let role: HubActor["role"] = "editor";
    if (!Object.prototype.hasOwnProperty.call(a, "role")) fail("actor.role", "required");
    else if (typeof a.role !== "string") fail("actor.role", "type");
    else {
      const r = checkStr(a.role, {});
      if (!r.ok) fail("actor.role", r.code);
      else if (!(ACTOR_ROLES as readonly string[]).includes(a.role)) fail("actor.role", "format");
      else role = a.role as HubActor["role"];
    }
    let id: string | number | undefined;
    if (Object.prototype.hasOwnProperty.call(a, "id")) {
      if (typeof a.id === "number" && Number.isFinite(a.id)) {
        if (String(a.id).length > ACTOR_ID_MAX) fail("actor.id", "too_long");
        else id = a.id;
      } else if (typeof a.id === "string") {
        const r = checkStr(a.id, { max: ACTOR_ID_MAX });
        if (r.ok) id = a.id;
        else fail("actor.id", r.code);
      } else fail("actor.id", "type");
    }
    actor = id === undefined ? { email, role } : { email, role, id };
  }

  if (Object.keys(errors).length) return { ok: false, status: 422, body: invalidBody(errors) };
  return { ok: true, value: { tenant: raw.tenant.trim(), actor } };
}

export interface PreviewClaims {
  [key: string]: unknown;
  tenant: string;
  slug: string;
  draft: true;
  exp: number;
}

/** EXACTLY the four keys the verifier reads (D4); `exp = now + 600`. */
export function previewClaims(tenantSlug: string, slug: string, nowSeconds: number): PreviewClaims {
  return { tenant: tenantSlug, slug, draft: true, exp: nowSeconds + PREVIEW_TTL_SECONDS };
}

export type FrontendUrlCheck = { ok: true; url: URL } | { ok: false; reason: "no_frontend_url" | "bad_frontend_url" };

const URL_STRING_REFUSED = /[?#\\\s\u0000-\u001f\u007f-\u009f]/;

/** D6. Empty / absent ⇒ `no_frontend_url`; anything else that is not a clean https (or local http) base ⇒ `bad_frontend_url`. */
export function checkFrontendUrl(raw: unknown): FrontendUrlCheck {
  if (raw === null || raw === undefined) return { ok: false, reason: "no_frontend_url" };
  if (typeof raw !== "string") return { ok: false, reason: "bad_frontend_url" };
  if (raw.trim() === "") return { ok: false, reason: "no_frontend_url" };
  if (URL_STRING_REFUSED.test(raw)) return { ok: false, reason: "bad_frontend_url" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_frontend_url" };
  }
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "bad_frontend_url" };
  if (u.search !== "" || u.hash !== "") return { ok: false, reason: "bad_frontend_url" };
  if (u.protocol === "https:") return { ok: true, url: u };
  if (u.protocol === "http:" && LOCAL_HTTP_HOSTS.includes(u.hostname)) return { ok: true, url: u };
  return { ok: false, reason: "bad_frontend_url" };
}

/** D5: `<origin><path without trailing "/">/preview?token=…&slug=…`, from the PARSED url. */
export function buildPreviewUrl(base: URL, token: string, slug: string): string {
  const root = (base.origin + base.pathname).replace(/\/+$/, "");
  return `${root}/preview?token=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}`;
}

/** A usable slug: a non-blank string (D7). */
export function hasPreviewSlug(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export const previewUnavailable = (reason: "no_frontend_url" | "bad_frontend_url" | "no_slug") =>
  json({ ok: false, status: "preview_unavailable", reason }, 409);

/** The 200 body: EXACTLY {ok, id, tenant, url, expiresAt}. */
export function previewResponse(args: { id: number | string; tenant: string; url: string; exp: number }): Response {
  return json(
    { ok: true, id: args.id, tenant: args.tenant, url: args.url, expiresAt: new Date(args.exp * 1000).toISOString() },
    200,
    { "Cache-Control": "no-store" },
  );
}
