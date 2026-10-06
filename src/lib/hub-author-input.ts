/**
 * Hub author — strict, PURE request parsing for the two draft write routes
 * (APCGHub P5.1; Public Contracts "Kiểm đầu vào chặt").
 *
 *   POST  /api/hub/articles        → `parseCreateBody`
 *   PATCH /api/hub/articles/{id}   → `parseUpdateBody`
 *
 * No I/O. Checked BY SCHEMA, never by a generic recursive walk: only the known
 * containers (root, `flags`, `actor`, `secondary[i]`) are looked into, so a
 * 100,000-level nested value under a known key is a 422 `type` at the first level
 * and never a `RangeError`.
 *
 * 400 vs 422 (frozen): 400 = not JSON / not an object / `tenant` missing or not a
 * string / an UNKNOWN key in a known container (incl. `__proto__`, `constructor`,
 * `prototype`). 422 = every other field-level violation, wrong JSON types
 * included; `fields.<name>` = ONE code of the closed list (hub-author-limits.ts).
 * Several fields of the same tier are reported together.
 *
 * The body runs its pure checks here too (`validateBodyPure`: size, C0 / lone
 * surrogate, trim, empty, W run, 1b, `![`, link) — once, before the tenant check.
 */

import { PG_INT4_MAX } from "@/lib/hub-article-id";
import { slugify } from "@/lib/http";
import {
  ACTOR_EMAIL_MAX,
  ACTOR_ID_MAX,
  ACTOR_ROLES,
  HUB_AUTHOR_LIMITS,
  HUB_SLUG_SHAPE,
  READ_MIN_MAX,
  READ_MIN_MIN,
  UNKNOWN_KEYS_MAX,
  UNKNOWN_KEY_CHARS,
  type HubFieldCode,
  type HubFieldErrors,
} from "@/lib/hub-author-limits";
import { hasBidi, hasForbiddenC0, hasLoneSurrogate, isWs, validateBodyPure } from "@/lib/hub-author-body";

export const HUB_FLAG_KEYS = ["aiAssisted", "breaking", "sponsored", "affiliate", "deepDive", "longHaul"] as const;
export type HubFlagKey = (typeof HUB_FLAG_KEYS)[number];

/** Field keys a create may carry (besides `tenant` and `actor`). */
export const HUB_DRAFT_FIELD_KEYS = [
  "title",
  "slug",
  "dek",
  "bodyMarkdown",
  "takeaways",
  "readMin",
  "pillarSlug",
  "subSectionSlug",
  "secondary",
  "tagSlugs",
  "countrySlugs",
  "citySlugs",
  "authorId",
  "coAuthorIds",
  "flags",
  "sponsor",
] as const;
export type HubDraftFieldKey = (typeof HUB_DRAFT_FIELD_KEYS)[number];

export const HUB_CREATE_KEYS: readonly string[] = ["tenant", ...HUB_DRAFT_FIELD_KEYS, "actor"];
export const HUB_UPDATE_KEYS: readonly string[] = [...HUB_CREATE_KEYS, "expectedVersion"];
export const HUB_ACTOR_KEYS: readonly string[] = ["email", "role", "id"];
export const HUB_SECONDARY_KEYS: readonly string[] = ["pillarSlug", "subSectionSlug"];

export interface HubActor {
  email: string;
  role: (typeof ACTOR_ROLES)[number];
  id?: string | number;
}

export interface HubSecondary {
  pillarSlug: string;
  subSectionSlug: string | null;
}

export interface HubDraftFields {
  title?: string;
  slug?: string;
  dek?: string | null;
  /** W-trimmed body ("" = empty body). */
  bodyMarkdown?: string;
  takeaways?: string[];
  readMin?: number;
  pillarSlug?: string;
  subSectionSlug?: string | null;
  secondary?: HubSecondary[];
  tagSlugs?: string[];
  countrySlugs?: string[];
  citySlugs?: string[];
  authorId?: number;
  coAuthorIds?: number[];
  flags?: Partial<Record<HubFlagKey, boolean>>;
  sponsor?: string | null;
}

export interface HubDraftInput extends HubDraftFields {
  tenant: string;
  actor: HubActor;
  expectedVersion?: number;
  /** Draft field keys present in the request, in request order (used for PATCH `changed` / merge). */
  present: HubDraftFieldKey[];
}

export type HubParseResult =
  | { ok: true; value: HubDraftInput }
  | { ok: false; status: 400 | 422; body: Record<string, unknown> };

type Obj = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const badRequest = (reason: string): HubParseResult => ({ ok: false, status: 400, body: { ok: false, status: "bad_request", reason } });

/** The frozen 422 body. */
export function invalidBody(fields: HubFieldErrors): Record<string, unknown> {
  return { ok: false, status: "invalid", reason: "one or more fields are invalid", fields };
}

