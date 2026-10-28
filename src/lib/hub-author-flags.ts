/**
 * Hub editorial flags — PURE helpers ("Ghim lên Mới nhất" + "Độc quyền" from the hub).
 * Content-engine plan process/features/apcg-hub/active/hub-pin-exclusive-flags_PLAN_28-10-26.md
 * (D3, D5, D6, D8, D9; Public Contracts CMS 1 + 6). No I/O, no Payload, no `@payload-config`:
 * imported by `hub-author-handlers.ts` (the two draft routes), `hub-article-flags-core.ts`
 * (`POST /api/hub/articles/{id}/flags`) and the read routes (the `editorialFlags` discovery).
 *
 *   editorialFlagsTenants / isEditorialFlagsTenant — the CMS switch HUB_EDITORIAL_FLAGS_TENANTS (D3)
 *   pinUntilWindowCode — the `pinnedUntil` window (D5)
 *   draftEditorialErrors — the draft routes' switch + window step (D10)
 *   parseFlagsBody — the closed `{tenant, actor, expected, set}` body of the flags route
 *   flagsGateReason — the flags route gate (D9)
 *   storedEditorialValues / sameEditorialValues / flagsChange — `expected` and the change set
 *   flagsPostWriteDiff / flagsPostWriteCheck — the post-write assertion (D8)
 */

import {
  ACTOR_EMAIL_MAX,
  ACTOR_ID_MAX,
  ACTOR_ROLES,
  type HubFieldCode,
  type HubFieldErrors,
} from "@/lib/hub-author-limits";
import {
  HUB_EDITORIAL_KEYS,
  checkEditorialValues,
  checkStr,
  invalidBody,
  isActorEmailShape,
  normalizeHubUtc,
  unknownFieldsReason,
  type HubActor,
  type HubEditorialInput,
  type HubEditorialKey,
} from "@/lib/hub-author-input";
import { liveValueEqual } from "@/lib/hub-author-live-pure";

type Doc = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Doc, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ── D3: the CMS switch ───────────────────────────────────────────────────────

/** The env variable (set ONLY by the owner, on this repo's Vercel project; not in `.env.example`). */
export const HUB_EDITORIAL_FLAGS_ENV = "HUB_EDITORIAL_FLAGS_TENANTS";

/**
 * `HUB_EDITORIAL_FLAGS_TENANTS` — CSV of CMS tenant slugs, default OFF. Read on every call
 * (no cache); split on ",", trim, drop empty items; matched EXACTLY (case-sensitive) by
 * `isEditorialFlagsTenant`. `*`, another case, inner whitespace never match a slug. Same
 * shape as `liveEditTenants` (hub-author-live-pure.ts).
 */
export function editorialFlagsTenants(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[HUB_EDITORIAL_FLAGS_ENV];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isEditorialFlagsTenant(slug: string, tenants: readonly string[]): boolean {
  return tenants.includes(slug);
}

// ── D5: the window ───────────────────────────────────────────────────────────

/** = `MIN_LEAD_SECONDS` / `MAX_SCHEDULE_DAYS` of hub-author-publish-core.ts (declared here to keep this file pure; pinned equal by test:hub-flags). */
export const PIN_UNTIL_MIN_LEAD_SECONDS = 60;
export const PIN_UNTIL_MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** `out_of_range` unless now + 60 s < t ≤ now + 365 days (an unparseable value is out of range). */
export function pinUntilWindowCode(iso: string, nowMs: number): "out_of_range" | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "out_of_range";
  const lead = t - nowMs;
  return lead > PIN_UNTIL_MIN_LEAD_SECONDS * 1000 && lead <= PIN_UNTIL_MAX_DAYS * DAY_MS ? null : "out_of_range";
}

const isEditorialKey = (k: string): k is HubEditorialKey => (HUB_EDITORIAL_KEYS as readonly string[]).includes(k);

/** The editorial keys of a `present` list, in request order. */
export function editorialKeysOf(present: readonly string[]): HubEditorialKey[] {
  return present.filter(isEditorialKey);
}

/**
 * D10 — the draft routes, AFTER tenant + `features.articles`: no editorial key ⇒ null (the
 * switch is not consulted); the tenant is not on the switch ⇒ `not_enabled` on EVERY key
 * present; otherwise a non-null `pinnedUntil` outside the window ⇒ `pinnedUntil: out_of_range`.
 */
