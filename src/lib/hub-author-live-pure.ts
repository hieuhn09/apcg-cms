/**
 * Hub LIVE edit — pure helpers (APCGHub P5.4, "Sửa bài đã đăng"; content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-4-edit-published_PLAN_30-09-26.md, D2–D4,
 * D11, D12). No I/O, no Payload, no `@payload-config`: imported ONE WAY by
 * `hub-author-live-core.ts` and `hub-article-edit-select.ts` (this file imports neither
 * of them nor `hub-author-handlers.ts`).
 *
 *   liveEditTenants   — the CMS switch `HUB_LIVE_EDIT_TENANTS` (D11), read on EVERY call
 *   liveGateReason    — the live gate on (main, latest) (D2)
 *   parseLiveBody     — the nested `/live` body → the flat PATCH parser (D3 / D4)
 *   livePostWriteCheck — the post-write assertion inside the lock (D12)
 */

import { HUB_DRAFT_FIELD_KEYS, parseUpdateBody, type HubDraftFieldKey, type HubParseResult } from "@/lib/hub-author-input";
import { lexicalTreesEqual } from "@/lib/hub-author-convert-core";

type Doc = Record<string, unknown>;

/** D4: the 15 keys a live edit may carry = HUB_DRAFT_FIELD_KEYS minus slug / heroImageId / leadImageCaption. */
export const HUB_LIVE_FIELD_KEYS = [
  "title",
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
] as const satisfies readonly HubDraftFieldKey[];
export type HubLiveFieldKey = (typeof HUB_LIVE_FIELD_KEYS)[number];

/** D4: draft keys that exist but are LOCKED on a live article (422 not_live_editable). */
export const HUB_LIVE_LOCKED_FIELD_KEYS = ["slug", "heroImageId", "leadImageCaption"] as const satisfies readonly HubDraftFieldKey[];
/** D4 / O9 / O13: flags locked on a live article (present at all ⇒ 422 flags_locked). */
export const HUB_LIVE_LOCKED_FLAGS = ["breaking", "aiAssisted", "sponsored", "affiliate"] as const;
/** D4: the only flags a live edit may change. */
export const HUB_LIVE_EDITABLE_FLAGS = ["deepDive", "longHaul"] as const;
/** T1: the outer keys of the nested `/live` body — exactly these, all required. */
export const HUB_LIVE_BODY_KEYS = ["tenant", "expectedVersion", "actor", "fields"] as const;

/** D12: the localized `articles` fields (`localized: true` in Articles.ts; pinned against the config by test:hub-live). */
export const LIVE_LOCALIZED_FIELDS = ["title", "slug", "dek", "body", "imageLabel", "leadImageCaption"] as const;

/** D12 (1): columns never compared between `pre` and `post` (the write itself moves them). */
export const LIVE_POST_WRITE_IGNORED = [
  "id",
  "createdAt",
  "updatedAt",
  "version",
  "translationStatus",
  "lastEditedBy",
  "views",
  "_status",
  "publishedAt",
] as const;

// ── D11: the CMS switch ──────────────────────────────────────────────────────

/**
 * `HUB_LIVE_EDIT_TENANTS` — CSV of CMS tenant slugs, default OFF. Read on every call (no
 * cache); split on ",", trim, drop empty items; matched EXACTLY (case-sensitive) by the
 * caller. `*`, other case, inner whitespace never match a slug.
 */
export function liveEditTenants(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.HUB_LIVE_EDIT_TENANTS;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isLiveEditTenant(slug: string, tenants: readonly string[]): boolean {
  return tenants.includes(slug);
}

// ── D2: the live gate ────────────────────────────────────────────────────────

export type HubLiveGateReason = "origin" | "scheduled" | "status" | "draft_diverged" | "not_hub_authored";

/**
 * D2, on the FULL main row (no narrow select) and the LATEST version, after the id /
 * tenant checks (404) and before `expectedVersion` (409). First failure wins:
 * origin → scheduled (main OR latest; never `scheduledFor`, which the cron does not
 * clear) → status (main workflowStatus AND _status published) → draft_diverged (latest
 * `_status` published AND same `version` as main) → not_hub_authored (`isHubAuthored`
 * computed by the caller, and no `engineDraftId`). null = live-editable.
 */
export function liveGateReason(a: { main: Doc | null | undefined; latest: Doc | null | undefined; isHubAuthored: boolean }): HubLiveGateReason | null {
  const { main, latest } = a;
  if (!main || main.origin !== "manual") return "origin";
  if (main.workflowStatus === "scheduled" || latest?.workflowStatus === "scheduled") return "scheduled";
  if (main.workflowStatus !== "published" || main._status !== "published") return "status";
  if (!latest || latest._status !== "published" || latest.version !== main.version) return "draft_diverged";
  if (!a.isHubAuthored || main.engineDraftId != null) return "not_hub_authored";
  return null;
}

// ── D3 / D4: the nested body ─────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Doc, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const liveBadRequest = (reason: string, field: string): HubParseResult => ({
  ok: false,
  status: 400,
  body: { ok: false, status: "bad_request", reason, field },
});

