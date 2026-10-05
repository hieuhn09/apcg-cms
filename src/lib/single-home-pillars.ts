/**
 * Single-home pillar rule — the ONE source of the rule, shared by the Articles
 * `beforeChange` hook, the SubSections / secondary-row field validators, the
 * admin `filterOptions`, the Pillars row guards, the engine-intake pre-check
 * and the Console error unwrapping.
 *
 * A pillar P listed in SINGLE_HOME_PILLARS[tenantSlug] is "single-home":
 *   V1  primary = P  => no secondary-section rows (a persisted duplicate of the
 *       primary counts too)
 *   V2  primary = P  => no sub-section
 *   V3  a secondary row = P is refused, whatever the primary is
 *   V4  a sub-section whose pillar is P cannot exist
 *   V5  the (tenant, slug) key of P cannot be renamed / moved / deleted in use
 *       (Pillars guards: src/hooks/single-home-pillar-row-guard.ts)
 *   V6  primary = P  => the article cannot be flagged `exclusive`
 *
 * Keying (D-C): a pillar is single-home by the REFERENCED pillar doc's own
 * tenant + slug — never by the client-supplied `data.tenant` (drafts skip the
 * required check; the multi-tenant default comes from a cookie).
 *
 * Failure policy (D-B): the hard rules FAIL CLOSED (lookups propagate their
 * errors, unresolved ids throw); only the admin `filterOptions` (UX) fails open.
 *
 * PURE module: relative imports only and NO value import of `payload`, so the
 * node:test suite runs without a Payload instance. Lookups take an injected
 * `find`.
 */
import { SINGLE_HOME_PILLARS } from "./constants";

// ── Messages (frozen Shared Contract) ───────────────────────────────────────

const RULE_PREFIX = "pillar rule:";

const DETAIL = {
  V1: "an article filed there cannot also have secondary sections.",
  V2: "an article filed there cannot have a sub-section.",
  V3: "it cannot be added as a secondary section to another article.",
  V4: "it cannot have sub-sections.",
  V6: "an article filed there cannot be marked exclusive.",
} as const;
export type RuleId = keyof typeof DETAIL;

/** `pillar rule: "{slug}" is a single-home pillar: {detail}` */
export function ruleMessage(slug: string, rule: RuleId): string {
  return `${RULE_PREFIX} "${slug}" is a single-home pillar: ${DETAIL[rule]}`;
}

/** V5 Pillars-row messages (no single-home prefix). */
export const MSG = {
  rename: "pillar rule: this pillar's slug cannot be changed.",
  delete: "pillar rule: this pillar cannot be deleted while articles or sub-sections use it.",
  move: "pillar rule: this pillar cannot be moved to another tenant.",
  malformed: "pillar rule: malformed taxonomy input",
} as const;

// ── Keying ──────────────────────────────────────────────────────────────────

/** True when (tenantSlug, pillarSlug) is single-home. Exact, case-sensitive. */
export function isSingleHomePillar(tenantSlug: string | null | undefined, pillarSlug: string | null | undefined): boolean {
  if (typeof tenantSlug !== "string" || typeof pillarSlug !== "string") return false;
  const list = Object.hasOwn(SINGLE_HOME_PILLARS, tenantSlug) ? SINGLE_HOME_PILLARS[tenantSlug] : undefined;
  return Array.isArray(list) && list.includes(pillarSlug);
}

/** Single-home slugs configured for a tenant ([] when none / unknown). */
export function singleHomeSlugsFor(tenantSlug: string | null | undefined): string[] {
  if (typeof tenantSlug !== "string" || !Object.hasOwn(SINGLE_HOME_PILLARS, tenantSlug)) return [];
  return [...(SINGLE_HOME_PILLARS[tenantSlug] ?? [])];
}

/** Union of every tenant's single-home slugs (cheap pre-filter before a tenant lookup). */
export function singleHomeSlugUnion(): string[] {
  return [...new Set(Object.values(SINGLE_HOME_PILLARS).flat())];
}

// ── Ids ─────────────────────────────────────────────────────────────────────

type IdKey = string;

function isObjectLike(v: unknown): v is Record<string, unknown> {
  // Null-prototype objects (GraphQL inputs) are accepted: never compare prototypes.
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function malformed(field: string): Error {
  return new Error(`${MSG.malformed} (${field}).`);
}

/**
 * Strict id reader: undefined / null / "" => null; a non-empty string or a
 * safe integer => its string key; an object => its `id` under the same rules.
 * Anything else (NaN, booleans, arrays, `$`-operator objects, `{id: {...}}`)
 * throws — fail closed.
 */
function strictId(v: unknown, field: string): IdKey | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw malformed(field);
    return String(v);
  }
  if (isObjectLike(v)) {
    const id = v.id; // plain property access (never own-key enumeration)
    if (typeof id === "string" && id !== "") return id;
    if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
    throw malformed(field);
  }
  throw malformed(field);
}

