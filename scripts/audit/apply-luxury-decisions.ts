/**
 * BriefAsia `lifestyle/luxury` backlog re-classification — apply reviewed decisions.
 *
 * The content-engine shipped rewritten taxonomy descriptions so NEW articles
 * classify correctly, but its intake is idempotent by design and never
 * overwrites an existing CMS article. Everything already published under
 * `lifestyle/luxury` therefore stays mis-filed until something reaches into
 * Central CMS and moves it. That is this script.
 *
 * Input is the decision JSON emitted by the sibling script in the content-engine
 * repo (see `--in`). Its `category` / `subPillar` values are SLUGS, not ids and
 * not labels; they are resolved here against the BriefAsia tenant's own
 * `pillars` / `subsections` rows.
 *
 * Actions:
 *   keep — no-op, counted only.
 *   move — set `pillar` + `subSection` together in ONE update. Articles.subSection
 *          carries a hard `validate` (src/collections/Articles.ts, Taxonomy tab)
 *          rejecting any sub-section that does not belong to the article's pillar,
 *          so a split write would either fail or leave a stale sub-section that
 *          mislabels the article site-wide. When the proposed sub-section is
 *          absent, unresolvable, or owned by a different pillar, `subSection` is
 *          explicitly nulled rather than left behind.
 *   hide — set `workflowStatus: "hidden"` (a first-class member of
 *          ARTICLE_STATUSES, src/lib/constants.ts) AND `_status: "draft"`.
 *          `workflowStatus` is the field the public read API actually filters on
 *          (src/app/api/public/articles/route.ts: the only status clause is
 *          `{ workflowStatus: { equals: "published" } }`), so it is what removes
 *          the article from every live feed. `_status: "draft"` is set in the
 *          same update so Payload's own Publish/Draft indicator in the admin
 *          agrees with the editorial state instead of showing a published-looking
 *          row that readers cannot see. Nothing is deleted — fully reversible by
 *          restoring the `workflowStatus` / `_status` pair recorded in the undo
 *          trail written next to the input file.
 *
 * DRY-RUN by default. Nothing is written without `--apply`.
 *
 *   npm run audit:apply-luxury -- --in path/to/decisions.json
 *   npm run audit:apply-luxury -- --in path/to/decisions.json --only move --apply
 *   tsx scripts/audit/apply-luxury-decisions.ts --in d.json --min-confidence high --limit 20
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import { pFind, pUpdate } from "../lib/payload-loose";

// `@payload-config` throws at module scope when DATABASE_URL is unset, which
// would pre-empt the CLI guards below and hand the user a credentials error
// instead of "--in is required". Imported lazily inside main() so argument
// validation and the dry-run banner always come first.

type Action = "keep" | "move" | "hide";
type Confidence = "low" | "medium" | "high";

/**
 * `--min-confidence` keeps rows whose confidence ranks at or above the floor.
 * What each floor admits, in the sibling content-engine script's vocabulary:
 *   high   — safe re-ranks only: `keep`, plus a `move` whose proposed primary
 *            category was ALREADY one of the article's existing `sections`
 *            (re-ordering buckets the old classifier had also chosen).
 *   medium — the above, plus a `move` to a genuinely NEW pillar.
 *   low    — everything, including `hide` rows.
 */
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Tenant slugs to try, in order. The decision JSON's `publication` field is the
 *  content-engine registry id ("briefasia"); the CMS tenant slug is "brief-asia"
 *  (scripts/seed.ts TENANTS, src/collections/Tenants.ts slug description). */
const TENANT_SLUG_CANDIDATES = ["brief-asia", "briefasia"] as const;

interface DecisionProposed {
  action?: string;
  category?: string | null;
  subPillar?: string | null;
  sections?: string[] | null;
}

interface DecisionCurrent {
  category?: string | null;
  subPillar?: string | null;
  sections?: string[] | null;
}

interface Decision {
  engineArticleId?: string;
  sourceUrl?: string | null;
  slug?: string | null;
  title?: string | null;
  status?: string | null;
  current?: DecisionCurrent;
  proposed?: DecisionProposed;
  confidence?: string;
  reason?: string;
}

