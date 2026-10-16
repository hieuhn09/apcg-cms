/**
 * Redirect map builder for gtp-web (gtp-launch P4, 7.8 as superseded by
 * A11-S14, A12-N04, A10.1). Pure: input = the run's slug map + mapping `urls`
 * + known routes; output = rules, counts and the Phase 3 shaped files.
 */
import type { Mapping } from "./gtp-mapping";
import { normalise } from "./normalise-path";
import type { SlugMapEntry } from "./run-dir";
import { isKnownDestination, type KnownRoutes, type MapValue } from "./gtp-redirect-contract";

export interface RedirectRule {
  from: string;
  to: string | null;
  status: 301 | 410;
  kind: "article" | "section" | "subsection" | "static" | "feed";
  source: "slug-map" | "rule";
}

export interface RedirectBuild {
  rules: RedirectRule[];
  counts: Record<string, number>;
  collisions: { from: string; kept: string; dropped: string }[];
  unconverged: string[];
  errors: string[];
}

const STATIC_LEGACY: Record<string, string> = {
  "/about-us": "/about",
  "/contact-us": "/contact",
  "/privacy-policy": "/privacy",
  "/terms-and-conditions": "/terms",
  "/advertise-with-us": "/advertise",
};
const FEEDS = ["/feed", "/rss", "/rss.xml", "/feed.xml"];

function sectionTarget(pillar: string, sub?: string): string {
  return sub ? `/${pillar}/${sub}` : `/${pillar}`;
}