/** Lenient id key: same as the strict reader, but malformed input => null. */
export function idKey(v: unknown): IdKey | null {
  try {
    return strictId(v, "id");
  } catch {
    return null;
  }
}

/** Id key -> value for a Payload `where` (numeric strings back to numbers). */
function lookupValue(key: IdKey): string | number {
  return /^\d+$/.test(key) && Number.isSafeInteger(Number(key)) ? Number(key) : key;
}

function hasOperatorKey(o: Record<string, unknown>): boolean {
  return Object.keys(o).some((k) => k.startsWith("$"));
}

// ── Taxonomy normalisation + change detection ───────────────────────────────

export interface Taxonomy {
  pillar: IdKey | null;
  subSection: IdKey | null;
  secondary: { pillar: IdKey | null; subSection: IdKey | null }[];
}

/**
 * Reduce `{pillar, subSection, secondarySections}` to id keys. Absent / null /
 * "" / [] = empty. FAILS CLOSED (throws a `pillar rule:` Error) on any malformed
 * shape — notably `secondarySections: {$push: ...}`, which Payload 3.85.1
 * forwards to the DB untouched (G80).
 */
export function normalizeTaxonomy(src: { pillar?: unknown; subSection?: unknown; secondarySections?: unknown }): Taxonomy {
  const pillar = strictId(src.pillar, "pillar");
  const subSection = strictId(src.subSection, "subSection");
  const raw = src.secondarySections;
  const secondary: Taxonomy["secondary"] = [];
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw malformed("secondarySections");
    raw.forEach((row: unknown, i: number) => {
      if (!isObjectLike(row) || hasOperatorKey(row)) throw malformed(`secondarySections.${i}`);
      const p = strictId(row.pillar, `secondarySections.${i}.pillar`);
      const s = strictId(row.subSection, `secondarySections.${i}.subSection`);
      if (p !== null || s !== null) secondary.push({ pillar: p, subSection: s });
    });
  }
  return { pillar, subSection, secondary };
}

/** True when two normalised taxonomies differ (row order counts). */
export function taxonomyChanged(a: Taxonomy, b: Taxonomy): boolean {
  if (a.pillar !== b.pillar || a.subSection !== b.subSection) return true;
  if (a.secondary.length !== b.secondary.length) return true;
  return a.secondary.some((r, i) => r.pillar !== b.secondary[i]!.pillar || r.subSection !== b.secondary[i]!.subSection);
}

// ── Article decision (V1/V2/V3/V6) ──────────────────────────────────────────

export interface RuleViolation {
  message: string;
  path: string;
}

/**
 * Decide V1/V2/V3/V6 for an article's resulting taxonomy. `singleHomeSlugOf`
 * maps a pillar id key to its single-home slug (or null).
 */
export function checkSingleHome(
  tax: Taxonomy,
  singleHomeSlugOf: (id: IdKey | null) => string | null,
  exclusive: boolean,
): RuleViolation | null {
  const primary = tax.pillar !== null ? singleHomeSlugOf(tax.pillar) : null;
  if (primary) {
    if (tax.secondary.length > 0) return { message: ruleMessage(primary, "V1"), path: "secondarySections" };
    if (tax.subSection !== null) return { message: ruleMessage(primary, "V2"), path: "subSection" };
    if (exclusive) return { message: ruleMessage(primary, "V6"), path: "exclusive" };
  }
  for (let i = 0; i < tax.secondary.length; i += 1) {
    const rowPillar = tax.secondary[i]!.pillar;
    const slug = rowPillar !== null ? singleHomeSlugOf(rowPillar) : null;
    if (slug) return { message: ruleMessage(slug, "V3"), path: `secondarySections.${i}.pillar` };
  }
  return null;
}

// ── Engine intake pre-check (D-D) ───────────────────────────────────────────

const normSlug = (s: string) => s.trim().toLowerCase();
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Pure decision on the REQUEST slugs, run before any resolution or write.
 * Returns the refusal reason, or null. Compares trim + lowercase (a safe
 * superset of the case-sensitive resolver). Returns null immediately for a
 * tenant without single-home pillars. `secondaryPillarSlugs` (WTB) is never
 * checked: intake ignores it.
 */
