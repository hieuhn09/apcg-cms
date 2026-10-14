/**
 * Hub TAXONOMY create — pure helpers (APCGHub P5.6, chặng 2; content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-6-preview-taxonomy-cms-exit_PLAN_30-09-26.md,
 * D11–D16, Public Contracts C-AU / C-TG).
 *
 * No I/O, no Payload, no `@payload-config`. Imported ONE WAY by
 * `hub-taxonomy-create-core.ts`.
 *
 *   normaliseTaxonomyText  the D12 order: (1) NFC; (2) REFUSE (never fold) control,
 *                          line-break, bidi, lone-surrogate, format / private-use /
 *                          unassigned / default-ignorable code points and U+16FE4;
 *                          (3) every run of space separators becomes ONE space, ends
 *                          trimmed; (4) length in code points + closed character class;
 *                          (5) combining marks never first / after a space, ≤ 3 in a row;
 *                          (6) a pen name needs ≥ 2 letters, a tag title ≥ 1 letter or
 *                          digit (D14: "5G", "F1", "2024" are real news tags).
 *                          Every refusal code comes from the CLOSED list HUB_FIELD_CODES.
 *   AUTHOR_ROLES           the closed list of 9 roles (design DS:1583); default
 *                          "Staff writer" (O14).
 *   tagPreFold / tagSlugFrom  D14: letters NFKD cannot split (Đ, Ł, Ø, ß, Þ, Ħ, ı …) are
 *                          folded first, then `slugify` of `@/lib/http` (the intake's).
 *   parseAuthorBody / parseTagBody  EXACTLY {tenant, name, role?, actor} /
 *                          {tenant, title, actor}; the `actor` block is checked by the
 *                          preview body's parser (same rules as publish).
 *   TAXONOMY_SOFT_CAP_*    D16 soft caps (below the taxonomy read caps 1,000 / 3,000).
 */

import { slugify } from "@/lib/http";
import { HUB_SLUG_SHAPE, type HubFieldCode, type HubFieldErrors } from "@/lib/hub-author-limits";
import { invalidBody, unknownFieldsReason, type HubActor } from "@/lib/hub-author-input";
import { parsePreviewBody } from "@/lib/hub-author-preview-pure";

/** D16: refuse to CREATE (lookup still wins) once a tenant holds this many rows. */
export const TAXONOMY_SOFT_CAP_AUTHORS = 950;
export const TAXONOMY_SOFT_CAP_TAGS = 2900;

export const AUTHOR_NAME_MAX = 120;
export const TAG_TITLE_MAX = 60;
export const TAXONOMY_TEXT_MIN = 2;

/** The closed role list (DS:1583); anything else ⇒ `invalid`. */
export const AUTHOR_ROLES = [
  "Desk",
  "Staff writer",
  "Senior writer",
  "Correspondent",
  "Contributing writer",
  "Columnist",
  "Analyst",
  "Guest contributor",
  "Freelance / stringer",
] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];
export const DEFAULT_AUTHOR_ROLE: AuthorRole = "Staff writer";

export const HUB_AUTHOR_CREATE_KEYS: readonly string[] = ["tenant", "name", "role", "actor"];
export const HUB_TAG_CREATE_KEYS: readonly string[] = ["tenant", "title", "actor"];

export type TaxonomyKind = "author" | "tag";
export type NormaliseResult = { ok: true; value: string } | { ok: false; code: HubFieldCode };

