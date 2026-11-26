/**
 * Pure logic for `scripts/audit/reassign-gcv-authors.ts` (no DB, no Payload).
 *
 * WHY (plan `process/general-plans/active/gcv-author-reassign_PLAN_26-11-26.md`):
 * GCV has 68 `authors` rows; the hub composer lists them all. Most are retired
 * names that `prune-unused-authors` cannot delete because something still points
 * at them. This module works out, for ONE tenant, the row changes that leave those
 * names unused, so the prune script (`--tenant=gcv --include-profiles`) can then
 * delete them. It never deletes anything itself.
 *
 * Author sets, resolved BY EXACT NAME inside the tenant (trailing spaces matter):
 *   POOL    the content engine's byline pool (`ENGINE_POOLS.gcv`): kept, and the
 *           reassignment targets;
 *   KEEP    real writers, kept as they are (`Tu C. Nguyen ` is renamed, below);
 *   MERGE   `Valerie Nguyen ` (source) folds into `Valerie Nguyen` (target);
 *   REMOVE  every other author of the tenant.
 *
 * Row changes (only `latest = true` version rows; older revisions are left alone,
 * their FK is ON DELETE SET NULL):
 *   sync      a latest `_articles_v` row of a tenant article names a REMOVE author
 *             while the article's main row names a kept author: copy the main
 *             row's author (the MERGE target when the main row names the source);
 *   reassign  a tenant article whose `author_id` is a REMOVE author (import only)
 *             gets a POOL author: articles sorted by id, round-robin over the pool
 *             ordered by its current live article count ascending, then name, then
 *             id. Its latest version row follows when it names a REMOVE author;
 *   merge     every `author_id` / latest `version_author_id` / co-author rel
 *             (`articles_rels`, latest `_articles_v_rels`) on the MERGE source moves
 *             to the MERGE target;
 *   rename    `Tu C. Nguyen ` becomes `Tu C. Nguyen` (no twin may exist).
 *
 * The plan ABORTS (nothing is written) when:
 *   - a POOL name is missing or two rows share a POOL / KEEP / MERGE name;
 *   - a REMOVE author has a masthead rank, a linked user, or a live engine/manual
 *     article (only `origin = 'import'` articles may be reassigned);
 *   - a co-author rel (live, or on a latest version) names a REMOVE author. They
 *     are NOT moved: a co-author slot is an editorial choice, and moving it to a
 *     pool name would invent a second byline. The owner fixes them by hand first;
 *   - a latest version row to sync belongs to an article whose main row has no
 *     author or names an author outside the tenant (nothing safe to copy);
 *   - merging a co-author rel would duplicate the target on the same row;
 *   - the rename target name already exists.
 * References the plan leaves alone (another tenant's article naming a tenant
 * author) are reported as warnings: prune will keep those authors.
 */
import { ENGINE_POOLS } from "./prune-authors";

export const PLAN_KIND = "reassign-authors-plan";
export const PLAN_VERSION = 1;

export interface ReassignRules {
  tenant: string;
  pool: readonly string[];
  keep: readonly string[];
  merge: { from: string; to: string } | null;
  rename: { from: string; to: string } | null;
  /** Shown next to the REMOVE count; a mismatch is reported, not fatal. */
  expectedRemove: number | null;
}

/** The owner-approved GCV rules (plan decisions D1-D4, 26-11-26). */
export const GCV_RULES: ReassignRules = {
  tenant: "gcv",
  pool: ENGINE_POOLS.gcv ?? [],
  keep: ["Alexandre Rodrigues", "Amelia Tan", "Simon Ng", "Valerie Nguyen", "Tu C. Nguyen ", "Tu C. Nguyen"],
  merge: { from: "Valerie Nguyen ", to: "Valerie Nguyen" },
  rename: { from: "Tu C. Nguyen ", to: "Tu C. Nguyen" },
  expectedRemove: 55,
};

/* ── Input (as read by the owner script) ─────────────────────────────────── */

export interface AuthorRow {
  id: number;
  name: string;
  rank: number | null;
  userId: number | null;
}

