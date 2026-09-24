/**
 * BriefAsia prototype cleanup — find (and with `--apply` delete) the fabricated
 * articles and journalists that were pushed into Central CMS.
 *
 * While the BriefAsia reader site was being built, its UI was developed against
 * a fixture file (brief-asia-web `src/lib/data.ts`, header: "sample data aligned
 * to the prototype … will be replaced by Payload CMS reads in Phase 2"): 24
 * invented articles written under 6 invented bylines. Nothing in the reader
 * imports those fixtures any more — but they are visibly LIVE on the site, so at
 * some point the whole set was imported into the CMS for the `brief-asia`
 * tenant. They are not editorial work, they were never reported, and they sit in
 * the same pillars as real output. This script removes them.
 *
 * Two passes, because a fabricated row may have been re-slugged on import:
 *   1. the 24 known fixture slugs, matched exactly;
 *   2. anything else in the tenant carrying one of the 6 fabricated bylines —
 *      the same fixture set under a different slug, which is precisely what a
 *      slug-only sweep would leave behind.
 *
 * Safety hold: real engine output files into the same pillars (see
 * scripts/audit/apply-luxury-decisions.ts — the content engine also publishes
 * into lifestyle/luxury). Any candidate that looks like genuine work — it has
 * views, it carries engine provenance, or it has its own hero image — is HELD
 * and reported rather than deleted. `--force` releases the hold.
 *
 * Authors are handled last and only when they are left with zero articles, so an
 * author that turns out to have real work attached is never removed.
 *
 * DRY-RUN by default. Nothing is written without `--apply`.
 *
 *   npm run audit:purge-fabricated-ba
 *   npm run audit:purge-fabricated-ba -- --apply
 *   npm run audit:purge-fabricated-ba -- --apply --force
 */
import "../lib/env";
import { getPayload } from "payload";
import config from "@payload-config";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const TENANT_SLUG = "brief-asia";

/**
 * The 24 fixture slugs, verbatim from brief-asia-web `src/lib/data.ts`
 * (`ARTICLES`). Origin of truth for this list is that file — if it is ever
 * regenerated, re-derive rather than editing here by hand.
 */
const FABRICATED_SLUGS = [
  "sea-ai-cluster-singapore",
  "baidu-open-weights",
  "vng-cloud-listing",
  "tokopedia-grab-merger-fallout",
  "taiwan-chip-export-rules",
  "react-server-actions-tradeoffs",
  "oppo-find-x9-review",
  "briefasia-studio-aws-asean",
  "india-upi-cross-border",
  "deep-dive-asia-capex",
  "ai-assisted-translation-note",
  "sea-fintech-quiet-quarter",
  "alibaba-cloud-inference-tier",
  "korea-ai-chip-startups",
  "jakarta-data-residency",
  "asean-cross-border-payments",
  "go-1-24-async-iterators",
  "vercel-asia-edge",
  "kubernetes-1-32-pod-resize",
  "samsung-galaxy-s26-review",
  "meta-quest-pro-2-review",
  "asus-rog-flow-z14",
  "japan-cyber-law-2026",
  "india-dpdp-enforcement",
] as const;

/** The 6 invented journalists from the same fixture file (`AUTHORS`). */
const FABRICATED_AUTHOR_NAMES = [
  "Mei Lin",
  "Ravi Kim",
  "Thao Nguyen",
  "Jordan Chen",
  "Arif Rahman",
  "Ananya Iyer",
] as const;

type Outcome = "deleted" | "would-delete" | "held" | "not-found" | "skipped-wrong-tenant";

interface ArticleRow {
  id: string | number;
  tenant?: unknown;
  slug?: string | null;
  title?: string | null;
  pillar?: unknown;
  subSection?: unknown;
  author?: unknown;
  coAuthors?: unknown;
  workflowStatus?: string | null;
  publishedAt?: string | null;
  views?: number | null;
  heroImage?: unknown;
  engineDraftId?: string | null;
  engineSourceUrl?: string | null;
}

