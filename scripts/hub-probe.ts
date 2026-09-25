/**
 * hub-probe.ts — one-shot data check for the read-only `/api/hub/articles`
 * route (APCGHub P4 / CMS-1). LOCAL DOCKER POSTGRES ONLY.
 *
 *   docker compose up -d
 *   cp .env.docker.example .env.local
 *   npm run db:seed                      # (may stop early on the podcasts fixture)
 *   npx tsx scripts/hub-probe.ts --setup # create fixtures, print the hub token
 *   npm run dev                          # in another shell
 *   npx tsx scripts/hub-probe.ts --check --token <printed token>
 *
 * `--setup` is idempotent: it creates (or reuses) one author + two articles per
 * seeded tenant and one ContentEngines document with `hubRead: true` granted on
 * EVERY tenant — the multi-tenant grant that `authenticateEngine()` has always
 * refused (engine-auth.ts:84-92) and that the hub path exists to serve.
 *
 * `--check` calls the running dev server over real HTTP and compares the
 * route's output against `payload.find` on the same database, so a wrong tenant
 * filter shows up as a number mismatch rather than a plausible-looking list.
 *
 * NEVER point this at a deployed database. It writes fixtures.
 */

import "./lib/env";
import { getPayload } from "payload";
import { randomBytes } from "node:crypto";
import config from "../payload.config";
import { scopedFindMultiTenant, HubPageOutOfRangeError } from "../src/lib/hub-scoped";
// Namespace import for the CMS-2 checks: a static named import of an export that
// does not exist yet (`comparatorFor` before D14) would be a load-time
// SyntaxError and take the whole probe down. Feature-detect instead.
import * as hubScoped from "../src/lib/hub-scoped";
// CMS-3 (--setup3 / --check3).
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "@payloadcms/db-postgres";
import { isValidTransition } from "../src/lib/hub-transition";
import { ARTICLE_STATUSES, type ArticleStatus } from "../src/lib/constants";

