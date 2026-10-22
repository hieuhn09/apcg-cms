/**
 * The deterministic WHOLE-SET plan of the VowAsia import (Amendment 4 §4.3 step 2),
 * shared by import (dry-run and apply), redirects, rewrite-links and verify. Pure:
 * input = the verified snapshot, the local image store and the existing
 * tenant-vowasia articles (slug + marker); no Central write, no network.
 *
 * Per row: status (C2 + no-cover), taxonomy (C8), tag (C4/Q10), slug (kept;
 * `page`/clash/unsafe/duplicate rejected), body (§4.2.2), images (store check;
 * a store-level failure makes the article draft and drops a body section), links
 * (§4.2.3). Bylines are planned over ALL importable rows (also rows created by
 * earlier runs), so two runs agree. The plan order (created_at, id) drives `--limit`.
 */
import { assignAuthors, orderKey } from "./vowasia-author-distribution";
import { planBody, type BodyLink, type BodySection } from "./vowasia-body";
import type { MediaStore, StoreFailureReason } from "./vowasia-media";
import { buildVowasiaRedirects, type RedirectBuild, type RedirectSource } from "./vowasia-redirects";
import { planSlugs, type ExistingArticle } from "./vowasia-slug-plan";
import { dateFallbackCounts, rowFromSnapshot, transformRow, type CentralStatus, type DraftReason, type ImportPlanRow, type LegacyArticle } from "./vowasia-transform";
import type { SnapshotInput } from "./snapshot-vowasia-main";

export const STORE_FAILURE_LIMIT = 0.02;

export interface PlannedArticle extends ImportPlanRow {
  finalStatus: CentralStatus;
  finalDraftReasons: DraftReason[];
  sections: BodySection[];
  /** Body image URLs whose store check failed (their sections are dropped). */
  failedBodyUrls: string[];
  coverOk: boolean;
  links: BodyLink[];
  htmlLike: boolean;
  author: string;
}

export interface PlanReject {
  legacyId: string;
  slug: string;
  oldStatus: unknown;
  reason: string;
}

export interface FullPlan {
  rows: LegacyArticle[];
  importable: PlannedArticle[];
  toCreate: PlannedArticle[];
  existing: { legacyId: string; slug: string; articleId: number | string }[];
  rejects: PlanReject[];
  skipped: { legacyId: string; slug: string }[];
  /** Every planned (non-rejected) row by legacy id, in plan order. */
  byLegacyId: Map<string, PlannedArticle>;
  sourcesByLegacyId: Map<string, RedirectSource>;
  storeFailures: { legacyId: string; url: string; reason: StoreFailureReason; role: "cover" | "body" }[];
  imageRefs: number;
  imageHosts: string[];
  dateFallbacks: { all: number; imported: number };
}

export function snapshotArticles(input: SnapshotInput): LegacyArticle[] {
  const idCol = input.meta.articleColumns[0] as string;
  return input.articles.map((r) => rowFromSnapshot(r, input.meta.columnRoles, idCol));
}