/** `unknown field(s): k1, k2` — first 20 keys, each cut to 64 chars, `, …` (U+2026) when more. */
export function unknownFieldsReason(keys: string[]): string {
  const shown = keys.slice(0, UNKNOWN_KEYS_MAX).map((k) => k.slice(0, UNKNOWN_KEY_CHARS));
  return `unknown field(s): ${shown.join(", ")}${keys.length > UNKNOWN_KEYS_MAX ? ", …" : ""}`;
}

/** Unknown keys of the known containers, in JSON insertion order, with their prefix. */
function collectUnknownKeys(raw: Obj, allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) {
      out.push(k);
      continue;
    }
    const v = raw[k];
    if (k === "flags" && isPlainObject(v)) {
      for (const fk of Object.keys(v)) if (!(HUB_FLAG_KEYS as readonly string[]).includes(fk)) out.push(`flags.${fk}`);
    } else if (k === "actor" && isPlainObject(v)) {
      for (const ak of Object.keys(v)) if (!HUB_ACTOR_KEYS.includes(ak)) out.push(`actor.${ak}`);
    } else if (k === "secondary" && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const row = v[i];
        if (!isPlainObject(row)) continue;
        for (const sk of Object.keys(row)) if (!HUB_SECONDARY_KEYS.includes(sk)) out.push(`secondary[${i}].${sk}`);
      }
    }
  }
  return out;
}

const isSafeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

interface StrOpts {
  max?: number;
  bidi?: boolean;
  /** Empty (after trim for trimmed fields) ⇒ `required`. */
  nonEmpty?: boolean;
  trim?: boolean;
}

/** One string field: c0 → surrogate → bidi → empty → too_long. Returns the (trimmed) value or a code. */
function checkStr(v: string, o: StrOpts): { ok: true; value: string } | { ok: false; code: HubFieldCode } {
  if (hasForbiddenC0(v)) return { ok: false, code: "c0" };
  if (hasLoneSurrogate(v)) return { ok: false, code: "surrogate" };
  if (o.bidi && hasBidi(v)) return { ok: false, code: "bidi" };
  const value = o.trim ? v.trim() : v;
  if (o.nonEmpty && value === "") return { ok: false, code: "required" };
  if (o.max != null && v.length > o.max) return { ok: false, code: "too_long" };
  return { ok: true, value };
}

/** Linear e-mail shape: exactly one `@`, a `.` after it, no W / C0. */
export function isActorEmailShape(s: string): boolean {
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWs(c)) return false;
    if (c === 64) {
      if (at !== -1) return false;
      at = i;
    }
  }
  return at !== -1 && s.indexOf(".", at + 1) !== -1;
}

/** Array of slug-like references: strings, de-duplicated (order kept), at most `max` after de-duplication. */
function checkSlugArray(v: unknown, max: number): { ok: true; value: string[] } | { ok: false; code: HubFieldCode } {
  if (!Array.isArray(v)) return { ok: false, code: "type" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of v) {
    if (typeof el !== "string") return { ok: false, code: "type" };
    const r = checkStr(el, { nonEmpty: true });
    if (!r.ok) return r;
    if (seen.has(el)) continue;
    seen.add(el);
    out.push(el);
  }
  if (out.length > max) return { ok: false, code: "too_many" };
  return { ok: true, value: out };
}

/** An int4 id: safe integer (else `type`) in [1, PG_INT4_MAX] (else `out_of_range`). */
function checkInt4(v: unknown): { ok: true; value: number } | { ok: false; code: HubFieldCode } {
  if (!isSafeInt(v)) return { ok: false, code: "type" };
  if (v < 1 || v > PG_INT4_MAX) return { ok: false, code: "out_of_range" };
  return { ok: true, value: v };
}

