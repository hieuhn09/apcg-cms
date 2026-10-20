/**
 * Redirect map builder for `vowasia-web` (Amendment 4 §4.2.7, B-9a). Pure.
 *
 * Owner rules only (C3, Q1, Q9; no orchestrator default):
 *  - old published, live published in Central       -> `/<pillar>/<slug>`  (308 by the vowasia-web middleware)
 *  - old archived                                    -> `/<pillar>`
 *  - old published / archived, draft for NO COVER    -> `/<pillar>`
 *  - old draft / scheduled                           -> NO entry (report only), even without a cover
 *  - old rejected                                    -> `{"status":410}`
 *  - old published, draft because a STORED image failed (C6) -> STOP and list (O-B12, open owner item)
 *  - rejected by the importer (shape, slug, C8)      -> NO entry + report line
 *  - not in Central / a Central status no rule covers -> NO entry + report line
 * Keys: the old path `/article/<slug>` through the read-only GTP `normaliseKey`
 * (pinned). Coverage (CF1): published source rows WITH an entry / published
 * source rows; it can never exceed 1. The map is regenerated after an editor
 * publishes a non-public row, and then points straight at the article.
 */
import { normaliseKey } from "../../lib/normalise-path";

export type MapValue = string | { status: 410 };

export interface RedirectSource {
  legacyId: string;
  slug: string;
  oldStatus: string;
  plan: { kind: "import"; pillar: string; draftReasons: readonly ("noCover" | "storeFailure")[] } | { kind: "skip" } | { kind: "reject"; reason: string };
}

export interface RedirectBuild {
  map: Record<string, MapValue>;
  noEntry: { legacyId: string; slug: string; reason: string }[];
  stops: { legacyId: string; slug: string; reason: "O-B12" }[];
  counts: { publishedToArticle: number; archivedToPillar: number; noCoverToPillar: number; gone410: number; total: number };
  coverage: { published: number; publishedWithEntry: number; ratio: number };
  errors: string[];
}

/** `centralStatus`: live `workflowStatus` of the tenant-vowasia MARKER article per slug. */
export function buildVowasiaRedirects(sources: readonly RedirectSource[], centralStatus: ReadonlyMap<string, string>): RedirectBuild {
  const b: RedirectBuild = { map: {}, noEntry: [], stops: [], counts: { publishedToArticle: 0, archivedToPillar: 0, noCoverToPillar: 0, gone410: 0, total: 0 }, coverage: { published: 0, publishedWithEntry: 0, ratio: 1 }, errors: [] };
  const entries = new Map<string, MapValue>();
  const owner = new Map<string, string>();
  const put = (s: RedirectSource, v: MapValue): boolean => {
    const key = normaliseKey(`/article/${s.slug}`);
    if (!key || key === "/article") {
      b.errors.push(`old path of ${s.legacyId} does not normalise to a key`);
      return false;
    }
    const prev = owner.get(key);
    if (prev !== undefined) {
      b.errors.push(`two source rows map the same old path ${key} (${prev}, ${s.legacyId})`);
      return false;
    }
    owner.set(key, s.legacyId);
    entries.set(key, v);
    return true;
  };
  const none = (s: RedirectSource, reason: string) => b.noEntry.push({ legacyId: s.legacyId, slug: s.slug, reason });
  for (const s of sources) {
    const published = s.oldStatus === "published";
    if (published) b.coverage.published++;
    let entered = false;
    if (s.plan.kind === "skip") {
      if (s.oldStatus === "rejected" && put(s, { status: 410 })) b.counts.gone410++;
      else if (s.oldStatus !== "rejected") none(s, "skipped");
      continue;
    }
    if (s.plan.kind === "reject") {
      none(s, `importerRejected:${s.plan.reason}`);
      continue;
    }
    if (s.oldStatus === "draft" || s.oldStatus === "scheduled") {
      none(s, "oldDraftOrScheduled");
      continue;
    }
    const live = centralStatus.get(s.slug);
    const pillar = s.plan.pillar;
    if (live === undefined) none(s, "notInCentral");
    else if (s.oldStatus === "archived") {
      entered = put(s, `/${pillar}`);
      if (entered) {
        if (live === "draft" && s.plan.draftReasons.includes("noCover")) b.counts.noCoverToPillar++;
        else b.counts.archivedToPillar++;
      }
    } else if (published && live === "published") {
      entered = put(s, `/${pillar}/${s.slug}`);
      if (entered) b.counts.publishedToArticle++;
    } else if (published && live === "draft" && s.plan.draftReasons.includes("noCover")) {
      entered = put(s, `/${pillar}`);
      if (entered) b.counts.noCoverToPillar++;
    } else if (published && live === "draft" && s.plan.draftReasons.includes("storeFailure")) {
      b.stops.push({ legacyId: s.legacyId, slug: s.slug, reason: "O-B12" });
    } else none(s, `centralStatusNotCovered:${s.oldStatus}->${live}`);
    if (published && entered) b.coverage.publishedWithEntry++;
  }
  b.map = Object.fromEntries([...entries.entries()].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)));
  b.counts.total = entries.size;
  b.coverage.ratio = b.coverage.published ? b.coverage.publishedWithEntry / b.coverage.published : 1;
  return b;
}