const LINE_BREAKS = /[\t\n\r\u2028\u2029]/u;
// Cc other than the line breaks above (C0, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BIDI = /[‪-‮⁦-⁩]/u;
// Invisible / non-text code points: format, private use, unassigned, default-ignorable,
// plus U+16FE4 (KHITAN SMALL SCRIPT FILLER, Mn but renders as nothing).
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u{16FE4}]/u;
const SPACE_RUNS = /\p{Zs}+/gu;
const ALLOWED_CLASS = /^[\p{L}\p{M}\p{N} .'’,()&-]+$/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** (5): a combining mark is never first or right after a space, and at most 3 follow each other. */
function marksWellPlaced(cps: string[]): boolean {
  let run = 0;
  for (let i = 0; i < cps.length; i++) {
    if (MARK.test(cps[i]!)) {
      if (i === 0 || cps[i - 1] === " ") return false;
      run++;
      if (run > 3) return false;
    } else run = 0;
  }
  return true;
}

/** The D12 / D14 normalisation of a pen name or a tag title. */
export function normaliseTaxonomyText(raw: string, kind: TaxonomyKind): NormaliseResult {
  if (hasLoneSurrogate(raw)) return { ok: false, code: "surrogate" };
  const nfc = raw.normalize("NFC");
  if (LINE_BREAKS.test(nfc)) return { ok: false, code: "newline" };
  if (CONTROL.test(nfc)) return { ok: false, code: "c0" };
  if (BIDI.test(nfc)) return { ok: false, code: "bidi" };
  if (INVISIBLE.test(nfc)) return { ok: false, code: "invalid" };
  const value = nfc.replace(SPACE_RUNS, " ").trim();
  if (value === "") return { ok: false, code: "required" };
  const cps = Array.from(value);
  const max = kind === "author" ? AUTHOR_NAME_MAX : TAG_TITLE_MAX;
  if (cps.length > max) return { ok: false, code: "too_long" };
  if (cps.length < TAXONOMY_TEXT_MIN) return { ok: false, code: "format" };
  if (!ALLOWED_CLASS.test(value)) return { ok: false, code: "invalid" };
  if (!marksWellPlaced(cps)) return { ok: false, code: "format" };
  if (kind === "author") {
    if (cps.filter((c) => LETTER.test(c)).length < 2) return { ok: false, code: "format" };
  } else {
    if (!cps.some((c) => LETTER_OR_DIGIT.test(c))) return { ok: false, code: "invalid" };
    if (tagSlugFrom(value) === "") return { ok: false, code: "invalid" };
  }
  return { ok: true, value };
}

/** Letters NFKD does not decompose (D14), folded BEFORE `slugify`. */
const PRE_FOLD: Readonly<Record<string, string>> = {
  Đ: "D", đ: "d", Ł: "L", ł: "l", Ø: "O", ø: "o", ß: "ss", Æ: "AE", æ: "ae", Œ: "OE", œ: "oe",
  Ð: "D", ð: "d", Þ: "Th", þ: "th", Ħ: "H", ħ: "h", ı: "i",
};
const PRE_FOLD_RE = new RegExp(`[${Object.keys(PRE_FOLD).join("")}]`, "gu");

export function tagPreFold(s: string): string {
  return s.replace(PRE_FOLD_RE, (c) => PRE_FOLD[c] ?? c);
}

/** `slugify(tagPreFold(title))`; "" when nothing usable is left (e.g. CJK only). */
export function tagSlugFrom(title: string): string {
  const slug = slugify(tagPreFold(title));
  return HUB_SLUG_SHAPE.test(slug) ? slug : "";
}

/** The exact data written for a new author (D12: no slug / rank / user / avatar / bio / city). */
export function authorCreateData(name: string, role: AuthorRole): { name: string; role: AuthorRole } {
  return { name, role };
}

type Obj = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type TaxonomyParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 422; body: Record<string, unknown> };

export interface HubAuthorCreateInput {
  tenant: string;
  name: string;
  role: AuthorRole;
  actor: HubActor;
}
export interface HubTagCreateInput {
  tenant: string;
  title: string;
  slug: string;
  actor: HubActor;
}

const badRequest = (reason: string) => ({ ok: false as const, status: 400 as const, body: { ok: false, status: "bad_request", reason } });