export function draftEditorialErrors(a: {
  keys: readonly HubEditorialKey[];
  editorial: HubEditorialInput | undefined;
  tenantSlug: string;
  tenants: readonly string[];
  nowMs: number;
}): HubFieldErrors | null {
  if (a.keys.length === 0) return null;
  if (!isEditorialFlagsTenant(a.tenantSlug, a.tenants)) {
    const out: HubFieldErrors = {};
    for (const k of a.keys) out[k] = "not_enabled";
    return out;
  }
  const until = a.editorial?.pinnedUntil;
  if (typeof until === "string" && pinUntilWindowCode(until, a.nowMs)) return { pinnedUntil: "out_of_range" };
  return null;
}

// ── the flags route body (Public Contracts CMS 6) ────────────────────────────

/** The outer keys of `POST …/flags` — exactly these. */
export const HUB_FLAGS_BODY_KEYS = ["tenant", "actor", "expected", "set"] as const;
const ACTOR_KEYS: readonly string[] = ["email", "role", "id"];

/** The three values as the CMS stores them (`pinnedUntil` normalised `…:ss.fffZ`, or null). */
export interface HubEditorialValues {
  exclusive: boolean;
  pinnedToLatest: boolean;
  pinnedUntil: string | null;
}

export interface HubFlagsInput {
  tenant: string;
  actor: HubActor;
  /** What the page showed — compared with the MAIN row (409 flags_conflict). */
  expected: HubEditorialValues;
  /** The keys to change (non-empty, D5 pair rules, window checked). */
  set: HubEditorialInput;
  /** The keys of `set`, in request order. */
  setKeys: HubEditorialKey[];
}

export type HubFlagsParseResult =
  | { ok: true; value: HubFlagsInput }
  | { ok: false; status: 400 | 422; body: Record<string, unknown> };

const badRequest = (reason: string): HubFlagsParseResult => ({ ok: false, status: 400, body: { ok: false, status: "bad_request", reason } });

/** Unknown keys of the closed containers (root, `actor`, `expected`, `set`), prefixed, in insertion order. */
function unknownFlagsKeys(raw: Doc): string[] {
  const out: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!(HUB_FLAGS_BODY_KEYS as readonly string[]).includes(k)) {
      out.push(k);
      continue;
    }
    const v = raw[k];
    if (!isPlainObject(v)) continue;
    const allowed = k === "actor" ? ACTOR_KEYS : k === "expected" || k === "set" ? (HUB_EDITORIAL_KEYS as readonly string[]) : null;
    if (allowed) for (const ik of Object.keys(v)) if (!allowed.includes(ik)) out.push(`${k}.${ik}`);
  }
  return out;
}

/**
 * The `actor` block — the same rules as the draft / publish parsers (`actor` required; e-mail
 * shape ≤ 254; role ∈ ACTOR_ROLES = admin | editor | marketer, so `viewer` ⇒ `format`; optional
 * id ≤ 64 chars). The CMS only RECORDS it. Drift against `parseCreateBody` is pinned by test:hub-flags.
 */
export function checkActorBlock(raw: Doc, fail: (name: string, code: HubFieldCode) => void): HubActor {
  if (!own(raw, "actor")) {
    fail("actor", "required");
    return { email: "", role: "editor" };
  }
  if (!isPlainObject(raw.actor)) {
    fail("actor", "type");
    return { email: "", role: "editor" };
  }
  const a = raw.actor;
  let email = "";
  if (!own(a, "email")) fail("actor.email", "required");
  else if (typeof a.email !== "string") fail("actor.email", "type");
  else {
    const r = checkStr(a.email, { nonEmpty: true });
    if (!r.ok) fail("actor.email", r.code);
    else if (a.email.length > ACTOR_EMAIL_MAX) fail("actor.email", "too_long");
    else if (!isActorEmailShape(a.email)) fail("actor.email", "format");
    else email = a.email;
  }
  let role: HubActor["role"] = "editor";
  if (!own(a, "role")) fail("actor.role", "required");
  else if (typeof a.role !== "string") fail("actor.role", "type");
  else {
    const r = checkStr(a.role, {});
    if (!r.ok) fail("actor.role", r.code);
    else if (!(ACTOR_ROLES as readonly string[]).includes(a.role)) fail("actor.role", "format");
    else role = a.role as HubActor["role"];
  }
  let id: string | number | undefined;
  if (own(a, "id")) {
    if (typeof a.id === "number" && Number.isFinite(a.id)) {
      if (String(a.id).length > ACTOR_ID_MAX) fail("actor.id", "too_long");
      else id = a.id;
    } else if (typeof a.id === "string") {
      const r = checkStr(a.id, { max: ACTOR_ID_MAX });
      if (r.ok) id = a.id;
      else fail("actor.id", r.code);
    } else fail("actor.id", "type");
  }
  return id === undefined ? { email, role } : { email, role, id };
}