function parseCommon(raw: unknown, mode: "create" | "update"): HubParseResult {
  if (!isPlainObject(raw)) return badRequest("body must be a JSON object");
  if (typeof raw.tenant !== "string" || raw.tenant.trim() === "") return badRequest("tenant is required");

  const unknown = collectUnknownKeys(raw, mode === "create" ? HUB_CREATE_KEYS : HUB_UPDATE_KEYS);
  if (unknown.length) return badRequest(unknownFieldsReason(unknown));

  const errors: HubFieldErrors = {};
  const fail = (name: string, code: HubFieldCode) => {
    if (!(name in errors)) errors[name] = code;
  };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const value: HubDraftInput = {
    tenant: raw.tenant.trim(),
    actor: { email: "", role: "editor" },
    present: [],
  };
  for (const k of Object.keys(raw)) {
    if ((HUB_DRAFT_FIELD_KEYS as readonly string[]).includes(k)) value.present.push(k as HubDraftFieldKey);
  }
  const create = mode === "create";

  // title
  if (has("title")) {
    if (typeof raw.title !== "string") fail("title", "type");
    else {
      const r = checkStr(raw.title, { max: HUB_AUTHOR_LIMITS.title, bidi: true, nonEmpty: true, trim: true });
      if (r.ok) value.title = r.value;
      else fail("title", r.code);
    }
  } else if (create) fail("title", "required");

  // slug (explicit); absent on create ⇒ slugify(title)
  if (has("slug")) {
    if (typeof raw.slug !== "string") fail("slug", "type");
    else {
      const r = checkStr(raw.slug, { nonEmpty: true });
      if (!r.ok) fail("slug", r.code);
      else if (raw.slug.length > HUB_AUTHOR_LIMITS.slug) fail("slug", "too_long");
      else if (!HUB_SLUG_SHAPE.test(raw.slug)) fail("slug", "format");
      else value.slug = raw.slug;
    }
  } else if (create && value.title !== undefined) {
    const derived = slugify(value.title, HUB_AUTHOR_LIMITS.slug);
    if (derived === "") fail("slug", "required");
    else value.slug = derived;
  }

  // dek (null = clear on PATCH; absent on POST)
  if (has("dek")) {
    if (raw.dek === null) value.dek = null;
    else if (typeof raw.dek !== "string") fail("dek", "type");
    else {
      const r = checkStr(raw.dek, { max: HUB_AUTHOR_LIMITS.dek, bidi: true, trim: true });
      if (r.ok) value.dek = r.value === "" ? null : r.value;
      else fail("dek", r.code);
    }
  }

  // bodyMarkdown — the pure body checks, once, in the frozen order
  if (has("bodyMarkdown")) {
    if (typeof raw.bodyMarkdown !== "string") fail("bodyMarkdown", "type");
    else {
      const r = validateBodyPure(raw.bodyMarkdown);
      if (r.ok) value.bodyMarkdown = r.body;
      else fail("bodyMarkdown", r.code);
    }
  }

  // takeaways: array of single-line strings, ≤ 5, each ≤ 300
  if (has("takeaways")) {
    const v = raw.takeaways;
    if (!Array.isArray(v)) fail("takeaways", "type");
    else if (v.length > HUB_AUTHOR_LIMITS.takeawaysLines) fail("takeaways", "too_many");
    else {
      const out: string[] = [];
      for (const el of v) {
        if (typeof el !== "string") {
          fail("takeaways", "type");
          break;
        }
        if (el.includes("\n") || el.includes("\r")) {
          fail("takeaways", "newline");
          break;
        }
        const r = checkStr(el, { max: HUB_AUTHOR_LIMITS.takeawayChars, trim: true });
        if (!r.ok) {
          fail("takeaways", r.code);
          break;
        }
        if (r.value !== "") out.push(r.value);
      }
      if (!("takeaways" in errors)) value.takeaways = out;
    }
  }

  // readMin: integer 1..120
  if (has("readMin")) {
    if (!isSafeInt(raw.readMin)) fail("readMin", "type");
    else if (raw.readMin < READ_MIN_MIN || raw.readMin > READ_MIN_MAX) fail("readMin", "out_of_range");
    else value.readMin = raw.readMin;
  }

  // pillarSlug (optional on create since P5.1b: a draft needs only a title; required again at publish, P5.2)
  if (has("pillarSlug")) {
    if (typeof raw.pillarSlug !== "string") fail("pillarSlug", "type");
    else {
      const r = checkStr(raw.pillarSlug, { nonEmpty: true });
      if (r.ok) value.pillarSlug = r.value;
      else fail("pillarSlug", r.code);
    }
  }

  // subSectionSlug (null = none)
  if (has("subSectionSlug")) {
    if (raw.subSectionSlug === null) value.subSectionSlug = null;
    else if (typeof raw.subSectionSlug !== "string") fail("subSectionSlug", "type");
    else {
      const r = checkStr(raw.subSectionSlug, { nonEmpty: true });
      if (r.ok) value.subSectionSlug = r.value;
      else fail("subSectionSlug", r.code);
    }
  }

  // secondary: [{pillarSlug, subSectionSlug?}], ≤ 5, no repeat, never the primary pillar
  if (has("secondary")) {
    const v = raw.secondary;
    if (!Array.isArray(v)) fail("secondary", "type");
    else if (v.length > HUB_AUTHOR_LIMITS.secondary) fail("secondary", "too_many");
    else {
      const rows: HubSecondary[] = [];
      let bad = false;
      for (let i = 0; i < v.length; i++) {
        const row = v[i];
        if (!isPlainObject(row)) {
          fail("secondary", "type");
          bad = true;
          break;
        }
        let pillar: string | null = null;
        if (!Object.prototype.hasOwnProperty.call(row, "pillarSlug")) {
          fail(`secondary[${i}].pillarSlug`, "required");
          bad = true;
        } else if (typeof row.pillarSlug !== "string") {
          fail(`secondary[${i}].pillarSlug`, "type");
          bad = true;
        } else {
          const r = checkStr(row.pillarSlug, { nonEmpty: true });
          if (r.ok) pillar = r.value;
          else {
            fail(`secondary[${i}].pillarSlug`, r.code);
            bad = true;
          }
        }
        let sub: string | null = null;
        if (Object.prototype.hasOwnProperty.call(row, "subSectionSlug") && row.subSectionSlug !== null) {
          if (typeof row.subSectionSlug !== "string") {
            fail(`secondary[${i}].subSectionSlug`, "type");
            bad = true;
          } else {
            const r = checkStr(row.subSectionSlug, { nonEmpty: true });
            if (r.ok) sub = r.value;
            else {
              fail(`secondary[${i}].subSectionSlug`, r.code);
              bad = true;
            }
          }
        }
        if (pillar !== null) rows.push({ pillarSlug: pillar, subSectionSlug: sub });
      }
      if (!bad) {
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.pillarSlug) || (value.pillarSlug !== undefined && r.pillarSlug === value.pillarSlug)) {
            fail("secondary", "duplicate");
            bad = true;
            break;
          }
          seen.add(r.pillarSlug);
        }
      }
      if (!bad) value.secondary = rows;
    }
  }

  // tag / country / city slugs: de-duplicated silently
  for (const [key, max] of [
    ["tagSlugs", HUB_AUTHOR_LIMITS.tags],
    ["countrySlugs", HUB_AUTHOR_LIMITS.countries],
    ["citySlugs", HUB_AUTHOR_LIMITS.cities],
  ] as const) {
    if (!has(key)) continue;
    const r = checkSlugArray(raw[key], max);
    if (r.ok) value[key] = r.value;
    else fail(key, r.code);
  }

  // authorId (optional on create since P5.1b; required again at publish, P5.2)
  if (has("authorId")) {
    const r = checkInt4(raw.authorId);
    if (r.ok) value.authorId = r.value;
    else fail("authorId", r.code);
  }

  // coAuthorIds: int4 ids, de-duplicated, ≤ 10
  if (has("coAuthorIds")) {
    const v = raw.coAuthorIds;
    if (!Array.isArray(v)) fail("coAuthorIds", "type");
    else {
      const out: number[] = [];
      for (const el of v) {
        const r = checkInt4(el);
        if (!r.ok) {
          fail("coAuthorIds", r.code);
          break;
        }
        if (!out.includes(r.value)) out.push(r.value);
      }
      if (!("coAuthorIds" in errors)) {
        if (out.length > HUB_AUTHOR_LIMITS.coAuthors) fail("coAuthorIds", "too_many");
        else value.coAuthorIds = out;
      }
    }
  }

  // flags: object of real booleans
  if (has("flags")) {
    const v = raw.flags;
    if (!isPlainObject(v)) fail("flags", "type");
    else {
      const out: Partial<Record<HubFlagKey, boolean>> = {};
      for (const k of HUB_FLAG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (typeof v[k] !== "boolean") fail(`flags.${k}`, "type");
        else out[k] = v[k] as boolean;
      }
      value.flags = out;
    }
  }

  // sponsor (null = clear)
  if (has("sponsor")) {
    if (raw.sponsor === null) value.sponsor = null;
    else if (typeof raw.sponsor !== "string") fail("sponsor", "type");
    else {
      const r = checkStr(raw.sponsor, { max: HUB_AUTHOR_LIMITS.sponsor, bidi: true, trim: true });
      if (r.ok) value.sponsor = r.value === "" ? null : r.value;
      else fail("sponsor", r.code);
    }
  }
  // POST: sponsored ⇒ sponsor required (PATCH checks the merged article instead).
  if (create && value.flags?.sponsored === true && !("sponsor" in errors) && !value.sponsor) fail("sponsor", "required");

  // actor (required; the CMS only RECORDS it, never uses it for permission)
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
    value.actor = id === undefined ? { email, role } : { email, role, id };
  }

  // expectedVersion (PATCH only; required)
  if (!create) {
    if (!has("expectedVersion")) fail("expectedVersion", "required");
    else {
      const r = checkInt4(raw.expectedVersion);
      if (r.ok) value.expectedVersion = r.value;
      else fail("expectedVersion", r.code);
    }
  }

  if (Object.keys(errors).length) return { ok: false, status: 422, body: invalidBody(errors) };
  return { ok: true, value };
}

/** POST body (already JSON-parsed). */
export function parseCreateBody(raw: unknown): HubParseResult {
  return parseCommon(raw, "create");
}

/** PATCH body (already JSON-parsed). Every draft field optional; absent ⇒ unchanged. */
export function parseUpdateBody(raw: unknown): HubParseResult {
  return parseCommon(raw, "update");
}