export interface ArticleRow {
  id: number;
  /** Central tenant slug of the article. */
  tenant: string | null;
  authorId: number | null;
  origin: string | null;
  slug: string | null;
  title: string | null;
}

/** A `_articles_v` row with `latest = true`. */
export interface VersionRow {
  id: number;
  articleId: number | null;
  authorId: number | null;
}

export type RelTable = "articles_rels" | "_articles_v_rels";

/** A co-author rel (`authors_id` set). For `_articles_v_rels` only rows of a latest version. */
export interface RelRow {
  table: RelTable;
  id: number;
  /** `parent_id`: the article id (`articles_rels`) or the version id (`_articles_v_rels`). */
  parentId: number;
  /** The article the rel belongs to (for `_articles_v_rels`: the version's `parent_id`). */
  articleId: number | null;
  authorId: number;
}

export interface ReassignInput {
  /** Every author row of the tenant. */
  authors: AuthorRow[];
  /** Every article of the tenant plus any other article whose `author_id` is a tenant author. */
  articles: ArticleRow[];
  /** Latest version rows of tenant articles plus any latest version naming a tenant author. */
  versions: VersionRow[];
  /** Co-author rels naming a tenant author. */
  rels: RelRow[];
}

/* ── Output ──────────────────────────────────────────────────────────────── */

export type ChangeOp = "sync" | "reassign" | "merge";
export type ChangeTable = "articles" | "_articles_v" | RelTable;

/** Re-point one FK cell from author `from` to author `to`. */
export interface Change {
  op: ChangeOp;
  table: ChangeTable;
  rowId: number;
  /** For `_articles_v_rels`: the version id the rel hangs off (its `parent_id`). */
  parentId: number | null;
  articleId: number | null;
  from: number;
  to: number;
  fromName: string;
  toName: string;
}

export interface Rename {
  authorId: number;
  from: string;
  to: string;
}

export interface AuthorRef {
  id: number;
  name: string;
}

export interface RemoveEntry extends AuthorRef {
  importArticles: number;
  otherArticles: number;
  coAuthorRels: number;
  latestVersionRefs: number;
}

export interface PoolCount extends AuthorRef {
  before: number;
  after: number;
}

export interface ReassignResult {
  tenant: string;
  pool: AuthorRef[];
  keep: AuthorRef[];
  mergeFrom: AuthorRef | null;
  mergeTo: AuthorRef | null;
  remove: RemoveEntry[];
  changes: Change[];
  renames: Rename[];
  poolCounts: PoolCount[];
  aborts: string[];
  warnings: string[];
}