/**
 * `POST /api/hub/articles/{id}/flags` body (already JSON-parsed), EXACTLY `{tenant, actor,
 * expected, set}`. 400 = not an object / `tenant` missing or not a non-blank string / an
 * unknown key at the root or inside `actor` / `expected` / `set` (prefixed; `__proto__`
 * included). 422 = field level, closed codes: `actor.*`; `expected` (required / type) and
 * `expected.<k>` (all three required; booleans; `pinnedUntil` null or K7 ⇒ `format` — no pair
 * rule: `expected` mirrors the STORED values); `set` (required / type; `{}` ⇒ required) and its
 * keys with the draft rules (bare names `exclusive` / `pinnedToLatest` / `pinnedUntil`) + the
 * window (`pinnedUntil: out_of_range`, `nowMs` injected).
 */
export function parseFlagsBody(raw: unknown, nowMs: number): HubFlagsParseResult {
  if (!isPlainObject(raw)) return badRequest("body must be a JSON object");
  if (typeof raw.tenant !== "string" || raw.tenant.trim() === "") return badRequest("tenant is required");
  const unknown = unknownFlagsKeys(raw);
  if (unknown.length) return badRequest(unknownFieldsReason(unknown));

  const errors: HubFieldErrors = {};
  const fail = (name: string, code: HubFieldCode) => {
    if (!(name in errors)) errors[name] = code;
  };

  const actor = checkActorBlock(raw, fail);

  const expected: HubEditorialValues = { exclusive: false, pinnedToLatest: false, pinnedUntil: null };
  if (!own(raw, "expected")) fail("expected", "required");
  else if (!isPlainObject(raw.expected)) fail("expected", "type");
  else {
    const e = raw.expected;
    for (const k of ["exclusive", "pinnedToLatest"] as const) {
      if (!own(e, k)) fail(`expected.${k}`, "required");
      else if (typeof e[k] !== "boolean") fail(`expected.${k}`, "type");
      else expected[k] = e[k] as boolean;
    }
    if (!own(e, "pinnedUntil")) fail("expected.pinnedUntil", "required");
    else if (e.pinnedUntil === null) expected.pinnedUntil = null;
    else if (typeof e.pinnedUntil !== "string") fail("expected.pinnedUntil", "type");
    else {
      const n = normalizeHubUtc(e.pinnedUntil);
      if (n) expected.pinnedUntil = n;
      else fail("expected.pinnedUntil", "format");
    }
  }

  let set: HubEditorialInput = {};
  let setKeys: HubEditorialKey[] = [];
  if (!own(raw, "set")) fail("set", "required");
  else if (!isPlainObject(raw.set)) fail("set", "type");
  else if (Object.keys(raw.set).length === 0) fail("set", "required");
  else {
    setKeys = Object.keys(raw.set) as HubEditorialKey[];
    set = checkEditorialValues(raw.set, fail);
    if (typeof set.pinnedUntil === "string" && !("pinnedUntil" in errors) && pinUntilWindowCode(set.pinnedUntil, nowMs)) fail("pinnedUntil", "out_of_range");
  }

  if (Object.keys(errors).length) return { ok: false, status: 422, body: invalidBody(errors) };
  return { ok: true, value: { tenant: raw.tenant.trim(), actor, expected, set, setKeys } };
}

// ── D9: the gate ─────────────────────────────────────────────────────────────

export type HubFlagsGateReason = "scheduled" | "status" | "legacy_status" | "draft_diverged";

/**
 * D9, on the MAIN row and the LATEST version of the article (tenant already checked), first
 * failure wins: `scheduled` (main OR latest) → `status` (main `workflowStatus` not published)
 * → `legacy_status` (main published by `workflowStatus` but `_status` not published: the
 * imported-article shape, Q12) → `draft_diverged` (latest not `_status: published`, or another
 * `version` than main: a pending draft would be published by a non-draft write). null = ok.
 */
export function flagsGateReason(a: { main: Doc | null | undefined; latest: Doc | null | undefined }): HubFlagsGateReason | null {
  const { main, latest } = a;
  if (!main) return "status";
  if (main.workflowStatus === "scheduled" || latest?.workflowStatus === "scheduled") return "scheduled";
  if (main.workflowStatus !== "published") return "status";
  if (main._status !== "published") return "legacy_status";
  if (!latest || latest._status !== "published" || latest.version !== main.version) return "draft_diverged";
  return null;
}

// ── expected / change set ────────────────────────────────────────────────────