export function checkIntakeSingleHome(
  tenantSlug: string | null | undefined,
  body: { pillarSlug?: unknown; sections?: unknown; subSectionSlug?: unknown; subSectionSlugs?: unknown; secondarySubSections?: unknown },
): string | null {
  const list = singleHomeSlugsFor(tenantSlug);
  if (list.length === 0) return null;
  const canonical = new Map(list.map((s) => [normSlug(s), s]));

  const primary = typeof body.pillarSlug === "string" ? normSlug(body.pillarSlug) : "";
  const sectionSlugs = asArray(body.sections)
    .map((entry) => (typeof entry === "string" ? entry : isObjectLike(entry) && typeof entry.pillar === "string" ? entry.pillar : null))
    .filter(nonEmpty)
    .map(normSlug);

  const primaryCanonical = canonical.get(primary);
  if (primaryCanonical) {
    // An entry equal to the primary is ignored (the resolver drops it too).
    if (sectionSlugs.some((s) => s !== primary)) return ruleMessage(primaryCanonical, "V1");
    if (nonEmpty(body.subSectionSlug) || asArray(body.subSectionSlugs).some(nonEmpty)) return ruleMessage(primaryCanonical, "V2");
    if (asArray(body.secondarySubSections).some((x) => x !== null && x !== undefined)) return ruleMessage(primaryCanonical, "V1");
    return null;
  }
  const hit = sectionSlugs.find((s) => canonical.has(s));
  return hit ? ruleMessage(canonical.get(hit)!, "V3") : null;
}

// ── Pillars row guards (V5) ─────────────────────────────────────────────────

/**
 * (tenant, slug) change on an existing pillar. Tenant ids are pre-normalised;
 * the slug is compared RAW (a trim/lowercase compare would let `pressroom` ->
 * `Pressroom ` pass as unchanged). Rejects when the pair changed and EITHER the
 * old or the new pair is single-home. Tenant move wins over rename.
 */
export function checkPillarRowChange(p: {
  oldTenantId: string | null;
  oldTenantSlug: string | null;
  oldSlug: unknown;
  newTenantId: string | null;
  newTenantSlug: string | null;
  newSlug: unknown;
}): "rename" | "move" | null {
  const tenantChanged = p.oldTenantId !== p.newTenantId;
  const slugChanged = p.oldSlug !== p.newSlug;
  if (!tenantChanged && !slugChanged) return null;
  const asSlug = (v: unknown) => (typeof v === "string" ? v : null);
  const either = isSingleHomePillar(p.oldTenantSlug, asSlug(p.oldSlug)) || isSingleHomePillar(p.newTenantSlug, asSlug(p.newSlug));
  if (!either) return null;
  return tenantChanged ? "move" : "rename";
}

export interface PillarRefCounts {
  articles: number;
  subsections: number;
  newsletters: number;
  draftVersions: number;
}

/** True when deleting the pillar must be refused (single-home and referenced). */
export function checkPillarDelete(singleHome: boolean, refs: PillarRefCounts): boolean {
  if (!singleHome) return false;
  return refs.articles + refs.subsections + refs.newsletters + refs.draftVersions > 0;
}

// ── Error detection / unwrapping ────────────────────────────────────────────