interface Candidate {
  article: ArticleRow;
  /** Which pass found it — pass 2 rows are reported under their own heading. */
  source: "slug" | "byline";
  outcome: Outcome;
  /** Populated only when the safety hold fired. */
  holdReasons: string[];
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

function relIds(v: unknown): Array<string | number> {
  if (!Array.isArray(v)) {
    const one = relId(v);
    return one == null ? [] : [one];
  }
  return v.map(relId).filter((x): x is string | number => x != null);
}

function sameId(a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function pad(v: unknown, n: number): string {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

/** Non-empty after trimming — engine provenance fields are sometimes "". */
function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main() {
  /* ── Banner ───────────────────────────────────────────────────────────── */
  console.log("");
  console.log("═".repeat(78));
  console.log(APPLY ? "  APPLYING — this run WRITES to the database" : "  DRY RUN — no writes; pass --apply to write");
  console.log("═".repeat(78));
  console.log(`  tenant          : ${TENANT_SLUG} (locked)`);
  console.log(`  known slugs     : ${FABRICATED_SLUGS.length}`);
  console.log(`  known bylines   : ${FABRICATED_AUTHOR_NAMES.length}`);
  console.log(`  safety hold     : ${FORCE ? "RELEASED (--force)" : "on (views / engine provenance / heroImage)"}`);
  console.log("═".repeat(78));

  const payload = await getPayload({ config: await config });

  /* ── Tenant ───────────────────────────────────────────────────────────── */
  const tenants = await payload.find({
    collection: "tenants",
    where: { slug: { equals: TENANT_SLUG } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const tenant = tenants.docs[0];
  if (!tenant) throw new Error(`tenant ${TENANT_SLUG} not found — refusing to run`);
  const tenantId = tenant.id;
  console.log(`\ntenant: ${TENANT_SLUG} (id ${tenantId})`);

  /* ── Taxonomy maps, for a readable report ─────────────────────────────── */
  const pillars = await payload.find({
    collection: "pillars",
    where: { tenant: { equals: tenantId } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  });
  const pillarSlugById = new Map<string, string>();
  for (const raw of pillars.docs) {
    const p = raw as unknown as { id: string | number; slug?: string | null };
    if (p.slug) pillarSlugById.set(String(p.id), p.slug);
  }

  const subsections = await payload.find({
    collection: "subsections",
    where: { tenant: { equals: tenantId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  });
  const subSlugById = new Map<string, string>();
  for (const raw of subsections.docs) {
    const s = raw as unknown as { id: string | number; slug?: string | null };
    if (s.slug) subSlugById.set(String(s.id), s.slug);
  }

  /* ── Every article in the tenant, paginated ───────────────────────────────
     Articles declare `versions: { drafts: true }` (src/collections/Articles.ts).
     `draft: true` is passed deliberately: without it Payload overlays the
     PUBLISHED version, so a fabricated article that was imported and never
     published reads back with stale/empty fields and its slug would not match
     the known list — the exact row this cleanup must not miss. With `draft:
     true` the newest version wins, so draft-only fixtures are found and
     reported like any other. */
  const articles: ArticleRow[] = [];
  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenantId } },
      sort: "id",
      page,
      limit: 200,
      depth: 0,
      locale: "en",
      draft: true,
      overrideAccess: true,
    });
    for (const raw of res.docs) articles.push(raw as unknown as ArticleRow);
    if (!res.hasNextPage) break;
    page += 1;
  }
  console.log(`articles in tenant: ${articles.length}\n`);

  /* ── Fabricated authors ───────────────────────────────────────────────────
     Matched case-insensitively on `name`, tenant-scoped. Fetched before the
     article passes because pass 2 needs their ids. */
  const authors = await payload.find({
    collection: "authors",
    where: { tenant: { equals: tenantId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  });
  const wantedNames = new Set(FABRICATED_AUTHOR_NAMES.map((n) => n.toLowerCase()));
  const fabricatedAuthors = (authors.docs as unknown as Array<{ id: string | number; name?: string | null; slug?: string | null; role?: string | null; city?: string | null; tenant?: unknown }>)
    .filter((a) => hasText(a.name) && wantedNames.has(a.name!.trim().toLowerCase()));
  const fabricatedAuthorIds = new Set(fabricatedAuthors.map((a) => String(a.id)));

  /* ── Pass 1 — exact slug match ────────────────────────────────────────── */
  const bySlug = new Map<string, ArticleRow>();
  for (const a of articles) if (hasText(a.slug)) bySlug.set(a.slug!.trim(), a);

  const candidates: Candidate[] = [];
  const notFoundSlugs: string[] = [];
  const claimed = new Set<string>();

  for (const slug of FABRICATED_SLUGS) {
    const article = bySlug.get(slug);
    if (!article) {
      notFoundSlugs.push(slug);
      continue;
    }
    // Belt-and-braces: the query was already tenant-scoped, but never delete on
    // the strength of a filter alone.
    if (!sameId(relId(article.tenant), tenantId)) {
      candidates.push({ article, source: "slug", outcome: "skipped-wrong-tenant", holdReasons: [] });
      continue;
    }
    claimed.add(String(article.id));
    candidates.push({ article, source: "slug", outcome: "would-delete", holdReasons: [] });
  }

  /* ── Pass 2 — widen by fabricated byline ──────────────────────────────── */
  for (const article of articles) {
    if (claimed.has(String(article.id))) continue;
    const bylineIds = [...relIds(article.author), ...relIds(article.coAuthors)];
    if (!bylineIds.some((id) => fabricatedAuthorIds.has(String(id)))) continue;
    if (!sameId(relId(article.tenant), tenantId)) {
      candidates.push({ article, source: "byline", outcome: "skipped-wrong-tenant", holdReasons: [] });
      continue;
    }
    claimed.add(String(article.id));
    candidates.push({ article, source: "byline", outcome: "would-delete", holdReasons: [] });
  }

  /* ── Safety hold ──────────────────────────────────────────────────────────
     Anything that reads like genuine editorial work is held back. The prototype
     fixtures have no views, no engine provenance and no hero image of their own
     (that is why the live Oppo review renders the hardcoded lifestyle fallback),
     so a candidate failing any of these tests is probably NOT a fixture. */
  for (const c of candidates) {
    if (c.outcome !== "would-delete") continue;
    const reasons: string[] = [];
    const views = typeof c.article.views === "number" ? c.article.views : 0;
    if (views > 0) reasons.push(`views=${views}`);
    if (hasText(c.article.engineDraftId)) reasons.push(`engineDraftId=${c.article.engineDraftId}`);
    if (hasText(c.article.engineSourceUrl)) reasons.push(`engineSourceUrl=${c.article.engineSourceUrl}`);
    if (relId(c.article.heroImage) != null) reasons.push("has heroImage");
    if (reasons.length > 0 && !FORCE) {
      c.outcome = "held";
      c.holdReasons = reasons;
    } else if (reasons.length > 0) {
      c.holdReasons = reasons; // released by --force, still worth printing
    }
  }

  /* ── Report ───────────────────────────────────────────────────────────── */
  const authorNameById = new Map<string, string>();
  for (const raw of authors.docs) {
    const a = raw as unknown as { id: string | number; name?: string | null };
    if (hasText(a.name)) authorNameById.set(String(a.id), a.name!);
  }

  const describe = (c: Candidate): string => {
    const a = c.article;
    const pillarSlug = pillarSlugById.get(String(relId(a.pillar) ?? "")) ?? "-";
    const subSlug = subSlugById.get(String(relId(a.subSection) ?? "")) ?? "-";
    const authorName = authorNameById.get(String(relId(a.author) ?? "")) ?? "-";
    return (
      `${pad(a.id, 6)} ${pad(a.slug, 32)} ${pad(a.title, 40)} ` +
      `${pad(pillarSlug, 14)} ${pad(subSlug, 14)} ${pad(authorName, 14)} ` +
      `${pad(a.workflowStatus, 10)} ${pad(a.publishedAt, 26)} ${pad(a.views ?? 0, 6)}`
    );
  };

  const header =
    `${pad("id", 6)} ${pad("slug", 32)} ${pad("title", 40)} ` +
    `${pad("pillar", 14)} ${pad("subSection", 14)} ${pad("author", 14)} ` +
    `${pad("status", 10)} ${pad("publishedAt", 26)} ${pad("views", 6)}`;

  const slugRows = candidates.filter((c) => c.source === "slug");
  const bylineRows = candidates.filter((c) => c.source === "byline");

  console.log("KNOWN FABRICATED SLUGS");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const c of slugRows) {
    console.log(describe(c));
    if (c.outcome === "held") console.log(`       HELD — ${c.holdReasons.join(", ")} — pass --force to delete anyway`);
    if (c.outcome === "skipped-wrong-tenant") console.log(`       NOT in tenant ${TENANT_SLUG} — skipped`);
  }
  if (notFoundSlugs.length > 0) {
    console.log(`\n  not-found (${notFoundSlugs.length}) — never imported, or already removed:`);
    for (const s of notFoundSlugs) console.log(`    ${s}`);
  }

  console.log("\nEXTRA — fabricated byline, slug not in the known list");
  if (bylineRows.length === 0) {
    console.log("  (none)");
  } else {
    console.log(header);
    console.log("-".repeat(header.length));
    for (const c of bylineRows) {
      console.log(describe(c));
      if (c.outcome === "held") console.log(`       HELD — ${c.holdReasons.join(", ")} — pass --force to delete anyway`);
      if (c.outcome === "skipped-wrong-tenant") console.log(`       NOT in tenant ${TENANT_SLUG} — skipped`);
    }
  }

  /* ── Delete articles ──────────────────────────────────────────────────────
     Via the Payload API (never raw SQL) so versions and relations clean up and
     the reader's revalidation hooks fire. */
  const deletedArticleIds = new Set<string>();
  if (APPLY) {
    console.log("\ndeleting articles…");
    for (const c of candidates) {
      if (c.outcome !== "would-delete") continue;
      await payload.delete({ collection: "articles", id: c.article.id, overrideAccess: true });
      c.outcome = "deleted";
      deletedArticleIds.add(String(c.article.id));
      console.log(`  deleted ${c.article.id} ${c.article.slug ?? ""}`);
    }
  }

  /* ── Authors last ─────────────────────────────────────────────────────────
     Re-count from the in-memory article set minus anything just deleted: an
     author is only removed once NOTHING in the tenant still points at it. */
  console.log("\nFABRICATED AUTHORS");
  let authorsDeleted = 0;
  let authorsKept = 0;
  if (fabricatedAuthors.length === 0) {
    console.log("  (none found in this tenant)");
  }
  for (const author of fabricatedAuthors) {
    const stillReferencing = articles.filter((a) => {
      if (deletedArticleIds.has(String(a.id))) return false;
      return [...relIds(a.author), ...relIds(a.coAuthors)].some((id) => sameId(id, author.id));
    }).length;

    const label = `${pad(author.id, 6)} ${pad(author.name, 18)} ${pad(author.role ?? "-", 22)} ${pad(author.city ?? "-", 14)}`;
    if (stillReferencing > 0) {
      authorsKept += 1;
      console.log(`${label} KEPT — ${stillReferencing} article(s) still reference this author`);
      continue;
    }
    if (APPLY) {
      await payload.delete({ collection: "authors", id: author.id, overrideAccess: true });
      authorsDeleted += 1;
      console.log(`${label} deleted (0 remaining articles)`);
    } else {
      authorsDeleted += 1;
      console.log(`${label} would-delete (0 remaining articles)`);
    }
  }

  /* ── Summary ──────────────────────────────────────────────────────────── */
  const tally = (o: Outcome) => candidates.filter((c) => c.outcome === o).length;
  console.log("\nsummary");
  console.log(`  deleted               : ${tally("deleted")}`);
  console.log(`  would-delete          : ${tally("would-delete")}`);
  console.log(`  held                  : ${tally("held")}`);
  console.log(`  not-found             : ${notFoundSlugs.length}`);
  console.log(`  skipped-wrong-tenant  : ${tally("skipped-wrong-tenant")}`);
  console.log(`  authors ${APPLY ? "deleted" : "would-delete"}       : ${authorsDeleted}`);
  console.log(`  authors kept          : ${authorsKept}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply after review.");
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