/** Plain code-unit comparison: the same order on every machine and locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const show = (name: string) => JSON.stringify(name);

export function buildReassignPlan(input: ReassignInput, rules: ReassignRules): ReassignResult {
  const aborts: string[] = [];
  const warnings: string[] = [];

  const byName = new Map<string, AuthorRow[]>();
  for (const a of input.authors) {
    const list = byName.get(a.name) ?? [];
    list.push(a);
    byName.set(a.name, list);
  }
  const authorName = new Map(input.authors.map((a) => [a.id, a.name]));
  const nameOf = (id: number) => authorName.get(id) ?? `#${id}`;

  /** The single row with this exact name, or null; two rows abort. */
  const one = (name: string, what: string): AuthorRow | null => {
    const hits = byName.get(name) ?? [];
    if (hits.length > 1) aborts.push(`${what} name ${show(name)} matches ${hits.length} authors (#${hits.map((h) => h.id).join(", #")}): ambiguous.`);
    return hits.length === 1 ? (hits[0] as AuthorRow) : null;
  };

  const pool: AuthorRef[] = [];
  for (const name of rules.pool) {
    const a = one(name, "POOL");
    if (a) pool.push({ id: a.id, name: a.name });
    else if (!byName.has(name)) aborts.push(`POOL author ${show(name)} not found in tenant ${rules.tenant}.`);
  }
  const keep: AuthorRef[] = [];
  for (const name of rules.keep) {
    const a = one(name, "KEEP");
    if (a) keep.push({ id: a.id, name: a.name });
  }
  const mergeFromRow = rules.merge ? one(rules.merge.from, "MERGE source") : null;
  const mergeToRow = rules.merge ? one(rules.merge.to, "MERGE target") : null;
  if (rules.merge && mergeFromRow && !mergeToRow) aborts.push(`MERGE target ${show(rules.merge.to)} not found while the source exists.`);
  const mergeFrom = mergeFromRow ? { id: mergeFromRow.id, name: mergeFromRow.name } : null;
  const mergeTo = mergeToRow ? { id: mergeToRow.id, name: mergeToRow.name } : null;
  const merging = mergeFrom !== null && mergeTo !== null && mergeFrom.id !== mergeTo.id;

  const poolIds = new Set(pool.map((p) => p.id));
  const keptIds = new Set<number>([...poolIds, ...keep.map((k) => k.id)]);
  if (mergeTo) keptIds.add(mergeTo.id);
  const removeRows = input.authors.filter((a) => !keptIds.has(a.id) && a.id !== mergeFrom?.id);
  const removeIds = new Set(removeRows.map((a) => a.id));

  for (const a of removeRows) {
    if (a.rank !== null) aborts.push(`REMOVE author #${a.id} ${show(a.name)} has masthead rank ${a.rank}.`);
    if (a.userId !== null) aborts.push(`REMOVE author #${a.id} ${show(a.name)} is linked to CMS user #${a.userId}.`);
    const fold = a.name.trim().toLowerCase();
    const twin = [...keep, ...pool].find((k) => k.name.trim().toLowerCase() === fold);
    if (twin) warnings.push(`REMOVE author #${a.id} ${show(a.name)} looks like kept author #${twin.id} ${show(twin.name)}.`);
  }

  const articleById = new Map(input.articles.map((a) => [a.id, a]));
  const tenantArticles = input.articles.filter((a) => a.tenant === rules.tenant).sort((x, y) => x.id - y.id);

  // ── REMOVE usage counts and the per-author abort on non-import articles ──
  const removeStats = new Map<number, RemoveEntry>(
    removeRows.map((a) => [a.id, { id: a.id, name: a.name, importArticles: 0, otherArticles: 0, coAuthorRels: 0, latestVersionRefs: 0 }]),
  );
  for (const art of input.articles) {
    if (art.authorId === null || !removeIds.has(art.authorId)) continue;
    const s = removeStats.get(art.authorId) as RemoveEntry;
    if (art.tenant !== rules.tenant) {
      warnings.push(`article #${art.id} of tenant ${art.tenant ?? "(none)"} names REMOVE author #${s.id} ${show(s.name)}; left alone, prune will keep that author.`);
      continue;
    }
    if (art.origin === "import") s.importArticles += 1;
    else s.otherArticles += 1;
  }
  for (const s of removeStats.values()) {
    if (s.otherArticles > 0) aborts.push(`REMOVE author #${s.id} ${show(s.name)} has ${s.otherArticles} live engine/manual article(s); only import articles may be reassigned.`);
  }

  // ── Co-author rels ──
  const changes: Change[] = [];
  const mergeRels: RelRow[] = [];
  for (const r of input.rels) {
    if (removeIds.has(r.authorId)) {
      const s = removeStats.get(r.authorId) as RemoveEntry;
      s.coAuthorRels += 1;
      aborts.push(`co-author rel ${r.table} #${r.id} (article #${r.articleId ?? "?"}) names REMOVE author #${s.id} ${show(s.name)}.`);
    } else if (merging && r.authorId === mergeFrom.id) {
      const art = r.articleId === null ? undefined : articleById.get(r.articleId);
      if (r.table === "articles_rels" && art?.tenant !== rules.tenant) {
        warnings.push(`co-author rel articles_rels #${r.id} (article #${r.articleId ?? "?"}, not ${rules.tenant}) names the MERGE source; left alone.`);
        continue;
      }
      mergeRels.push(r);
    }
  }
  for (const r of mergeRels) {
    const sameParent = input.rels.filter((x) => x.table === r.table && x.parentId === r.parentId && x.id !== r.id);
    const dup = sameParent.find((x) => x.authorId === (mergeTo as AuthorRef).id || x.authorId === (mergeFrom as AuthorRef).id);
    if (dup) {
      aborts.push(`merging ${r.table} #${r.id} would list ${show((mergeTo as AuthorRef).name)} twice on parent #${r.parentId} (rel #${dup.id}).`);
      continue;
    }
    changes.push({
      op: "merge", table: r.table, rowId: r.id, parentId: r.table === "_articles_v_rels" ? r.parentId : null, articleId: r.articleId,
      from: (mergeFrom as AuthorRef).id, to: (mergeTo as AuthorRef).id, fromName: (mergeFrom as AuthorRef).name, toName: (mergeTo as AuthorRef).name,
    });
  }

  // ── Reassign (deterministic, balanced) ──
  const liveCount = new Map<number, number>(pool.map((p) => [p.id, 0]));
  for (const art of tenantArticles) if (art.authorId !== null && liveCount.has(art.authorId)) liveCount.set(art.authorId, (liveCount.get(art.authorId) ?? 0) + 1);
  const rotation = [...pool].sort((x, y) => (liveCount.get(x.id) ?? 0) - (liveCount.get(y.id) ?? 0) || cmp(x.name, y.name) || x.id - y.id);
  const newAuthor = new Map<number, AuthorRef>();
  const toReassign = tenantArticles.filter((a) => a.authorId !== null && removeIds.has(a.authorId) && a.origin === "import");
  if (toReassign.length > 0 && rotation.length === 0) aborts.push("no POOL author to reassign to.");
  toReassign.forEach((art, i) => {
    const target = rotation[i % Math.max(rotation.length, 1)];
    if (!target) return;
    newAuthor.set(art.id, target);
    changes.push({
      op: "reassign", table: "articles", rowId: art.id, parentId: null, articleId: art.id,
      from: art.authorId as number, to: target.id, fromName: nameOf(art.authorId as number), toName: target.name,
    });
  });

  // ── Merge on main rows ──
  if (merging) {
    for (const art of tenantArticles) {
      if (art.authorId !== mergeFrom.id) continue;
      changes.push({ op: "merge", table: "articles", rowId: art.id, parentId: null, articleId: art.id, from: mergeFrom.id, to: mergeTo.id, fromName: mergeFrom.name, toName: mergeTo.name });
    }
    for (const art of input.articles) {
      if (art.tenant !== rules.tenant && art.authorId === mergeFrom.id) warnings.push(`article #${art.id} of tenant ${art.tenant ?? "(none)"} names the MERGE source; left alone.`);
    }
  }

  // ── Latest version rows ──
  const tenantAuthorIds = new Set(input.authors.map((a) => a.id));
  for (const v of input.versions) {
    if (v.authorId === null) continue;
    const isRemove = removeIds.has(v.authorId);
    const isMergeSource = merging && v.authorId === mergeFrom.id;
    if (!isRemove && !isMergeSource) continue;
    if (isRemove) (removeStats.get(v.authorId) as RemoveEntry).latestVersionRefs += 1;
    const art = v.articleId === null ? undefined : articleById.get(v.articleId);
    if (!art || art.tenant !== rules.tenant) {
      warnings.push(`latest version #${v.id} (article #${v.articleId ?? "?"}, not ${rules.tenant}) names ${show(nameOf(v.authorId))}; left alone, prune will keep that author.`);
      continue;
    }
    const base = { table: "_articles_v" as const, rowId: v.id, parentId: null, articleId: art.id, from: v.authorId, fromName: nameOf(v.authorId) };
    if (isMergeSource) {
      changes.push({ ...base, op: "merge", to: (mergeTo as AuthorRef).id, toName: (mergeTo as AuthorRef).name });
      continue;
    }
    const reassigned = newAuthor.get(art.id);
    if (reassigned) {
      changes.push({ ...base, op: "reassign", to: reassigned.id, toName: reassigned.name });
      continue;
    }
    if (art.authorId !== null && removeIds.has(art.authorId)) continue; // non-import main row: already an abort above
    let target: number | null = art.authorId;
    if (merging && target === mergeFrom.id) target = mergeTo.id;
    if (target === null || !tenantAuthorIds.has(target)) {
      aborts.push(`latest version #${v.id} of article #${art.id} names REMOVE author ${show(nameOf(v.authorId))} but the article's main row has ${target === null ? "no author" : `author #${target} outside ${rules.tenant}`}: nothing safe to copy.`);
      continue;
    }
    changes.push({ ...base, op: "sync", to: target, toName: nameOf(target) });
  }

  // ── Rename ──
  const renames: Rename[] = [];
  if (rules.rename) {
    const src = one(rules.rename.from, "RENAME source");
    if (src) {
      const twins = byName.get(rules.rename.to) ?? [];
      if (twins.length > 0) aborts.push(`cannot rename #${src.id} ${show(src.name)}: ${show(rules.rename.to)} already exists (#${twins.map((t) => t.id).join(", #")}).`);
      else renames.push({ authorId: src.id, from: src.name, to: rules.rename.to });
    }
  }

  const gained = new Map<number, number>();
  for (const c of changes) if (c.table === "articles" && c.op === "reassign") gained.set(c.to, (gained.get(c.to) ?? 0) + 1);
  const poolCounts = rotation.map((p) => ({ ...p, before: liveCount.get(p.id) ?? 0, after: (liveCount.get(p.id) ?? 0) + (gained.get(p.id) ?? 0) }));

  const order: Record<ChangeTable, number> = { articles: 0, _articles_v: 1, articles_rels: 2, _articles_v_rels: 3 };
  changes.sort((x, y) => order[x.table] - order[y.table] || x.rowId - y.rowId);
  const remove = [...removeStats.values()].sort((x, y) => cmp(x.name, y.name) || x.id - y.id);

  return { tenant: rules.tenant, pool, keep, mergeFrom, mergeTo, remove, changes, renames, poolCounts, aborts, warnings };
}