/** A stored date (string / Date) → epoch ms; null / absent / unparseable → null. */
export function pinInstant(v: unknown): number | null {
  if (v == null) return null;
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The three values of a stored doc; `pinnedUntil` normalised to `…:ss.fffZ` (unparseable ⇒ null). */
export function storedEditorialValues(doc: Doc): HubEditorialValues {
  const t = pinInstant(doc.pinnedUntil);
  return { exclusive: doc.exclusive === true, pinnedToLatest: doc.pinnedToLatest === true, pinnedUntil: t === null ? null : new Date(t).toISOString() };
}

export function sameEditorialValues(a: HubEditorialValues, b: HubEditorialValues): boolean {
  return a.exclusive === b.exclusive && a.pinnedToLatest === b.pinnedToLatest && pinInstant(a.pinnedUntil) === pinInstant(b.pinnedUntil);
}

export interface HubFlagsChange {
  changed: HubEditorialKey[];
  /** The update data: ONLY the changed columns. */
  data: Partial<HubEditorialValues>;
  from: Partial<HubEditorialValues>;
  to: Partial<HubEditorialValues>;
}

/** The keys of `set` (in `order`) whose value differs from `current` (`pinnedUntil` by instant). */
export function flagsChange(current: HubEditorialValues, set: HubEditorialInput, order: readonly HubEditorialKey[]): HubFlagsChange {
  const out: HubFlagsChange = { changed: [], data: {}, from: {}, to: {} };
  for (const k of order) {
    if (!own(set as Doc, k)) continue;
    const next = set[k];
    if (next === undefined) continue;
    const same = k === "pinnedUntil" ? pinInstant(next) === pinInstant(current.pinnedUntil) : next === current[k];
    if (same) continue;
    out.changed.push(k);
    (out.data as Doc)[k] = next;
    (out.from as Doc)[k] = current[k];
    (out.to as Doc)[k] = next;
  }
  return out;
}

// ── D8: the post-write assertion ─────────────────────────────────────────────

/** The only columns a flags write may move. */
export const FLAGS_POST_WRITE_IGNORED = ["exclusive", "pinnedToLatest", "pinnedUntil", "updatedAt"] as const;

/**
 * D8 (1): the keys whose values differ between `pre` and `post` (both the MAIN row read with
 * `locale: "all"`, depth 0, in the transaction), over the UNION of their keys (pre order
 * first), minus `FLAGS_POST_WRITE_IGNORED`. Localized columns compare as one object (every
 * locale). `[]` = nothing else moved — `version`, `_status`, `publishedAt`, `lastEditedBy`,
 * `translationStatus` and `views` included.
 */
export function flagsPostWriteDiff(pre: Doc, post: Doc): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    if ((FLAGS_POST_WRITE_IGNORED as readonly string[]).includes(k)) continue;
    if (!liveValueEqual(pre[k], post[k])) out.push(k);
  }
  return out;
}

export type FlagsPostWriteResult = { ok: true } | { ok: false; leg: "missing" | "fields" | "values" | "latest"; detail: string[] };

/**
 * D8, inside the lock right after the write: (missing) both re-reads exist; (fields)
 * `flagsPostWriteDiff(pre, post)` empty; (values) the three stored values of `post` equal
 * `want` (= current ⊕ set); (latest) the latest version is still `_status: published` with
 * the SAME `version` as `post` (no pending draft created, no bump). Any leg failing ⇒ the
 * caller rolls back: `fields` / `latest` (something landed on the article mid-flight, e.g. a human
 * Save Draft that the non-draft write merged) ⇒ 409 `draft_diverged`; `missing` / `values` (our
 * own write did not land as asked) ⇒ 500. Both also write one `integration_error` row.
 */
export function flagsPostWriteCheck(a: { pre: Doc; post: Doc | null | undefined; latest: Doc | null | undefined; want: HubEditorialValues }): FlagsPostWriteResult {
  const { pre, post, latest } = a;
  if (!post) return { ok: false, leg: "missing", detail: ["post"] };
  if (!latest) return { ok: false, leg: "missing", detail: ["latest"] };
  const diff = flagsPostWriteDiff(pre, post);
  if (diff.length) return { ok: false, leg: "fields", detail: diff };
  const got = storedEditorialValues(post);
  const values = HUB_EDITORIAL_KEYS.filter((k) => (k === "pinnedUntil" ? pinInstant(got[k]) !== pinInstant(a.want[k]) : got[k] !== a.want[k]));
  if (values.length) return { ok: false, leg: "values", detail: [...values] };
  const lat: string[] = [];
  if (latest._status !== "published") lat.push("latest._status");
  if (latest.version !== post.version) lat.push("latest.version");
  if (lat.length) return { ok: false, leg: "latest", detail: lat };
  return { ok: true };
}