interface DecisionFile {
  generatedAt?: string;
  publication?: string;
  model?: string;
  scope?: Record<string, unknown>;
  counts?: Record<string, number>;
  decisions?: Decision[];
}

interface StatusPair {
  pillar: string | number | null;
  subSection: string | number | null;
  status: string | null;
  workflowStatus: string | null;
}

type Outcome = "applied" | "skipped" | "not-found" | "ambiguous" | "no-op" | "would-apply" | "failed";

interface ResultRow {
  engineArticleId: string;
  slug: string;
  title: string;
  action: Action | string;
  matchedBy: "engineSourceUrl" | "slug" | null;
  articleId: string | number | null;
  /** `status` is Payload's version `_status`; `workflowStatus` is the editorial
   *  status the public read API filters on. BOTH are recorded before and after
   *  so a mis-hide can be reversed exactly from this log. */
  before: StatusPair;
  after: StatusPair | null;
  outcome: Outcome;
  reason: string;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const APPLY = process.argv.includes("--apply");
const IN_PATH = argValue("--in");
const ONLY = argValue("--only");
const MIN_CONFIDENCE = argValue("--min-confidence");
const LIMIT_RAW = argValue("--limit");

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error(
    "Usage:\n" +
      "  tsx scripts/audit/apply-luxury-decisions.ts --in <decisions.json> [--apply]\n" +
      "        [--only move|hide|keep] [--min-confidence low|medium|high] [--limit <n>]\n" +
      "\n" +
      "  --min-confidence keeps rows at or above the given floor:\n" +
      "    high   — safe re-ranks only (proposed category was already one of the\n" +
      "             article's existing sections)\n" +
      "    medium — also accepts moves to a genuinely new pillar\n" +
      "    low    — also accepts hide rows\n",
  );
  process.exit(1);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Relationship fields come back as an id or an expanded doc; normalise to id. */
function relId(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
    const id = (v as { id?: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return id;
  }
  return null;
}

function sameId(a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b);
}

function pad(v: unknown, n: number): string {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

interface ArticleRow {
  id: string | number;
  slug?: string | null;
  title?: string | null;
  pillar?: unknown;
  subSection?: unknown;
  _status?: string | null;
  workflowStatus?: string | null;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main() {
  if (!IN_PATH) usage("Refusing to run: --in <path-to-decision-json> is required.");
  const inPath = path.resolve(process.cwd(), IN_PATH);
  if (!fs.existsSync(inPath)) usage(`Decision file not found: ${inPath}`);

  if (ONLY !== null && !["keep", "move", "hide"].includes(ONLY)) {
    usage(`--only must be one of keep|move|hide (got: ${ONLY})`);
  }
  if (MIN_CONFIDENCE !== null && !["low", "medium", "high"].includes(MIN_CONFIDENCE)) {
    usage(`--min-confidence must be one of low|medium|high (got: ${MIN_CONFIDENCE})`);
  }
  const LIMIT = LIMIT_RAW === null ? Infinity : Number(LIMIT_RAW);
  if (!Number.isFinite(LIMIT) && LIMIT_RAW !== null) usage(`--limit must be a number (got: ${LIMIT_RAW})`);
  if (LIMIT_RAW !== null && (!Number.isInteger(LIMIT) || LIMIT <= 0)) {
    usage(`--limit must be a positive integer (got: ${LIMIT_RAW})`);
  }

  const parsed = JSON.parse(fs.readFileSync(inPath, "utf8")) as DecisionFile;
  const allDecisions = Array.isArray(parsed.decisions) ? parsed.decisions : null;
  if (!allDecisions) usage("Decision file has no `decisions` array — wrong file?");

  // Filter to the working set BEFORE any DB work, so the banner count is honest.
  const minRank = MIN_CONFIDENCE ? CONFIDENCE_RANK[MIN_CONFIDENCE as Confidence] : -1;
  const selected = allDecisions
    .filter((d) => (ONLY === null ? true : (d.proposed?.action ?? "") === ONLY))
    .filter((d) => {
      if (minRank < 0) return true;
      const c = (d.confidence ?? "") as Confidence;
      const rank = CONFIDENCE_RANK[c];
      return rank !== undefined && rank >= minRank;
    })
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  const writeActions = selected.filter((d) => {
    const a = d.proposed?.action;
    return a === "move" || a === "hide";
  });

  /* ── Banner ───────────────────────────────────────────────────────────── */
  console.log("");
  console.log("═".repeat(78));
  console.log(APPLY ? "  APPLYING — this run WRITES to the database" : "  DRY RUN — no writes; pass --apply to write");
  console.log("═".repeat(78));
  console.log(`  input           : ${inPath}`);
  console.log(`  publication     : ${parsed.publication ?? "(unset)"}`);
  console.log(`  generatedAt     : ${parsed.generatedAt ?? "(unset)"}`);
  console.log(`  decisions in file: ${allDecisions.length}`);
  console.log(`  filters         : only=${ONLY ?? "(all)"} min-confidence=${MIN_CONFIDENCE ?? "(none)"} limit=${LIMIT_RAW ?? "(none)"}`);
  console.log(`  in scope        : ${selected.length}  (of which write-actions: ${writeActions.length})`);
  console.log("═".repeat(78));

  if (selected.length === 0) {
    // A filter that quietly empties the batch is the failure mode this guards
    // against — name the filter that did it instead of reporting "nothing to do".
    const filterNotes: string[] = [];
    if (ONLY !== null) filterNotes.push(`--only=${ONLY}`);
    if (MIN_CONFIDENCE !== null) filterNotes.push(`--min-confidence=${MIN_CONFIDENCE}`);
    if (LIMIT_RAW !== null) filterNotes.push(`--limit=${LIMIT_RAW}`);
    console.log(
      filterNotes.length > 0
        ? `\n${allDecisions.length} decisions in file, 0 after ${filterNotes.join(" ")}. Nothing in scope. Exiting.\n`
        : "\nNothing in scope. Exiting.\n",
    );
    process.exit(0);
  }

  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: await payloadConfig });

  /* ── Tenant ───────────────────────────────────────────────────────────── */
  let tenantId: string | number | null = null;
  let tenantSlug = "";
  for (const candidate of TENANT_SLUG_CANDIDATES) {
    const res = (await pFind(payload, "tenants", {
      where: { slug: { equals: candidate } },
      limit: 1,
    })) as { docs: Array<{ id: string | number; slug?: string }> };
    const doc = res.docs[0];
    if (doc) {
      tenantId = doc.id;
      tenantSlug = doc.slug ?? candidate;
      break;
    }
  }
  if (tenantId === null) {
    const all = (await pFind(payload, "tenants", { limit: 100 })) as { docs: Array<{ slug?: string }> };
    throw new Error(
      `BriefAsia tenant not found (tried: ${TENANT_SLUG_CANDIDATES.join(", ")}). ` +
        `Tenants in this database: ${all.docs.map((t) => t.slug).join(", ")}`,
    );
  }
  console.log(`\ntenant: ${tenantSlug} (id ${tenantId})`);

  /* ── Taxonomy maps (tenant-scoped) ────────────────────────────────────── */
  const pillarsRes = (await pFind(payload, "pillars", {
    where: { tenant: { equals: tenantId } },
    limit: 500,
  })) as { docs: Array<{ id: string | number; slug?: string }> };
  const pillarIdBySlug = new Map<string, string | number>();
  for (const p of pillarsRes.docs) if (p.slug) pillarIdBySlug.set(p.slug, p.id);

  const subsRes = (await pFind(payload, "subsections", {
    where: { tenant: { equals: tenantId } },
    limit: 1000,
  })) as { docs: Array<{ id: string | number; slug?: string; pillar?: unknown }> };
  /** Sub-section slugs are unique per pillar, not per tenant — key on both. */
  const subIdByPillarAndSlug = new Map<string, string | number>();
  for (const s of subsRes.docs) {
    const owner = relId(s.pillar);
    if (s.slug && owner != null) subIdByPillarAndSlug.set(`${String(owner)}::${s.slug}`, s.id);
  }
  console.log(`taxonomy: ${pillarIdBySlug.size} pillars, ${subIdByPillarAndSlug.size} sub-sections\n`);

  /* ── Per-decision pass ────────────────────────────────────────────────── */
  const rows: ResultRow[] = [];

  const record = (d: Decision, partial: Partial<ResultRow>): ResultRow => {
    const row: ResultRow = {
      engineArticleId: d.engineArticleId ?? "",
      slug: d.slug ?? "",
      title: d.title ?? "",
      action: d.proposed?.action ?? "(none)",
      matchedBy: null,
      articleId: null,
      before: { pillar: null, subSection: null, status: null, workflowStatus: null },
      after: null,
      outcome: "skipped",
      reason: "",
      ...partial,
    };
    rows.push(row);
    return row;
  };

  try {
    for (const d of selected) {
      const action = d.proposed?.action;

      if (action === "keep") {
        record(d, { outcome: "no-op", reason: "keep" });
        continue;
      }
      if (action !== "move" && action !== "hide") {
        record(d, { outcome: "skipped", reason: `unsupported action: ${String(action)}` });
        continue;
      }

      /* Match — engineSourceUrl first (indexed), slug as fallback. Always
         tenant-scoped. 0 or >1 matches must never write.
         `draft: true` so `_status` reflects the NEWEST version rather than the
         published one; without it an already-unpublished article reads back as
         published and the `hide` idempotency check below would rewrite it on
         every run. */
      let matches: ArticleRow[] = [];
      let matchedBy: "engineSourceUrl" | "slug" | null = null;

      if (d.sourceUrl) {
        const res = (await pFind(payload, "articles", {
          where: { and: [{ tenant: { equals: tenantId } }, { engineSourceUrl: { equals: d.sourceUrl } }] },
          limit: 10,
          draft: true,
        })) as { docs: ArticleRow[] };
        if (res.docs.length > 0) {
          matches = res.docs;
          matchedBy = "engineSourceUrl";
        }
      }
      if (matches.length === 0 && d.slug) {
        const res = (await pFind(payload, "articles", {
          where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: d.slug } }] },
          limit: 10,
          draft: true,
        })) as { docs: ArticleRow[] };
        matches = res.docs;
        matchedBy = res.docs.length > 0 ? "slug" : null;
      }

      if (matches.length === 0) {
        record(d, { outcome: "not-found", reason: "no article matched sourceUrl or slug in this tenant" });
        continue;
      }
      if (matches.length > 1) {
        record(d, {
          outcome: "ambiguous",
          matchedBy,
          reason: `${matches.length} articles matched by ${matchedBy} — never guess between candidates`,
        });
        continue;
      }

      const article = matches[0]!;
      const before = {
        pillar: relId(article.pillar),
        subSection: relId(article.subSection),
        status: article._status ?? null,
        workflowStatus: article.workflowStatus ?? null,
      };

      let data: Record<string, unknown>;
      let after: ResultRow["after"];
      let note = "";

      if (action === "hide") {
        // Idempotency is keyed on BOTH fields — an article already hidden and
        // already unpublished is a no-op; one of the two still out of place is
        // a real (partial) write, not a rewrite.
        if (before.workflowStatus === "hidden" && before.status === "draft") {
          record(d, {
            outcome: "no-op",
            matchedBy,
            articleId: article.id,
            before,
            reason: "already hidden + draft",
          });
          continue;
        }
        data = { workflowStatus: "hidden", _status: "draft" };
        after = {
          pillar: before.pillar,
          subSection: before.subSection,
          status: "draft",
          workflowStatus: "hidden",
        };
      } else {
        const categorySlug = d.proposed?.category ?? null;
        if (!categorySlug) {
          record(d, { outcome: "skipped", matchedBy, articleId: article.id, before, reason: "move without proposed.category" });
          continue;
        }
        const newPillarId = pillarIdBySlug.get(categorySlug);
        if (newPillarId === undefined) {
          record(d, {
            outcome: "skipped",
            matchedBy,
            articleId: article.id,
            before,
            reason: `pillar slug not found in tenant: ${categorySlug}`,
          });
          continue;
        }

        /* Resolve the sub-section WITHIN the new pillar. Anything that does not
           resolve there becomes an explicit null — never a stale carry-over. */
        const subSlug = d.proposed?.subPillar ?? null;
        let newSubId: string | number | null = null;
        if (subSlug) {
          const found = subIdByPillarAndSlug.get(`${String(newPillarId)}::${subSlug}`);
          if (found === undefined) {
            note = `sub-section "${subSlug}" does not belong to pillar "${categorySlug}" — subSection cleared`;
          } else {
            newSubId = found;
          }
        } else {
          note = "no proposed sub-section — subSection cleared";
        }

        if (sameId(before.pillar, newPillarId) && sameId(before.subSection, newSubId)) {
          record(d, {
            outcome: "no-op",
            matchedBy,
            articleId: article.id,
            before,
            reason: "already at target pillar/sub-section",
          });
          continue;
        }

        /* Secondary sections are NOT written by this script — only the primary
           pillar/subSection pair is. A decision carrying extra sections is still
           applied (its primary move is real); the unapplied remainder is reported
           on the row so the operator can see exactly what was left behind. */
        const proposedSections = d.proposed?.sections ?? null;
        if (Array.isArray(proposedSections) && proposedSections.length > 1) {
          const secondary = proposedSections.filter((s) => s !== categorySlug);
          if (secondary.length > 0) {
            const sectionsNote = `secondary sections not applied (unsupported): ${JSON.stringify(secondary)}`;
            note = note ? `${note}; ${sectionsNote}` : sectionsNote;
          }
        }

        // pillar + subSection ALWAYS travel together — Articles.subSection's
        // validate rejects a sub-section owned by a different pillar.
        data = { pillar: newPillarId, subSection: newSubId };
        after = {
          pillar: newPillarId,
          subSection: newSubId,
          status: before.status,
          workflowStatus: before.workflowStatus,
        };
      }

      const row = record(d, {
        outcome: APPLY ? "applied" : "would-apply",
        matchedBy,
        articleId: article.id,
        before,
        after,
        reason: note || action,
      });

      if (APPLY) {
        try {
          await pUpdate(payload, "articles", article.id, data);
        } catch (e) {
          row.outcome = "failed";
          const detail = e instanceof Error ? e.message : String(e);
          row.reason = note ? `${note}; update failed: ${detail}` : `update failed: ${detail}`;
        }
      }
    }
  } finally {
    /* ── Table ──────────────────────────────────────────────────────────── */
    console.log(
      `${pad("slug", 34)} ${pad("current", 26)} ${pad("-> proposed", 26)} ${pad("action", 7)} ${pad("result", 12)} reason`,
    );
    console.log("-".repeat(140));
    /** "pillar/sub (wf:_status)" — both statuses, since `hide` moves both. */
    const cell = (s: StatusPair): string => {
      const statuses = [s.workflowStatus, s.status].filter(Boolean).join(":");
      return `${s.pillar ?? "-"}/${s.subSection ?? "-"}${statuses ? ` (${statuses})` : ""}`;
    };
    for (const r of rows) {
      const cur = cell(r.before);
      const next = r.after ? cell(r.after) : "-";
      console.log(
        `${pad(r.slug, 34)} ${pad(cur, 26)} ${pad(next, 26)} ${pad(r.action, 7)} ${pad(r.outcome, 12)} ${r.reason}`,
      );
    }

    /* ── Summary ────────────────────────────────────────────────────────── */
    const tally = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
    console.log("\nsummary");
    console.log(`  applied / would-apply : ${tally("applied")} / ${tally("would-apply")}`);
    console.log(`  no-op (idempotent)    : ${tally("no-op")}`);
    console.log(`  skipped               : ${tally("skipped")}`);
    console.log(`  not-found             : ${tally("not-found")}`);
    console.log(`  ambiguous             : ${tally("ambiguous")}`);
    console.log(`  failed                : ${tally("failed")}`);

    /* ── Undo trail ─────────────────────────────────────────────────────── */
    if (APPLY) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = `${inPath}.applied-${stamp}.json`;
      fs.writeFileSync(
        logPath,
        `${JSON.stringify(
          {
            appliedAt: new Date().toISOString(),
            input: inPath,
            tenant: { slug: tenantSlug, id: tenantId },
            filters: { only: ONLY, minConfidence: MIN_CONFIDENCE, limit: LIMIT_RAW },
            summary: {
              applied: tally("applied"),
              noOp: tally("no-op"),
              skipped: tally("skipped"),
              notFound: tally("not-found"),
              ambiguous: tally("ambiguous"),
              failed: tally("failed"),
            },
            rows,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\nundo trail written: ${logPath}`);
    } else {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