/** Shape + unknown keys (400), then the actor block through the preview body's parser. */
function parseCommon(
  raw: unknown,
  keys: readonly string[],
): { ok: true; obj: Obj; actor: HubActor | null; errors: HubFieldErrors } | { ok: false; status: 400; body: Record<string, unknown> } {
  if (!isPlainObject(raw)) return badRequest("body must be a JSON object");
  if (typeof raw.tenant !== "string" || raw.tenant.trim() === "") return badRequest("tenant is required");
  const unknown: string[] = [];
  for (const k of Object.keys(raw)) if (!keys.includes(k)) unknown.push(k);
  if (isPlainObject(raw.actor)) {
    for (const ak of Object.keys(raw.actor)) if (!["email", "role", "id"].includes(ak)) unknown.push(`actor.${ak}`);
  }
  if (unknown.length) return badRequest(unknownFieldsReason(unknown));
  const errors: HubFieldErrors = {};
  const actorCheck = parsePreviewBody({ tenant: raw.tenant, ...(Object.prototype.hasOwnProperty.call(raw, "actor") ? { actor: raw.actor } : {}) });
  if (!actorCheck.ok) {
    const fields = (actorCheck.body.fields ?? {}) as HubFieldErrors;
    for (const [k, v] of Object.entries(fields)) errors[k] = v;
    return { ok: true, obj: raw, actor: null, errors };
  }
  return { ok: true, obj: raw, actor: actorCheck.value.actor, errors };
}

function textField(obj: Obj, key: string, kind: TaxonomyKind, errors: HubFieldErrors): string | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    errors[key] = "required";
    return null;
  }
  const v = obj[key];
  if (typeof v !== "string") {
    errors[key] = "type";
    return null;
  }
  const r = normaliseTaxonomyText(v, kind);
  if (!r.ok) {
    errors[key] = r.code;
    return null;
  }
  return r.value;
}

/** EXACTLY {tenant, name, role?, actor}. 400 = shape / unknown key; 422 = `fields.*`. */
export function parseAuthorBody(raw: unknown): TaxonomyParseResult<HubAuthorCreateInput> {
  const c = parseCommon(raw, HUB_AUTHOR_CREATE_KEYS);
  if (!c.ok) return c;
  const { obj, errors } = c;
  const name = textField(obj, "name", "author", errors);
  let role: AuthorRole = DEFAULT_AUTHOR_ROLE;
  if (Object.prototype.hasOwnProperty.call(obj, "role")) {
    if (typeof obj.role !== "string") errors.role = "type";
    else if (!(AUTHOR_ROLES as readonly string[]).includes(obj.role)) errors.role = "invalid";
    else role = obj.role as AuthorRole;
  }
  if (Object.keys(errors).length || name === null || c.actor === null) return { ok: false, status: 422, body: invalidBody(errors) };
  return { ok: true, value: { tenant: (obj.tenant as string).trim(), name, role, actor: c.actor } };
}

/** EXACTLY {tenant, title, actor}. The slug is derived here (D14). */
export function parseTagBody(raw: unknown): TaxonomyParseResult<HubTagCreateInput> {
  const c = parseCommon(raw, HUB_TAG_CREATE_KEYS);
  if (!c.ok) return c;
  const { obj, errors } = c;
  const title = textField(obj, "title", "tag", errors);
  if (Object.keys(errors).length || title === null || c.actor === null) return { ok: false, status: 422, body: invalidBody(errors) };
  return { ok: true, value: { tenant: (obj.tenant as string).trim(), title, slug: tagSlugFrom(title), actor: c.actor } };
}

/** Response allowlists (no tenant / user / avatar / bio). */
export function authorView(d: Obj): { id: number | string; name: string; role: string | null } {
  return { id: d.id as number | string, name: String(d.name ?? ""), role: typeof d.role === "string" ? d.role : null };
}
export function tagView(d: Obj): { id: number | string; slug: string; title: string } {
  return { id: d.id as number | string, slug: String(d.slug ?? ""), title: typeof d.title === "string" ? d.title : "" };
}