export type HubLiveLockReason = "slug_locked" | "media_locked" | "flags_locked";

const notLiveEditable = (reason: HubLiveLockReason): HubParseResult => ({
  ok: false,
  status: 422,
  body: { ok: false, status: "not_live_editable", reason },
});

const ALLOWED_FIELD_KEYS: readonly string[] = [...HUB_LIVE_FIELD_KEYS, ...HUB_LIVE_LOCKED_FIELD_KEYS];

/**
 * `{tenant, expectedVersion, actor, fields}` → the PATCH parser on a FLAT copy. Fixed order:
 * (1) outer keys exactly the four (an extra key first, in insertion order, then a missing
 * one, in the order above) and `fields` a plain object ⇒ 400 `field:<key>`;
 * (2) every key of `fields` ∈ the 15 live keys ∪ the 3 locked draft keys, else 400
 * `field:fields.<key>` (`tenant`, `actor`, `expectedVersion`, `fields`, `__proto__`,
 * `constructor` included); (3) a locked key PRESENT ⇒ 422 not_live_editable (slug_locked,
 * then media_locked, then flags_locked — a locked flag present even with its stored value);
 * (4) a SPREAD copy `{...fields, tenant, expectedVersion, actor}` (never Object.assign: a
 * `__proto__` own key would hit the setter) → `parseUpdateBody` (its 400 / 422 as-is).
 */
export function parseLiveBody(raw: unknown): HubParseResult {
  if (!isPlainObject(raw)) return liveBadRequest("body must be a JSON object", "body");
  for (const k of Object.keys(raw)) {
    if (!(HUB_LIVE_BODY_KEYS as readonly string[]).includes(k)) return liveBadRequest(`unknown field: ${k.slice(0, 64)}`, k.slice(0, 64));
  }
  for (const k of HUB_LIVE_BODY_KEYS) {
    if (!has(raw, k)) return liveBadRequest(`${k} is required`, k);
  }
  const fields = raw.fields;
  if (!isPlainObject(fields)) return liveBadRequest("fields must be a JSON object", "fields");
  for (const k of Object.keys(fields)) {
    if (!ALLOWED_FIELD_KEYS.includes(k)) {
      const shown = k.slice(0, 64);
      return liveBadRequest(`unknown field: fields.${shown}`, `fields.${shown}`);
    }
  }
  if (has(fields, "slug")) return notLiveEditable("slug_locked");
  if (has(fields, "heroImageId") || has(fields, "leadImageCaption")) return notLiveEditable("media_locked");
  const flags = fields.flags;
  if (isPlainObject(flags) && HUB_LIVE_LOCKED_FLAGS.some((f) => has(flags, f))) return notLiveEditable("flags_locked");
  const flat: Doc = { ...fields, tenant: raw.tenant, expectedVersion: raw.expectedVersion, actor: raw.actor };
  return parseUpdateBody(flat);
}

/** Every key of a parsed live input (sanity: never one of the draft-only keys). */
export function isLiveFieldKey(k: string): k is HubLiveFieldKey {
  return (HUB_LIVE_FIELD_KEYS as readonly string[]).includes(k);
}

/** D4 helper for tests: HUB_DRAFT_FIELD_KEYS minus the locked ones, in order. */
export const DERIVED_LIVE_FIELD_KEYS: readonly string[] = HUB_DRAFT_FIELD_KEYS.filter(
  (k) => !(HUB_LIVE_LOCKED_FIELD_KEYS as readonly string[]).includes(k),
);