const HUB_ENGINE_NAME = "apcghub-read";
const BASE = process.env.HUB_PROBE_BASE ?? "http://localhost:3000";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function setup() {
  const payload = await getPayload({ config });

  const tenants = (
    await payload.find({ collection: "tenants", limit: 100, depth: 0, overrideAccess: true })
  ).docs as unknown as { id: number; slug: string }[];
  if (!tenants.length) throw new Error("no tenants — run `npm run db:seed` first");
  console.log(`[probe] tenants: ${tenants.map((t) => t.slug).join(", ")} (${tenants.length})`);

  for (const t of tenants) {
    const pillar = (
      await payload.find({
        collection: "pillars",
        where: { tenant: { equals: t.id } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
    ).docs[0] as { id: number } | undefined;
    if (!pillar) {
      console.log(`[probe] ${t.slug}: no pillar, skipping article fixtures`);
      continue;
    }

    let author = (
      await payload.find({
        collection: "authors",
        where: { tenant: { equals: t.id } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
    ).docs[0] as { id: number } | undefined;
    if (!author) {
      author = (await payload.create({
        collection: "authors",
        overrideAccess: true,
        data: { tenant: t.id, name: `Probe Author ${t.slug}`, slug: `probe-author-${t.slug}` },
      })) as unknown as { id: number };
    }

    // Two articles per tenant with DIFFERENT workflowStatus, so the `status`
    // filter has something to discriminate and a missing filter is visible.
    for (const [i, status] of (["published", "pending_review"] as const).entries()) {
      const slug = `hub-probe-${t.slug}-${status}`;
      const existing = await payload.find({
        collection: "articles",
        where: { slug: { equals: slug } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      });
      if (existing.docs.length) continue;
      await payload.create({
        collection: "articles",
        overrideAccess: true,
        data: {
          tenant: t.id,
          title: `Hub probe ${t.slug} ${status}`,
          slug,
          pillar: pillar.id,
          author: author.id,
          workflowStatus: status,
          publishedAt: new Date(Date.UTC(2026, 8, 20 + i, 12)).toISOString(),
        } as never,
      });
    }
  }

  const existingEngine = await payload.find({
    collection: "content-engines",
    where: { name: { equals: HUB_ENGINE_NAME } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const rawToken = randomBytes(24).toString("hex");
  if (existingEngine.docs.length) {
    await payload.update({
      collection: "content-engines",
      id: (existingEngine.docs[0] as { id: number }).id,
      overrideAccess: true,
      data: {
        rawToken,
        hubRead: true,
        status: "active",
        allowedTenants: tenants.map((t) => t.id),
      } as never,
    });
    console.log(`[probe] rotated ${HUB_ENGINE_NAME} token`);
  } else {
    await payload.create({
      collection: "content-engines",
      overrideAccess: true,
      data: {
        name: HUB_ENGINE_NAME,
        engineType: "other",
        status: "active",
        rawToken,
        hubRead: true,
        allowedTenants: tenants.map((t) => t.id),
        // Deliberately NO write actions: hub read must not depend on any of them.
        allowedActions: ["import"],
      } as never,
    });
    console.log(`[probe] created ${HUB_ENGINE_NAME}`);
  }

  // A second engine WITHOUT hubRead, to prove the 403 path is about the flag
  // and not about the token being unknown.
  const noHubToken = randomBytes(24).toString("hex");
  const existingNoHub = await payload.find({
    collection: "content-engines",
    where: { name: { equals: "apcghub-nohub" } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  if (existingNoHub.docs.length) {
    await payload.update({
      collection: "content-engines",
      id: (existingNoHub.docs[0] as { id: number }).id,
      overrideAccess: true,
      data: { rawToken: noHubToken, hubRead: false, status: "active" } as never,
    });
  } else {
    await payload.create({
      collection: "content-engines",
      overrideAccess: true,
      data: {
        name: "apcghub-nohub",
        engineType: "other",
        status: "active",
        rawToken: noHubToken,
        hubRead: false,
        allowedTenants: tenants.map((t) => t.id),
        allowedActions: ["import"],
      } as never,
    });
  }

  console.log(`\n[probe] HUB TOKEN      : ${rawToken}`);
  console.log(`[probe] NO-HUB TOKEN   : ${noHubToken}`);
  console.log(`[probe] tenant slugs   : ${tenants.map((t) => t.slug).join(",")}\n`);
  process.exit(0);
}

async function check() {
  const token = arg("token");
  const noHubToken = arg("nohub-token");
  if (!token) throw new Error("--token <hub token> required");
  const payload = await getPayload({ config });

  const tenants = (
    await payload.find({ collection: "tenants", limit: 100, depth: 0, overrideAccess: true })
  ).docs as unknown as { id: number; slug: string }[];

  const call = async (qs: string, bearer = token) => {
    const res = await fetch(`${BASE}/api/hub/articles${qs}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  let failures = 0;
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(wanted)}`);
    if (!ok) failures++;
  };

  // Ground truth straight from the DB, per tenant, for comparison.
  const truth: Record<string, number> = {};
  let truthTotal = 0;
  for (const t of tenants) {
    const n = (
      await payload.find({
        collection: "articles",
        where: { tenant: { equals: t.id } },
        limit: 0,
        depth: 0,
        overrideAccess: true,
      })
    ).totalDocs;
    truth[t.slug] = n;
    truthTotal += n;
  }
  console.log(`[probe] DB ground truth: ${JSON.stringify(truth)} total=${truthTotal}\n`);

  // 1. No token → 401.
  expect("no token → 401", (await call("", "")).status, 401);

  // 2. Bad token → 401.
  expect("bad token → 401", (await call("", "not-a-real-token")).status, 401);

  // 3. Valid token without hubRead → 403.
  if (noHubToken) {
    const r = await call("", noHubToken);
    expect("token without hubRead → 403", r.status, 403);
  }

  // 4. Cross-tenant read: total must equal the sum over ALL tenants.
  const all = await call("?limit=200");
  expect("all tenants → 200", all.status, 200);
  expect("all tenants totalDocs == DB sum", all.body.totalDocs, truthTotal);
  const seenSlugs = [
    ...new Set((all.body.articles as { tenant: { slug: string } }[]).map((a) => a.tenant.slug)),
  ].sort();
  expect(
    "rows span every tenant that has articles",
    seenSlugs,
    Object.entries(truth).filter(([, n]) => n > 0).map(([s]) => s).sort(),
  );

  // 5. Narrowing to one tenant.
  const one = tenants[0] as { slug: string };
  const narrowed = await call(`?tenants=${one.slug}&limit=200`);
  expect(`tenants=${one.slug} → 200`, narrowed.status, 200);
  expect(`tenants=${one.slug} totalDocs`, narrowed.body.totalDocs, truth[one.slug]);

  // 6. Tenant outside the grant → 403, not a silent drop.
  const denied = await call("?tenants=definitely-not-a-tenant");
  expect("unknown tenant → 403", denied.status, 403);

  // 7. workflowStatus filter works, and _status is NOT filtered: every fixture
  //    article is `_status: draft` + a real workflowStatus, exactly like the
  //    ~3,300 live imported rows. If the route ever filtered _status, these
  //    counts would be 0.
  const published = await call("?status=published&limit=200");
  const dbPublished = (
    await payload.find({
      collection: "articles",
      where: { workflowStatus: { equals: "published" } },
      limit: 0,
      depth: 0,
      overrideAccess: true,
    })
  ).totalDocs;
  expect("status=published totalDocs == DB", published.body.totalDocs, dbPublished);
  expect("status=published > 0 (proves _status is NOT filtered)", dbPublished > 0, true);

  // 8. Unknown status → 400.
  expect("status=bogus → 400", (await call("?status=bogus")).status, 400);

  // 9. Leak check on the real wire payload.
  const wire = JSON.stringify(all.body);
  for (const secret of ["readTokens", "tokenHash", "tokenPrefix", "allowedActions", "hubRead", "lastSeenIp", "email"]) {
    expect(`response does not contain "${secret}"`, wire.includes(secret), false);
  }
  const keys = [
    ...new Set((all.body.articles as Record<string, unknown>[]).flatMap((a) => Object.keys(a))),
  ].sort();
  console.log(`[probe] emitted article keys: ${keys.join(", ")}`);

  console.log(`\n[probe] ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * --paging: calls scopedFindMultiTenant DIRECTLY with a tiny `maxOverFetch` so
 * the 4 seed articles cross the reachable limit (production limit is 500, which
 * seed data can never reach). Proves the helper guards its own invariant.
 */
async function paging() {
  const payload = await getPayload({ config });
  const tenantIds = (
    await payload.find({ collection: "tenants", limit: 100, depth: 0, overrideAccess: true })
  ).docs.map((t) => (t as { id: number }).id);

  let failures = 0;
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(wanted)}`);
    if (!ok) failures++;
  };
  const find = (page: number, limit: number, maxOverFetch: number) =>
    scopedFindMultiTenant<{ publishedAt: string }>({
      payload, collection: "articles", tenantIds, limit, page, maxOverFetch, depth: 0,
      select: { publishedAt: true },
    });
  const throwsName = async (fn: () => Promise<unknown>) => {
    try { await fn(); return "no-throw"; } catch (e) { return (e as Error).name; }
  };

  // Global ground truth (publishedAt only — two tenants share dates, so ids tie).
  const truth = (
    await payload.find({ collection: "articles", limit: 100, depth: 0, sort: "-publishedAt", overrideAccess: true })
  ).docs.map((d) => (d as unknown as { publishedAt: string }).publishedAt);
  console.log(`[paging] total=${truth.length}, maxOverFetch=3 → reachable=3`);

  const p1 = await find(1, 2, 3);
  expect("(b) truncated=true when totalDocs > maxOverFetch", p1.truncated, true);
  expect("totalDocs stays the TRUE count", p1.totalDocs, truth.length);
  expect("totalPages = ceil(min(total,max)/limit)", p1.totalPages, 2);
  expect("page1 hasNextPage=true", p1.hasNextPage, true);
  expect("page1 rows = global positions 0-1", p1.docs.map((d) => d.publishedAt), truth.slice(0, 2));

  const p2 = await find(2, 2, 3);
  expect("(d) last reachable page is CUT to 1 row, not padded to 2", p2.docs.length, 1);
  expect("(d) that row is global position 2", p2.docs.map((d) => d.publishedAt), truth.slice(2, 3));
  expect("(c) hasNextPage=false on last reachable page", p2.hasNextPage, false);

  expect("(a) window starting at the limit → HubPageOutOfRangeError", await throwsName(() => find(3, 2, 3)), "HubPageOutOfRangeError");
  expect("(a) error class is exported for callers", HubPageOutOfRangeError.name, "HubPageOutOfRangeError");
  expect("fractional page → RangeError", await throwsName(() => find(1.5, 2, 3)), "RangeError");

  // limit=1 separates ceil(min(total,max)/limit)=3 from ceil(total/limit)=4;
  // with limit=2 both are 2, which is exactly how the original bug hid.
  const p3 = await find(3, 1, 3);
  expect("(c) limit=1: totalPages = 3 reachable, not 4", p3.totalPages, 3);
  expect("(c) limit=1 page 3 (last reachable) hasNextPage=false", p3.hasNextPage, false);

  const wide = await find(1, 2, 10);
  expect("(b) truncated=false when everything is reachable", wide.truncated, false);
  expect("wide totalPages", wide.totalPages, Math.ceil(truth.length / 2));

  // Route-level: deep page refused up front; fractional page floored.
  const token = arg("token");
  if (token) {
    const base = process.env.HUB_PROBE_BASE ?? "http://localhost:3000";
    const r = await fetch(`${base}/api/hub/articles?limit=50&page=11`, { headers: { authorization: `Bearer ${token}` } });
    expect("route page=11 limit=50 → 400", r.status, 400);
    const f = await fetch(`${base}/api/hub/articles?limit=2&page=1.5`, { headers: { authorization: `Bearer ${token}` } });
    const fb = (await f.json()) as { page: number };
    expect("route page=1.5 → floored to 1", [f.status, fb.page], [200, 1]);
  }

  console.log(`\n[paging] ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS-2 checks (APCGHub P4 / CMS-2): search, pillar filter, views sort, merge
// order, /api/hub/tenants, /api/hub/taxonomy.
//
//   --setup2     idempotent CMS-2 fixtures (run AFTER --check/--paging: these
//                fixtures break --paging's "<= 10 articles" assumption).
//   --nullorder  calls scopedFindMultiTenant directly (no dev server).
//   --check2     real HTTP against the dev server (HUB_PROBE_BASE).
// ─────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;

async function tenantsBySlug(payload: P): Promise<Map<string, number>> {
  const docs = (
    await payload.find({ collection: "tenants", limit: 100, depth: 0, overrideAccess: true, pagination: false })
  ).docs as unknown as { id: number; slug: string }[];
  return new Map(docs.map((t) => [t.slug, t.id]));
}

function need(map: Map<string, number>, slug: string): number {
  const id = map.get(slug);
  if (id == null) throw new Error(`tenant ${slug} missing — run the patched \`npm run db:seed\` first`);
  return id;
}

async function ensurePillar(payload: P, tenantId: number, slug: string, title: string, order = 0): Promise<number> {
  const found = await payload.find({
    collection: "pillars",
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const existing = found.docs[0] as unknown as { id: number } | undefined;
  if (existing) return existing.id;
  const created = (await payload.create({
    collection: "pillars",
    overrideAccess: true,
    data: { tenant: tenantId, slug, title, order } as never,
  })) as unknown as { id: number };
  return created.id;
}

async function ensureAuthor(payload: P, tenantId: number, slug: string, name: string, rank?: number): Promise<number> {
  const found = await payload.find({
    collection: "authors",
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const existing = found.docs[0] as unknown as { id: number } | undefined;
  if (existing) return existing.id;
  const created = (await payload.create({
    collection: "authors",
    overrideAccess: true,
    data: { tenant: tenantId, slug, name, ...(rank != null ? { rank } : {}) } as never,
  })) as unknown as { id: number };
  return created.id;
}

interface ArticleSpec {
  slug: string;
  title: string;
  dek?: string;
  publishedAt: string | null;
  views?: number | null;
  pillar?: number;
}

/** Idempotent by (tenant, slug). Returns the id. */
async function ensureArticle(
  payload: P,
  tenantId: number,
  defaults: { pillar: number; author: number },
  a: ArticleSpec,
): Promise<number> {
  const found = await payload.find({
    collection: "articles",
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: a.slug } }] },
    limit: 1,
    depth: 0,
    locale: "en",
    overrideAccess: true,
  });
  const existing = found.docs[0] as unknown as { id: number } | undefined;
  if (existing) return existing.id;

  const base = {
    tenant: tenantId,
    title: a.title,
    slug: a.slug,
    pillar: a.pillar ?? defaults.pillar,
    author: defaults.author,
    workflowStatus: "published",
    ...(a.dek ? { dek: a.dek } : {}),
  };

  let id: number;
  if (a.publishedAt === null) {
    // publishedAt is `required` + has a defaultValue (Articles.ts), so leaving
    // it out yields "now" and sending null fails validation. A DRAFT create
    // skips validation (payload create.js: skipValidation for drafts) and
    // writes NULL to the main table with `_status: draft` — the same shape as
    // the ~3,300 imported live rows (`_status: draft` + workflowStatus published).
    id = (
      (await payload.create({
        collection: "articles",
        draft: true,
        overrideAccess: true,
        locale: "en",
        data: { ...base, publishedAt: null } as never,
      })) as unknown as { id: number }
    ).id;
  } else {
    id = (
      (await payload.create({
        collection: "articles",
        overrideAccess: true,
        locale: "en",
        data: { ...base, publishedAt: a.publishedAt, ...(typeof a.views === "number" ? { views: a.views } : {}) } as never,
      })) as unknown as { id: number }
    ).id;
  }
  if (a.views === null) {
    await payload.update({
      collection: "articles",
      id,
      overrideAccess: true,
      locale: "en",
      data: { views: null } as never,
    });
  }
  return id;
}

const iso = (y: number, m: number, d: number, h = 12) => new Date(Date.UTC(y, m - 1, d, h)).toISOString();

async function setup2() {
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const gcv = need(tenants, "gcv");
  const wad = need(tenants, "wad");

  // ── dtw: >= 12 authors (taxonomy "not cut at 10") ──
  const dtwAuthors: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, "0");
    dtwAuthors.push(await ensureAuthor(payload, dtw, `probe2-author-${n}`, `Probe2 Author ${n}`, i));
  }
  const dtwPillar = await ensurePillar(payload, dtw, "ai", "AI");
  const dtwSolo = await ensurePillar(payload, dtw, "probe-solo", "Probe Solo");
  const dtwShared = await ensurePillar(payload, dtw, "probe-shared", "Probe Shared (dtw)");
  const dd = { pillar: dtwPillar, author: dtwAuthors[0] as number };

  // Search fixtures + their baits (a wildcard leak would match the bait too).
  const search: ArticleSpec[] = [
    { slug: "probe2-50pct", title: "Probe 50% off", publishedAt: iso(2026, 8, 1) },
    { slug: "probe2-500units", title: "Probe 500 units", publishedAt: iso(2026, 8, 1) },
    { slug: "probe2-a-under-b", title: "Probe a_b", publishedAt: iso(2026, 8, 2) },
    { slug: "probe2-a1b", title: "Probe a1b", publishedAt: iso(2026, 8, 2) },
    { slug: "probe2-back-slash", title: "Probe back\\slash", publishedAt: iso(2026, 8, 3) },
    { slug: "probe2-backslash", title: "Probe backslash", publishedAt: iso(2026, 8, 3) },
    { slug: "probe2-dek", title: "Probe dek carrier", dek: "This standfirst carries zqxdekword only here.", publishedAt: iso(2026, 8, 4) },
  ];
  for (const a of search) await ensureArticle(payload, dtw, dd, a);

  // 8 articles whose views run OPPOSITE to publishedAt (newest = fewest views):
  // an ignored views key (buildOrderBy silently skips unknown columns) shows up
  // as a publishedAt order instead of a views order.
  for (let i = 0; i < 8; i++) {
    await ensureArticle(payload, dtw, dd, {
      slug: `probe2-views-${i}`,
      title: `Probe views ${i}`,
      publishedAt: iso(2026, 9, 1 + i),
      views: 800 - i * 100,
    });
  }
  // Three articles TIED at the top views value, created so id order runs
  // opposite to date order: the -publishedAt tiebreak inside -views is visible.
  for (const [i, day] of [3, 2, 1].entries()) {
    await ensureArticle(payload, dtw, dd, {
      slug: `probe2-v900-${i}`,
      title: `Probe v900 ${i}`,
      publishedAt: iso(2026, 7, day),
      views: 900,
    });
  }
  // Six articles with views 0 and the SAME publishedAt: only `id` separates them.
  for (let i = 0; i < 6; i++) {
    await ensureArticle(payload, dtw, dd, {
      slug: `probe2-tie-${i}`,
      title: `Probe tie ${i}`,
      publishedAt: iso(2026, 6, 15),
      views: 0,
    });
  }
  // One article with views NULL (legacy-import shape).
  await ensureArticle(payload, dtw, dd, { slug: "probe2-views-null", title: "Probe views null", publishedAt: iso(2026, 6, 20), views: null });
  // Pillar-only-in-dtw + shared pillar.
  await ensureArticle(payload, dtw, dd, { slug: "probe2-solo", title: "Probe solo pillar", publishedAt: iso(2026, 5, 1), pillar: dtwSolo });
  await ensureArticle(payload, dtw, dd, { slug: "probe2-shared-dtw", title: "Probe shared dtw", publishedAt: iso(2026, 5, 2), pillar: dtwShared });

  // ── gcv: >= 6 articles with publishedAt NULL (null-order fixture) ──
  const gcvPillar = await ensurePillar(payload, gcv, "exclusive", "Exclusive");
  const gcvShared = await ensurePillar(payload, gcv, "probe-shared", "Probe Shared (gcv)");
  const gcvAuthor = await ensureAuthor(payload, gcv, "probe2-author-gcv", "Probe2 Author gcv");
  const gd = { pillar: gcvPillar, author: gcvAuthor };
  for (let i = 0; i < 6; i++) {
    await ensureArticle(payload, gcv, gd, { slug: `probe2-null-${i}`, title: `Probe null ${i}`, publishedAt: null });
  }
  await ensureArticle(payload, gcv, gd, { slug: "probe2-gcv-dated-0", title: "Probe gcv dated 0", publishedAt: iso(2026, 4, 1) });
  await ensureArticle(payload, gcv, gd, { slug: "probe2-gcv-dated-1", title: "Probe gcv dated 1", publishedAt: iso(2026, 4, 2) });
  await ensureArticle(payload, gcv, gd, { slug: "probe2-shared-gcv", title: "Probe shared gcv", publishedAt: iso(2026, 5, 3), pillar: gcvShared });

  const gcvNull = (
    await payload.find({
      collection: "articles",
      where: { tenant: { equals: gcv } },
      pagination: false,
      depth: 0,
      locale: "en",
      overrideAccess: true,
      select: { publishedAt: true },
    })
  ).docs.filter((d) => (d as unknown as { publishedAt: unknown }).publishedAt == null).length;
  if (gcvNull < 6) throw new Error(`gcv has ${gcvNull} publishedAt=null articles, need >= 6`);
  console.log(`[setup2] gcv publishedAt=null articles: ${gcvNull}`);

  // ── wad: 201 pillars (taxonomy CAP 200 → truncated:true, and the default-10 trap) ──
  for (let i = 1; i <= 201; i++) {
    const n = String(i).padStart(3, "0");
    await ensurePillar(payload, wad, `probe-p-${n}`, `Probe pillar ${n}`, i);
  }

  // ── dtw tenant: give every WITHHELD field a value, so a leak is visible ──
  await payload.update({
    collection: "tenants",
    id: dtw,
    overrideAccess: true,
    context: { disableRevalidate: true },
    data: {
      additionalDomains: [{ domain: "probe.example" }],
      socials: [{ platform: "x", url: "https://x.com/probe" }],
      contact: { generalEmail: "probe@example.com", editorialEmail: "desk@example.com" },
      brand: { faviconUrl: "https://probe.example/favicon.ico", themeTokens: { accent: "#123456" } },
      seo: { titleSuffix: " — Probe", twitterHandle: "@probe" },
      dashboards: { disclaimer: { en: "probe disclaimer" }, aiMethodology: { en: "probe method" } },
    } as never,
  });

  console.log("[setup2] done");
  process.exit(0);
}

// ── Independent ordering oracle (does NOT reuse the helper's comparator) ──

/** Hand-written Postgres-order comparison for one key: DESC ⇒ NULL first,
 *  ASC ⇒ NULL last; numbers numerically, everything else as strings. */
function pgCompare(a: unknown, b: unknown, desc: boolean): number {
  const an = a == null;
  const bn = b == null;
  if (an && bn) return 0;
  if (an) return desc ? -1 : 1;
  if (bn) return desc ? 1 : -1;
  let c: number;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else c = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return desc ? -c : c;
}

/** First index i where rows[i] should come AFTER rows[i+1] under `keys`, or -1. */
function monotoneViolation(rows: Doc[], keys: string[]): number {
  for (let i = 0; i + 1 < rows.length; i++) {
    for (const k of keys) {
      const desc = k.startsWith("-");
      const f = k.replace(/^-/, "");
      const c = pgCompare((rows[i] as Doc)[f], (rows[i + 1] as Doc)[f], desc);
      if (c < 0) break;
      if (c > 0) return i;
    }
  }
  return -1;
}

function makeExpect() {
  const state = { failures: 0 };
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(wanted)}`);
    if (!ok) state.failures++;
  };
  return { state, expect };
}

type MultiFind = (args: Record<string, unknown>) => Promise<{ docs: Doc[] }>;
type Comparator = (sort: string | string[]) => (a: Doc, b: Doc) => number;

async function nullorder() {
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const gcv = need(tenants, "gcv");
  const { state, expect } = makeExpect();

  const truth = (
    await payload.find({
      collection: "articles",
      where: { tenant: { in: [dtw, gcv] } },
      sort: ["-publishedAt", "-id"],
      pagination: false,
      depth: 0,
      locale: "en",
      overrideAccess: true,
      select: { publishedAt: true },
    })
  ).docs as unknown as Doc[];
  const truthIds = truth.slice(0, 5).map((d) => d.id);
  const nullCount = truth.filter((d) => d.publishedAt == null).length;
  console.log(`[nullorder] dtw+gcv rows=${truth.length}, publishedAt=null rows=${nullCount}`);

  const multi = hubScoped.scopedFindMultiTenant as unknown as MultiFind;
  const comparator = (hubScoped as unknown as { comparatorFor?: Comparator }).comparatorFor;
  const hasComparator = typeof comparator === "function";

  const variant = async (label: string, sort?: string[]) => {
    const res = await multi({
      payload,
      collection: "articles",
      tenantIds: [dtw, gcv],
      limit: 5,
      page: 1,
      depth: 0,
      select: { publishedAt: true },
      ...(sort ? { sort, locale: "en" } : {}),
    });
    const rows = res.docs;
    expect(`${label}: page-1 ids == payload.find ground truth ["-publishedAt","-id"]`, rows.map((d) => d.id), truthIds);
    expect(`${label}: page-1 monotone (JS oracle, NULL first on DESC, then -id)`, monotoneViolation(rows, ["-publishedAt", "-id"]), -1);
  };

  // Default sort FIRST — this is the path CMS-1 exercises today.
  await variant("default sort");
  if (hasComparator) await variant('sort ["-publishedAt","-id"]', ["-publishedAt", "-id"]);
  else console.log("SKIP array-sort variant (helper cũ chỉ nhận chuỗi)");

  if (hasComparator) {
    const order = (rows: Doc[], sort: string | string[]) => [...rows].sort(comparator(sort)).map((r) => r.id);
    const dated = [
      { id: 1, publishedAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, publishedAt: null },
      { id: 3, publishedAt: "2026-02-01T00:00:00.000Z" },
    ];
    expect("comparatorFor DESC puts NULL first", order(dated, ["-publishedAt", "-id"]), [2, 3, 1]);
    expect("comparatorFor ASC puts NULL last", order(dated, ["publishedAt", "id"]), [1, 3, 2]);
    expect("comparatorFor accepts a plain string sort", order(dated, "-publishedAt"), [2, 3, 1]);
    const views = [
      { id: 1, views: 10 },
      { id: 2, views: 9 },
      { id: 3, views: 100 },
    ];
    expect("comparatorFor compares numbers numerically", order(views, ["-views", "-id"]), [3, 1, 2]);
    const ties = [
      { id: 5, publishedAt: "2026-03-01T00:00:00.000Z" },
      { id: 7, publishedAt: "2026-03-01T00:00:00.000Z" },
      { id: 6, publishedAt: "2026-03-01T00:00:00.000Z" },
    ];
    expect("comparatorFor breaks ties on the id key (DESC)", order(ties, ["-publishedAt", "-id"]), [7, 6, 5]);
    expect("comparatorFor breaks ties on the id key (ASC)", order(ties, ["publishedAt", "id"]), [5, 6, 7]);
    const mixed = [
      { id: 1, views: null, publishedAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, views: 5, publishedAt: "2026-01-02T00:00:00.000Z" },
      { id: 3, views: 5, publishedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect("comparatorFor multi-key -views,-publishedAt,-id", order(mixed, ["-views", "-publishedAt", "-id"]), [1, 3, 2]);
    expect("comparatorFor multi-key views,publishedAt,id (NULL last)", order(mixed, ["views", "publishedAt", "id"]), [2, 3, 1]);
  } else {
    console.log("SKIP comparator (chưa export)");
  }

  console.log(`\n[nullorder] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

async function check2() {
  const token = arg("token");
  const noHubToken = arg("nohub-token");
  if (!token) throw new Error("--token <hub token> required");
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const allIds = [...tenants.values()];
  const { state, expect } = makeExpect();

  const call = async (path: string, qs: string, bearer: string | undefined = token) => {
    const res = await fetch(`${BASE}/api/hub/${path}${qs}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    const text = await res.text();
    let body: Doc = {};
    try {
      body = JSON.parse(text) as Doc;
    } catch {
      body = { __raw: text };
    }
    return { status: res.status, body, text };
  };
  const arts = (b: Doc) => (b.articles ?? []) as Doc[];

  // Ground truth: every article in every tenant, locale en, no pagination.
  const all = (
    await payload.find({
      collection: "articles",
      where: { tenant: { in: allIds } },
      pagination: false,
      depth: 0,
      locale: "en",
      overrideAccess: true,
      select: { title: true, dek: true, slug: true, views: true, publishedAt: true, pillar: true, tenant: true },
    })
  ).docs as unknown as Doc[];
  console.log(`[check2] ground truth: ${all.length} articles across ${allIds.length} tenants\n`);

  // ── G-P2 key set ──
  const base = await call("articles", "?limit=200");
  expect("G-P2 /articles → 200", base.status, 200);
  const wantKeys = ["contentType", "id", "lastEditedBy", "pillar", "publishedAt", "slug", "tenant", "title", "views", "workflowStatus"];
  const keySets = [...new Set(arts(base.body).map((a) => Object.keys(a).sort().join(",")))];
  expect("G-P2 every article has exactly the contract keys", keySets, [wantKeys.join(",")]);
  const pillarKeys = [
    ...new Set(arts(base.body).map((a) => (a.pillar && typeof a.pillar === "object" ? Object.keys(a.pillar as Doc).sort().join(",") : String(a.pillar)))),
  ];
  expect("G-P2 pillar is {slug,title}", pillarKeys, ["slug,title"]);
  const viewTypes = [...new Set(arts(base.body).map((a) => (a.views === null ? "null" : typeof a.views)))].sort();
  expect("G-P2 views is number|null (null fixture visible)", viewTypes, ["null", "number"]);
  expect("G-P2 echo sort/q/pillar defaults", [base.body.sort, base.body.q, base.body.pillar], ["-publishedAt", null, []]);

  // ── G-P3 search ──
  const qTruth = (q: string) =>
    all
      .filter((d) =>
        ["title", "dek", "slug"].some((f) => typeof d[f] === "string" && (d[f] as string).toLowerCase().includes(q.toLowerCase())),
      )
      .map((d) => d.id as number)
      .sort((a, b) => a - b);
  const qRoute = async (q: string) => {
    const r = await call("articles", `?limit=200&q=${encodeURIComponent(q)}`);
    return { r, ids: arts(r.body).map((a) => a.id as number).sort((a, b) => a - b) };
  };
  const idOfSlug = (slug: string) => all.find((d) => d.slug === slug)?.id as number | undefined;
  const qCases: [string, string | null, string | null][] = [
    ["50%", "probe2-50pct", "probe2-500units"],
    ["a_b", "probe2-a-under-b", "probe2-a1b"],
    ["k\\s", "probe2-back-slash", "probe2-backslash"],
    ["zqxdekword", "probe2-dek", null],
    ["PROBE2-50PCT", "probe2-50pct", null],
  ];
  for (const [q, hit, bait] of qCases) {
    const { r, ids } = await qRoute(q);
    expect(`G-P3 q=${JSON.stringify(q)} → 200`, r.status, 200);
    expect(`G-P3 q=${JSON.stringify(q)} ids == JS ground truth`, ids, qTruth(q));
    expect(`G-P3 q=${JSON.stringify(q)} hits ${hit}`, ids.includes(idOfSlug(hit as string) as number), true);
    if (bait) expect(`G-P3 q=${JSON.stringify(q)} does NOT hit bait ${bait}`, ids.includes(idOfSlug(bait) as number), false);
    expect(`G-P3 q=${JSON.stringify(q)} echoed unescaped`, r.body.q, q);
  }
  const blank = await call("articles", "?limit=1&q=%20%20");
  expect("G-P3 q=<blank> → no filter (totalDocs == all)", [blank.status, blank.body.totalDocs, blank.body.q], [200, all.length, null]);

  // ── G-P4 bad q ──
  expect("G-P4 q=a → 400", (await call("articles", "?q=a")).status, 400);
  expect("G-P4 q=<201 chars> → 400", (await call("articles", `?q=${"x".repeat(201)}`)).status, 400);
  expect("G-P4 q=<200 chars> → 200", (await call("articles", `?q=${"x".repeat(200)}`)).status, 200);
  expect("G-P4 q with %0A → 400", (await call("articles", "?q=ab%0Acd")).status, 400);

  // ── G-P5 pillar ──
  const pillarsAll = (
    await payload.find({ collection: "pillars", pagination: false, depth: 0, locale: "en", overrideAccess: true, select: { slug: true, tenant: true } })
  ).docs as unknown as { id: number; slug: string; tenant: number }[];
  const truthByTenantForPillar = (slug: string, scope: number[]) => {
    const ids = new Set(pillarsAll.filter((p) => p.slug === slug && scope.includes(p.tenant)).map((p) => p.id));
    const out: Record<string, number> = {};
    for (const [s, tid] of tenants) {
      if (!scope.includes(tid)) continue;
      out[s] = all.filter((a) => a.tenant === tid && ids.has(a.pillar as number)).length;
    }
    return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
  };
  // Keys sorted so the JSON comparison does not depend on tenant order.
  const totalsObj = (b: Doc) =>
    Object.fromEntries(
      ((b.totalsByTenant ?? []) as { tenant: string; totalDocs: number }[])
        .map((t) => [t.tenant, t.totalDocs] as const)
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  const solo = await call("articles", "?limit=200&pillar=probe-solo");
  expect("G-P5 pillar=probe-solo → totals match DB", totalsObj(solo.body), truthByTenantForPillar("probe-solo", allIds));
  const soloNonZero = Object.entries(totalsObj(solo.body)).filter(([, n]) => (n as number) > 0).map(([s]) => s);
  expect("G-P5 pillar=probe-solo → only dtw > 0", soloNonZero, ["dtw"]);
  expect("G-P5 pillar rows carry that pillar", [...new Set(arts(solo.body).map((a) => (a.pillar as Doc | null)?.slug))], ["probe-solo"]);
  const dtwId = need(tenants, "dtw");
  const gcvId = need(tenants, "gcv");
  const shared = await call("articles", "?limit=200&pillar=probe-shared&tenants=dtw,gcv");
  const st = totalsObj(shared.body);
  expect("G-P5 pillar=probe-shared&tenants=dtw,gcv → both > 0", [(st.dtw ?? 0) > 0, (st.gcv ?? 0) > 0], [true, true]);
  expect("G-P5 probe-shared totals match DB", st, truthByTenantForPillar("probe-shared", [dtwId, gcvId]));
  const none = await call("articles", "?pillar=zzz-none");
  expect("G-P5 pillar=zzz-none → 200, 0 rows", [none.status, none.body.totalDocs, arts(none.body).length], [200, 0, 0]);
  expect("G-P5 pillar=a%25b → 400", (await call("articles", "?pillar=a%25b")).status, 400);
  expect("G-P5 pillar=<65 chars> → 400", (await call("articles", `?pillar=${"p".repeat(65)}`)).status, 400);
  expect("G-P5 pillar=<64 chars> → 200", (await call("articles", `?pillar=${"p".repeat(64)}`)).status, 200);
  const many = Array.from({ length: 21 }, (_, i) => `s${i}`).join(",");
  expect("G-P5 21 pillar slugs → 400", (await call("articles", `?pillar=${many}`)).status, 400);
  const twenty = Array.from({ length: 20 }, (_, i) => `s${i}`).join(",");
  expect("G-P5 20 pillar slugs → 200", (await call("articles", `?pillar=${twenty}`)).status, 200);
  const commas = await call("articles", "?limit=1&pillar=,,");
  expect("G-P5 pillar=,, → no filter", [commas.status, commas.body.totalDocs, commas.body.pillar], [200, all.length, []]);

  // ── G-P6 / G-P6b sort ──
  const SORTS: Record<string, string[]> = {
    "-publishedAt": ["-publishedAt", "-id"],
    publishedAt: ["publishedAt", "id"],
    "-views": ["-views", "-publishedAt", "-id"],
    views: ["views", "publishedAt", "id"],
  };
  for (const [pub, keys] of Object.entries(SORTS)) {
    const p1 = await call("articles", `?sort=${encodeURIComponent(pub)}&limit=5&page=1`);
    const p2 = await call("articles", `?sort=${encodeURIComponent(pub)}&limit=5&page=2`);
    const rows = [...arts(p1.body), ...arts(p2.body)];
    const ids = rows.map((r) => r.id);
    expect(`G-P6b sort=${pub}: echo`, p1.body.sort, pub);
    expect(`G-P6b sort=${pub}: 10 rows, no duplicate id`, [rows.length, new Set(ids).size], [10, 10]);
    expect(`G-P6b sort=${pub}: pages 1+2 monotone (JS oracle ${JSON.stringify(keys)})`, monotoneViolation(rows, keys), -1);
    if (pub === "-views") {
      const truth = (
        await payload.find({
          collection: "articles",
          where: { tenant: { in: allIds } },
          sort: keys,
          pagination: false,
          depth: 0,
          locale: "en",
          overrideAccess: true,
          select: { publishedAt: true },
        })
      ).docs.slice(0, 10).map((d) => (d as unknown as Doc).id);
      expect("G-P6 sort=-views pages 1+2 == payload.find ground truth top 10", ids, truth);
      const tied = rows.filter((r) => r.views === 900);
      expect(
        "G-P6b -views window holds >= 3 rows tied at views=900 with distinct publishedAt",
        tied.length >= 3 && new Set(tied.map((r) => r.publishedAt)).size === tied.length,
        true,
      );
    }
  }
  const bogusSort = await call("articles", "?sort=-veiws&limit=1");
  expect("G-P6 unknown sort silently falls back to -publishedAt (CMS-1 contract)", [bogusSort.status, bogusSort.body.sort], [200, "-publishedAt"]);

  // ── G-P8 /tenants ──
  const tn = await call("tenants", "");
  expect("G-P8 /tenants → 200", tn.status, 200);
  const allowedPaths = new Set([
    "ok", "locale", "missing", "missing[]", "tenants", "tenants[]",
    "tenants[].id", "tenants[].slug", "tenants[].name", "tenants[].status", "tenants[].domain",
    "tenants[].additionalDomains", "tenants[].additionalDomains[]", "tenants[].frontendUrl",
    "tenants[].logoMediaId", "tenants[].brandColor",
    "tenants[].brand", "tenants[].brand.faviconUrl", "tenants[].brand.ogImageDefaultMediaId",
    "tenants[].defaultLanguage", "tenants[].supportedLanguages", "tenants[].supportedLanguages[]", "tenants[].timezone",
    "tenants[].seo", "tenants[].seo.titleSuffix", "tenants[].seo.defaultMetaDescription",
    "tenants[].seo.defaultOgImageMediaId", "tenants[].seo.twitterHandle",
    "tenants[].socials", "tenants[].socials[]", "tenants[].socials[].platform", "tenants[].socials[].url",
    "tenants[].features",
    ...["articles", "newsletters", "podcasts", "marketData", "sponsorSlots", "wireDrops", "corrections", "translations", "dashboards", "citiesMap", "video"].map(
      (f) => `tenants[].features.${f}`,
    ),
  ]);
  const paths = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (path) paths.add(path);
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(tn.body, "");
  expect("G-P8 every JSON path is in the allowlist", [...paths].filter((p) => !allowedPaths.has(p)), []);
  for (const secret of ["readTokens", "tokenHash", "tokenPrefix", "contact", "Email", "allowedEngines", "autoPublishEngineDrafts", "themeTokens", "aiMethodology", "disclaimer", "probe@example.com", "#123456"]) {
    expect(`G-P8 raw body does not contain "${secret}"`, tn.text.includes(secret), false);
  }
  const tlist = (tn.body.tenants ?? []) as Doc[];
  expect("G-P8 no top-level dashboards key", tlist.some((t) => "dashboards" in t), false);
  expect("G-P8 one entry per allowed tenant", tlist.map((t) => t.slug).sort(), [...tenants.keys()].sort());
  const dtwT = tlist.find((t) => t.slug === "dtw") as Doc | undefined;
  expect("G-P8 allowed nested values flow (dtw socials/additionalDomains)", [dtwT?.additionalDomains, dtwT?.socials], [["probe.example"], [{ platform: "x", url: "https://x.com/probe" }]]);
  const ord = await call("tenants", "?tenants=gcv,dtw");
  expect("G-P8 order follows ?tenants=", ((ord.body.tenants ?? []) as Doc[]).map((t) => t.slug), ["gcv", "dtw"]);

  // ── G-P9 /taxonomy ──
  const tx = await call("taxonomy", "");
  expect("G-P9 /taxonomy → 200", tx.status, 200);
  const count = async (collection: "pillars" | "authors", tid: number) =>
    (await payload.find({ collection, where: { tenant: { equals: tid } }, pagination: false, depth: 0, overrideAccess: true, select: { slug: true } })).docs.length;
  for (const entry of (tx.body.tenants ?? []) as Doc[]) {
    const tid = need(tenants, entry.tenant as string);
    for (const [kind, cap] of [["pillars", 200], ["authors", 1000]] as const) {
      const block = entry[kind] as Doc;
      const truthN = await count(kind, tid);
      expect(`G-P9 ${entry.tenant} ${kind}.count == min(CAP, DB)`, [block.count, (block.items as Doc[]).length], [Math.min(cap, truthN), Math.min(cap, truthN)]);
      expect(`G-P9 ${entry.tenant} ${kind}.truncated`, block.truncated, truthN > cap);
      expect(`G-P9 ${entry.tenant} ${kind}.totalDocs == DB`, block.totalDocs, truthN);
    }
  }
  const txT = Object.fromEntries(((tx.body.tenants ?? []) as Doc[]).map((e) => [e.tenant, e]));
  const dtwAuthors = (txT.dtw as Doc | undefined)?.authors as Doc | undefined;
  expect("G-P9 dtw authors > 10 and not truncated", [(dtwAuthors?.count as number) > 10, dtwAuthors?.truncated], [true, false]);
  const wadP = (txT.wad as Doc | undefined)?.pillars as Doc | undefined;
  expect("G-P9 wad pillars count 200, truncated true, totalDocs > 200", [wadP?.count, wadP?.truncated, (wadP?.totalDocs as number) > 200], [200, true, true]);
  const authorKeys = [
    ...new Set(Object.values(txT).flatMap((e) => (((e as Doc).authors as Doc).items as Doc[]).map((a) => Object.keys(a).sort().join(",")))),
  ];
  expect("G-P9 author item keys (no user/tenant)", authorKeys, ["avatarMediaId,bio,city,id,name,rank,role,slug"]);
  const pillarItemKeys = [
    ...new Set(Object.values(txT).flatMap((e) => (((e as Doc).pillars as Doc).items as Doc[]).map((a) => Object.keys(a).sort().join(",")))),
  ];
  expect("G-P9 pillar item keys", pillarItemKeys, ["color,description,heading,icon,id,navLabel,order,slug,title"]);
  expect("G-P9 raw body has no user/email", [tx.text.includes('"user"'), tx.text.includes("email")], [false, false]);
  const kp = await call("taxonomy", "?kinds=pillars&tenants=dtw");
  expect("G-P9 kinds=pillars → authors key absent", [kp.status, "authors" in (((kp.body.tenants ?? []) as Doc[])[0] ?? {}), "pillars" in (((kp.body.tenants ?? []) as Doc[])[0] ?? {})], [200, false, true]);
  expect("G-P9 kinds=bogus → 400", (await call("taxonomy", "?kinds=bogus")).status, 400);

  // ── G-P10 auth + tenant grant on all three routes ──
  for (const path of ["articles", "tenants", "taxonomy"]) {
    expect(`G-P10 /${path} junk token → 401`, (await call(path, "", "junk-token")).status, 401);
    const d = await call(path, "?tenants=gcv,khong-co");
    expect(`G-P10 /${path} tenants=gcv,khong-co → 403 [khong-co]`, [d.status, d.body.tenants], [403, ["khong-co"]]);
    if (noHubToken) expect(`G-P10 /${path} token without hubRead → 403`, (await call(path, "", noHubToken)).status, 403);
  }

  console.log(`\n[check2] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS-3 (APCGHub P4) — the hub WRITE route POST /api/hub/articles/{id}/status.
// DISPOSABLE POSTGRES ONLY (it forces a column to NULL with raw SQL and writes
// articles). Run after the CMS-1/CMS-2 modes; independent of their fixtures.
//
//   --setup3 --out <file>   create/refresh 3 engines (hubWrite true / false /
//                           genuinely NULL), all hubRead:true, granted dtw+gcv
//                           only. Tokens go to <file> (mode 600), NEVER stdout.
//   --check3 --in <file>    real HTTP against the dev server (HUB_PROBE_BASE) for
//                           AC1–AC12, AC21, AC22 + Local API for AC18–AC20, AC23.
//                           Creates FRESH articles every run (unique slugs), so
//                           it can be re-run under each red-first mutation.
//            [--hooks-only] only the Local-API shared-hook sections (AC18–AC20,
//                           AC23) — no dev server needed; prints OBS lines meant
//                           to be diffed between the pre-CMS-3 hook and this one.
// ─────────────────────────────────────────────────────────────────────────────

const W_ENGINES = { write: "apcghub-cms3-write", nowrite: "apcghub-cms3-nowrite", nullwrite: "apcghub-cms3-nullwrite" } as const;
type W_Tokens = { write: string; nowrite: string; nullwrite: string };

function rawDb(payload: P) {
  // Payload.db is typed as the base adapter (no `.drizzle`); same cast as
  // scripts/wad-audit-fixes{,-pass2,-pass3}.ts.
  return (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle;
}

async function forceHubWriteNull(payload: P, engineId: number): Promise<void> {
  const db = rawDb(payload);
  await db.execute(sql`UPDATE content_engines SET hub_write = NULL WHERE id = ${engineId}`);
  const res = (await db.execute(
    sql`SELECT (hub_write IS NULL) AS is_null FROM content_engines WHERE id = ${engineId}`,
  )) as { rows?: { is_null: boolean }[] };
  if (res.rows?.[0]?.is_null !== true) {
    console.error(`[setup3] FATAL: content_engines.hub_write is not NULL for engine ${engineId} — AC22 fixture invalid`);
    process.exit(1);
  }
}

async function engineIdByName(payload: P, name: string): Promise<number | undefined> {
  const r = await payload.find({ collection: "content-engines", where: { name: { equals: name } }, limit: 1, depth: 0, overrideAccess: true });
  return (r.docs[0] as unknown as { id: number } | undefined)?.id;
}

async function setup3() {
  const out = arg("out");
  if (!out) throw new Error("--out <file> required (tokens are written there, never printed)");
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const grant = [need(tenants, "dtw"), need(tenants, "gcv")];
  need(tenants, "wad"); // must exist, deliberately NOT granted (AC8)

  const tokens = {} as W_Tokens;
  const flags: Record<keyof W_Tokens, boolean> = { write: true, nowrite: false, nullwrite: false };
  for (const key of Object.keys(W_ENGINES) as (keyof W_Tokens)[]) {
    const name = W_ENGINES[key];
    const token = randomBytes(24).toString("hex");
    tokens[key] = token;
    const data = { rawToken: token, hubRead: true, hubWrite: flags[key], status: "active", allowedTenants: grant };
    const id = await engineIdByName(payload, name);
    if (id != null) {
      await payload.update({ collection: "content-engines", id, overrideAccess: true, data: data as never });
    } else {
      await payload.create({
        collection: "content-engines",
        overrideAccess: true,
        data: { name, engineType: "other", allowedActions: ["import"], ...data } as never,
      });
    }
    console.log(`[setup3] engine ${name}: hubRead=true hubWrite=${key === "nullwrite" ? "NULL (forced below)" : flags[key]}`);
  }
  // create() fills defaultValue:false for an absent checkbox, so NULL needs raw SQL.
  const nullId = await engineIdByName(payload, W_ENGINES.nullwrite);
  if (nullId == null) throw new Error("nullwrite engine missing after create");
  await forceHubWriteNull(payload, nullId);
  console.log(`[setup3] engine ${W_ENGINES.nullwrite}: SELECT hub_write IS NULL → true`);

  writeFileSync(out, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`[setup3] tokens written to ${out} (not printed). grant = dtw,gcv (wad deliberately excluded)`);
  process.exit(0);
}

async function check3() {
  const inFile = arg("in");
  const hooksOnly = flag("hooks-only");
  const tokens = inFile ? (JSON.parse(readFileSync(inFile, "utf8")) as W_Tokens) : undefined;
  if (!hooksOnly && !tokens) throw new Error("--in <file from --setup3> required (or --hooks-only)");
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const gcv = need(tenants, "gcv");
  const { state, expect } = makeExpect();
  const obs = (label: string, v: unknown) => console.log(`OBS   ${label}  ${JSON.stringify(v)}`);
  const stamp = Date.now().toString(36);

  const admin = (
    await payload.find({ collection: "users", where: { role: { equals: "systemAdmin" } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as (Doc & { id: number }) | undefined;
  if (!admin) throw new Error("no systemAdmin user — run `npm run db:seed` first");

  const firstPillar = async (tenantId: number) => {
    const p = (await payload.find({ collection: "pillars", where: { tenant: { equals: tenantId } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
    if (!p) throw new Error(`tenant ${tenantId} has no pillar`);
    return p.id;
  };
  const defs = new Map<number, { pillar: number; author: number }>();
  for (const t of [dtw, gcv]) {
    defs.set(t, { pillar: await firstPillar(t), author: await ensureAuthor(payload, t, "cms3-probe-author", "CMS-3 Probe Author") });
  }

  type Shape = "imported" | "natural";
  const mk = async (tenantId: number, key: string, shape: Shape, workflowStatus: ArticleStatus, context?: Record<string, unknown>) => {
    const d = defs.get(tenantId)!;
    const data = {
      tenant: tenantId,
      title: `CMS3 ${key} ${stamp}`,
      dek: `dek ${key}`,
      slug: `cms3-${key}-${stamp}`,
      pillar: d.pillar,
      author: d.author,
      workflowStatus,
      publishedAt: iso(2026, 9, 1),
      ...(shape === "natural" ? { _status: "published" } : {}),
    };
    const created = (await payload.create({
      collection: "articles",
      overrideAccess: true,
      locale: "en",
      ...(shape === "imported" ? { draft: true } : {}),
      ...(context ? { context } : {}),
      data: data as never,
    })) as unknown as { id: number };
    return created.id;
  };
  const read = async (id: number) =>
    (await payload.findByID({ collection: "articles", id, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
  const snap = async (id: number) => {
    const d = await read(id);
    return {
      workflowStatus: d.workflowStatus,
      _status: d._status,
      version: d.version,
      title: d.title,
      dek: d.dek,
      pillar: d.pillar,
      author: d.author,
      publishedAt: d.publishedAt,
      editedByHuman: d.editedByHuman ?? null,
    };
  };
  const actRows = async (id: number) =>
    (
      await payload.find({
        collection: "activityLog",
        where: { and: [{ targetCollection: { equals: "articles" } }, { targetId: { equals: String(id) } }] },
        sort: "id",
        pagination: false,
        depth: 0,
        overrideAccess: true,
      })
    ).docs as unknown as Doc[];
  const jobCount = async (id: number) =>
    (await payload.count({ collection: "translationJobs", where: { article: { equals: id } }, overrideAccess: true })).totalDocs;
  const publicVisible = async (tenantId: number, id: number) => {
    const d = await read(id);
    // Same where-clause as /api/public/articles/[slug] (tenant-scoped + workflowStatus).
    const r = await payload.find({
      collection: "articles",
      where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: d.slug } }, { workflowStatus: { equals: "published" } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    return r.docs.length === 1;
  };
  /** A human Payload-admin Publish/Publish-changes save: real `user`, access
   *  enforced, `_status:'published'`, the workflowStatus select posted UNCHANGED,
   *  and every content field posted with its STORED value (not a sparse patch). */
  const humanPublishSave = async (id: number, extra: Doc = {}) => {
    const d = await read(id);
    return payload.update({
      collection: "articles",
      id,
      locale: "en",
      overrideAccess: false,
      user: admin as never,
      data: { title: d.title, dek: d.dek, body: d.body, slug: d.slug, workflowStatus: d.workflowStatus, _status: "published", ...extra } as never,
    });
  };
  /** A translation engine completing every target locale at the CURRENT version
   *  (mirrors /api/engine/translation's sidecar write). */
  const completeTranslations = async (id: number) => {
    const d = await read(id);
    const version = d.version as number;
    const rows = (["vi", "id"] as const).map((locale) => ({ locale, state: "machine_translated", sourceVersionAtTranslation: version }));
    await payload.update({
      collection: "articles",
      id,
      overrideAccess: true,
      data: { translationStatus: rows } as never,
      context: { translationWrite: true, skipTranslationEnqueue: true },
    });
  };

  // ── Pure: transition table (hub-transition.ts) ──
  const allowed = new Set(["published>archived", "hidden>published", "archived>published"]);
  const bad: string[] = [];
  for (const f of ARTICLE_STATUSES) for (const t of ARTICLE_STATUSES) {
    if (isValidTransition(f, t) !== allowed.has(`${f}>${t}`)) bad.push(`${f}>${t}`);
  }
  expect("T-PURE isValidTransition matches exactly {published→archived, hidden→published, archived→published}", bad, []);

  // ── AC18–AC20: shared hook, NON-hub write contexts, via Local API ──
  // AC18 human write (req.user present).
  const h = await mk(dtw, "h18", "natural", "published");
  const h0 = await snap(h);
  await payload.update({ collection: "articles", id: h, locale: "en", overrideAccess: false, user: admin as never, data: { title: `CMS3 h18 edited ${stamp}`, _status: "published" } as never });
  const h1 = await snap(h);
  const hDoc = await read(h);
  obs("AC18 human edit: versionDelta,editedByHuman,lastEditedByIsAdmin,workflowStatus", [(h1.version as number) - (h0.version as number), h1.editedByHuman, hDoc.lastEditedBy === admin.id, h1.workflowStatus]);
  expect("AC18 human edit → editedByHuman true, lastEditedBy = admin, version bumped", [h1.editedByHuman, hDoc.lastEditedBy === admin.id, (h1.version as number) > (h0.version as number)], [true, true, true]);
  // AC18 + PR #20: human Unpublish → hidden, then Publish-save revives → published; actorType human.
  const r20 = await mk(dtw, "r20", "natural", "published");
  const beforeR20 = (await actRows(r20)).length;
  await payload.update({ collection: "articles", id: r20, locale: "en", overrideAccess: false, user: admin as never, data: { _status: "draft" } as never });
  const r20a = await snap(r20);
  await humanPublishSave(r20);
  const r20b = await snap(r20);
  const r20rows = (await actRows(r20)).slice(beforeR20).filter((r) => r.eventType !== "translation_queued");
  obs("AC18 PR#20 round trip: afterUnpublish,afterPublishSave,events", [r20a.workflowStatus, r20b.workflowStatus, r20rows.map((r) => `${r.eventType}/${r.actorType}/${r.fromStatus}>${r.toStatus}`)]);
  expect("AC18 PR#20 human Unpublish → hidden, human Publish-save → published, both actorType human", [r20a.workflowStatus, r20b.workflowStatus, r20rows.map((r) => r.actorType)], ["hidden", "published", ["human", "human"]]);

  // AC19 engine intake write (context.engineWrite) — create, then refreshExisting-shaped update.
  const writeEngineId = (await engineIdByName(payload, W_ENGINES.write)) ?? null;
  if (writeEngineId == null) throw new Error("run --setup3 first (its write engine is the provenance id here)");
  const eng = writeEngineId;
  const e = await mk(dtw, "e19", "natural", "published", { engineWrite: true, engineId: eng, processingVersion: "p-1" });
  const eCreate = (await actRows(e)).find((r) => r.eventType === "article_created");
  const e0 = await snap(e);
  await payload.update({
    collection: "articles",
    id: e,
    locale: "en",
    overrideAccess: true,
    context: { engineWrite: true, engineId: eng, processingVersion: "p-2" },
    data: { title: `CMS3 e19 refreshed ${stamp}`, engineSourceUrl: `https://example.invalid/${stamp}` } as never,
  });
  const e1 = await snap(e);
  const eDoc = await read(e);
  obs("AC19 engine: createActorType,editedByHuman,lastEngineMatches,processingVersion,versionDelta,workflowStatus", [eCreate?.actorType, e1.editedByHuman, eDoc.lastEngine === eng, eDoc.processingVersion, (e1.version as number) - (e0.version as number), e1.workflowStatus]);
  expect("AC19 engine refresh → actorType engine, editedByHuman false, lastEngine/processingVersion stamped, workflowStatus untouched", [eCreate?.actorType, e1.editedByHuman, eDoc.lastEngine === eng, eDoc.processingVersion, e1.workflowStatus], ["engine", false, true, "p-2", "published"]);

  // AC20 translation write (context.translationWrite) — early return before the version bump.
  const t0 = await snap(e);
  await completeTranslations(e);
  const t1 = await snap(e);
  obs("AC20 translation write: versionDelta,editedByHuman", [(t1.version as number) - (t0.version as number), t1.editedByHuman]);
  expect("AC20 translation write → version unchanged, editedByHuman unchanged", [t1.version, t1.editedByHuman], [t0.version, t0.editedByHuman]);

  // ── AC23 (Local API part): hub-archived article is NOT revived by a human Publish-save ──
  // Control first: a naturally hidden article IS revived by the identical save (PR #20).
  const ctl = await mk(dtw, "c23", "natural", "published");
  await payload.update({ collection: "articles", id: ctl, locale: "en", overrideAccess: false, user: admin as never, data: { _status: "draft" } as never });
  const ctlHidden = (await snap(ctl)).workflowStatus;
  await humanPublishSave(ctl);
  const ctlAfter = await snap(ctl);
  expect("AC23 control: naturally hidden article + human Publish-save → published", [ctlHidden, ctlAfter.workflowStatus], ["hidden", "published"]);
  // Main case: archive it exactly as the route does (Local API, same context), then the same save.
  const a23 = await mk(dtw, "a23", "natural", "published");
  await payload.update({
    collection: "articles",
    id: a23,
    overrideAccess: true,
    data: { workflowStatus: "archived" } as never,
    context: { hubWrite: { actor: { email: "probe@example.com", role: "editor" }, reason: "AC23 probe hide" }, engineId: eng },
  });
  const a23Archived = await snap(a23);
  await humanPublishSave(a23);
  const a23After = await snap(a23);
  const a23Doc = await read(a23);
  const outdated = ((a23Doc.translationStatus ?? []) as Doc[]).filter((r) => r.state === "outdated").length;
  expect("AC23 hub-archived article + human Publish-save → STAYS archived, _status published, no row marked outdated (fixture mirrors content)", [a23Archived.workflowStatus, a23After.workflowStatus, a23After._status, outdated], ["archived", "archived", "published", 0]);

  if (hooksOnly) {
    console.log(`\n[check3 --hooks-only] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
    process.exit(state.failures === 0 ? 0 : 1);
  }
  if (!tokens || writeEngineId == null) throw new Error("run --setup3 first");
  const nullEngineId = (await engineIdByName(payload, W_ENGINES.nullwrite))!;

  // ── HTTP ──
  const post = async (id: number | string, body: unknown, bearer: string | undefined = tokens.write) => {
    const res = await fetch(`${BASE}/api/hub/articles/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Doc = {};
    try {
      json = JSON.parse(text) as Doc;
    } catch {
      json = { __raw: text.slice(0, 200) };
    }
    return { status: res.status, body: json, text };
  };
  const actor = { email: "operator@example.com", role: "editor", id: "hub-user-7" };
  const req = (tenant: string, to: string, expectedStatus: string, reason = "probe reason ok", extra: Doc = {}) => ({ tenant, to, expectedStatus, reason, actor, ...extra });
  /** A call that must be refused: status/body as expected, article untouched, 0 new ActivityLog rows. */
  const refused = async (label: string, id: number, body: unknown, wantStatus: number, wantCode: string, bearer?: string) => {
    const before = await snap(id);
    const rowsBefore = (await actRows(id)).length;
    const r = await post(id, body, bearer);
    const after = await snap(id);
    const rowsAfter = (await actRows(id)).length;
    expect(`${label} → ${wantStatus} ${wantCode}, no write, no ActivityLog row`, [r.status, r.body.status, after, rowsAfter - rowsBefore], [wantStatus, wantCode, before, 0]);
    return r;
  };
  // jsonb does not keep key order — compare structure, not serialization.
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Doc).sort().map((k) => [k, canon((v as Doc)[k])])) : v;
  /** A successful hub call: 200 + response contract + exactly ONE status ActivityLog row with actor/reason.
   *  `newJobs` = translation jobs this call may legitimately create: 0, except an article going live for
   *  the FIRST time (never published → no job ever queued), where enqueueTranslations queues one per target
   *  locale and logs one `translation_queued` row per job (pre-existing behavior, not hub-specific). */
  const hub = async (label: string, tenantSlug: string, tenantId: number, id: number, to: "archived" | "published", reason = "probe reason ok", newJobs = 0) => {
    const before = await snap(id);
    const jobsBefore = await jobCount(id);
    const rowsBefore = (await actRows(id)).length;
    const r = await post(id, req(tenantSlug, to, before.workflowStatus as string, reason));
    const after = await snap(id);
    const allNew = (await actRows(id)).slice(rowsBefore);
    const newRows = allNew.filter((r) => r.eventType !== "translation_queued");
    const queuedRows = allNew.length - newRows.length;
    expect(`${label} → 200 {ok,id,tenant,from,to,workflowStatus}`, r.body, { ok: true, id, tenant: tenantSlug, from: before.workflowStatus, to, workflowStatus: to });
    expect(`${label} → only workflowStatus changed (_status/version/title/dek/pillar/author/publishedAt/editedByHuman identical)`, after, { ...before, workflowStatus: to });
    const row = newRows[0] ?? {};
    const actorEngine = typeof row.actorEngine === "object" && row.actorEngine ? (row.actorEngine as Doc).id : row.actorEngine;
    expect(`${label} → exactly 1 status ActivityLog row: eventType/actorType/actorEngine/from/to/detail`, [newRows.length, row.eventType, row.actorType, actorEngine, row.fromStatus, row.toStatus, canon(row.detail)], [1, to === "archived" ? "article_archived" : "article_published", "engine", writeEngineId, before.workflowStatus, to, canon({ via: "hub", actor, reason: reason.trim() })]);
    expect(`${label} → public visibility = (workflowStatus === published)`, await publicVisible(tenantId, id), to === "published");
    const jobsDelta = (await jobCount(id)) - jobsBefore;
    expect(`${label} → new translation_jobs = ${newJobs} (and one translation_queued row per job, no other extra row)`, [jobsDelta, queuedRows], [newJobs, newJobs]);
    return r;
  };

  // Fixtures on dtw (granted) + one on gcv (granted; used for the cross-tenant 404).
  const imp = await mk(dtw, "imp", "imported", "published"); // AC1: _status draft + workflowStatus published
  const nat = await mk(dtw, "nat", "natural", "published"); // AC2 / AC6
  await completeTranslations(nat); // translations up to date at the CURRENT version
  const hid = await mk(dtw, "hid", "natural", "published");
  await payload.update({ collection: "articles", id: hid, locale: "en", overrideAccess: false, user: admin as never, data: { _status: "draft" } as never }); // native Unpublish → hidden
  const arc = await mk(dtw, "arc", "natural", "archived");
  const drf = await mk(dtw, "drf", "imported", "draft");
  const other = await mk(gcv, "gcv", "natural", "published");
  expect("fixtures: imp/nat/hid/arc/drf states", [(await snap(imp))._status, (await snap(nat))._status, (await snap(hid)).workflowStatus, (await snap(arc)).workflowStatus, (await snap(drf)).workflowStatus], ["draft", "published", "hidden", "archived", "draft"]);

  // AC22 first (before any call stamps lastSeen on that engine): hubWrite genuinely NULL → 403.
  await forceHubWriteNull(payload, nullEngineId);
  expect("AC22 fixture: content_engines.hub_write IS NULL (hard-checked in forceHubWriteNull)", true, true);
  await refused("AC22 hubWrite NULL key", nat, req("dtw", "archived", "published"), 403, "forbidden", tokens.nullwrite);
  // AC7: hubRead but hubWrite false.
  await refused("AC7 hubWrite false key", nat, req("dtw", "archived", "published"), 403, "forbidden", tokens.nowrite);
  // 401s.
  await refused("401 no bearer", nat, req("dtw", "archived", "published"), 401, "unauthorized", "");
  await refused("401 junk bearer", nat, req("dtw", "archived", "published"), 401, "unauthorized", "junk-token");

  // AC21: unknown keys (top-level and inside actor).
  await refused("AC21 unknown top-level key", nat, req("dtw", "archived", "published", "probe reason ok", { title: "pwned" }), 400, "bad_request");
  await refused("AC21 unknown actor key", nat, { ...req("dtw", "archived", "published"), actor: { ...actor, isAdmin: true } }, 400, "bad_request");
  // Body shape.
  await refused("400 tenant missing", nat, { to: "archived", expectedStatus: "published", reason: "probe reason ok", actor }, 400, "bad_request");
  await refused("400 tenant empty", nat, req("", "archived", "published"), 400, "bad_request");
  await refused("400 tenant blank", nat, req("   ", "archived", "published"), 400, "bad_request");
  await refused("400 tenant not a string", nat, req(["dtw"] as never, "archived", "published"), 400, "bad_request");
  await refused("400 invalid JSON", nat, "{not json", 400, "bad_request");
  await refused("400 array body", nat, [req("dtw", "archived", "published")], 400, "bad_request");
  await refused("400 expectedStatus bogus", nat, req("dtw", "archived", "bogus"), 400, "bad_request");
  await refused("400 actor missing email", nat, { ...req("dtw", "archived", "published"), actor: { role: "editor" } }, 400, "bad_request");
  await refused("400 actor missing role", nat, { ...req("dtw", "archived", "published"), actor: { email: "x@example.com" } }, 400, "bad_request");
  // AC12: reason 5–500 after trim.
  await refused("AC12 reason 4 chars", nat, req("dtw", "archived", "published", "abcd"), 400, "bad_request");
  await refused("AC12 reason 4 chars padded", nat, req("dtw", "archived", "published", "   abcd   "), 400, "bad_request");
  await refused("AC12 reason 501 chars", nat, req("dtw", "archived", "published", "x".repeat(501)), 400, "bad_request");
  await refused("AC12 reason missing", nat, { tenant: "dtw", to: "archived", expectedStatus: "published", actor }, 400, "bad_request");

  // AC8: tenant outside the grant → 403 with the (non-empty) allowed list.
  const t8 = await refused("AC8 tenant wad (not granted)", nat, req("wad", "archived", "published"), 403, "forbidden");
  expect("AC8 allowedTenants lists the grant, never empty", t8.body.allowedTenants, ["dtw", "gcv"]);
  // AC9: article in another tenant ≡ nonexistent article, byte for byte.
  const r9a = await refused("AC9 gcv article addressed as dtw", other, req("dtw", "archived", "published"), 404, "not_found");
  const r9b = await post(2147483000, req("dtw", "archived", "published"));
  const r9c = await post("abc", req("dtw", "archived", "published"));
  expect("AC9 404 bodies byte-identical (other tenant / nonexistent id / non-numeric id)", [r9a.text === r9b.text, r9a.text === r9c.text, r9b.status, r9c.status], [true, true, 404, 404]);

  // AC11: every pair outside the table → 422 (expectedStatus always correct).
  await refused("AC11 published→published", nat, req("dtw", "published", "published"), 422, "invalid_transition");
  await refused("AC11 hidden→hidden", hid, req("dtw", "hidden", "hidden"), 422, "invalid_transition");
  await refused("AC11 archived→archived", arc, req("dtw", "archived", "archived"), 422, "invalid_transition");
  await refused("AC11 draft→archived", drf, req("dtw", "archived", "draft"), 422, "invalid_transition");
  await refused("AC11 draft→published", drf, req("dtw", "published", "draft"), 422, "invalid_transition");
  await refused("AC11 published→hidden", nat, req("dtw", "hidden", "published"), 422, "invalid_transition");
  await refused("AC11 hidden→archived", hid, req("dtw", "archived", "hidden"), 422, "invalid_transition");
  await refused("AC11 to=bogus", nat, req("dtw", "bogus", "published"), 422, "invalid_transition");
  // AC10: valid transition, stale expectedStatus → 409 + real currentStatus.
  const r10 = await refused("AC10 expectedStatus stale", arc, req("dtw", "published", "hidden"), 409, "conflict");
  expect("AC10 409 carries the real currentStatus", r10.body.currentStatus, "archived");

  // AC1 / AC2 / AC3 / AC4 / AC5 / AC6 — the happy paths.
  await hub("AC1 Ẩn imported-shape (_status draft)", "dtw", dtw, imp, "archived");
  await hub("AC3 Đăng lại archived→published (imported-shape)", "dtw", dtw, imp, "published", "abcde"); // reason exactly 5
  const natV = (await snap(nat)).version;
  const natJobs = await jobCount(nat);
  await hub("AC2 Ẩn natural (_status published)", "dtw", dtw, nat, "archived", "y".repeat(500)); // reason exactly 500
  await hub("AC3 Đăng lại archived→published (natural, translations current)", "dtw", dtw, nat, "published", "  padded reason  ");
  expect("AC6 natural article after Ẩn+Đăng lại: version unchanged, 0 new translation_jobs", [(await snap(nat)).version, await jobCount(nat)], [natV, natJobs]);
  await hub("AC3 Đăng lại hidden→published (native-unpublished article)", "dtw", dtw, hid, "published");
  // Created archived = never published, so no translation was ever queued: going live for the first
  // time queues vi + id exactly as any first publication does (version still unchanged — see hub()).
  await hub("AC3 Đăng lại archived→published (created archived, first time live)", "dtw", dtw, arc, "published", "probe reason ok", 2);

  // AC23 over the real route: hub Ẩn, then a human Publish-save must not revive it.
  const a23h = await mk(dtw, "a23h", "natural", "published");
  await hub("AC23 route Ẩn", "dtw", dtw, a23h, "archived");
  await humanPublishSave(a23h);
  expect("AC23 route-archived + human Publish-save → stays archived, not public", [(await snap(a23h)).workflowStatus, await publicVisible(dtw, a23h)], ["archived", false]);

  console.log(`\n[check3] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

const run = flag("setup")
  ? setup
  : flag("check")
    ? check
    : flag("paging")
      ? paging
      : flag("setup2")
        ? setup2
        : flag("nullorder")
          ? nullorder
          : flag("check2")
            ? check2
            : flag("setup3")
              ? setup3
              : flag("check3")
                ? check3
                : null;
if (!run) {
  console.error(
    "usage: tsx scripts/hub-probe.ts --setup | --check --token <t> [--nohub-token <t>] | --paging [--token <t>] | --setup2 | --nullorder | --check2 --token <t> [--nohub-token <t>] | --setup3 --out <file> | --check3 --in <file> [--hooks-only]",
  );
  process.exit(2);
}
run().catch((err) => {
  console.error("[probe] failed", err);
  process.exit(1);
});