/** Row counts per operation, for the console. */
export function countByOp(changes: Change[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) {
    const k = `${c.op} ${c.table}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/* ── Plan file (dry run writes it, --apply reads it) ─────────────────────── */

export interface ReassignAuthorsPlan {
  kind: typeof PLAN_KIND;
  version: typeof PLAN_VERSION;
  createdAt: string;
  database: string;
  tenant: string;
  /** For the reviewer only; apply re-derives the sets. */
  remove: AuthorRef[];
  changes: Change[];
  renames: Rename[];
}

const CHANGE_OPS: readonly string[] = ["sync", "reassign", "merge"];
const CHANGE_TABLES: readonly string[] = ["articles", "_articles_v", "articles_rels", "_articles_v_rels"];
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function parsePlan(text: string): ReassignAuthorsPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("plan file is not valid JSON");
  }
  const p = raw as Partial<ReassignAuthorsPlan> | null;
  if (!p || p.kind !== PLAN_KIND || p.version !== PLAN_VERSION) throw new Error(`not a ${PLAN_KIND} v${PLAN_VERSION} file`);
  if (typeof p.database !== "string" || p.database === "") throw new Error("plan has no database");
  if (typeof p.tenant !== "string" || p.tenant === "") throw new Error("plan has no tenant");
  if (!Array.isArray(p.changes) || !Array.isArray(p.renames)) throw new Error("plan has no changes / renames array");
  const seen = new Set<string>();
  for (const c of p.changes) {
    if (!c || !CHANGE_OPS.includes(c.op) || !CHANGE_TABLES.includes(c.table)) throw new Error("plan has a change with a bad op or table");
    if (!posInt(c.rowId) || !posInt(c.from) || !posInt(c.to)) throw new Error(`plan change ${c.table} #${String(c.rowId)} has a bad id`);
    if (c.parentId !== null && !posInt(c.parentId)) throw new Error(`plan change ${c.table} #${c.rowId} has a bad parentId`);
    if (c.articleId !== null && !posInt(c.articleId)) throw new Error(`plan change ${c.table} #${c.rowId} has a bad articleId`);
    if (c.from === c.to) throw new Error(`plan change ${c.table} #${c.rowId} does not change anything`);
    const key = `${c.table}:${c.rowId}`;
    if (seen.has(key)) throw new Error(`plan lists ${c.table} #${c.rowId} twice`);
    seen.add(key);
  }
  for (const r of p.renames) {
    if (!r || !posInt(r.authorId) || typeof r.from !== "string" || typeof r.to !== "string" || r.to.trim() === "" || r.from === r.to) {
      throw new Error("plan has a bad rename");
    }
  }
  return p as ReassignAuthorsPlan;
}

