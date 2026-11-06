/**
 * Pure logic for `scripts/audit/prune-unused-authors.ts` (no DB, no Payload).
 *
 * WHY: the hub composer's byline picker lists EVERY `authors` row of a tenant.
 * Over time a tenant collects far more rows than it uses: retired engine pen
 * names (gcv/wad replaced theirs on 04-09-26), "ghost" authors the engine intake
 * auto-creates when a name does not match exactly, authors imported with a
 * legacy archive, and pen names created once from the hub. This module decides,
 * per author row, whether it is safe to DELETE.
 *
 * An author is a delete CANDIDATE only when NONE of the keep rules fires:
 *   articles   - it is `author` or a `coAuthors` entry of a live article row;
 *   draft      - it is referenced by a LATEST version still in DRAFT status
 *                (hub drafts keep their edits there, not in the main table);
 *   masthead   - `rank` is set (shown on the site's /about);
 *   user       - linked to a CMS user;
 *   engine     - its exact name is in the content engine's byline pool for the
 *                tenant (deleting it would make the next intake re-create it as
 *                a ghost: Central finds-or-creates authors by EXACT name);
 *   recent     - created less than `keepRecentDays` ago (a pen name made from
 *                the hub for a piece that is not saved yet);
 *   profile    - has a slug, an avatar or a bio (someone curated an author page);
 *                skipped with `--include-profiles` (`opts.includeProfiles`).
 * Any other version reference (older revisions, or a published latest version
 * whose main row now names someone else) does not keep an author: the FK on
 * `_articles_v.version_author_id` is ON DELETE SET NULL and the rels row
 * cascades, so only revision history loses the name. They are reported.
 */

export const PLAN_KIND = "prune-authors-plan";
export const PLAN_VERSION = 1;
export const DEFAULT_KEEP_RECENT_DAYS = 30;

/**
 * Content-engine byline pools, keyed by CENTRAL tenant slug. Mirror of
 * content-engine `src/lib/publications/<pub>/index.ts` `X_BYLINES` (and admin
 * `BYLINE_POLICIES`), copied 06-11-26. If the engine pool changes, update here.
 */
export const ENGINE_POOLS: Readonly<Record<string, readonly string[]>> = {
  gcv: ["Isabelle Renard", "Camille Dubois", "Hugo Bellamy", "Noor Haddad", "Marisol Vega", "Priya Sundaram", "Sofia Marchetti"],
  wad: ["Rachel Teo", "Duncan Reilly", "Lena Brandt", "Meera Chandran", "Tom Halloran", "Rina Sakai"],
  dtw: [
    "Arjun S. Mehta", "Mei-Lin Tan", "Daniel R. Whitfield", "Priya Nair", "Kenji Watanabe",
    "Sofia M. Reyes", "Wei Zhang", "Hana Park", "Marcus Halloran", "Linh T. Pham",
  ],
  "brief-asia": [
    "Priyanka V. Rao", "Cheng Wei-Lun", "Aiko Nakamura", "Rajesh K. Iyer", "Siti Nuraini",
    "Jun-ho Seo", "Mariel D. Santos", "Anand Sundaram", "Lim Hui Ying", "Tran Quoc Bao",
  ],
  "world-travel-brief": [
    "Isabelle Roux", "Marco Dellacasa", "Priya Anand", "Freya Lindqvist", "Diego Salcedo",
    "Amara Osei", "Noor Al-Rashid", "Charlotte Ashworth", "Tomás Rivera", "Yuki Sørensen",
  ],
  gtp: ["Daniel Cheong", "Priya Nair", "Marcus Tan", "Natalie Ong", "Yuki Hamada"],
  vowasia: ["Serene Chia", "Aarti Menon", "Danish Iskandar", "Hanna Pang", "Yumi Nakagawa", "Ishaan Bhatt"],
  agr: ["Rachel Lim", "Arjun Mehta", "Kenji Sato", "Ha Tran", "Daniel Wong"],
  amb: ["Rachel Tan", "Marcus Lim", "Siriporn Chaiyasit", "Dimas Prasetyo", "Lin Wei", "Aisyah Rahman"],
  asn: ["Mark Chen", "Anna Lee", "Linh Tran", "Ken Mori", "Grace Ong", "Ryan Cruz"],
  abb: ["Joanne Lau", "Kim Seo-yeon", "Kavita Rao", "Emi Fujita", "Nathan Leong"],
};

export type KeepReason = "articles" | "draft" | "masthead" | "user" | "engine" | "recent" | "profile";

/** One `authors` row plus its reference counts, as read by the audit query. */
export interface AuthorUsage {
  id: number;
  tenant: string | null;
  name: string;
  role: string | null;
  rank: number | null;
  slug: string | null;
  userId: number | null;
  avatarId: number | null;
  hasBio: boolean;
  createdAt: string;
  /** Live articles with this row as `author`, split by `origin`. */
  engineArticles: number;
  manualArticles: number;
  importArticles: number;
  /** Live articles with this row in `coAuthors`. */
  coAuthorArticles: number;
  /** Latest versions still in DRAFT status (unsaved-to-live hub edits) that reference this row. */
  draftRefs: number;
  /** Any other version (history, or a published latest version the main row supersedes); never a keep reason. */
  historyRefs: number;
  lastPublishedAt: string | null;
}

export interface Classification {
  verdict: "delete" | "keep";
  reasons: KeepReason[];
}

export function liveArticleCount(a: AuthorUsage): number {
  return a.engineArticles + a.manualArticles + a.importArticles + a.coAuthorArticles;
}