export function buildPlan(input: SnapshotInput, store: MediaStore, existingArticles: readonly ExistingArticle[]): FullPlan {
  const rows = snapshotArticles(input);
  const imageHosts = store.hosts();
  const rejects: PlanReject[] = [];
  const skipped: { legacyId: string; slug: string }[] = [];
  const candidates: { row: ImportPlanRow; sections: BodySection[]; links: BodyLink[]; htmlLike: boolean }[] = [];
  const sourcesByLegacyId = new Map<string, RedirectSource>();
  for (const r of rows) {
    const t = transformRow(r);
    const oldStatus = typeof r.status === "string" ? r.status : String(r.status);
    if (t.kind === "skip") {
      skipped.push({ legacyId: t.legacyId, slug: t.slug });
      sourcesByLegacyId.set(t.legacyId, { legacyId: t.legacyId, slug: t.slug, oldStatus, plan: { kind: "skip" } });
      continue;
    }
    const rej = (reason: string) => {
      rejects.push({ legacyId: r.legacyId, slug: t.slug, oldStatus: r.status, reason });
      sourcesByLegacyId.set(r.legacyId, { legacyId: r.legacyId, slug: t.slug, oldStatus, plan: { kind: "reject", reason } });
    };
    if (t.kind === "reject") {
      rej(t.reason);
      continue;
    }
    const b = planBody(t.body, t.title, imageHosts);
    if (!b.ok) {
      rej(b.reason);
      continue;
    }
    if (b.oldHostInText) {
      rej("oldImageHostInBodyText");
      continue;
    }
    candidates.push({ row: t, sections: b.sections, links: b.links, htmlLike: b.htmlLike });
  }
  const sp = planSlugs(candidates.map((c) => ({ legacyId: c.row.legacyId, slug: c.row.slug, createdAt: c.row.createdAt })), existingArticles);
  for (const x of sp.rejects) {
    const c = candidates.find((y) => y.row.legacyId === x.legacyId);
    rejects.push({ legacyId: x.legacyId, slug: x.slug, oldStatus: c?.row.oldStatus, reason: x.reason });
    sourcesByLegacyId.set(x.legacyId, { legacyId: x.legacyId, slug: x.slug, oldStatus: c?.row.oldStatus ?? "", plan: { kind: "reject", reason: x.reason } });
  }
  const keep = new Set([...sp.plan.map((p) => p.legacyId), ...sp.existing.map((e) => e.legacyId)]);
  const kept = candidates.filter((c) => keep.has(c.row.legacyId)).sort((a, b) => orderKey(a.row, b.row));
  const authors = assignAuthors(kept.map((c) => ({ legacyId: c.row.legacyId, pillar: c.row.pillar, createdAt: c.row.createdAt })));
  const storeFailures: FullPlan["storeFailures"] = [];
  const urls = new Set<string>();
  const importable: PlannedArticle[] = [];
  for (const c of kept) {
    const reasons: DraftReason[] = [...c.row.draftReasons];
    let coverOk = false;
    if (c.row.coverUrl) {
      urls.add(c.row.coverUrl);
      const chk = store.check(c.row.coverUrl);
      coverOk = chk.ok;
      if (!chk.ok) {
        storeFailures.push({ legacyId: c.row.legacyId, url: c.row.coverUrl, reason: chk.reason, role: "cover" });
        if (!reasons.includes("storeFailure")) reasons.push("storeFailure");
      }
    }
    const failedBody: string[] = [];
    for (const s of c.sections) {
      if (!s.image) continue;
      urls.add(s.image.url);
      const chk = store.check(s.image.url);
      if (!chk.ok) {
        storeFailures.push({ legacyId: c.row.legacyId, url: s.image.url, reason: chk.reason, role: "body" });
        failedBody.push(s.image.url);
        if (!reasons.includes("storeFailure")) reasons.push("storeFailure");
      }
    }
    const p: PlannedArticle = {
      ...c.row,
      finalStatus: reasons.length ? "draft" : c.row.status,
      finalDraftReasons: reasons,
      sections: c.sections,
      failedBodyUrls: failedBody,
      coverOk,
      links: c.links,
      htmlLike: c.htmlLike,
      author: authors.get(c.row.legacyId) as string,
    };
    importable.push(p);
    sourcesByLegacyId.set(p.legacyId, { legacyId: p.legacyId, slug: p.slug, oldStatus: p.oldStatus, plan: { kind: "import", pillar: p.pillar, draftReasons: reasons } });
  }
  const existingIds = new Set(sp.existing.map((e) => e.legacyId));
  const byLegacyId = new Map(importable.map((p) => [p.legacyId, p]));
  return {
    rows,
    importable,
    toCreate: importable.filter((p) => !existingIds.has(p.legacyId)),
    existing: sp.existing,
    rejects,
    skipped,
    byLegacyId,
    sourcesByLegacyId,
    storeFailures,
    imageRefs: urls.size,
    imageHosts,
    dateFallbacks: dateFallbackCounts(rows),
  };
}

/** Distinct failed image URLs / distinct image URLs referenced by importable rows. */
export function storeFailureRatio(plan: FullPlan): { failed: number; total: number; ratio: number } {
  const failed = new Set(plan.storeFailures.map((f) => f.url)).size;
  return { failed, total: plan.imageRefs, ratio: plan.imageRefs ? failed / plan.imageRefs : 0 };
}

/** Redirect sources of every snapshot row, in snapshot order. */
export function redirectSources(plan: FullPlan): RedirectSource[] {
  return plan.rows.map((r) => plan.sourcesByLegacyId.get(r.legacyId)).filter((x): x is RedirectSource => x !== undefined);
}