export interface Skipped {
  what: string;
  why: string;
}

/**
 * What `--apply` may write: plan entries that the CURRENT state (re-derived with
 * `buildReassignPlan`) still asks for, with the same op and the same old value.
 * A reassign whose balanced target shifted keeps the reviewed target as long as
 * it is still a pool author; a reassigned version row is written only together
 * with (or after) its article's main row. Anything else is skipped and reported.
 * `newSinceDryRun` counts changes the current state needs that the plan lacks:
 * they are NOT written (run a new dry run).
 */
export function reconcilePlan(
  plan: ReassignAuthorsPlan,
  current: ReassignResult,
): { changes: Change[]; renames: Rename[]; skipped: Skipped[]; newSinceDryRun: number } {
  const key = (c: { table: string; rowId: number }) => `${c.table}:${c.rowId}`;
  const now = new Map(current.changes.map((c) => [key(c), c]));
  const poolIds = new Set(current.pool.map((p) => p.id));
  const skipped: Skipped[] = [];
  const ok: Change[] = [];
  for (const c of plan.changes) {
    const what = `${c.op} ${c.table} #${c.rowId}`;
    const d = now.get(key(c));
    if (!d) skipped.push({ what, why: "no longer needed, or the row changed or is gone" });
    else if (d.op !== c.op || d.from !== c.from) skipped.push({ what, why: `now ${d.op} from #${d.from}` });
    else if (d.to === c.to || (c.op === "reassign" && poolIds.has(c.to))) ok.push(c);
    else skipped.push({ what, why: `target is now #${d.to} ${d.toName}` });
  }
  // A reassigned version row must end on the same author as its article.
  const articleTarget = new Map<number, number>();
  for (const c of ok) if (c.table === "articles") articleTarget.set(c.rowId, c.to);
  const changes = ok.filter((c) => {
    if (c.table !== "_articles_v" || c.op !== "reassign" || c.articleId === null) return true;
    if (articleTarget.get(c.articleId) === c.to) return true;
    skipped.push({ what: `${c.op} ${c.table} #${c.rowId}`, why: `article #${c.articleId} main row is not written to the same author` });
    return false;
  });
  const renames: Rename[] = [];
  for (const r of plan.renames) {
    const cur = current.renames.find((x) => x.authorId === r.authorId);
    if (cur && cur.from === r.from && cur.to === r.to) renames.push(r);
    else skipped.push({ what: `rename author #${r.authorId}`, why: "author renamed, gone, or a twin now exists" });
  }
  const planned = new Set(plan.changes.map(key));
  const newSinceDryRun =
    current.changes.filter((c) => !planned.has(key(c))).length +
    current.renames.filter((r) => !plan.renames.some((x) => x.authorId === r.authorId)).length;
  return { changes, renames, skipped, newSinceDryRun };
}

/* ── CSV report ──────────────────────────────────────────────────────────── */

const CSV_HEAD = ["article_id", "slug", "title", "old_author", "new_author", "operation", "table", "row_id"];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(result: Pick<ReassignResult, "changes" | "renames">, articles: ArticleRow[]): string {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const lines = [CSV_HEAD.join(",")];
  for (const c of result.changes) {
    const a = c.articleId === null ? undefined : byId.get(c.articleId);
    lines.push([c.articleId, a?.slug, a?.title, c.fromName, c.toName, c.op, c.table, c.rowId].map(cell).join(","));
  }
  for (const r of result.renames) lines.push(["", "", "", r.from, r.to, "rename", "authors", r.authorId].map(cell).join(","));
  return `${lines.join("\n")}\n`;
}