const blank = (v: string | null) => v === null || v.trim() === "";

export function classifyAuthor(a: AuthorUsage, opts: { now: Date; keepRecentDays: number; includeProfiles?: boolean }): Classification {
  const reasons: KeepReason[] = [];
  if (liveArticleCount(a) > 0) reasons.push("articles");
  if (a.draftRefs > 0) reasons.push("draft");
  if (a.rank !== null) reasons.push("masthead");
  if (a.userId !== null) reasons.push("user");
  const pool = a.tenant !== null ? ENGINE_POOLS[a.tenant] : undefined;
  if (pool?.includes(a.name)) reasons.push("engine");
  const created = Date.parse(a.createdAt);
  // An unreadable timestamp counts as recent: fail safe, keep the row.
  if (!Number.isFinite(created) || opts.now.getTime() - created < opts.keepRecentDays * 86_400_000) reasons.push("recent");
  if (opts.includeProfiles !== true && (!blank(a.slug) || a.avatarId !== null || a.hasBio)) reasons.push("profile");
  return { verdict: reasons.length === 0 ? "delete" : "keep", reasons };
}

export interface TenantSummary {
  tenant: string;
  total: number;
  keep: number;
  delete: number;
  /** keep rows per reason (a row with several reasons counts under each). */
  byReason: Partial<Record<KeepReason, number>>;
}

export function summarise(rows: { usage: AuthorUsage; c: Classification }[]): TenantSummary[] {
  const map = new Map<string, TenantSummary>();
  for (const { usage, c } of rows) {
    const key = usage.tenant ?? "(no tenant)";
    let s = map.get(key);
    if (!s) map.set(key, (s = { tenant: key, total: 0, keep: 0, delete: 0, byReason: {} }));
    s.total += 1;
    if (c.verdict === "delete") s.delete += 1;
    else {
      s.keep += 1;
      for (const r of c.reasons) s.byReason[r] = (s.byReason[r] ?? 0) + 1;
    }
  }
  return [...map.values()].sort((x, y) => x.tenant.localeCompare(y.tenant));
}

/* ── Plan file (dry run writes it, --apply reads it) ─────────────────────── */

export interface PlanCandidate {
  id: number;
  tenant: string | null;
  name: string;
}

export interface PruneAuthorsPlan {
  kind: typeof PLAN_KIND;
  version: typeof PLAN_VERSION;
  createdAt: string;
  database: string;
  keepRecentDays: number;
  includeProfiles: boolean;
  tenants: string[] | null;
  candidates: PlanCandidate[];
}

export function parsePlan(text: string): PruneAuthorsPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("plan file is not valid JSON");
  }
  const p = raw as Partial<PruneAuthorsPlan> | null;
  if (!p || p.kind !== PLAN_KIND || p.version !== PLAN_VERSION) throw new Error(`not a ${PLAN_KIND} v${PLAN_VERSION} file`);
  if (typeof p.database !== "string" || p.database === "") throw new Error("plan has no database");
  if (!Array.isArray(p.candidates)) throw new Error("plan has no candidates array");
  const seen = new Set<number>();
  for (const c of p.candidates) {
    if (!c || !Number.isSafeInteger(c.id) || c.id <= 0) throw new Error("plan has a candidate with a bad id");
    if (typeof c.name !== "string") throw new Error(`plan candidate #${c.id} has no name`);
    if (seen.has(c.id)) throw new Error(`plan lists #${c.id} twice`);
    seen.add(c.id);
  }
  if (p.includeProfiles !== undefined && typeof p.includeProfiles !== "boolean") throw new Error("plan has a bad includeProfiles");
  return { ...(p as PruneAuthorsPlan), includeProfiles: p.includeProfiles === true };
}

/**
 * Ids to delete on `--apply`: plan candidates that are STILL delete candidates
 * now, with the same tenant and name. Anything else is skipped and reported.
 */
export function reconcilePlan(
  plan: PruneAuthorsPlan,
  current: Map<number, { usage: AuthorUsage; c: Classification }>,
): { ids: number[]; skipped: { id: number; name: string; why: string }[] } {
  const ids: number[] = [];
  const skipped: { id: number; name: string; why: string }[] = [];
  for (const cand of plan.candidates) {
    const now = current.get(cand.id);
    if (!now) skipped.push({ id: cand.id, name: cand.name, why: "no longer exists" });
    else if (now.usage.name !== cand.name || now.usage.tenant !== cand.tenant) skipped.push({ id: cand.id, name: cand.name, why: "name or tenant changed" });
    else if (now.c.verdict !== "delete") skipped.push({ id: cand.id, name: cand.name, why: `now kept (${now.c.reasons.join(", ")})` });
    else ids.push(cand.id);
  }
  return { ids, skipped };
}

/* ── CSV report ──────────────────────────────────────────────────────────── */

const CSV_HEAD = [
  "tenant", "id", "name", "role", "verdict", "keep_reasons", "engine_articles", "manual_articles",
  "import_articles", "coauthor_articles", "draft_refs", "history_refs", "last_published_at",
  "rank", "slug", "created_at",
];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: { usage: AuthorUsage; c: Classification }[]): string {
  const lines = [CSV_HEAD.join(",")];
  for (const { usage: a, c } of rows) {
    lines.push(
      [
        a.tenant, a.id, a.name, a.role, c.verdict, c.reasons.join(" "), a.engineArticles, a.manualArticles,
        a.importArticles, a.coAuthorArticles, a.draftRefs, a.historyRefs, a.lastPublishedAt,
        a.rank, a.slug, a.createdAt,
      ].map(cell).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