export function buildRedirects(entries: readonly SlugMapEntry[], m: Pick<Mapping, "archivedAs"> & { urls: Omit<Mapping["urls"], "gonePaths"> & { gonePaths?: readonly string[] } }, kr: KnownRoutes): RedirectBuild {
  const out: RedirectBuild = { rules: [], counts: { identityDropped: 0, archived: 0, published: 0, sections: 0, static: 0, gone: 0, feeds: 0, draftsNoRule: 0, collisions: 0, normaliseUnconverged: 0 }, collisions: [], unconverged: [], errors: [] };
  const byFrom = new Map<string, RedirectRule & { owner: string }>();
  const add = (rawFrom: string, to: string | null, status: 301 | 410, kind: RedirectRule["kind"], source: RedirectRule["source"], owner: string) => {
    const k = normalise(rawFrom);
    if (!k.ok) {
      out.unconverged.push(rawFrom);
      out.counts.normaliseUnconverged = (out.counts.normaliseUnconverged ?? 0) + 1;
      return;
    }
    if (to !== null && (normalise(to).ok ? (normalise(to) as { key: string }).key : to) === k.key) {
      out.counts.identityDropped = (out.counts.identityDropped ?? 0) + 1;
      return;
    }
    const prev = byFrom.get(k.key);
    if (prev) {
      if (prev.to !== to || prev.status !== status) {
        out.collisions.push({ from: k.key, kept: prev.owner, dropped: owner });
        out.counts.collisions = (out.counts.collisions ?? 0) + 1;
      }
      return;
    }
    byFrom.set(k.key, { from: k.key, to, status, kind, source, owner });
  };

  const articles = entries.filter((e) => e.kind === "article");
  const sectionsSeen = new Map<string, string>(); // old path -> new target
  for (const e of articles) {
    if (e.oldSection) {
      const oldSec = m.urls.sectionPaths[e.oldSection] ?? `/${e.oldSection}`;
      if (!sectionsSeen.has(oldSec)) sectionsSeen.set(oldSec, sectionTarget(e.oldSection));
      if (e.oldSub) {
        const oldSubPath = `${oldSec}/${e.oldSub}`;
        if (!sectionsSeen.has(oldSubPath)) sectionsSeen.set(oldSubPath, sectionTarget(e.pillar ?? e.oldSection, e.subSection));
      }
    }
    if (!e.oldUrl) continue;
    if (e.status === "published") {
      add(e.oldUrl, `/article/${e.slug}`, 301, "article", "slug-map", e.legacyId);
      out.counts.published = (out.counts.published ?? 0) + 1;
    } else if (e.status === "archived") {
      const to = m.archivedAs === "410" ? null : sectionTarget(e.pillar ?? e.oldSection ?? "news", e.subSection);
      add(e.oldUrl, to, m.archivedAs === "410" ? 410 : 301, "article", "slug-map", e.legacyId);
      out.counts.archived = (out.counts.archived ?? 0) + 1;
    } else out.counts.draftsNoRule = (out.counts.draftsNoRule ?? 0) + 1;
  }
  for (const [from, to] of sectionsSeen) {
    add(from, to, 301, from.split("/").filter(Boolean).length > 1 ? "subsection" : "section", "rule", `section:${from}`);
    out.counts.sections = (out.counts.sections ?? 0) + 1;
  }
  for (const p of m.urls.extraLegacyPaths) {
    const to = STATIC_LEGACY[p];
    if (to && kr.static.includes(to)) {
      add(p, to, 301, "static", "rule", `static:${p}`);
      out.counts.static = (out.counts.static ?? 0) + 1;
    }
  }
  // Amendment 4: sections dropped on the new site answer 410 Gone (no target page).
  for (const p of m.urls.gonePaths ?? []) {
    add(p, null, 410, "static", "rule", `gone:${p}`);
    out.counts.gone = (out.counts.gone ?? 0) + 1;
  }
  const feedTarget = kr.static.find((s) => FEEDS.includes(s)) ?? "/news";
  for (const f of FEEDS) {
    add(f, feedTarget, 301, "feed", "rule", `feed:${f}`);
    out.counts.feeds = (out.counts.feeds ?? 0) + 1;
  }
  out.rules = [...byFrom.values()].map((r) => ({ from: r.from, to: r.to, status: r.status, kind: r.kind, source: r.source }));

  // Hard checks (exit 3): chains, loops, dangling targets.
  const keys = new Set(out.rules.map((r) => r.from));
  const published = new Set(articles.filter((e) => e.status === "published").map((e) => `/article/${e.slug}`));
  for (const r of out.rules) {
    if (r.to === null) continue;
    if (keys.has(r.to)) out.errors.push(`chain or loop: ${r.from} -> ${r.to}`);
    if (r.to.startsWith("/article/") ? !published.has(r.to) : !isKnownDestination(r.to, kr)) out.errors.push(`dangling target: ${r.from} -> ${r.to}`);
  }
  // Coverage of published entries whose old URL differs from /article/<slug>.
  for (const e of articles) {
    if (e.status !== "published" || !e.oldUrl) continue;
    const k = normalise(e.oldUrl);
    if (!k.ok) continue;
    if (k.key === `/article/${e.slug}`) continue;
    if (!keys.has(k.key)) out.errors.push(`published entry without a rule: ${e.legacyId}`);
  }
  return out;
}

export function gtpWebFiles(b: RedirectBuild): { map: Record<string, MapValue>; rules: unknown[] } {
  const map: Record<string, MapValue> = {};
  for (const r of [...b.rules].sort((a, c) => (a.from < c.from ? -1 : 1))) map[r.from] = r.status === 410 || r.to === null ? { status: 410 } : r.to;
  return { map, rules: [] };
}

/** Coverage of a supplied URL list (sitemap / top URLs). */
export function coverage(urls: readonly string[], b: RedirectBuild): { total: number; matched: number; pct: number; unmatched: string[] } {
  const keys = new Set(b.rules.map((r) => r.from));
  let matched = 0;
  const unmatched: string[] = [];
  for (const u of urls) {
    let p = u.trim();
    if (!p) continue;
    try {
      p = new URL(p, "https://x.invalid").pathname;
    } catch {
      /* keep */
    }
    const k = normalise(p);
    if (k.ok && keys.has(k.key)) matched++;
    else unmatched.push(u.trim());
  }
  const total = matched + unmatched.length;
  return { total, matched, pct: total ? Math.round((matched / total) * 10000) / 100 : 100, unmatched: unmatched.slice(0, 50) };
}