// ── D12: the post-write assertion ────────────────────────────────────────────

const isLexicalNode = (v: unknown): boolean => isPlainObject(v) && isPlainObject(v.root);

/** Canonical JSON (object keys sorted; jsonb does not keep insertion order). */
function canon(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(walk);
    if (isPlainObject(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    return x;
  };
  return JSON.stringify(walk(v) ?? null);
}

/** One value: both nullish ⇒ equal; both Lexical trees ⇒ `lexicalTreesEqual`; else canonical JSON (array order kept). */
export function liveValueEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (isLexicalNode(a) && isLexicalNode(b)) return lexicalTreesEqual(a, b);
  return canon(a) === canon(b);
}

/**
 * D12 (1): the keys whose values differ between `pre` and `post` (both read with
 * `locale: "all"`, depth 0, in the transaction), over the UNION of their keys, minus
 * `LIVE_POST_WRITE_IGNORED` and minus `changedColumns` — except that a LOCALIZED changed
 * column is still compared on every locale other than `en` (the live write only touches
 * `en`). Localized values compare per locale. `[]` = no slipped write.
 */
export function liveDiffKeys(pre: Doc, post: Doc, changedColumns: readonly string[], localized: readonly string[] = LIVE_LOCALIZED_FIELDS): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(pre), ...Object.keys(post)]);
  for (const k of keys) {
    if ((LIVE_POST_WRITE_IGNORED as readonly string[]).includes(k)) continue;
    const isLocalized = localized.includes(k);
    const changed = changedColumns.includes(k);
    if (changed && !isLocalized) continue;
    if (isLocalized) {
      const a = isPlainObject(pre[k]) && !isLexicalNode(pre[k]) ? (pre[k] as Doc) : {};
      const b = isPlainObject(post[k]) && !isLexicalNode(post[k]) ? (post[k] as Doc) : {};
      const locales = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const l of locales) {
        if (changed && l === "en") continue;
        if (!liveValueEqual(a[l], b[l])) {
          out.push(`${k}.${l}`);
          break;
        }
      }
      continue;
    }
    if (!liveValueEqual(pre[k], post[k])) out.push(k);
  }
  return out;
}

const instant = (v: unknown): number | null => {
  if (v == null) return null;
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
};

export type LivePostWriteResult = { ok: true } | { ok: false; leg: "fields" | "status" | "version"; detail: string[] };

/**
 * D12, inside the lock right after the write: (1) `liveDiffKeys(pre, post, changedColumns)`
 * empty; (2) `post` still published on both statuses, same `publishedAt`, latest `_status`
 * published; (3) version: no translations ⇒ `post.version === currentVersion + 1`;
 * translations active ⇒ `post.version >= currentVersion + 1` AND `=== latest.version`.
 * Any leg failing ⇒ the caller rolls back and answers 409 `draft_diverged`.
 */
export function livePostWriteCheck(a: {
  pre: Doc;
  post: Doc | null | undefined;
  latest: Doc | null | undefined;
  changedColumns: readonly string[];
  currentVersion: number;
  translationsActive: boolean;
  localized?: readonly string[];
}): LivePostWriteResult {
  const { pre, post, latest } = a;
  if (!post || !latest) return { ok: false, leg: "status", detail: ["missing"] };
  const diff = liveDiffKeys(pre, post, a.changedColumns, a.localized ?? LIVE_LOCALIZED_FIELDS);
  if (diff.length) return { ok: false, leg: "fields", detail: diff };
  const status: string[] = [];
  if (post.workflowStatus !== "published") status.push("workflowStatus");
  if (post._status !== "published") status.push("_status");
  if (instant(post.publishedAt) !== instant(pre.publishedAt)) status.push("publishedAt");
  if (latest._status !== "published") status.push("latest._status");
  if (status.length) return { ok: false, leg: "status", detail: status };
  const pv = typeof post.version === "number" ? post.version : -1;
  const want = a.currentVersion + 1;
  if (a.translationsActive ? !(pv >= want && pv === latest.version) : pv !== want) {
    return { ok: false, leg: "version", detail: [`post=${pv}`, `current=${a.currentVersion}`, `latest=${String(latest.version)}`] };
  }
  return { ok: true };
}