/** The redirect map the plan would give once every planned row exists with its planned status. */
export function expectedRedirects(plan: FullPlan): RedirectBuild {
  return buildVowasiaRedirects(redirectSources(plan), new Map(plan.importable.map((p) => [p.slug, p.finalStatus])));
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const kv = (m: Record<string, number>) => Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

/** The §4.1 expected-count block (the owner compares it with the measured facts). */
export function countBlock(plan: FullPlan): string[] {
  const statusBefore: Record<string, number> = {};
  const statusAfter: Record<string, number> = {};
  const noCover: Record<string, number> = {};
  const pillarsAll: Record<string, number> = {};
  const pillarsImported: Record<string, number> = {};
  const tagsAll: Record<string, number> = {};
  const tagsImported: Record<string, number> = {};
  const rejectsByReason: Record<string, number> = {};
  let c8 = 0;
  for (const r of plan.rows) {
    const t = transformRow(r);
    if (typeof r.section === "string") bump(pillarsAll, r.section);
    if (t.kind === "import") bump(tagsAll, t.tag ?? "(no tag)");
    if (!(typeof r.image === "string" && r.image.trim())) bump(noCover, String(r.status));
    if (t.kind === "import") bump(statusBefore, t.oldStatus === "scheduled" ? "draft" : t.oldStatus);
  }
  for (const p of plan.importable) {
    bump(statusAfter, p.finalStatus);
    bump(pillarsImported, p.pillar);
    bump(tagsImported, p.tag ?? "(no tag)");
  }
  for (const x of plan.rejects) {
    bump(rejectsByReason, x.reason);
    if (/^C8/.test(x.reason)) c8++;
  }
  const noCoverTotal = Object.values(noCover).reduce((a, b) => a + b, 0);
  const sf = storeFailureRatio(plan);
  const bodyImages = plan.importable.reduce((n, p) => n + p.sections.filter((s) => s.image).length, 0);
  const covers = plan.importable.filter((p) => p.coverUrl).length;
  const red = expectedRedirects(plan);
  const pct = (sf.ratio * 100).toFixed(1);
  const lines = [
    `rows in snapshot: ${plan.rows.length}; dropped (rejected, C2): ${plan.skipped.length}; rejected by the importer: ${plan.rejects.length}; to import: ${plan.importable.length} (already in Central from earlier runs: ${plan.existing.length}; new in this plan: ${plan.toCreate.length})`,
    `rejects by reason: ${kv(rejectsByReason)}; C8 rejects: ${c8}`,
    `status before the no-cover rule (imported rows): ${kv(statusBefore)}`,
    `status after the no-cover rule and store failures: ${kv(statusAfter)}`,
    `no-cover rows: ${noCoverTotal} (published ${noCover.published ?? 0}, archived ${noCover.archived ?? 0}, draft ${noCover.draft ?? 0}, scheduled ${noCover.scheduled ?? 0}, rejected ${noCover.rejected ?? 0})`,
    `pillar totals over all rows: ${kv(pillarsAll)}`,
    `pillar totals of imported rows: ${kv(pillarsImported)}`,
    `tag totals (upper bound, all importable shapes): ${kv(tagsAll)}`,
    `tag totals of imported rows: ${kv(tagsImported)}`,
    `date fallbacks (no published_at): all rows ${plan.dateFallbacks.all}, imported rows ${plan.dateFallbacks.imported}`,
    `images: distinct URLs referenced ${plan.imageRefs}; cover refs ${covers}; body images ${bodyImages}; store-level failures ${sf.failed} (${pct}%; limit 2%)`,
    `body text that looks like HTML (kept as escaped text): ${plan.importable.filter((p) => p.htmlLike).length}`,
    `expected redirect map: ${red.counts.total} entries = ${red.counts.gone410} x 410 + ${red.counts.total - red.counts.gone410} x 308 (published -> article ${red.counts.publishedToArticle}, archived -> pillar ${red.counts.archivedToPillar}, no-cover -> pillar ${red.counts.noCoverToPillar}); no entry ${red.noEntry.length}; O-B12 rows ${red.stops.length}`,
    `off-allow-list links in body text: ${plan.importable.reduce((n, p) => n + p.links.length, 0)}`,
  ];
  for (const p of plan.importable) for (const l of p.links) lines.push(`  link: ${l.cls} slug=${p.slug} url=${l.url}`);
  for (const f of plan.storeFailures) lines.push(`  store failure: ${f.role} slug=${plan.byLegacyId.get(f.legacyId)?.slug ?? f.legacyId} reason=${f.reason}`);
  for (const x of plan.rejects) lines.push(`  reject: slug=${x.slug} reason=${x.reason}`);
  return lines;
}