function fieldErrorMessages(err: unknown): string[] {
  if (err === null || typeof err !== "object") return [];
  const data = (err as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return [];
  const errors = (data as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e: unknown) => (e !== null && typeof e === "object" ? (e as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string" && m !== "");
}

/** True only for a single-home rule rejection (ValidationError entry or plain/API Error message). */
export function isSingleHomeRuleError(err: unknown): boolean {
  if (fieldErrorMessages(err).some((m) => m.startsWith(RULE_PREFIX))) return true;
  return err instanceof Error && typeof err.message === "string" && err.message.startsWith(RULE_PREFIX);
}

/**
 * Human text for an error: a ValidationError's real field messages (its
 * top-level message is the generic "The following field is invalid: <path>"),
 * else the Error message.
 */
export function humanErrorMessage(err: unknown): string {
  const msgs = fieldErrorMessages(err);
  if (msgs.length) return msgs.join("; ");
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Something went wrong.";
}

// ── Admin builders (UX) and validate decisions ──────────────────────────────

/**
 * Secondary-row pillar picker filter. Exactly `true` when the tenant has no
 * single-home pillar; `false` (nothing pickable) when the primary is
 * single-home; otherwise exclude the single-home slugs.
 */
export function pillarFilterWhere(singleHomeSlugs: string[], primaryIsSingleHome: boolean): true | false | { slug: { not_in: string[] } } {
  if (singleHomeSlugs.length === 0) return true;
  if (primaryIsSingleHome) return false;
  return { slug: { not_in: [...singleHomeSlugs] } };
}

/** SubSections.pillar: V4 when the parent pillar is single-home. */
export function subSectionPillarDecision(singleHomeSlug: string | null): string | true {
  return singleHomeSlug ? ruleMessage(singleHomeSlug, "V4") : true;
}

/** Articles secondary row pillar: V3 when the row pillar is single-home. */
export function secondaryRowPillarDecision(singleHomeSlug: string | null): string | true {
  return singleHomeSlug ? ruleMessage(singleHomeSlug, "V3") : true;
}

// ── Resolver (injected find; per-request memo) ──────────────────────────────

export type FindFn = (args: {
  collection: "pillars" | "tenants";
  where: Record<string, unknown>;
  select: Record<string, true>;
  depth: 0;
  pagination: false;
  overrideAccess: true;
}) => Promise<{ docs: Array<Record<string, unknown>> }>;

interface Memo {
  pillars: Map<IdKey, { slug: string | null; tenant: IdKey | null }>;
  tenants: Map<IdKey, string | null>;
}

const MEMO_KEY = "singleHomePillarMemo";

/** Per-request memo stored on `req.context` (never a process-wide cache). */
function memoOf(context: Record<string, unknown> | undefined): Memo {
  if (!context) return { pillars: new Map(), tenants: new Map() };
  const existing = context[MEMO_KEY] as Memo | undefined;
  if (existing && existing.pillars instanceof Map && existing.tenants instanceof Map) return existing;
  const memo: Memo = { pillars: new Map(), tenants: new Map() };
  context[MEMO_KEY] = memo;
  return memo;
}

/** Test / maintenance helper: drop the per-request memo. */
export function resetSingleHomeMemo(context: Record<string, unknown> | undefined): void {
  if (context) delete context[MEMO_KEY];
}

function uniqueKeys(ids: unknown[]): IdKey[] {
  const out = new Set<IdKey>();
  for (const v of ids) {
    const k = idKey(v);
    if (k !== null) out.add(k);
  }
  return [...out];
}

/** Map tenant ids to slugs (batched, memoised, FAIL CLOSED on an unresolved id). */
export async function resolveTenantSlugs(args: { tenantIds: unknown[]; find: FindFn; context?: Record<string, unknown> }): Promise<Map<IdKey, string | null>> {
  const memo = memoOf(args.context);
  const keys = uniqueKeys(args.tenantIds);
  const missing = keys.filter((k) => !memo.tenants.has(k));
  if (missing.length) {
    const res = await args.find({
      collection: "tenants",
      where: { id: { in: missing.map(lookupValue) } },
      select: { slug: true },
      depth: 0,
      pagination: false,
      overrideAccess: true,
    });
    for (const d of res.docs) {
      const k = idKey(d.id);
      if (k !== null) memo.tenants.set(k, typeof d.slug === "string" ? d.slug : null);
    }
    const unresolved = missing.filter((k) => !memo.tenants.has(k));
    if (unresolved.length) throw new Error(`single-home rule: unresolved tenant id(s) ${unresolved.join(", ")}`);
  }
  return new Map(keys.map((k) => [k, memo.tenants.get(k) ?? null]));
}

/**
 * For each referenced pillar id: its single-home slug, or null. One batched
 * pillars find (`select {slug, tenant}`, `pagination:false`); the tenant
 * id->slug lookup only runs when some referenced slug is in the single-home
 * union. FAILS CLOSED on an unresolved id or a lookup error.
 */
export async function resolveSingleHome(args: { pillarIds: unknown[]; find: FindFn; context?: Record<string, unknown> }): Promise<Map<IdKey, string | null>> {
  const memo = memoOf(args.context);
  const keys = uniqueKeys(args.pillarIds);
  if (keys.length === 0) return new Map();

  const missing = keys.filter((k) => !memo.pillars.has(k));
  if (missing.length) {
    const res = await args.find({
      collection: "pillars",
      where: { id: { in: missing.map(lookupValue) } },
      select: { slug: true, tenant: true },
      depth: 0,
      pagination: false,
      overrideAccess: true,
    });
    for (const d of res.docs) {
      const k = idKey(d.id);
      if (k !== null) memo.pillars.set(k, { slug: typeof d.slug === "string" ? d.slug : null, tenant: idKey(d.tenant) });
    }
    const unresolved = missing.filter((k) => !memo.pillars.has(k));
    if (unresolved.length) throw new Error(`single-home rule: unresolved pillar id(s) ${unresolved.join(", ")}`);
  }

  const union = new Set(singleHomeSlugUnion());
  const candidates = keys.filter((k) => {
    const p = memo.pillars.get(k)!;
    return p.slug !== null && union.has(p.slug) && p.tenant !== null;
  });
  const out = new Map<IdKey, string | null>(keys.map((k) => [k, null]));
  if (candidates.length === 0) return out;

  const tenantSlugs = await resolveTenantSlugs({
    tenantIds: candidates.map((k) => memo.pillars.get(k)!.tenant),
    find: args.find,
    context: args.context,
  });
  for (const k of candidates) {
    const p = memo.pillars.get(k)!;
    const tSlug = tenantSlugs.get(p.tenant!) ?? null;
    if (isSingleHomePillar(tSlug, p.slug)) out.set(k, p.slug);
  }
  return out;
}
