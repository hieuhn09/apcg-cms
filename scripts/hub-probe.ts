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
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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

// ─────────────────────────────────────────────────────────────────────────────
// CMS-4 (APCGHub P4) — the hub READ route GET /api/hub/articles/{id}?tenant=.
// DISPOSABLE POSTGRES ONLY (raw SQL writes into articles / articles_locales).
//
//   --setup4 --out <file>   create/refresh 2 engines (hubRead true / false),
//                           granted dtw+gcv only (wad deliberately excluded).
//                           Tokens go to <file> (mode 600), NEVER stdout.
//   --check4 --in <file>    unit checks of the body wrapper + sanitizer (no
//                           server needed), then real HTTP against the dev
//                           server (HUB_PROBE_BASE) for AC1–AC13, AC18, AC19.
//                           Creates FRESH fixtures every run (unique slugs), so
//                           it can be re-run under each red-first mutation.
//            [--unit-only]  only the in-process checks.
// ─────────────────────────────────────────────────────────────────────────────

const R_ENGINES = { read: "apcghub-cms4-read", noread: "apcghub-cms4-noread" } as const;
type R_Tokens = { read: string; noread: string };

async function setup4() {
  const out = arg("out");
  if (!out) throw new Error("--out <file> required (tokens are written there, never printed)");
  const payload = await getPayload({ config });
  const tenants = await tenantsBySlug(payload);
  const grant = [need(tenants, "dtw"), need(tenants, "gcv")];
  need(tenants, "wad"); // must exist, deliberately NOT granted (AC3)
  const tokens = {} as R_Tokens;
  for (const key of Object.keys(R_ENGINES) as (keyof R_Tokens)[]) {
    const name = R_ENGINES[key];
    const token = randomBytes(24).toString("hex");
    tokens[key] = token;
    const data = { rawToken: token, hubRead: key === "read", hubWrite: false, status: "active", allowedTenants: grant };
    const id = await engineIdByName(payload, name);
    if (id != null) await payload.update({ collection: "content-engines", id, overrideAccess: true, data: data as never });
    else
      await payload.create({
        collection: "content-engines",
        overrideAccess: true,
        data: { name, engineType: "other", allowedActions: ["import"], ...data } as never,
      });
    console.log(`[setup4] engine ${name}: hubRead=${key === "read"} hubWrite=false grant=dtw,gcv`);
  }
  writeFileSync(out, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`[setup4] tokens written to ${out} (not printed)`);
  process.exit(0);
}

// Lexical JSON builders (hand-built editor state, as in the CMS-4 FEASIBILITY probe).
const lx = {
  text: (text: string, format = 0) => ({ type: "text", version: 1, text, format, detail: 0, mode: "normal", style: "" }),
  el: (type: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
    type, version: 1, direction: "ltr", format: "", indent: 0, children, ...extra,
  }),
  p: (...children: unknown[]) => lx.el("paragraph", children, { textFormat: 0, textStyle: "" }),
  link: (url: string, label: string) =>
    lx.el("link", [lx.text(label)], { version: 3, id: randomBytes(6).toString("hex"), fields: { linkType: "custom", url, newTab: false } }),
  upload: (relationTo: string, value: number) => ({ type: "upload", version: 3, format: "", id: randomBytes(6).toString("hex"), fields: null, relationTo, value }),
  rel: (relationTo: string, value: number) => ({ type: "relationship", version: 2, format: "", relationTo, value }),
  root: (...children: unknown[]) => ({ root: lx.el("root", children) }),
};

const DETAIL_KEYS = [
  "author", "bodyMarkdown", "bodyState", "coAuthors", "contentType", "dek", "heroImage", "id", "pillar", "publishedAt",
  "readMin", "slug", "subSection", "tags", "takeaways", "tenant", "title", "updatedAt", "video", "views", "workflowStatus",
];

// 1×1 PNG, and a minimal ISO-BMFF `ftyp` header (detected as video/mp4).
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const MP4_STUB = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.from([0, 0, 0, 0]), Buffer.from("mp42isom"),
  Buffer.from([0, 0, 0, 8]), Buffer.from("free"),
]);

async function check4() {
  const unitOnly = flag("unit-only");
  const inFile = arg("in");
  const tokens = inFile ? (JSON.parse(readFileSync(inFile, "utf8")) as R_Tokens) : undefined;
  if (!unitOnly && !tokens) throw new Error("--in <file from --setup4> required (or --unit-only)");
  const payload = await getPayload({ config });
  const { state, expect } = makeExpect();
  const obs = (label: string, v: unknown) => console.log(`OBS   ${label}  ${JSON.stringify(v)}`);
  const md = await import("../src/lib/hub-article-markdown");
  const sel = await import("../src/lib/hub-article-detail-select");
  const loadCfg = () => md.loadHubEditorConfig(payload.config);
  // A throw escaping the wrapper is itself a failure: record it and keep going,
  // so one mutation cannot hide every later check.
  type BodyOpts = Parameters<typeof md.hubArticleBodyToMarkdown>[1];
  const wrap = async (data: unknown, opts: BodyOpts): Promise<Partial<Awaited<ReturnType<typeof md.hubArticleBodyToMarkdown>>> & { threw?: string }> => {
    try { return await md.hubArticleBodyToMarkdown(data, opts); } catch (err) { return { threw: (err as Error).name }; }
  };

  // ── Unit: body wrapper (checklist step 1) ─────────────────────────────────
  let calls = 0;
  const spy = (() => { calls++; return "x"; }) as never;
  for (const [label, data] of [
    ["null", null], ["undefined", undefined], ["no root", {}], ["root without children", { root: { type: "root" } }],
    ["root, 0 children", lx.root()], ["root, one empty paragraph", lx.root(lx.p())],
  ] as const) {
    const r = await wrap(data, { loadEditorConfig: loadCfg, convert: spy });
    expect(`AC18 unit ${label} → empty`, [r.bodyState, r.bodyMarkdown], ["empty", ""]);
  }
  expect("AC18 unit converter never called for empty bodies", calls, 0);

  let threw = false;
  let rThrow: unknown;
  try {
    rThrow = await md.hubArticleBodyToMarkdown(lx.root(lx.p(lx.text("secret body text"))), {
      loadEditorConfig: loadCfg,
      convert: (() => { throw new Error("secret body text"); }) as never,
    });
  } catch { threw = true; }
  expect("AC19 unit forced converter throw does not escape the wrapper", threw, false);
  const rt = rThrow as { bodyState?: string; bodyMarkdown?: string; error?: Record<string, unknown> } | undefined;
  expect("AC19 unit forced throw → error, empty markdown", [rt?.bodyState, rt?.bodyMarkdown], ["error", ""]);
  expect("AC19 unit error detail carries no body text / message", JSON.stringify(rt?.error ?? {}).includes("secret"), false);
  {
    const r = await wrap(lx.root(lx.p(lx.text("x"))), { loadEditorConfig: () => Promise.reject(new Error("cfg")) });
    expect("AC19 unit editor-config failure → error, does not escape", [r.bodyState, r.threw], ["error", undefined]);
  }

  const nonEmpty = lx.root(lx.p(lx.text("x")));
  for (const bad of ["[a](javascript:alert(1))", "[a](JaVaScRiPt:alert(1))", "[a]( javascript:alert(1))", "[a](vbscript:x)", "[a](data:text/html,<script>alert(1)</script>)"]) {
    const r = await wrap(nonEmpty, { loadEditorConfig: loadCfg, convert: (() => `ok ${bad}`) as never });
    expect(`AC7 unit scrub blocks ${bad}`, [r.bodyState, r.bodyMarkdown, r.error?.kind], ["error", "", "dangerous_link"]);
  }
  {
    const r = await wrap(nonEmpty, { loadEditorConfig: loadCfg, convert: (() => "  \n") as never });
    expect("AC19 unit non-empty body converted to nothing → error", [r.bodyState, r.bodyMarkdown, r.error?.name], ["error", "", "EmptyConversionOutput"]);
  }
  for (const good of ["[a](https://example.com)", "![a](data:image/png;base64,AAAA)", "text about javascript: in prose"]) {
    const r = await wrap(nonEmpty, { loadEditorConfig: loadCfg, convert: (() => good) as never });
    expect(`AC7 unit scrub keeps ${good}`, [r.bodyState, r.bodyMarkdown], ["ok", good]);
  }

  // ── Unit: sanitizer (checklist step 2) ────────────────────────────────────
  const hostile = {
    id: 7, title: "T", slug: "s", dek: "d", workflowStatus: "hidden", publishedAt: null, updatedAt: "2026-09-25T00:00:00.000Z",
    contentType: "article", readMin: 3, takeaways: "one\n\n two \n", views: null,
    tenant: { id: 1, slug: "dtw", readTokens: [{ token: "LEAK-readtoken" }] },
    lastEngine: { id: 9, tokenHash: "LEAK-hash", tokenPrefix: "LEAK-pfx" },
    assignedTo: { id: 2, email: "LEAK@example.test" },
    lastEditedBy: { id: 2, email: "LEAK2@example.test" },
    translationStatus: [{ locale: "vi", state: "done" }],
    author: { id: 3, name: "A", role: "R", email: "LEAK3@example.test", user: { email: "LEAK4@example.test" } },
    coAuthors: [{ id: 4, name: "B", role: null, bio: "LEAK-bio" }, 5],
    tags: [{ id: 6, slug: "t", title: "Tag", tenant: { readTokens: "LEAK-tag" } }],
    pillar: 99, subSection: null,
    heroImage: { id: 8, url: "/u.png", alt: "alt", caption: null, credit: "c", tenant: { readTokens: "LEAK-media" } },
    body: { root: "LEAK-body" },
  } as Record<string, unknown>;
  const s = sel.sanitizeHubArticleDetail(hostile, "dtw", { bodyMarkdown: "", bodyState: "empty" });
  expect("AC6 unit sanitizer emits exactly the allowlisted keys", Object.keys(s).sort(), DETAIL_KEYS);
  expect("AC6 unit sanitizer output has no LEAK marker", JSON.stringify(s).includes("LEAK"), false);
  expect("AC6 unit takeaways split per line", s.takeaways, ["one", "two"]);
  expect("AC11 unit unpopulated pillar id → null, null subSection → null", [s.pillar, s.subSection], [null, null]);
  expect("AC11 unit id-only coAuthor dropped", s.coAuthors, [{ name: "B", role: null }]);
  expect("AC6 unit views NULL stays null", s.views, null);

  if (unitOnly) {
    console.log(`\n[check4] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`} (unit-only)`);
    process.exit(state.failures === 0 ? 0 : 1);
  }

  // ── Fixtures (fresh per run) ──────────────────────────────────────────────
  const t = tokens as R_Tokens;
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const gcv = need(tenants, "gcv");
  const wad = need(tenants, "wad");
  const stamp = Date.now().toString(36);
  const db = rawDb(payload);

  const firstPillar = async (tenantId: number) => {
    const p = (await payload.find({ collection: "pillars", where: { tenant: { equals: tenantId } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
    if (!p) throw new Error(`tenant ${tenantId} has no pillar`);
    return p.id;
  };
  const pDtw = await firstPillar(dtw);
  const author = await ensureAuthor(payload, dtw, "cms4-probe-author", "CMS-4 Probe Author");
  await payload.update({ collection: "authors", id: author, overrideAccess: true, data: { role: "Probe Desk" } as never });
  const coAuthor = await ensureAuthor(payload, dtw, "cms4-probe-coauthor", "CMS-4 Probe CoAuthor");
  const sub = (await payload.create({ collection: "subsections", overrideAccess: true, locale: "en", data: { tenant: dtw, pillar: pDtw, slug: `cms4-sub-${stamp}`, title: "CMS4 Sub", order: 0 } as never })) as unknown as { id: number };
  const tag = (await payload.create({ collection: "tags", overrideAccess: true, locale: "en", data: { tenant: dtw, slug: `cms4-tag-${stamp}`, title: "CMS4 Tag" } as never })) as unknown as { id: number };
  const media = (await payload.create({
    collection: "media", overrideAccess: true, locale: "en",
    data: { tenant: dtw, alt: "cms4 alt", caption: "cms4 caption", credit: "cms4 credit" } as never,
    file: { data: PNG_1X1, mimetype: "image/png", name: `cms4-${stamp}.png`, size: PNG_1X1.length },
  })) as unknown as { id: number; url: string };
  let videoId: number | null = null;
  try {
    const v = (await payload.create({
      collection: "videoMedia", overrideAccess: true, locale: "en",
      data: { tenant: dtw, alt: "cms4 video" } as never,
      file: { data: MP4_STUB, mimetype: "video/mp4", name: `cms4-${stamp}.mp4`, size: MP4_STUB.length },
    })) as unknown as { id: number };
    videoId = v.id;
  } catch (err) {
    obs("videoMedia fixture create failed", (err as Error).message);
  }
  const markerEmail = `probe-leak-marker-${stamp}@example.test`;
  const user = (await payload.create({ collection: "users", overrideAccess: true, data: { name: "Leak Marker", email: markerEmail, password: randomBytes(12).toString("hex"), role: "standard" } as never })) as unknown as { id: number };
  const markerToken = `cms4leakmarker${randomBytes(16).toString("hex")}`;
  const engine = (await payload.create({ collection: "content-engines", overrideAccess: true, data: { name: `cms4-marker-${stamp}`, engineType: "other", status: "active", allowedTenants: [dtw], allowedActions: ["import"], rawToken: markerToken } as never })) as unknown as { id: number };
  const engineRow = (await payload.findByID({ collection: "content-engines", id: engine.id, depth: 0, overrideAccess: true })) as unknown as { tokenHash?: string; tokenPrefix?: string };
  obs("marker engine tokenHash present", Boolean(engineRow.tokenHash));

  const fullBody = lx.root(
    lx.el("heading", [lx.text("CMS4 heading")], { tag: "h2" }),
    lx.p(lx.text("Normal "), lx.text("bold", 1), lx.text(" and "), lx.text("italic", 2), lx.text(" text.")),
    lx.el("list", [lx.el("listitem", [lx.text("First")], { value: 1 }), lx.el("listitem", [lx.text("Second")], { value: 2 })], { listType: "number", start: 1, tag: "ol" }),
    lx.el("list", [lx.el("listitem", [lx.text("Bullet")], { value: 1 })], { listType: "bullet", start: 1, tag: "ul" }),
    lx.el("quote", [lx.text("Quoted line.")]),
    lx.p(lx.link("javascript:alert(1)", "danger 1")),
    lx.p(lx.link("JaVaScRiPt:alert(1)", "danger 2")),
    lx.p(lx.link("data:text/html,<script>alert(1)</script>", "danger 4")),
    lx.p(lx.link("vbscript:x", "danger 5")),
    lx.p(lx.link("https://example.com/safe", "safe link")),
    lx.upload("media", media.id),
    lx.rel("users", user.id),
    lx.rel("content-engines", engine.id),
  );
  // The leading-space variant cannot be saved through Payload (validateUrl);
  // it is appended with raw SQL below, bypassing field validation.
  const leadingSpace = lx.p(lx.link(" javascript:alert(1)", "danger 3"));

  const mk = async (tenantId: number, key: string, workflowStatus: ArticleStatus, extra: Record<string, unknown> = {}) => {
    const created = (await payload.create({
      collection: "articles", overrideAccess: true, locale: "en", draft: true,
      data: {
        tenant: tenantId, title: `CMS4 ${key} ${stamp}`, slug: `cms4-${key}-${stamp}`,
        pillar: tenantId === dtw ? pDtw : await firstPillar(tenantId),
        author: tenantId === dtw ? author : await ensureAuthor(payload, tenantId, "cms4-probe-author", "CMS-4 Probe Author"),
        workflowStatus, publishedAt: iso(2026, 9, 2), ...extra,
      } as never,
    })) as unknown as { id: number };
    return created.id;
  };
  const setBodySql = async (id: number, body: unknown) =>
    db.execute(sql`UPDATE articles_locales SET body = ${JSON.stringify(body)}::jsonb WHERE _parent_id = ${id} AND _locale = 'en'`);

  const idFull = await mk(dtw, "full", "published", {
    dek: "cms4 dek", body: fullBody, takeaways: "Take one\nTake two", readMin: 7, views: 42, contentType: "article",
    subSection: sub.id, coAuthors: [coAuthor], tags: [tag.id], heroImage: media.id,
    ...(videoId != null ? { video: videoId, videoCaption: "vcap", videoCredit: "vcred", videoDescription: "vdesc" } : {}),
    lastEngine: engine.id, assignedTo: user.id, lastEditedBy: user.id,
  });
  await setBodySql(idFull, { root: { ...fullBody.root, children: [...fullBody.root.children, leadingSpace] } });
  const idHidden = await mk(dtw, "hidden", "hidden");
  await db.execute(sql`UPDATE articles SET pillar_id = NULL, author_id = NULL WHERE id = ${idHidden}`);
  const idArchived = await mk(dtw, "archived", "archived", { body: lx.root(lx.p(lx.text("archived body"))) });
  const idPending = await mk(dtw, "pending", "pending_review");
  const idEmptyRoot = await mk(dtw, "emptyroot", "published");
  await setBodySql(idEmptyRoot, lx.root(lx.p()));
  const idUnknownNode = await mk(dtw, "unknownnode", "published");
  await setBodySql(idUnknownNode, lx.root({ type: "cms4-unknown-node", version: 1 }));
  const idGcv = await mk(gcv, "gcv", "published");
  const idWad = await mk(wad, "wad", "published");
  obs("fixtures", { idFull, idHidden, idArchived, idPending, idEmptyRoot, idUnknownNode, idGcv, idWad, videoId });

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const get = async (id: string | number, tenant: string | null, token: string | null = t.read) => {
    const qs = tenant == null ? "" : `?tenant=${encodeURIComponent(tenant)}`;
    const res = await fetch(`${BASE}/api/hub/articles/${id}${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    let body: Doc = {};
    try { body = JSON.parse(text) as Doc; } catch { /* non-JSON (e.g. Next 404 page) */ }
    return { status: res.status, text, body };
  };
  const logCount = async (eventType?: string) =>
    (await payload.count({ collection: "activityLog", ...(eventType ? { where: { eventType: { equals: eventType } } } : {}), overrideAccess: true })).totalDocs;

  // Registration / auth.
  const reg = await get(idFull, "dtw");
  expect("route registered: JSON with ok:true (not the Next 404 page)", [reg.status, reg.body.ok], [200, true]);
  expect("AUTH no bearer → 401", (await get(idFull, "dtw", null)).status, 401);
  expect("AUTH unknown bearer → 401", (await get(idFull, "dtw", "nope-" + stamp)).status, 401);
  expect("AUTH hubRead:false → 403", (await get(idFull, "dtw", t.noread)).status, 403);

  // AC1 — tenant required.
  for (const [label, tq] of [["absent", null], ["empty", ""], ["blank", "   "]] as const) {
    const r = await get(idFull, tq);
    expect(`AC1 tenant ${label} → 400 bad_request`, [r.status, r.body.status], [400, "bad_request"]);
  }

  // AC3 + AC13 — tenant outside grant.
  const deniedBefore = await logCount("engine_tenant_denied");
  const r403 = await get(idWad, "wad");
  expect("AC3 tenant outside grant → 403 forbidden", [r403.status, r403.body.status], [403, "forbidden"]);
  expect("AC3 allowedTenants non-empty, exactly the grant", [...((r403.body.allowedTenants as string[]) ?? [])].sort(), ["dtw", "gcv"]);
  expect("AC13 denial logged as engine_tenant_denied (+1)", (await logCount("engine_tenant_denied")) - deniedBefore, 1);
  expect("AC3 unknown tenant slug → 403", (await get(idFull, "nope")).status, 403);

  // AC2 + AC4 — one 404 body for every "not here" case.
  const missing = await get(999999999, "dtw");
  expect("AC2/AC4 nonexistent id → 404 not_found", [missing.status, missing.body.status], [404, "not_found"]);
  for (const bad of ["abc", "-1", "1.5", "0", "01", "12345678901234567", "1e3", "%20" + idFull]) {
    const r = await get(bad, "dtw");
    expect(`AC2 malformed id ${JSON.stringify(bad)} → 404 identical body`, [r.status, r.text], [404, missing.text]);
  }
  const other = await get(idGcv, "dtw");
  expect("AC4 article in another (granted) tenant → 404 byte-identical", [other.status, other.text], [404, missing.text]);
  expect("AC4 same article with its own tenant → 200", (await get(idGcv, "gcv")).status, 200);

  // AC5 — every workflowStatus readable.
  for (const [id, ws] of [[idHidden, "hidden"], [idArchived, "archived"], [idPending, "pending_review"], [idFull, "published"]] as const) {
    const r = await get(id, "dtw");
    expect(`AC5 ${ws} article readable`, [r.status, (r.body.article as Doc | undefined)?.workflowStatus], [200, ws]);
  }

  // Full article — AC6–AC10, AC12.
  const okBefore = await logCount();
  const full = await get(idFull, "dtw");
  expect("AC12 successful read writes no ActivityLog row", (await logCount()) - okBefore, 0);
  const a = (full.body.article ?? {}) as Doc;
  const mdOut = String(a.bodyMarkdown ?? "");
  expect("AC6 response keys = exact allowlist", Object.keys(a).sort(), DETAIL_KEYS);
  expect("AC6 top-level response keys", Object.keys(full.body).sort(), ["article", "ok"]);
  for (const [label, needle] of [
    ["marker email", markerEmail], ["marker raw token", markerToken], ["marker tokenHash", engineRow.tokenHash ?? "<none>"],
    ["marker tokenPrefix", engineRow.tokenPrefix ?? "<none>"], ["readTokens", "readTokens"], ["tokenHash key", "tokenHash"],
    ["lastEngine", "lastEngine"], ["assignedTo", "assignedTo"], ["translationStatus", "translationStatus"], ["lastEditedBy", "lastEditedBy"],
    ["password/hash", "\"hash\""],
  ] as const) {
    expect(`AC6/AC8 response JSON contains no ${label}`, full.text.includes(needle), false);
  }
  expect("AC6 tenant slug from narrowed tenant", a.tenant, { slug: "dtw" });
  expect("AC6 scalar fields", [a.id, a.dek, a.readMin, a.views, a.contentType, a.takeaways], [idFull, "cms4 dek", 7, 42, "article", ["Take one", "Take two"]]);
  expect("AC6 pillar/subSection/tags reduced to {slug,title}", [Object.keys((a.pillar as Doc) ?? {}).sort(), a.subSection, a.tags],
    [["slug", "title"], { slug: `cms4-sub-${stamp}`, title: "CMS4 Sub" }, [{ slug: `cms4-tag-${stamp}`, title: "CMS4 Tag" }]]);
  expect("AC6 author/coAuthors reduced to {name,role}", [a.author, a.coAuthors],
    [{ name: "CMS-4 Probe Author", role: "Probe Desk" }, [{ name: "CMS-4 Probe CoAuthor", role: null }]]);
  expect("AC18/AC19 bodyState ok for a convertible body", a.bodyState, "ok");
  expect("AC7 bodyMarkdown has no javascript: (any case, incl. SQL-injected leading-space variant)", /javascript:/i.test(mdOut), false);
  expect("AC7 bodyMarkdown has no vbscript: / data:text", /vbscript:|data:text/i.test(mdOut), false);
  expect("AC7 safe link kept", mdOut.includes("[safe link](https://example.com/safe)"), true);
  obs("AC7 neutralised links", mdOut.split("\n").filter((l) => l.includes("danger")));
  expect("AC8 relationship nodes export as '{relationTo} relation to {id}' only", [mdOut.includes(`users relation to ${user.id}`), mdOut.includes(`content-engines relation to ${engine.id}`)], [true, true]);
  expect("AC9 (a) body Upload node → real media URL, no placeholder", [mdOut.includes(`![media:${media.id}]`), mdOut.includes(`](${media.url})`)], [false, true]);
  expect("GFM heading / lists / quote / emphasis", [mdOut.includes("## CMS4 heading"), mdOut.includes("1. First"), mdOut.includes("- Bullet"), mdOut.includes("> Quoted line."), mdOut.includes("**bold**"), mdOut.includes("*italic*")], [true, true, true, true, true, true]);
  const hero = a.heroImage as Doc | null;
  expect("AC10 (b) heroImage populated {url,alt,caption,credit}", hero && [Object.keys(hero).sort(), hero.url, hero.alt, hero.caption, hero.credit],
    [["alt", "caption", "credit", "url"], media.url, "cms4 alt", "cms4 caption", "cms4 credit"]);
  const video = a.video as Doc | null;
  if (videoId != null) {
    expect("AC10 (c) video resolved (attached branch)", video && [typeof video.url, (video.url as string).length > 0, video.mimeType, video.posterUrl ? "poster" : "none", video.caption, video.credit, video.description],
      ["string", true, "video/mp4", "poster", "vcap", "vcred", "vdesc"]);
  } else {
    expect("AC10 (c) video fixture could be created (attached branch)", videoId != null, true);
  }

  // AC11 + AC18 — hidden article: pillar/author NULLed by SQL, nothing else set, body null.
  const h = ((await get(idHidden, "dtw")).body.article ?? {}) as Doc;
  expect("AC11 absent relations → null / []", [h.pillar, h.subSection, h.author, h.coAuthors, h.tags, h.heroImage, h.video, h.takeaways],
    [null, null, null, [], [], null, null, []]);
  expect("AC10 (c) video absent branch → null (no throw)", h.video, null);
  expect("AC18 body null → 200, bodyMarkdown '', bodyState empty", [h.bodyMarkdown, h.bodyState], ["", "empty"]);
  const er = await get(idEmptyRoot, "dtw");
  expect("AC18 empty-root body → 200 empty", [er.status, (er.body.article as Doc)?.bodyMarkdown, (er.body.article as Doc)?.bodyState], [200, "", "empty"]);

  // AC19 over the real route — an unregistered node type stored via raw SQL.
  const errBefore = await logCount("integration_error");
  const un = await get(idUnknownNode, "dtw");
  const ua = (un.body.article ?? {}) as Doc;
  obs("AC19 route unknown-node result", { status: un.status, bodyState: ua.bodyState });
  // convertLexicalToMarkdown swallows this parse failure (console.error) and returns "";
  // the wrapper must still report it as an error, never as an empty "ok" body.
  expect("AC19 route: unregistered node type → bodyState error (not a silent empty ok)", ua.bodyState, "error");
  if (ua.bodyState === "error") {
    expect("AC19 route: unconvertible body → 200, '' , error, other fields intact", [un.status, ua.bodyMarkdown, ua.workflowStatus, Object.keys(ua).sort()], [200, "", "published", DETAIL_KEYS]);
    const errRows = (await payload.find({ collection: "activityLog", where: { eventType: { equals: "integration_error" } }, sort: "-id", limit: 1, depth: 0, overrideAccess: true })).docs as unknown as Doc[];
    expect("AC19 route: integration_error logged (+1)", (await logCount("integration_error")) - errBefore, 1);
    obs("AC19 route: logged detail", errRows[0]?.detail);
    expect("AC19 route: log detail has no token / body text", JSON.stringify(errRows[0]?.detail ?? {}).includes(t.read), false);
  } else {
    expect("AC19 route: unconvertible body never 500", un.status, 200);
  }

  console.log(`\n[check4] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS-4b (--check5): hub article ids bounded to Postgres int4
// (gap `hub-id-over-int4-returns-500`). LOCAL / DISPOSABLE POSTGRES ONLY.
//
//   npx tsx scripts/hub-probe.ts --check5 --unit-only
//   npx tsx scripts/hub-probe.ts --check5 --in <file from --setup4> --in3 <file from --setup3>
//
// Unit rows U1-U14 check `isHubArticleId` alone. Live rows L1-L8 call both hub
// article routes over HTTP and compare every out-of-range answer with the answer
// the same route gives an in-range id that does not exist (L-baseline): same
// status, same body text, 0 new ActivityLog rows, no article's workflowStatus
// changed. Tokens come from the --setup3/--setup4 files and are never printed.
// Creates one fresh article per run (unique slug), so it can be re-run under
// each red-first mutation.
// ─────────────────────────────────────────────────────────────────────────────

async function check5() {
  const unitOnly = flag("unit-only");
  const inFile = arg("in");
  const in3File = arg("in3");
  const rTokens = inFile ? (JSON.parse(readFileSync(inFile, "utf8")) as R_Tokens) : undefined;
  const wTokens = in3File ? (JSON.parse(readFileSync(in3File, "utf8")) as W_Tokens) : undefined;
  if (!unitOnly && (!rTokens || !wTokens)) throw new Error("--in <file from --setup4> and --in3 <file from --setup3> required (or --unit-only)");
  const { state, expect } = makeExpect();
  const obs = (label: string, v: unknown) => console.log(`OBS   ${label}  ${JSON.stringify(v)}`);
  const { isHubArticleId } = await import("../src/lib/hub-article-id");

  // ── Unit: isHubArticleId (U1-U14) ─────────────────────────────────────────
  for (const [n, input, want] of [
    ["U1", "1", true],
    ["U2", "2147483647", true],
    ["U3", "2147483648", false],
    ["U4", "0", false],
    ["U5", "01", false],
    ["U6", "-1", false],
    ["U7", "", false],
    ["U8", " 1", false],
    ["U9", "1 ", false],
    ["U10", "1e3", false],
    ["U11", "+1", false],
    ["U12", "１", false],
    ["U13", "9999999999999999", false],
    ["U14", "99999999999999999999999", false],
  ] as const) {
    expect(`${n} unit isHubArticleId(${JSON.stringify(input)})`, isHubArticleId(input), want);
  }

  if (unitOnly) {
    console.log(`\n[check5] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`} (unit-only)`);
    process.exit(state.failures === 0 ? 0 : 1);
  }

  const r = rTokens as R_Tokens;
  const w = wTokens as W_Tokens;
  const payload = await getPayload({ config });
  const db = rawDb(payload);
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const stamp = Date.now().toString(36);

  // One real, in-range article (AC2).
  const pillar = (await payload.find({ collection: "pillars", where: { tenant: { equals: dtw } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
  if (!pillar) throw new Error("dtw has no pillar — run `npm run db:seed` first");
  const author = await ensureAuthor(payload, dtw, "cms4b-probe-author", "CMS-4b Probe Author");
  const idReal = ((await payload.create({
    collection: "articles", overrideAccess: true, locale: "en", draft: true,
    data: { tenant: dtw, title: `CMS4b real ${stamp}`, slug: `cms4b-real-${stamp}`, pillar: pillar.id, author, workflowStatus: "published", publishedAt: iso(2026, 9, 2) } as never,
  })) as unknown as { id: number }).id;
  obs("fixture", { idReal });

  // ── HTTP ──────────────────────────────────────────────────────────────────
  type Reply = { status: number; text: string; body: Doc };
  const parse = async (res: Response): Promise<Reply> => {
    const text = await res.text();
    let body: Doc = {};
    try { body = JSON.parse(text) as Doc; } catch { /* non-JSON */ }
    return { status: res.status, text, body };
  };
  const get = async (id: string | number, token: string | null = r.read) =>
    parse(await fetch(`${BASE}/api/hub/articles/${id}?tenant=dtw`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const actor = { email: "operator@example.com", role: "editor", id: "hub-user-4b" };
  const post = async (id: string | number, to = "archived", expectedStatus = "published", token: string | null = w.write) =>
    parse(await fetch(`${BASE}/api/hub/articles/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ tenant: "dtw", to, expectedStatus, reason: "probe reason ok", actor }),
    }));
  const logCount = async () => (await payload.count({ collection: "activityLog", overrideAccess: true })).totalDocs;
  const statusSnap = async () => {
    const res = (await db.execute(sql`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(workflow_status::text, ''), ',' ORDER BY id), '')) AS h FROM articles`)) as { rows?: { h: string }[] };
    return res.rows?.[0]?.h ?? "";
  };
  /** Call, and report [reply, new ActivityLog rows, article statuses unchanged?]. */
  const measure = async (call: () => Promise<Reply>): Promise<[Reply, number, boolean]> => {
    const logBefore = await logCount();
    const snapBefore = await statusSnap();
    const reply = await call();
    return [reply, (await logCount()) - logBefore, (await statusSnap()) === snapBefore];
  };

  // L-baseline: an in-range id that does not exist (today already 404).
  const MISSING = "999999999";
  const [bGet, bGetLog] = await measure(() => get(MISSING));
  const [bPost, bPostLog, bPostSnap] = await measure(() => post(MISSING));
  obs("L-baseline GET", { status: bGet.status, body: bGet.body, log: bGetLog });
  obs("L-baseline POST", { status: bPost.status, body: bPost.body, log: bPostLog });
  const NOT_FOUND = { ok: false, status: "not_found", reason: "article not found for tenant" };
  expect("L-baseline GET missing in-range id → 404 not_found, 0 log rows", [bGet.status, bGet.body, bGetLog], [404, NOT_FOUND, 0]);
  expect("L-baseline POST missing in-range id → 404 not_found, 0 log rows, no status change", [bPost.status, bPost.body, bPostLog, bPostSnap], [404, NOT_FOUND, 0, true]);

  // L1-L3 (GET) and L4-L5 (+ 23-digit) (POST): identical to the baseline, byte for byte.
  for (const [n, id] of [["L1", "2147483648"], ["L2", "9999999999999999"], ["L3", "99999999999999999999999"]] as const) {
    const [g, gLog] = await measure(() => get(id));
    expect(`${n} GET ${id} → same status + body text as L-baseline, 0 log rows`, [g.status, g.text, gLog], [bGet.status, bGet.text, 0]);
  }
  for (const [n, id] of [["L4", "2147483648"], ["L5", "9999999999999999"], ["L5b", "99999999999999999999999"]] as const) {
    const [p, pLog, pSnap] = await measure(() => post(id));
    expect(`${n} POST ${id} → same status + body text as L-baseline, 0 log rows, no workflowStatus changed`, [p.status, p.text, pLog, pSnap], [bPost.status, bPost.text, 0, true]);
  }

  // L6: int4 max itself is IN range → the ordinary "no such article" path.
  {
    const [g, gLog] = await measure(() => get("2147483647"));
    expect("L6 GET 2147483647 (in range, no row) → same as L-baseline, 0 log rows", [g.status, g.text, gLog], [bGet.status, bGet.text, 0]);
    const [p, pLog, pSnap] = await measure(() => post("2147483647"));
    expect("L6 POST 2147483647 (in range, no row) → same as L-baseline, 0 log rows, no status change", [p.status, p.text, pLog, pSnap], [bPost.status, bPost.text, 0, true]);
  }

  // L7 / L8 (AC3): auth still runs first, whatever the id.
  {
    const [inG] = await measure(() => get(idReal, null));
    const [outG, outGLog] = await measure(() => get("2147483648", null));
    expect("L7 GET no bearer, out-of-range id → 401, same body as no bearer + real id, 0 log rows", [outG.status, outG.text, outGLog], [401, inG.text, 0]);
    const [inP] = await measure(() => post(idReal, "archived", "published", null));
    const [outP, outPLog, outPSnap] = await measure(() => post("2147483648", "archived", "published", null));
    expect("L7 POST no bearer, out-of-range id → 401, same body as no bearer + real id, 0 log rows", [outP.status, outP.text, outPLog, outPSnap], [401, inP.text, 0, true]);
    // A 403 auth denial already logs its own row today; AC3 = "exactly as today",
    // so the out-of-range call must log exactly what the real-id call logs.
    const [inN, inNLog] = await measure(() => post(idReal, "archived", "published", w.nowrite));
    const [outN, outNLog, outNSnap] = await measure(() => post("2147483648", "archived", "published", w.nowrite));
    obs("L8 POST hubWrite:false log delta (real id / out-of-range id)", [inNLog, outNLog]);
    expect("L8 POST hubWrite:false, out-of-range id → 403, same body + same log delta as with real id, no status change", [outN.status, outN.text, outNLog, outNSnap], [403, inN.text, inNLog, true]);
    const [inR, inRLog] = await measure(() => get(idReal, r.noread));
    const [outR, outRLog] = await measure(() => get("2147483648", r.noread));
    obs("L8 GET hubRead:false log delta (real id / out-of-range id)", [inRLog, outRLog]);
    expect("L8 GET hubRead:false, out-of-range id → 403, same body + same log delta as with real id", [outR.status, outR.text, outRLog], [403, inR.text, inRLog]);
  }

  // AC2: a real in-range article is unchanged on both routes.
  {
    const g = await get(idReal);
    const art = (g.body.article ?? {}) as Doc;
    expect("AC2 GET real article → 200 ok, same id, published", [g.status, g.body.ok, art.id, art.workflowStatus], [200, true, idReal, "published"]);
    const hide = await post(idReal, "archived", "published");
    expect("AC2 POST hide real article → 200", [hide.status, hide.body.ok], [200, true]);
    const rep = await post(idReal, "published", "archived");
    expect("AC2 POST republish real article → 200", [rep.status, rep.body.ok], [200, true]);
  }

  console.log(`\n[check5] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.1 / Stage 0.5 — `--explore6` (APCGHub P5.1, nháp chữ). OBSERVE ONLY.
//
// Prints `OBS` lines and NEVER asserts: these measurements feed the frozen
// values of Stage 0.6 (node allow-list P-4, round-trip comparator key sets
// P-1b, D20 branch P-14, body / depth caps P-15, slug pre-check P-19, slugify
// vectors). Nothing here is a pass/fail gate; `--check6` (Stage 3) is.
//
//   npx tsx scripts/hub-probe.ts --explore6 --in4 <setup4.json> [--only P-1,P-15,P-20..P-24] [--vec <name>] [--list] [--lim lines,starUnd,links]
//
// Writes fixtures (articles, one tenant frontendUrl / readTokens entry restored
// at the end) — LOCAL DATABASE ONLY, guarded below.
// ─────────────────────────────────────────────────────────────────────────────

function assertLocalTargets(): void {
  const local = (u: string) => {
    try {
      const h = new URL(u).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
    } catch {
      return false;
    }
  };
  if (!local(process.env.DATABASE_URL ?? "") || !local(BASE)) {
    console.error("[explore6] refusing: DATABASE_URL and HUB_PROBE_BASE must both point at localhost / 127.0.0.1 / ::1");
    process.exit(2);
  }
}

/** W = the JS `\s` class ∪ C0 (Public Contracts §Kiểm thân bài (0)). */
const isWs6 = (c: number): boolean => c <= 0x1f || /\s/.test(String.fromCharCode(c));

function maxWsRun(s: string): number {
  let best = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (isWs6(s.charCodeAt(i))) {
      cur++;
      if (cur > best) best = cur;
    } else cur = 0;
  }
  return best;
}

interface TreeStats {
  nodes: number;
  maxDepth: number;
  maxListNest: number;
  types: Record<string, number>;
  links: { type: string; url: unknown; fields: unknown }[];
  text: string;
}

/** Iterative walk of a Lexical editor state (no recursion: deep trees are part of the test). */
function treeStats(state: unknown): TreeStats {
  const out: TreeStats = { nodes: 0, maxDepth: 0, maxListNest: 0, types: {}, links: [], text: "" };
  const root = (state as { root?: unknown } | null)?.root;
  if (!root) return out;
  const texts: string[] = [];
  const stack: { n: Record<string, unknown>; d: number; l: number }[] = [{ n: root as Record<string, unknown>, d: 0, l: 0 }];
  while (stack.length) {
    const { n, d, l } = stack.pop()!;
    out.nodes++;
    const type = String(n.type);
    out.types[type] = (out.types[type] ?? 0) + 1;
    if (d > out.maxDepth) out.maxDepth = d;
    const nl = type === "list" ? l + 1 : l;
    if (nl > out.maxListNest) out.maxListNest = nl;
    if (type === "link" || type === "autolink") {
      const f = n.fields as Record<string, unknown> | undefined;
      out.links.push({ type, url: f?.url ?? n.url, fields: f ?? null });
    }
    if (typeof n.text === "string") texts.push(n.text);
    const kids = n.children;
    if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i] as Record<string, unknown>, d: d + 1, l: nl });
  }
  out.text = texts.join("");
  return out;
}

/** Structural diff → the set of KEY NAMES whose values differ (key-level, not path-level). */
function diffKeyNames(a: unknown, b: unknown, key: string, out: Set<string>): void {
  if (a === b) return;
  const ao = typeof a === "object" && a !== null;
  const bo = typeof b === "object" && b !== null;
  if (!ao || !bo) {
    out.add(key);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.add(key);
    return;
  }
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) out.add(`${key}[len]`);
    for (let i = 0; i < Math.min(a.length, bb.length); i++) diffKeyNames(a[i], bb[i], key, out);
    return;
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ar), ...Object.keys(br)])) {
    if (!(k in ar) || !(k in br)) out.add(`${k}(${k in ar ? "lost" : "added"})`);
    else diffKeyNames(ar[k], br[k], k, out);
  }
}

const P1_SAMPLES6: Record<string, string> = {
  paragraph_vi: "Đoạn văn tiếng Việt có dấu: Hà Nội, Đà Nẵng, Thừa Thiên Huế. Ơ ư ă â ê ô đ Đ.",
  bold_italic: "Chữ **đậm** và *nghiêng* và ***cả hai*** và _gạch dưới nghiêng_ và __đậm gạch__.",
  bold_only: "Chữ **đậm** ở giữa.",
  italic_only: "Chữ *nghiêng* ở giữa.",
  triple_star: "***cả hai***",
  bold_wraps_italic: "**_cả hai_**",
  italic_wraps_bold: "*__cả hai__*",
  bold_then_italic: "**đậm** *nghiêng*",
  bold_inside_italic_word: "*nghiêng **đậm** nghiêng*",
  headings: "## Tiêu đề H2\n\nĐoạn một.\n\n### Tiêu đề H3\n\nĐoạn hai.",
  quote: "> Trích dẫn một dòng.\n> Dòng hai của trích dẫn.",
  bullet: "- mục một\n- mục hai\n- mục ba",
  ordered: "1. một\n2. hai\n3. ba",
  nested_list: "- a\n  - b\n    - c\n- d",
  link: "Có [một link](https://example.com/a?b=1#c) ở đây.",
  link_kinds: "[mail](mailto:a@b.com) [tel](tel:+84123) [rel](/duong-dan) [hash](#muc) [q](?q=1)",
  hard_break: "Dòng một  \nDòng hai",
  soft_break: "Dòng một\nDòng hai",
  emoji: "Emoji 😀🎉 và 👍🏽 ở giữa câu.",
  blank_lines: "Đoạn A\n\n\n\n\nĐoạn B",
  article:
    "## Mở đầu\n\nĐoạn mở đầu với **điểm nhấn** và [nguồn](https://example.com).\n\n> Một trích dẫn.\n\n- ý một\n- ý hai\n\n1. bước một\n2. bước hai\n\n### Kết\n\nĐoạn kết *nhẹ nhàng*.",
};

// ─────────────────────────────────────────────────────────────────────────────
// P5.1 / Stage 0.5b — body-limit feasibility probes P-20 … P-24 (OBSERVE ONLY).
// Pure-conversion measurements (no DB writes, no dev server): they feed the
// pre-check thresholds (lines / `*`+`_` / `](`), the tree caps (nodes / JSON) and
// the stability gate F (md2 === md1). Each vector is meant to run in its OWN
// process:   --explore6 --only P-22 --vec <name>   (list names with --list).
// ─────────────────────────────────────────────────────────────────────────────

const BODY6_PROBES = ["P-20", "P-21", "P-22", "P-23", "P-24", "P-25", "P-26"];
/** Proposed (temporary) pre-check limits under test: lines, `*`+`_`, `](`. */
const LIM6 = { lines: 5000, starUnd: 3000, links: 1000 };
/** Revised proposal under test (after the P-22 / P-23 measurements): total lines, `*`+`_` chars, mark runs, `](`, per-paragraph-unit runs / links, tree caps. */
const REV6 = (() => {
  const d = { lines: 1200, starUnd: 5000, runs: 2500, links: 500, unitRuns: 30, unitLinks: 20, markChars: 5000, nodes: 12000, json: 1_500_000, indent: 16 };
  const o = process.argv.includes("--rev") ? process.argv[process.argv.indexOf("--rev") + 1] : undefined; // lines,starUnd,runs,links,unitRuns,unitLinks,markChars,nodes,json,indent
  if (o) {
    const k = Object.keys(d) as (keyof typeof d)[];
    o.split(",").forEach((v, i) => {
      if (v !== "" && k[i]) d[k[i]!] = Number(v);
    });
  }
  return d;
})();

interface Pre6 {
  len: number;
  lines: number;
  lf: number;
  cr: number;
  ls: number;
  ps: number;
  starUnd: number;
  runs: number;
  maxRun: number;
  links: number;
  maxUnitLines: number;
  maxUnitRuns: number;
  maxUnitLinks: number;
  backticks: number;
  tildes: number;
  maxIndent: number;
}

/**
 * O(n) pre-check counters: lines (LF, CR, U+2028, U+2029 each one), `*`+`_` characters, mark RUNS (maximal runs of ONE of `*` `_` `` ` `` `~`),
 * `](`, plus the per-UNIT maxima. A unit = what the importer converts as one text node: consecutive non-blank lines of one paragraph;
 * a blank line ends a unit, and a line that starts a list item / quote / heading (`-`,`+`,`*␠`,`>`,`#`, `1.`/`1)`) is its own unit.
 */
function pre6(s: string): Pre6 {
  let lf = 0, cr = 0, ls = 0, ps = 0, starUnd = 0, links = 0, runs = 0, maxRun = 0, curRun = 0, curCh = 0, backticks = 0, tildes = 0, indent = 0, maxIndent = 0;
  let ul = 0, ur = 0, uk = 0, mul = 0, mur = 0, muk = 0;
  const flush = () => {
    if (ul > mul) mul = ul;
    if (ur > mur) mur = ur;
    if (uk > muk) muk = uk;
    ul = ur = uk = 0;
  };
  let atLineStart = true;
  let lineHasText = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) {
      if (c === 10) lf++;
      else if (c === 13) cr++;
      else if (c === 0x2028) ls++;
      else ps++;
      if (!lineHasText) flush();
      lineHasText = false;
      atLineStart = true;
      indent = 0;
      curRun = 0;
      curCh = 0;
      continue;
    }
    if (atLineStart && (c === 32 || c === 9)) {
      indent++;
      if (indent > maxIndent) maxIndent = indent;
    }
    if (atLineStart && c !== 32 && c !== 9) {
      atLineStart = false;
      const n1 = s.charCodeAt(i + 1);
      let digitsEnd = i;
      while (s.charCodeAt(digitsEnd) >= 48 && s.charCodeAt(digitsEnd) <= 57) digitsEnd++;
      const startsUnit =
        c === 45 || c === 43 || c === 62 || c === 35 || (c === 42 && (n1 === 32 || n1 === 9)) ||
        (digitsEnd > i && digitsEnd - i <= 9 && (s.charCodeAt(digitsEnd) === 46 || s.charCodeAt(digitsEnd) === 41) && s.charCodeAt(digitsEnd + 1) === 32);
      if (startsUnit) flush();
      lineHasText = true;
      ul++; // approximate: counts unit lines
    } else if (c !== 32 && c !== 9) lineHasText = true;
    if (c === 42 || c === 95 || c === 96 || c === 126) {
      if (c === 42 || c === 95) starUnd++;
      if (c === 96) backticks++;
      else if (c === 126) tildes++;
      if (c === curCh) curRun++;
      else {
        curCh = c;
        curRun = 1;
        runs++;
        ur++;
      }
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curCh = 0;
      curRun = 0;
      if (c === 93 && s.charCodeAt(i + 1) === 40) {
        links++;
        uk++;
      }
    }
  }
  flush();
  return { len: s.length, lines: lf + cr + ls + ps + 1, lf, cr, ls, ps, starUnd, runs, maxRun, links, maxUnitLines: mul, maxUnitRuns: mur, maxUnitLinks: muk, backticks, tildes, maxIndent };
}

function seeded6(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const VI_WORDS6 = ("hành trình khám phá những điểm đến mới giữa lòng thành phố cổ kính nơi ánh sáng buổi sớm chạm vào mái ngói rêu phong " +
  "du khách thường chọn đi bộ qua các con phố nhỏ thưởng thức cà phê và ngắm nhìn nhịp sống chậm rãi của người dân địa phương " +
  "kiến trúc thuộc địa hoà quyện cùng nét hiện đại tạo nên bức tranh đô thị độc đáo mỗi mùa mang đến một sắc thái riêng biệt").split(" ");

/** Article-like Markdown: Vietnamese words, a bold phrase / link / line break at the given average spacing (chars), occasional lists and headings. */
function realBody6(target: number, o: { line: number; bold: number; link: number; ital: number; seed: number }): string {
  const rnd = seeded6(o.seed);
  const word = () => VI_WORDS6[Math.floor(rnd() * VI_WORDS6.length)]!;
  const phrase = (n: number) => Array.from({ length: n }, word).join(" ");
  let out = "";
  let sinceBold = 0, sinceLink = 0, sinceItal = 0, sinceLine = 0, block = 0;
  while (out.length < target) {
    block++;
    if (block % 25 === 0) {
      out += `## ${phrase(4)}\n\n`;
      continue;
    }
    if (block % 15 === 0) {
      for (let k = 0; k < 4; k++) out += `- ${phrase(6)}\n`;
      out += "\n";
      continue;
    }
    const lines = 1 + Math.floor(rnd() * 4);
    for (let l = 0; l < lines; l++) {
      let line = "";
      while (line.length < o.line) {
        let tok = word();
        if (sinceBold >= o.bold) {
          tok = `**${phrase(2)}**`;
          sinceBold = 0;
        } else if (sinceLink >= o.link) {
          tok = `[${phrase(2)}](https://example.com/${word()}/${Math.floor(rnd() * 9999)})`;
          sinceLink = 0;
        } else if (sinceItal >= o.ital) {
          tok = `*${word()}*`;
          sinceItal = 0;
        }
        line += (line ? " " : "") + tok;
        sinceBold += tok.length + 1;
        sinceLink += tok.length + 1;
        sinceItal += tok.length + 1;
      }
      out += line + (l < lines - 1 ? "\n" : "\n\n");
      sinceLine += line.length;
    }
  }
  return out.slice(0, target);
}

interface V6 {
  probe: string;
  gen: () => string;
}

function body6Vectors(lim: { lines: number; starUnd: number; links: number } = LIM6): Record<string, V6> {
  const v: Record<string, V6> = {};
  const rep = (s: string, n: number) => s.repeat(n);
  const add = (probe: string, name: string, gen: () => string) => {
    v[name] = { probe, gen };
  };
  // ── P-22: calibrate the allowed region, and per-paragraph vs whole-body ──
  for (const n of [200, 400, 750, 1000, 1500]) {
    add("P-22", `p22_bold_${n}`, () => rep("**a**", n));
    add("P-22", `p22_bold_sp_${n}`, () => rep("**a** ", n));
    add("P-22", `p22_ital_${n}`, () => rep("*a*", n));
    add("P-22", `p22_ital_sp_${n}`, () => rep("*a* ", n));
  }
  for (const n of [1000, 2000, 3000, 5000, 8000]) {
    add("P-22", `p22_star_${n}`, () => rep("*", n));
    add("P-22", `p22_und_${n}`, () => rep("_", n));
  }
  for (const n of [150, 430, 700]) add("P-22", `p22_mixed_${n}`, () => rep("*a _b_ **c** ", n));
  for (const n of [5, 20, 100]) {
    add("P-22", `p22_para_a1000_x${n}`, () => rep(rep("a\n", 1000) + "\n", n));
    add("P-22", `p22_block_a_${1001 * n}`, () => rep("a\n", 1001 * n));
  }
  for (const n of [10, 50]) {
    add("P-22", `p22_para_star2000_x${n}`, () => rep(rep("*", 2000) + "\n\n", n));
    add("P-22", `p22_block_star_${2000 * n}`, () => rep("*", 2000 * n));
  }
  for (const n of [5, 20]) {
    add("P-22", `p22_para_bold750_x${n}`, () => rep(rep("**a** ", 750) + "\n\n", n));
    add("P-22", `p22_block_bold_sp_${750 * n}`, () => rep("**a** ", 750 * n));
  }
  for (const n of [2000, 5000, 8000, 12000]) {
    add("P-22", `p22_lf_${n}`, () => rep("a\n", n));
    add("P-22", `p22_crlf_${n}`, () => rep("line\r\n", n));
  }
  for (const n of [5000, 10000]) add("P-22", `p22_dash_${n}`, () => rep("- a\n", n));
  const zig = (tabs: number, lines: number, cap = 200000) => {
    let s = "";
    let l = 0;
    while (l < lines && s.length < cap) {
      s += rep("\t", tabs) + "- x\n- y\n";
      l += 2;
    }
    return s.slice(0, cap);
  };
  for (const n of [2000, 5000, 10000]) add("P-22", `p22_zigzag63_${n}`, () => zig(63, n));
  for (const n of [500, 1000, 2000, 5000]) {
    add("P-22", `p22_link_${n}`, () => rep("[a](/b) ", n));
    add("P-22", `p22_linkref_${n}`, () => rep("[a][r] ", n) + "\n\n[r]: /x");
    add("P-22", `p22_autolink_${n}`, () => rep("<https://a.b> ", n));
  }
  // ── P-22 hunt: does the `*`+`_` count alone bound the cost? (delimiter-ambiguity families, one block) ──
  const fam: [string, string, number, number][] = [
    ["f1", "*a _b_ **c** ", 7, 0],
    ["f2", "*a ", 1, 0],
    ["f3", "**a ", 2, 0],
    ["f4", "_a ", 1, 0],
    ["f5", "*a **b ", 3, 0],
    ["f6", "**a *b ", 3, 0],
    ["f7", "*_*_ ", 4, 0],
    ["f8", "**a** *b* ", 6, 0],
    ["f9", "*a**b* ", 3, 0],
    ["f10", "*a _b* c_ ", 4, 0],
    ["f11", "***a** ", 3, 0],
    ["f12", "*a __b__ ", 5, 0],
    ["f13", "*[a](/b) ", 1, 1],
    ["f14", "[*a*](/b) ", 2, 1],
  ];
  for (const [id, unit, su] of fam) for (const N of [200, 400, 800]) add("P-22", `p22h_${id}_${N}`, () => rep(unit, Math.ceil(N / su)));
  for (const n of [200, 250, 300, 350]) add("P-22", `p22f1_${n}`, () => rep("*a _b_ **c** ", n));
  for (const [u, k] of [[100, 5], [200, 5], [300, 5], [400, 5], [400, 25], [200, 25]] as const) add("P-22", `p22blk_f2_u${u}_x${k}`, () => rep(rep("*a ", u) + "\n\n", k));
  for (const [u, k] of [[35, 6], [70, 6], [70, 20], [100, 14]] as const) add("P-22", `p22blk_f1_u${u}_x${k}`, () => rep(rep("*a _b_ **c** ", u) + "\n\n", k));
  // star × link interaction grid (unclosed stars first, then links, one block) + interleaved variants
  for (const R of [0, 50, 100, 200]) for (const K of [0, 50, 100, 200]) if (R + K > 0) add("P-22", `p22g_r${R}_k${K}`, () => rep("*a ", R) + rep("[a](/b) ", K));
  for (const N of [25, 50, 100, 150]) add("P-22", `p22gi_star_${N}`, () => rep("*[a](/b) ", N));
  for (const N of [50, 100, 150]) {
    add("P-22", `p22gi_und_${N}`, () => rep("_[a](/b) ", N));
    add("P-22", `p22gi_bold_${N}`, () => rep("**[a](/b) ", N));
    add("P-22", `p22gi_word_${N}`, () => rep("*a [b](/c) ", N));
    add("P-22", `p22gi_closing_${N}`, () => rep("[a](/b)* ", N));
    add("P-22", `p22gi_linkopen_${N}`, () => rep("[*a](/b) ", N));
  }
  // what is the unit of the quartic cost: a list item, a soft-wrapped paragraph, a blank-line-separated paragraph?
  for (const N of [100, 200, 400]) {
    add("P-22", `p22L_list_star_${N}`, () => rep("- *[a](/b)\n", N));
    add("P-22", `p22L_para_star_${N}`, () => rep("*[a](/b)\n", N));
    add("P-22", `p22L_blank_star_${N}`, () => rep("*[a](/b)\n\n", N));
    add("P-22", `p22L_heading_star_${N}`, () => rep("## *[a](/b)\n\n", N));
    add("P-22", `p22L_quote_star_${N}`, () => rep("> *[a](/b)\n>\n", N));
  }
  add("P-22", "p22L_list_item_100_in_one", () => "- " + rep("*[a](/b) ", 100) + "\n");
  add("P-22", "p22L_list_5items_x50", () => rep("- " + rep("*[a](/b) ", 50) + "\n", 5));
  add("P-22", "p22L_blank_50x5", () => rep(rep("*[a](/b) ", 50) + "\n\n", 5));
  add("P-22", "p22L_blank_30x20", () => rep(rep("*[a](/b) ", 30) + "\n\n", 20));
  add("P-22", "p22L_blank_40x15", () => rep(rep("*[a](/b) ", 40) + "\n\n", 15));
  // unclosed backtick / tilde next to links (same interplay as `*[a](/b)`), per-paragraph
  for (const N of [50, 100, 150]) {
    add("P-22", `p22x_bt_link_${N}`, () => rep("`[a](/b) ", N));
    add("P-22", `p22x_tilde_link_${N}`, () => rep("~~[a](/b) ", N));
    add("P-22", `p22x_bt_star_${N}`, () => rep("`a *[b](/c) ", N));
    add("P-22", `p22x_bt_only_${N * 4}`, () => rep("`a ", N * 4));
    add("P-22", `p22x_tilde_only_${N * 4}`, () => rep("~~a ", N * 4));
  }
  // ── P-23: syntax not yet probed, 200 000 chars each ──────────────────────
  const to200 = (unit: string) => () => rep(unit, Math.ceil(200000 / unit.length)).slice(0, 200000);
  const syn: Record<string, string> = {
    backtick: "`",
    codespan: "`a` ",
    fence: "```\ncode\n```\n",
    tilde: "~~a~~ ",
    escstar: "\\*",
    amp: "&amp;",
    htmlb: "<b>x</b>",
    tablerow: "|a|b|\n",
    hash: "#",
    hash_a: "# a\n",
    quote_nest: "> ",
    quote_a: "> a\n",
    setext: "a\n===\n",
    ordered: "1. a\n",
    hr_dash: "---\n",
    hr_star: "***\n",
    hr_under: "___\n",
    plus_item: "+ a\n",
    star_item: "* a\n",
    task_item: "- [ ] a\n",
    indented_code: "    code\n",
    hard_break: "a  \n",
    bang: "!",
    lt: "<",
    backslash: "\\",
    bracket_pair: "[]",
    paren_pair: "()",
    ref_def: "[r]: /x\n",
    entity_num: "&#106;",
    tab: "\t",
    emoji: "😀",
  };
  for (const [k, u] of Object.entries(syn)) add("P-23", `p23_${k}`, to200(u));
  // calibration for the P-23 vectors that did not finish at 200 000 chars, and the line-based ones at the proposed 5 000-line cap
  for (const k of ["backtick", "codespan", "tilde", "tab"]) for (const n of [250, 500, 1000, 2000, 4000, 8000]) add("P-23", `p23c_${k}_${n}`, () => rep(syn[k]!, n));
  add("P-23", "p23c_tab_a_100k", () => rep("a\t", 100000));
  add("P-23", "p23c_tab_a_2k", () => rep("a\t", 2000));
  for (const [k, u] of Object.entries(syn)) {
    const per = (u.match(/\n/g) ?? []).length;
    if (per > 0) add("P-23", `p23c_${k}_L${lim.lines}`, () => rep(u, Math.ceil(lim.lines / per)));
  }
  // line-count calibration of the syntaxes that blew the 1 s budget at 5 000 lines
  for (const k of ["fence", "tablerow", "hash_a", "hr_star", "hr_under", "ordered", "setext", "hr_dash"]) {
    const u = syn[k]!;
    const per = (u.match(/\n/g) ?? []).length;
    for (const L of [500, 1000, 1500, 2000]) add("P-23", `p23d_${k}_L${L}`, () => rep(u, Math.ceil(L / per)));
  }
  // ── P-24: worst-case at the proposed limits, real-like bodies, tree caps ─
  const worst = (spread: boolean, nested = false) => () => {
    const L = lim.lines;
    const rows: string[] = [];
    const starLines = Math.floor(lim.starUnd / 2);
    for (let i = 0; i < L; i++) {
      if (spread && i % 50 === 49) {
        rows.push("");
        continue;
      }
      const parts = ["w"];
      if (nested && i < lim.starUnd / 6) parts.push("*a **b _c_ d** e*");
      else if (!nested && i < starLines) parts.push("*x*");
      if (i < lim.links) parts.push("[a](/b)");
      rows.push(parts.join(" "));
    }
    return rows.join("\n");
  };
  add("P-24", "p24_worst_single", worst(false));
  add("P-24", "p24_worst_spread", worst(true));
  add("P-24", "p24_worst_f1_single", () => {
    const rows: string[] = [];
    const f1Lines = Math.ceil(lim.starUnd / 7);
    for (let i = 0; i < lim.lines; i++) {
      const parts = ["w"];
      if (i < f1Lines) parts.push("*a _b_ **c**");
      if (i < lim.links) parts.push("[a](/b)");
      rows.push(parts.join(" "));
    }
    return rows.join("\n");
  });
  add("P-24", "p24_worst_f1_oneline", () => rep("*a _b_ **c** ", Math.ceil(lim.starUnd / 7)) + "\n" + rep("[a](/b) ", lim.links) + "\n" + rep("a\n", lim.lines - 2));
  add("P-24", "p24_worst_nested", worst(false, true));
  add("P-24", "p24_worst_unbalanced", () => {
    const rows = ["*".repeat(lim.starUnd), "](".repeat(lim.links)];
    while (rows.length < lim.lines) rows.push("a");
    return rows.join("\n");
  });
  // vectors that PASS the revised pre-check at its limits (per-unit caps stuffed, then the totals)
  const unitsJoin = (unit: string, n: number, k: number) => Array.from({ length: k }, () => rep(unit + " ", n).trim()).join("\n\n");
  const nLinkUnits = Math.floor(REV6.links / REV6.unitLinks);
  const nRunUnits = Math.floor(REV6.runs / REV6.unitRuns);
  add("P-24", "p24_cap_f13_units", () => unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_f13b_units", () => unitsJoin("[a](/b)*\\**", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_star_link_units", () => unitsJoin("*[a](/b)", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_bt_star_units", () => unitsJoin("`a *[b](/c)", Math.floor(REV6.unitRuns / 2), nLinkUnits));
  add("P-24", "p24_cap_tilde_link_units", () => unitsJoin("~~[a](/b)", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_runs_units", () => unitsJoin("*a", REV6.unitRuns, nRunUnits));
  add("P-24", "p24_cap_bt_runs_units", () => unitsJoin("`a", REV6.unitRuns, nRunUnits));
  add("P-24", "p24_cap_f1_units", () => unitsJoin("*a _b_ **c**", Math.floor(REV6.unitRuns / 5), nRunUnits));
  add("P-24", "p24_cap_lines_fence", () => rep("```\ncode\n```\n", Math.ceil(REV6.lines / 3)));
  add("P-24", "p24_cap_lines_fence_plus_units", () => rep("```\ncode\n```\n", Math.floor(REV6.lines / 6)) + "\n" + unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_tablerows", () => rep("|a|b|\n", REV6.lines));
  add("P-24", "p24_cap_headings", () => rep("# a\n", REV6.lines));
  add("P-24", "p24_cap_backticks", () => rep("`a` ", Math.floor(REV6.markChars / 8)) + "\n\n" + rep("~~a~~ ", Math.floor(REV6.markChars / 12)));
  add("P-24", "p24_cap_combo_table_f13", () => rep("|a|b|\n", REV6.lines - 100) + "\n" + unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_combo_zigzag_units", () => zig(31, REV6.lines - 100) + "\n\n" + unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), Math.floor(nLinkUnits / 2)) + "\n\n" + unitsJoin("`a *[b](/c)", Math.floor(REV6.unitRuns / 2), Math.floor(nLinkUnits / 2)));
  add("P-24", "p24_cap_combo_headings_units", () => rep("# a\n", REV6.lines - 100) + "\n" + unitsJoin("*[a](/b)", REV6.unitLinks, nLinkUnits) + "\n\n" + unitsJoin("*a", REV6.unitRuns, nRunUnits - 5));
  add("P-24", "p24_cap_combo_zigzag_edge", () => zig(31, Math.floor((REV6.nodes - 600) / 9)) + "\n\n" + unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_combo_zigzag15_units", () => zig(REV6.indent, REV6.lines - 80) + "\n\n" + unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_combo_fence_free", () => rep("|a|b|\n", Math.floor((REV6.lines - 80) / 2)) + "\n" + rep("# a\n", Math.floor((REV6.lines - 80) / 2)) + "\n\n" + unitsJoin("*[a](/b)", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_combo_table_f13b", () => rep("|a|b|\n", REV6.lines - 100) + "\n" + unitsJoin("[a](/b)*\\**", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_combo_zigzag15_f13b", () => zig(REV6.indent, REV6.lines - 80) + "\n\n" + unitsJoin("[a](/b)*\\**", REV6.unitLinks, nLinkUnits));
  add("P-24", "p24_cap_zigzag_nodes", () => zig(31, REV6.lines));
  add("P-24", "p24_cap_list_items", () => rep("- a **b** [c](/d)\n", REV6.lines));
  add("P-24", "p24_normal_199k", () => {
    const para = "Đây là một đoạn văn **bình thường** với [liên kết](https://example.com/a) và *nghiêng*, dài vừa phải cho một bài báo. ";
    let s = "";
    while (s.length < 199000) s += rep(para, 4) + "\n\n";
    return s;
  });
  add("P-21", "p21_normal_199k", v.p24_normal_199k!.gen);
  add("P-21", "p21_real_40k", () => realBody6(40000, { line: 150, bold: 300, link: 1000, ital: 600, seed: 40 }));
  add("P-24", "p24_real_40k", () => realBody6(40000, { line: 150, bold: 300, link: 1000, ital: 600, seed: 40 }));
  add("P-24", "p24_real_200k", () => realBody6(200000, { line: 150, bold: 300, link: 1000, ital: 600, seed: 200 }));
  add("P-24", "p24_real_200k_para", () => realBody6(200000, { line: 600, bold: 300, link: 1000, ital: 600, seed: 203 }));
  add("P-24", "p24_real_dense_200k_para", () => realBody6(200000, { line: 600, bold: 100, link: 400, ital: 250, seed: 204 }));
  add("P-24", "p24_real_sparse_200k", () => realBody6(200000, { line: 150, bold: 800, link: 2500, ital: 1500, seed: 201 }));
  add("P-24", "p24_real_dense_200k", () => realBody6(200000, { line: 80, bold: 100, link: 400, ital: 250, seed: 202 }));
  add("P-24", "p24_docs_concat", () => {
    const dir = "docs";
    const names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return names.map((f) => readFileSync(`${dir}/${f}`, "utf8")).join("\n\n");
  });
  for (const k of [15, 31, 63, 127, 255]) add("P-24", `p24_nodes_zigzag${k}`, () => zig(k, lim.lines));
  add("P-24", "p24_nodes_dash_lines", () => rep("- a\n", lim.lines));
  add("P-24", "p24_nodes_text_lines", () => rep("a\n", lim.lines));
  add("P-24", "p24_nodes_ital_words", () => rep("a *b* ", Math.floor(lim.starUnd / 2)));
  add("P-24", "p24_nodes_links", () => rep("[a](/b) ", lim.links));
  add("P-24", "p24_nodes_quote_nest", () => rep("> ", 5000) + "x");
  return v;
}

interface Body6Ctx {
  /** the editor config the converters use (P-25 compares it before / after terminations) */
  editorConfig?: unknown;
  md2lex: (m: string) => Record<string, unknown>;
  lex2md: (d: unknown) => string;
  obs: (label: string, v: unknown) => void;
  ms: (t0: number) => number;
  only?: string[];
  vecOnly?: string;
}

/** Compact (type, format, text) rendering of a small Lexical tree. */
function flat6(n: unknown): string {
  const o = n as Record<string, unknown>;
  const kids = Array.isArray(o.children) ? (o.children as unknown[]).map(flat6).join(" ") : "";
  if (o.type === "text") return `t(f=${o.format})${JSON.stringify(o.text)}`;
  const tag = o.type === "heading" ? `h${String(o.tag).slice(1)}` : String(o.type);
  return `${tag}[${kids}]`;
}

/** Semantic signature: element open/close markers + adjacent same-format text runs merged (node splitting is NOT a difference). */
function formatSeq6(state: unknown): string {
  const out: string[] = [];
  let runFmt: unknown = null;
  let runTxt = "";
  const flush = () => {
    if (runTxt !== "") out.push(`${runFmt}:${runTxt}`);
    runTxt = "";
  };
  const stack: unknown[] = [(state as { root?: unknown })?.root];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | string | undefined;
    if (!n) continue;
    if (typeof n === "string") {
      flush();
      out.push(n);
      continue;
    }
    if (n.type === "text") {
      if (runTxt !== "" && runFmt !== n.format) flush();
      runFmt = n.format;
      runTxt += String(n.text);
      continue;
    }
    flush();
    out.push(`<${n.type}${n.tag ? n.tag : ""}${n.listType ? n.listType : ""}${(n.fields as { url?: string } | undefined)?.url ?? ""}>`);
    stack.push(`</${n.type}>`);
    if (Array.isArray(n.children)) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  flush();
  return out.join("|");
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.1 / Stage 0.5c — hard time guard feasibility (OBSERVE ONLY).
//   P-25 : wrap the WHOLE conversion in `vm` with `timeout` (H6a hard stop, H6b same process stays healthy,
//          H6c overhead, H6d importer / exporter are synchronous).
//   P-26 : `worker_threads` + `terminate()` fallback (H6e) — only measured when P-25 does not hold.
// Run each vector in its OWN process, with an outer `timeout 60` (a vector the guard cannot interrupt must not hang the shell):
//   --explore6 --only P-25 --vec <label> --T 1000,1500,2000 [--ctx new|reuse]
//   --explore6 --only P-25 --mode redos|native|sync|overhead|cycle [--T ..] [--cycles 50]
//   --explore6 --list    (labels `P-25 p25_*`)
// ─────────────────────────────────────────────────────────────────────────────

/** P-25 vector labels → generators. Reuses the P-22/P-23/P-24 generators by name; adds only the vectors that did not exist. */
function p25Vectors(v: Record<string, V6>): Record<string, () => string> {
  const rep = (s: string, n: number) => s.repeat(n);
  const reuse = (name: string): (() => string) => {
    const g = v[name]?.gen;
    if (!g) throw new Error(`P-25: unknown base vector ${name}`);
    return g;
  };
  return {
    p25_star_a_3000: () => rep("*a ", 3000),
    p25_star_a_1000: () => rep("*a ", 1000),
    p25_star_link_200: () => rep("*[a](/b) ", 200),
    p25_star_link_400: () => rep("*[a](/b) ", 400),
    p25_backtick_200k: reuse("p23_backtick"),
    p25_tilde_33333: reuse("p23_tilde"),
    p25_tab_200k: reuse("p23_tab"),
    p25_fence_5000: reuse("p23c_fence_L5000"),
    p25_tablerow_5000: reuse("p23c_tablerow_L5000"),
    p25_star_100k: reuse("p22_block_star_100000"),
    p25_block_lf_100100: reuse("p22_block_a_100100"),
    p25_codespan_66667: reuse("p23_codespan"),
    p25_hash_200k: reuse("p23_hash_a"),
    p25_hr_dash_200k: reuse("p23_hr_dash"),
    // real-like (must NOT be interrupted) and the unguarded-but-heavy cases from the P-24 measurements
    p25_real_40k: reuse("p24_real_40k"),
    p25_real_200k_para: reuse("p24_real_200k_para"),
    p25_real_dense_200k_para: reuse("p24_real_dense_200k_para"),
    p25_normal_199k: reuse("p24_normal_199k"),
    p25_zigzag255_200k: reuse("p24_nodes_zigzag255"),
    p25_nodes_dash_lines: reuse("p24_nodes_dash_lines"),
  };
}

async function p25p26(c: Body6Ctx, v: Record<string, V6>): Promise<void> {
  const { md2lex, lex2md, obs, ms } = c;
  const vm = await import("node:vm");
  const { createHash } = await import("node:crypto");
  const v8 = await import("node:v8");
  const ah = await import("node:async_hooks");
  const vecs = p25Vectors(v);
  const Ts = (arg("T") ?? "1000,1500,2000").split(",").map((x) => Number(x));
  const mode = arg("mode") ?? "vec";
  const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
  /** link nodes carry a random 24-hex `id` (the ONLY key that differs between two conversions of one body — see `--mode nondet`): blank it before hashing */
  const canon = (json: string) => json.replace(/"id":"[0-9a-f]{24}"/g, '"id":"#"');

  /** The whole conversion as one SYNCHRONOUS function: md→lex, tree walk, JSON, lex→md, stability pass (md→lex, lex→md). */
  const work = (md: string) => {
    const lex1 = md2lex(md);
    const st = treeStats(lex1);
    const json = JSON.stringify(lex1);
    const md1 = lex2md(lex1);
    const lex2 = md2lex(md1);
    const md2 = lex2md(lex2);
    return { nodes: st.nodes, json, md1, md2 };
  };

  // guard variants (all synchronous): new context per call, or one reused context + precompiled Script
  const guardNew = <A, R>(fn: (a: A) => R, a: A, T: number): R => vm.runInNewContext("fn(a)", { fn, a }, { timeout: T }) as R;
  const reuseSandbox: Record<string, unknown> = {};
  const reuseCtx = vm.createContext(reuseSandbox);
  const reuseScript = new vm.Script("fn(a)");
  const guardReuse = <A, R>(fn: (a: A) => R, a: A, T: number): R => {
    reuseSandbox.fn = fn;
    reuseSandbox.a = a;
    try {
      return reuseScript.runInContext(reuseCtx, { timeout: T }) as R;
    } finally {
      reuseSandbox.fn = undefined;
      reuseSandbox.a = undefined;
    }
  };
  const guard = (kind: string) => (kind === "reuse" ? guardReuse : guardNew);
  const run = <A, R>(kind: string, fn: (a: A) => R, a: A, T: number) => {
    const t0 = performance.now();
    try {
      const r = guard(kind)(fn, a, T);
      return { ok: true as const, ms: performance.now() - t0, r };
    } catch (e) {
      const err = e as { code?: string; name?: string; message?: string };
      return { ok: false as const, ms: performance.now() - t0, code: err.code ?? null, name: err.name ?? typeof e, msg: String(err.message ?? "").slice(0, 120) };
    }
  };
  const r1 = (x: number) => Math.round(x * 10) / 10;

  if (c.only?.includes("P-26")) {
    obs("P-26 (worker_threads + terminate) NOT run: H6e is only measured when P-25 H6a or H6b is NOT-VIABLE / INCONCLUSIVE (see report)", {});
    return;
  }

  // which key names differ between two conversions of the SAME input (random ids, etc.)? — needed to compare trees across runs
  if (mode === "nondet") {
    const body = vecs.p25_real_40k!();
    const a = md2lex(body);
    const b = md2lex(body);
    const ks = new Set<string>();
    diffKeyNames(a, b, "root", ks);
    const sample = (JSON.stringify(a).match(/"id":"[^"]*"/g) ?? []).slice(0, 3);
    obs("P-25 nondeterministic key names between two conversions of the same body", { keys: [...ks], sampleIds: sample });
    return;
  }

  // ── H6a (breadth): random hostile bodies under a SHORT guard — does ANY input run past the timeout? (max overshoot = slowest interrupt) ──
  if (mode === "fuzz") {
    const T = Ts[0]!;
    const kind = arg("ctx") ?? "new";
    const trials = Number(arg("trials") ?? 300);
    const rnd = seeded6(Number(arg("seed") ?? 31));
    const inl = ["*", "**", "_", "__", "[a]", "(/b)", "](/b)", "[", "]", "a ", " ", "a", "`", "~~", "\\", "<", "*a", "a*", "_a", "a_", "[a](/b)", "](", "(", ")", "**a", "a**", "[a](/b)*", "*[a]", "\t", "&amp;", "<b>", "|", "!", "#", "==", "$", "\u2028", "\u00a0"];
    const lin = ["a", "# a", "## a", "|a|b|", "|---|---|", "```", "~~~", "---", "***", "___", "- a", "* a", "+ a", "1. a", "> a", ">", "[r]: /x", "a  ", "    a", "a\\", "===", "-", "a **b**", "[a](/b)", "`a`", "", "- [ ] a", "  - b", "\t- c", "<div>", "![i](/x.png)"];
    const res: { shape: string; len: number; elapsedMs: number; overshootMs: number; timedOut: boolean; ok: boolean }[] = [];
    for (let i = 0; i < trials; i++) {
      let body: string;
      let shape: string;
      if (rnd() < 0.5) {
        const k = 1 + Math.floor(rnd() * 5);
        const unit = Array.from({ length: k }, () => inl[Math.floor(rnd() * inl.length)]!).join("");
        const n = Math.max(1, Math.floor((50 + rnd() * 200_000) / Math.max(1, unit.length + 1)));
        body = (unit + " ").repeat(n).slice(0, 200_000);
        shape = `inline ${JSON.stringify(unit)} x${n}`;
      } else {
        const pick = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => lin[Math.floor(rnd() * lin.length)]!);
        const L = 50 + Math.floor(rnd() * 20_000);
        body = Array.from({ length: L }, () => pick[Math.floor(rnd() * pick.length)]!).join("\n").slice(0, 200_000);
        shape = `lines ${JSON.stringify(pick)} x${L}`;
      }
      const r = run<string, ReturnType<typeof work>>(kind, work, body, T);
      res.push({ shape: shape.slice(0, 90), len: body.length, elapsedMs: r1(r.ms), overshootMs: r1(r.ms - T), timedOut: !r.ok && r.code === "ERR_SCRIPT_EXECUTION_TIMEOUT", ok: r.ok });
    }
    const timed = res.filter((x) => x.timedOut);
    const unexpected = res.filter((x) => !x.ok && !x.timedOut);
    const fin = res.filter((x) => x.ok);
    const worst = timed.slice().sort((a, b) => b.overshootMs - a.overshootMs);
    const finMax = fin.reduce((m, x) => Math.max(m, x.elapsedMs), 0);
    obs(`P-25 fuzz T=${T} ctx=${kind} trials=${trials}`, { finishedWithinT: fin.length, timedOut: timed.length, otherFailures: unexpected.length, slowestFinishedMs: finMax, overshootMs: { max: worst[0]?.overshootMs ?? null, p90: worst[Math.floor(worst.length * 0.1)]?.overshootMs ?? null, median: worst[Math.floor(worst.length / 2)]?.overshootMs ?? null }, worst5: worst.slice(0, 5), otherFailureExamples: unexpected.slice(0, 3) });
    return;
  }

  // ── H6d: is the conversion synchronous? (no promise / microtask / timer created during md→lex→md) ──
  if (mode === "sync") {
    const counts: Record<string, number> = {};
    const hook = ah.createHook({
      init(_id, type) {
        counts[type] = (counts[type] ?? 0) + 1;
      },
    });
    const body = vecs.p25_real_40k!();
    hook.enable();
    const out = work(body);
    hook.disable();
    // positive control: the same hook DOES see a microtask / promise / timer when one is created
    const ctl: Record<string, number> = {};
    const hook2 = ah.createHook({
      init(_id, type) {
        ctl[type] = (ctl[type] ?? 0) + 1;
      },
    });
    hook2.enable();
    queueMicrotask(() => undefined);
    void Promise.resolve().then(() => undefined);
    clearTimeout(setTimeout(() => undefined, 1));
    hook2.disable();
    obs("P-25 H6d positive control (hook sees queueMicrotask / Promise / setTimeout)", ctl);
    const isP = (x: unknown) => typeof (x as { then?: unknown } | null)?.then === "function";
    obs("P-25 H6d async resources created while converting a 40k body (empty object = fully synchronous)", { counts, outputIsThenable: isP(out) || isP(out.json) || isP(out.md1), nodes: out.nodes, md1Len: out.md1.length, stable: out.md1 === out.md2 });
    // does a `discrete` update commit before it returns? (the JSON is complete right after md2lex)
    const lex = md2lex("## a\n\n**b** [c](/d)");
    obs("P-25 H6d editor state complete immediately after md2lex return", { rootChildren: ((lex as { root: { children: unknown[] } }).root.children ?? []).length, md: lex2md(lex) });
    return;
  }

  // ── pure-JS and native control cases (vm timeout vs things that are not importer code) ──
  if (mode === "redos") {
    for (const T of Ts) {
      const r = run<string, boolean>("new", (s) => /^(a+)+$/.test(s), "a".repeat(40) + "!", T);
      obs(`P-25 redos /^(a+)+$/ x 40a+! T=${T}`, { timedOut: !r.ok && r.code === "ERR_SCRIPT_EXECUTION_TIMEOUT", elapsedMs: r1(r.ms), overshootMs: r1(r.ms - T), ...(r.ok ? { result: r.r } : { code: r.code, name: r.name }) });
    }
    return;
  }
  if (mode === "native") {
    const bigArr = Array.from({ length: 3_000_000 }, (_, i) => ({ x: i, y: [i, "a"] }));
    const nums = Array.from({ length: 4_000_000 }, (_, i) => (i * 7919) % 1_000_003);
    const bigStr = "a".repeat(100_000_000);
    const cases: Record<string, () => unknown> = {
      json_stringify_3M_objects: () => JSON.stringify(bigArr).length,
      array_sort_default_4M: () => nums.slice().sort().length,
      string_replaceAll_100M: () => bigStr.replaceAll("a", "bb").length,
      string_split_join: () => "a,".repeat(20_000_000).split(",").join(";").length,
      normalize_100M: () => bigStr.normalize("NFD").length,
      js_infinite_loop: () => {
        for (;;) {
          /* spin */
        }
      },
    };
    // the same builtins at input sizes the hub can actually feed them (body <= 200 000 chars, <= ~100 000 pieces): unguarded wall time
    const small: Record<string, () => unknown> = {
      array_sort_default_200k: () => nums.slice(0, 200_000).sort().length,
      string_replaceAll_200k: () => bigStr.slice(0, 200_000).replaceAll("a", "bb").length,
      string_split_join_100k: () => "a,".repeat(100_000).split(",").join(";").length,
      normalize_200k: () => bigStr.slice(0, 200_000).normalize("NFD").length,
      json_stringify_tree_1_4MB: () => JSON.stringify(bigArr.slice(0, 30_000)).length,
    };
    if (arg("small") !== undefined || flag("small")) {
      for (const [name, fn] of Object.entries(small)) {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          fn();
          times.push(performance.now() - t0);
        }
        obs(`P-25 native@hub-scale ${name} (ms, 5 runs)`, { min: r1(Math.min(...times)), max: r1(Math.max(...times)) });
      }
      return;
    }
    const only = arg("case");
    for (const [name, fn] of Object.entries(cases)) {
      if (only && only !== name) continue;
      for (const T of Ts) {
        const r = run<undefined, unknown>("new", () => fn(), undefined, T);
        obs(`P-25 native ${name} T=${T}`, { timedOut: !r.ok && r.code === "ERR_SCRIPT_EXECUTION_TIMEOUT", elapsedMs: r1(r.ms), overshootMs: r1(r.ms - T), ...(r.ok ? { finishedWithin: true } : { code: r.code }) });
      }
    }
    return;
  }

  // ── H6c: overhead on normal bodies, new context vs reused context ──
  if (mode === "overhead") {
    const N = Number(arg("n") ?? 15);
    const bodies: Record<string, string> = { real_40k: vecs.p25_real_40k!(), real_200k_para: vecs.p25_real_200k_para!(), small_2k: vecs.p25_real_40k!().slice(0, 2000) };
    const T = Number(arg("Tg") ?? 5000);
    const stat = (xs: number[]) => {
      const s = xs.slice().sort((a, b) => a - b);
      return { min: r1(s[0]!), median: r1(s[Math.floor(s.length / 2)]!), p90: r1(s[Math.floor(s.length * 0.9)]!), max: r1(s[s.length - 1]!) };
    };
    for (const [bn, body] of Object.entries(bodies)) {
      const t: Record<string, number[]> = { unguarded: [], guardNew: [], guardReuse: [] };
      for (let i = 0; i < N; i++) {
        // rotate the order so no variant always runs first / last
        const order = ["unguarded", "guardNew", "guardReuse"];
        for (let k = 0; k < i % 3; k++) order.push(order.shift()!);
        for (const m of order) {
          const t0 = performance.now();
          if (m === "unguarded") work(body);
          else guard(m === "guardNew" ? "new" : "reuse")(work, body, T);
          t[m]!.push(performance.now() - t0);
        }
      }
      const base = stat(t.unguarded!);
      obs(`P-25 H6c overhead body=${bn} (${body.length} chars) n=${N}`, {
        unguarded: base,
        guardNew: { ...stat(t.guardNew!), deltaMedianMs: r1(stat(t.guardNew!).median - base.median), pct: r1(((stat(t.guardNew!).median - base.median) / base.median) * 100) },
        guardReuse: { ...stat(t.guardReuse!), deltaMedianMs: r1(stat(t.guardReuse!).median - base.median), pct: r1(((stat(t.guardReuse!).median - base.median) / base.median) * 100) },
      });
    }
    // cost of the context itself (trivial script)
    const mk: number[] = [];
    const mkR: number[] = [];
    for (let i = 0; i < 300; i++) {
      let t0 = performance.now();
      vm.runInNewContext("1+1", {}, { timeout: 1000 });
      mk.push(performance.now() - t0);
      t0 = performance.now();
      guardReuse(() => 1, 1, 1000);
      mkR.push(performance.now() - t0);
    }
    obs("P-25 H6c context cost, trivial fn: runInNewContext vs reused context (ms)", { newContext: stat(mk), reusedContext: stat(mkR) });
    // memory: 300 fresh contexts, then gc
    v8.setFlagsFromString("--expose_gc");
    const gc = vm.runInNewContext("gc") as () => void;
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 300; i++) vm.runInNewContext("fn(a)", { fn: (x: number) => x, a: i }, { timeout: 1000 });
    gc();
    obs("P-25 H6c heap after 300 fresh contexts + gc (KB delta)", { deltaKB: Math.round((process.memoryUsage().heapUsed - h0) / 1024) });
    return;
  }

  // ── H6b: 50 alternating cycles (catastrophic vector terminated, then normal bodies) in ONE process ──
  if (mode === "cycle") {
    const T = Ts[0]!;
    const kind = arg("ctx") ?? "new";
    const cycles = Number(arg("cycles") ?? 50);
    v8.setFlagsFromString("--expose_gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const bads = ["p25_star_link_200", "p25_star_a_1000", "p25_backtick_200k", "p25_tilde_33333", "p25_fence_5000"];
    const normals: Record<string, string> = { real_40k: vecs.p25_real_40k!(), real_200k_para: vecs.p25_real_200k_para!() };
    const sampleBodies = Object.entries(P1_SAMPLES6);
    /** signature of the editor config's markdown transformers (type, format, regexes, handlers by source text) */
    const trSig = () => {
      const tr = ((c.editorConfig as { features?: { markdownTransformers?: unknown[] } } | undefined)?.features?.markdownTransformers ?? []) as Record<string, unknown>[];
      const rx = (x: unknown) => (x instanceof RegExp ? x.source + "/" + x.flags : x === undefined ? "" : typeof x === "object" ? JSON.stringify(Object.keys(x as object)) : String(x));
      const fn = (x: unknown) => (typeof x === "function" ? sha(Function.prototype.toString.call(x)) : "");
      return sha(JSON.stringify(tr.map((t) => [t.type, t.format, t.tag, t.trigger, rx(t.regExp), rx(t.regExpStart), rx(t.regExpEnd), rx(t.importRegExp), fn(t.replace), fn(t.export), fn(t.importer)])));
    };
    const battery = () => sha(sampleBodies.map(([n, m]) => `${n}:${canon(JSON.stringify(md2lex(m)))}:${lex2md(md2lex(m))}`).join("|"));
    // baseline (no guard, before any termination)
    const base: Record<string, { jsonSha: string; md1Sha: string; ms: number }> = {};
    for (const [n, body] of Object.entries(normals)) {
      work(body); // extra warm run
      const t0 = performance.now();
      const o = work(body);
      base[n] = { jsonSha: sha(canon(o.json)), md1Sha: sha(o.md1), ms: performance.now() - t0 };
    }
    const baseBattery = battery();
    const baseTr = trSig();
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    obs("P-25 H6b baseline (unguarded, before any termination)", { base: Object.fromEntries(Object.entries(base).map(([k, x]) => [k, { ...x, ms: r1(x.ms) }])), batterySha: baseBattery, transformersSig: baseTr, transformerCount: ((c.editorConfig as { features?: { markdownTransformers?: unknown[] } } | undefined)?.features?.markdownTransformers ?? []).length, heapKB: Math.round(heap0 / 1024) });
    let terminated = 0, notTerminated = 0, mismatches = 0, batteryMismatches = 0, transformerMismatches = 0;
    const slow: Record<string, number[]> = { real_40k: [], real_200k_para: [] };
    const killMs: number[] = [];
    const heapTrace: number[] = [];
    for (let i = 0; i < cycles; i++) {
      const bad = bads[i % bads.length]!;
      const r = run<string, ReturnType<typeof work>>(kind, work, vecs[bad]!(), T);
      if (!r.ok && r.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        terminated++;
        killMs.push(r.ms);
      } else {
        notTerminated++;
        obs(`P-25 H6b cycle ${i} bad=${bad} NOT terminated`, { ok: r.ok, elapsedMs: r1(r.ms), ...(r.ok ? { nodes: r.r.nodes } : { code: r.code, name: r.name }) });
      }
      for (const [n, body] of Object.entries(normals)) {
        const t0 = performance.now();
        const g = run<string, ReturnType<typeof work>>(kind, work, body, 20000);
        const dt = performance.now() - t0;
        slow[n]!.push(dt);
        if (!g.ok || sha(canon(g.r.json)) !== base[n]!.jsonSha || sha(g.r.md1) !== base[n]!.md1Sha) {
          mismatches++;
          obs(`P-25 H6b cycle ${i} normal=${n} MISMATCH`, { ok: g.ok, ...(g.ok ? { jsonSha: sha(canon(g.r.json)), md1Sha: sha(g.r.md1) } : { code: g.code, name: g.name }) });
        }
      }
      if (i % 5 === 4) {
        const b = battery();
        if (b !== baseBattery) {
          batteryMismatches++;
          obs(`P-25 H6b cycle ${i} P-1 sample battery MISMATCH`, { sha: b });
        }
        if (trSig() !== baseTr) {
          transformerMismatches++;
          obs(`P-25 H6b cycle ${i} editor-config transformers CHANGED`, {});
        }
      }
      if (i % 10 === 9 || i === cycles - 1) {
        gc();
        heapTrace.push(Math.round(process.memoryUsage().heapUsed / 1024));
      }
    }
    const med = (xs: number[]) => r1(xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);
    const sortedKill = killMs.slice().sort((a, b) => a - b);
    obs(`P-25 H6b summary T=${T} ctx=${kind} cycles=${cycles}`, {
      terminated, notTerminated, normalMismatches: mismatches, batteryMismatches, transformerMismatches,
      killElapsedMs: { min: r1(sortedKill[0] ?? 0), median: med(killMs), max: r1(sortedKill[sortedKill.length - 1] ?? 0) },
      normalMs: Object.fromEntries(Object.entries(slow).map(([k, xs]) => [k, { baselineMs: r1(base[k]!.ms), firstHalfMedian: med(xs.slice(0, Math.floor(xs.length / 2))), secondHalfMedian: med(xs.slice(Math.floor(xs.length / 2))), max: r1(Math.max(...xs)) }])),
      heapKB_afterGc_every10Cycles: heapTrace, heapBaselineKB: Math.round(heap0 / 1024),
    });
    return;
  }

  // ── H6a (default): one vector × several T, each in the same process ──
  const label = c.vecOnly;
  if (!label || !vecs[label]) {
    obs("P-25 needs --vec <label>; labels", Object.keys(vecs));
    return;
  }
  const kind = arg("ctx") ?? "new";
  const body = vecs[label]!();
  const t0s = performance.now();
  const pre = pre6(body);
  const scanMs = ms(t0s);
  const memBase = process.resourceUsage().maxRSS;
  for (const T of Ts) {
    const r = run<string, ReturnType<typeof work>>(kind, work, body, T);
    const mu = process.memoryUsage();
    obs(`P-25 ${label} T=${T} ctx=${kind}`, {
      mem: { heapUsedMB: Math.round(mu.heapUsed / 1048576), rssMB: Math.round(mu.rss / 1048576), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), maxRssGrowthMB: Math.round((process.resourceUsage().maxRSS - memBase) / 1024) },
      len: body.length, lines: pre.lines, starUnd: pre.starUnd, links: pre.links, scanMs,
      timedOut: !r.ok && r.code === "ERR_SCRIPT_EXECUTION_TIMEOUT",
      elapsedMs: r1(r.ms), overshootMs: r1(r.ms - T),
      ...(r.ok ? { finished: true, nodes: r.r.nodes, jsonLen: r.r.json.length, stable: r.r.md1 === r.r.md2 } : { code: r.code, name: r.name, msg: r.msg }),
    });
  }
  // after the (last) termination the same process must still convert a normal body correctly
  const sane = run<string, ReturnType<typeof work>>(kind, work, vecs.p25_real_40k!(), 20000);
  obs(`P-25 ${label} post-termination sanity (real_40k, same process)`, sane.ok ? { ok: true, ms: r1(sane.ms), nodes: sane.r.nodes, stable: sane.r.md1 === sane.r.md2 } : { ok: false, code: sane.code });
}

async function body6(c: Body6Ctx): Promise<void> {
  const { md2lex, lex2md, obs, ms } = c;
  const want = (p: string) => !c.only || c.only.includes(p);
  // warm-up: exclude one-off module / editor initialisation from the measurements
  const w0 = performance.now();
  lex2md(md2lex("Khởi động **đậm** *nghiêng* [liên kết](/x)\n\n- a\n- b"));
  obs("warmup (one-off init, excluded from vectors)", { ms: ms(w0) });
  if (c.only?.includes("P-25") || c.only?.includes("P-26")) {
    await p25p26(c, body6Vectors(parseLim6()));
    return;
  }

  const rt = (md0: string) => {
    const lex1 = md2lex(md0);
    const md1 = lex2md(lex1);
    const lex2 = md2lex(md1);
    const md2 = lex2md(lex2);
    return { lex1, md1, lex2, md2 };
  };

  // ── P-20: where the root cause of the triple-star round trip lives ──────
  if (want("P-20")) {
    const forms: Record<string, string> = {
      triple: "***x***",
      bold_ital: "**_x_**",
      ital_bold: "*__x__*",
      ital_bold_mid: "Câu có *__x__* giữa câu.",
      triple_then_word: "***x*** y",
      triple_in_word: "a***x***b",
      strike_bold_ital: "~~**_x_**~~",
      mark_triple: "==***x***==",
      triple_in_link: "[***x***](/a)",
      triple_in_list: "- ***x***",
      triple_in_quote: "> ***x***",
      triple_in_heading: "## ***x***",
      triple_two_words: "***hai từ***",
      triple_vi: "***Đà Nẵng***",
      under_triple: "___x___",
      bold_ital_under: "__*x*__",
      ital_under_bold: "_**x**_",
      bold_open_ital: "**a *b* c**",
      ital_open_bold: "*a **b** c*",
      ital_open_bold_end: "*a **b***",
      bold_open_ital_end: "**a *b***",
      plain_stars: "a * b * c",
      escaped: "\\*x\\*",
      underscore_word: "snake_case_word",
    };
    for (const [name, md0] of Object.entries(forms)) {
      const r = rt(md0);
      const t1 = formatSeq6(r.lex1);
      const t2 = formatSeq6(r.lex2);
      obs(`P-20 ${name}`, {
        md0,
        lex1: flat6((r.lex1 as { root: unknown }).root),
        md1: r.md1,
        md2: r.md2,
        stable: r.md2 === r.md1,
        F_blocks: r.md2 !== r.md1,
        lex2: flat6((r.lex2 as { root: unknown }).root),
        formatSeqSame: t1 === t2,
      });
    }
    // fuzz: short strings over an inline-marker alphabet — instability and silent drift
    const toks = ["*", "**", "_", "__", "~~", "`", "[", "](/a)", "a", "b", " ", "\n", "x y", " *", "* ", "==", "***", "_ ", " _", "\\*"];
    const rnd = seeded6(20260930);
    let n = 0, unstable = 0, stableDrift = 0, unstable3 = 0;
    const ex: string[] = [];
    const exDrift: string[] = [];
    const driftDetail: Record<string, string>[] = [];
    for (let i = 0; i < 4000; i++) {
      const len = 3 + Math.floor(rnd() * 8);
      let md0 = "";
      for (let k = 0; k < len; k++) md0 += toks[Math.floor(rnd() * toks.length)];
      let r;
      try {
        r = rt(md0);
      } catch {
        continue;
      }
      n++;
      const unst = r.md2 !== r.md1;
      if (unst) {
        unstable++;
        if (ex.length < 12) ex.push(md0);
        // does a THIRD round still change? (is the instability a diverging walk?)
        const md3 = lex2md(md2lex(r.md2));
        if (md3 !== r.md2) unstable3++;
      } else if (formatSeq6(r.lex1) !== formatSeq6(r.lex2)) {
        stableDrift++;
        if (exDrift.length < 12) exDrift.push(md0);
        if (driftDetail.length < 10) driftDetail.push({ md0, md1: r.md1, lex1: flat6((r.lex1 as { root: unknown }).root), lex2: flat6((r.lex2 as { root: unknown }).root) });
      }
    }
    obs("P-20 fuzz (4000 random short inline strings)", { tried: n, F_blocks: unstable, F_blocks_and_third_round_still_changes: unstable3, md2EqMd1_but_formatSeq_differs: stableDrift, examplesBlocked: ex, examplesStableDrift: exDrift });
    obs("P-20 fuzz drift detail (md2 === md1 but semantic signature of lex1 differs from lex2)", driftDetail);
  }

  // ── P-21: gate F on the 18 known-stable samples + 3 unstable ones ───────
  if (want("P-21")) {
    const extra: Record<string, string> = { under_italic: "_x_", under_bold: "__x__", under_italic_mid: "Chữ _nghiêng_ giữa câu.", under_bold_mid: "Chữ __đậm__ giữa câu." };
    const unstable = ["***x***", "**_x_**", "*__x__*"];
    const stableNames: string[] = [];
    let blocked = 0, fOk = 0;
    const rows: Record<string, unknown>[] = [];
    const all: [string, string][] = [...Object.entries(P1_SAMPLES6), ...Object.entries(extra)];
    for (const [name, md0] of all) {
      const t0 = performance.now();
      const r = rt(md0);
      const t = ms(t0);
      const ok = r.md2 === r.md1;
      rows.push({ name, F_passes: ok, F2_passes_sem: ok && formatSeq6(r.lex1) === formatSeq6(r.lex2), ms: t });
      if (ok) {
        fOk++;
        stableNames.push(name);
      } else blocked++;
    }
    for (const u of unstable) {
      const r = rt(u);
      rows.push({ name: `UNSTABLE ${u}`, F_passes: r.md2 === r.md1 });
    }
    // plausible plain-text / punctuation-heavy inputs an editor might paste (looking for FALSE rejections beyond bold+italic)
    const plain: Record<string, string> = {
      backslash_path: "Đường dẫn C:\\Users\\a\\b và \\n literal",
      single_backslash: "a \\ b",
      snake_url: "Xem https://example.com/a_b_c_d?x=1_2 và file_name_final.pdf",
      math_stars: "Phép tính 2*3*4 = 24 và 5 * 6",
      tilde_approx: "Giá ~$5 đến ~$10, khoảng ~3 triệu",
      hashtag: "#DuLich #HaNoi và C# với F#",
      pipes: "a | b | c và x||y",
      brackets: "Mảng [1, 2, 3] và (ghi chú) và [không phải link]",
      angle: "a < b > c và <tag> & &amp; &lt;",
      ordered_text: "Bước 1. làm A 2. làm B 3) làm C",
      stray_bold: "Có ** lẻ loi và * lẻ loi và _ lẻ loi",
      quote_char: 'Anh nói: "xin chào" và \'ok\' và “cong” ‘cong’',
      percent: "Tăng 6,5% so với 2025; 100% chắc chắn!",
      emoji_flags: "🇻🇳 Việt Nam 🇸🇬 Singapore ❤️",
      url_plain: "Truy cập https://example.com/path?a=1&b=2#frag để biết thêm.",
      email: "Liên hệ a_b@example.com hoặc *@example.com",
      markdown_in_words: "snake_case và camelCase và kebab-case và 3_4_5",
      long_vi: "Việt Nam là một quốc gia nằm ở phía Đông bán đảo Đông Dương, thuộc khu vực Đông Nam Á. ".repeat(5),
      dash_text: "Một — hai – ba - bốn -- năm --- sáu",
      numbered_headings: "1. Mở đầu\n\n2. Nội dung\n\n3. Kết",
      two_paragraphs_hard: "Dòng một  \nDòng hai\n\nĐoạn hai",
      nbsp_text: "Một\u00a0hai\u00a0ba",
      tabs_inline: "a\tb\tc",
      code_span: "Dùng `npm install` rồi `npm test`",
      strike: "Giá ~~cũ~~ mới",
      html_entity: "Tom &amp; Jerry &copy; 2026",
      link_with_parens: "[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
      image_like_text: "Không phải ảnh ! [x] (y)",
      trailing_spaces: "Dòng có đuôi   \nDòng tiếp",
      bold_with_underscore: "**snake_case** và *snake_case*",
    };
    const plainRows: Record<string, unknown>[] = [];
    for (const [name, md0] of Object.entries(plain)) {
      const r = rt(md0);
      plainRows.push({ name, F_passes: r.md2 === r.md1, ...(r.md2 === r.md1 ? {} : { md0, md1: r.md1.slice(0, 80), md2: r.md2.slice(0, 80) }) });
    }
    obs("P-21 F on plausible plain-text inputs", plainRows);
    obs("P-21 F on P-1 samples + extras (F_passes=false means F rejects)", rows);
    obs("P-21 summary", { samples: all.length, F_passes: fOk, F_rejects: blocked, rejected: all.filter(([, m]) => rt(m).md2 !== rt(m).md1).map(([n]) => n) });
  }

  // ── P-22 random worst-case hunt (in-process; random unit templates repeated n times, md→lex time only) ──
  if (c.vecOnly === "hunt-lines") {
    const kinds = ["a", "# a", "## a", "|a|b|", "|---|---|", "```", "~~~", "---", "***", "___", "- a", "* a", "+ a", "1. a", "> a", ">", "[r]: /x", "a  ", "    a", "a\\", "===", "-", "a **b**", "[a](/b)", "`a`", "", "- [ ] a", "  - b", "\t- c"];
    const rnd = seeded6(Number(arg("seed") ?? 5));
    const L = Number(arg("lines") ?? 1000);
    const trials = Number(arg("trials") ?? 120);
    const res: { kinds: string[]; roundTripMs: number; md2lexMs: number; nodes: number }[] = [];
    for (let i = 0; i < trials; i++) {
      const pick = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => kinds[Math.floor(rnd() * kinds.length)]!);
      const body = Array.from({ length: L }, () => pick[Math.floor(rnd() * pick.length)]!).join("\n");
      const t = performance.now();
      const lex1 = md2lex(body);
      const a = ms(t);
      const md1 = lex2md(lex1);
      md2lex(md1);
      res.push({ kinds: pick, md2lexMs: a, roundTripMs: ms(t), nodes: treeStats(lex1).nodes });
    }
    res.sort((a, b) => b.roundTripMs - a.roundTripMs);
    obs(`P-23 hunt-lines lines=${L} trials=${trials} top10 by import+export+reimport ms`, res.slice(0, 10));
    return;
  }
  if (c.vecOnly === "hunt" && arg("unit-json")) {
    const unit = JSON.parse(arg("unit-json")!) as string;
    const curve = (arg("ns") ?? "10,20,30,40,50,60").split(",").map((x) => {
      const n = Number(x);
      const body = (unit + " ").repeat(n).trim();
      const pr = pre6(body);
      const t = performance.now();
      md2lex(body);
      return { n, ms: ms(t), runs: pr.runs, links: pr.links, len: body.length };
    });
    obs(`P-22 hunt unit curve ${JSON.stringify(unit)}`, curve);
    return;
  }
  if (c.vecOnly === "hunt") {
    const toks = ["*", "**", "_", "__", "[a]", "(/b)", "](/b)", "[", "]", "a ", " ", "a", "`", "~~", "\\", "<", "*a", "a*", "_a", "a_", "[a](/b)", "](", "(", ")", "**a", "a**", "[a](/b)*", "*[a]"];
    const rnd = seeded6(Number(arg("seed") ?? 7));
    const n0 = Number(arg("units") ?? 40);
    const trials = Number(arg("trials") ?? 300);
    const res: { unit: string; ms: number; runs: number; links: number }[] = [];
    for (let i = 0; i < trials; i++) {
      const k = 2 + Math.floor(rnd() * 4);
      let unit = "";
      for (let j = 0; j < k; j++) unit += toks[Math.floor(rnd() * toks.length)];
      const body = (unit + " ").repeat(n0).trim();
      const pr = pre6(body);
      const t = performance.now();
      md2lex(body);
      res.push({ unit, ms: ms(t), runs: pr.runs, links: pr.links });
    }
    res.sort((a, b) => b.ms - a.ms);
    obs(`P-22 hunt units=${n0} trials=${trials} top15 by md→lex ms`, res.slice(0, 15));
    const top = res.slice(0, 4);
    for (const r of top) {
      const curve = [n0 / 2, n0, n0 * 2].map((n) => {
        const body = (r.unit + " ").repeat(n).trim();
        const t = performance.now();
        md2lex(body);
        return { n, ms: ms(t), ...(({ runs, links }) => ({ runs, links }))(pre6(body)) };
      });
      obs(`P-22 hunt curve unit=${JSON.stringify(r.unit)}`, curve);
    }
    console.log("\n[explore6/body] done (observations only — no assertions)");
    return;
  }
  // ── P-21/22/23/24: one vector per process ───────────────────────────────
  const vecs = body6Vectors(parseLim6());
  for (const [name, { probe, gen }] of Object.entries(vecs)) {
    if (!want(probe)) continue;
    if (c.vecOnly && c.vecOnly !== name) continue;
    // without --vec, every vector of the requested group runs in this one process (cold-start effects shared)
    const body = gen(); // vectors are already trim()-stable shapes (the hub trims before converting)
    const t0 = performance.now();
    const p = pre6(body);
    const preMs = ms(t0);
    const blocked = p.lines > LIM6.lines || p.starUnd > LIM6.starUnd || p.links > LIM6.links;
    const rev: string[] = [];
    if (p.lines > REV6.lines) rev.push("lines");
    if (p.starUnd > REV6.starUnd) rev.push("starUnd");
    if (p.runs > REV6.runs) rev.push("runs");
    if (p.links > REV6.links) rev.push("links");
    if (p.maxUnitRuns > REV6.unitRuns) rev.push("unitRuns");
    if (p.maxUnitLinks > REV6.unitLinks) rev.push("unitLinks");
    if (p.starUnd + p.backticks + p.tildes > REV6.markChars) rev.push("markChars");
    if (p.maxIndent > REV6.indent) rev.push("indent");
    const rec: Record<string, unknown> = { ...p, blocked_by_proposed_limits: blocked, revised_precheck_rejects: rev, scanMs: preMs };
    let t = performance.now();
    const lex1 = md2lex(body);
    rec.md2lexMs = ms(t);
    t = performance.now();
    const st = treeStats(lex1);
    rec.treeWalkMs = ms(t);
    rec.nodes = st.nodes;
    rec.maxDepth = st.maxDepth;
    rec.maxListNest = st.maxListNest;
    t = performance.now();
    const json = JSON.stringify(lex1);
    rec.jsonMs = ms(t);
    rec.jsonLen = json.length;
    rec.emptyForNonEmptyInput = body.trim() !== "" && st.nodes <= 1;
    t = performance.now();
    let md1 = "";
    try {
      md1 = lex2md(lex1);
    } catch (e) {
      rec.exportThrew = (e as Error).name;
    }
    rec.lex2mdMs = ms(t);
    t = performance.now();
    const lex2 = md2lex(md1);
    rec.F_md2lexMs = ms(t);
    t = performance.now();
    const md2 = lex2md(lex2);
    rec.F_lex2mdMs = ms(t);
    rec.F_stable = md2 === md1;
    rec.writePathNoF_ms = Math.round((rec.scanMs as number) + (rec.md2lexMs as number) + (rec.treeWalkMs as number) + (rec.jsonMs as number) + (rec.lex2mdMs as number));
    rec.writePathWithF_ms = Math.round((rec.writePathNoF_ms as number) + (rec.F_md2lexMs as number) + (rec.F_lex2mdMs as number));
    rec.treeCapHit = (rec.nodes as number) > REV6.nodes || (rec.jsonLen as number) > REV6.json;
    rec.verdict_le1000 = (rec.writePathWithF_ms as number) <= 1000 ? "OK" : (rec.writePathWithF_ms as number) > 2000 ? "FAIL(>2000)" : "SLOW(1000-2000)";
    obs(`${probe} ${name}`, rec);
  }
  console.log("\n[explore6/body] done (observations only — no assertions)");
}

/** `--lim lines,starUnd,links` — override the proposed limits used by the P-24 generators / blocked flag. */
function parseLim6(): { lines: number; starUnd: number; links: number } {
  const l = arg("lim");
  if (!l) return LIM6;
  const [a, b, d] = l.split(",").map((x) => Number(x));
  return { lines: a ?? LIM6.lines, starUnd: b ?? LIM6.starUnd, links: d ?? LIM6.links };
}

async function explore6() {
  assertLocalTargets();
  if (flag("list")) {
    const bv = body6Vectors(parseLim6());
    for (const [name, { probe }] of Object.entries(bv)) console.log(`${probe} ${name}`);
    for (const name of Object.keys(p25Vectors(bv))) console.log(`P-25 ${name}`);
    process.exit(0);
  }
  const only = arg("only")?.split(",").map((s) => s.trim());
  const want = (p: string) => !only || only.includes(p);
  const vecOnly = arg("vec");
  const in4 = arg("in4");
  const readTok = in4 ? (JSON.parse(readFileSync(in4, "utf8")) as R_Tokens).read : undefined;

  // P-20 … P-26 are pure-conversion probes: they only need the sanitized config (no DB connection, no schema push).
  const bodyOnly = !!only && only.every((o) => BODY6_PROBES.includes(o));
  const payload0 = bodyOnly ? null : await getPayload({ config });
  const lexical = await import("@payloadcms/richtext-lexical");
  const { loadHubEditorConfig, countDangerousLinkTargets } = await import("../src/lib/hub-article-markdown");
  const { slugify } = await import("../src/lib/http");
  const { sha256Hex } = await import("../src/lib/crypto");
  const editorConfig = await loadHubEditorConfig(payload0 ? payload0.config : await config);
  type Conv = (a: Record<string, unknown>) => unknown;
  const md2lex = (markdown: string) => (lexical.convertMarkdownToLexical as unknown as Conv)({ editorConfig, markdown }) as Record<string, unknown>;
  const lex2md = (data: unknown) => (lexical.convertLexicalToMarkdown as unknown as Conv)({ data, editorConfig }) as string;
  const obs = (label: string, v: unknown) => console.log(`OBS   ${label}  ${JSON.stringify(v)}`);
  const ms = (t0: number) => Math.round(performance.now() - t0);

  if (bodyOnly) {
    await body6({ md2lex, lex2md, obs, ms, only, vecOnly, editorConfig });
    process.exit(0);
  }
  const payload = payload0!;

  const tenants = await tenantsBySlug(payload);
  const T = need(tenants, "dtw");
  const pillarDoc = (
    await payload.find({ collection: "pillars", where: { tenant: { equals: T } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as { id: number; slug: string };
  const authorDoc = (
    await payload.find({ collection: "authors", where: { tenant: { equals: T } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as { id: number };
  if (!pillarDoc || !authorDoc) throw new Error("dtw needs a pillar + author — run --setup / --setup2 first");

  let seq = 0;
  const uniq = (p: string) => `e6-${p}-${Date.now().toString(36)}-${++seq}`.toLowerCase();
  const mk = async (
    extra: Record<string, unknown> = {},
    opts: { draft?: boolean; context?: Record<string, unknown>; noDefaults?: boolean } = {},
  ): Promise<Doc> => {
    const slug = (extra.slug as string | undefined) ?? uniq("a");
    const base = opts.noDefaults
      ? { tenant: T, title: `E6 ${slug}`, slug }
      : { tenant: T, title: `E6 ${slug}`, slug, pillar: pillarDoc.id, author: authorDoc.id, workflowStatus: "draft", origin: "manual" };
    return (await payload.create({
      collection: "articles",
      overrideAccess: true,
      locale: "en",
      ...(opts.draft ? { draft: true } : {}),
      context: { disableRevalidate: true, ...(opts.context ?? {}) },
      data: { ...base, ...extra } as never,
    })) as unknown as Doc;
  };
  const pick = (d: Doc | null) =>
    d && { version: d.version, title: d.title, dek: d.dek ?? null, slug: d.slug, workflowStatus: d.workflowStatus, _status: d._status, sponsor: d.sponsor ?? null };
  const both = async (id: number) => {
    const main = (await payload.findByID({ collection: "articles", id, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
    const latest = (await payload.findByID({ collection: "articles", id, depth: 0, locale: "en", overrideAccess: true, draft: true })) as unknown as Doc;
    return { main: pick(main), latest: pick(latest) };
  };
  const tryW = async <R>(f: () => Promise<R>): Promise<{ ok: true; v: R } | { ok: false; name: string; msg: string }> => {
    try {
      return { ok: true, v: await f() };
    } catch (e) {
      return { ok: false, name: (e as Error)?.name ?? typeof e, msg: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  };
  const hubGet = async (id: number, timeoutMs = 120_000) => {
    if (!readTok) return { skipped: "no --in4" };
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}/api/hub/articles/${id}?tenant=dtw`, {
        headers: { Authorization: `Bearer ${readTok}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = (await res.json()) as { article?: { bodyState?: string; bodyMarkdown?: string } };
      return { status: res.status, ms: ms(t0), bodyState: j.article?.bodyState, mdLen: j.article?.bodyMarkdown?.length };
    } catch (e) {
      return { error: (e as Error).name, ms: ms(t0) };
    }
  };

  // ── P-4 inventory of what the editor registers ──────────────────────────
  const allTypes = new Set<string>();
  const addTypes = (s: TreeStats) => Object.keys(s.types).forEach((t) => allTypes.add(t));
  if (want("P-4")) {
    const ec = editorConfig as unknown as { resolvedFeatureMap?: Map<string, unknown>; editorConfig?: { lexical?: unknown } };
    obs("P-4 registered features", ec.resolvedFeatureMap ? [...ec.resolvedFeatureMap.keys()] : "n/a");
  }

  // ── P-1 Markdown-only samples: md → lex → md → lex ─────────────────────
  const ignoreKeys = new Set<string>();
  if (want("P-1") || want("P-1b") || want("P-4")) {
    const samples = P1_SAMPLES6;
    for (const [name, md0] of Object.entries(samples)) {
      const lex1 = md2lex(md0);
      const md1 = lex2md(lex1);
      const lex2 = md2lex(md1);
      const md2 = lex2md(lex2);
      const s1 = treeStats(lex1);
      const s2 = treeStats(lex2);
      addTypes(s1);
      const d = new Set<string>();
      diffKeyNames(lex1, lex2, "root", d);
      d.forEach((k) => ignoreKeys.add(k));
      const counts = (s: TreeStats) => ({ heading: s.types.heading ?? 0, list: s.types.list ?? 0, link: (s.types.link ?? 0) + (s.types.autolink ?? 0) });
      if (want("P-1"))
        obs(`P-1 ${name}`, {
          md0EqMd1: md0 === md1,
          fixedPoint_md2EqMd1: md2 === md1,
          textEq: s1.text === s2.text,
          countsEq: JSON.stringify(counts(s1)) === JSON.stringify(counts(s2)),
          counts: counts(s1),
          types: s1.types,
          lexDiffKeys: [...d],
          md1,
        });
    }
    if (want("P-1")) obs("P-1 union of differing keys on Markdown-only samples (candidate IGNORE set)", [...ignoreKeys]);
  }

  // ── P-1b CMS-admin-authored Lexical (hand-built, CMS-4 FEASIBILITY builders) ─
  if (want("P-1b") || want("P-4")) {
    const t = lx.text;
    const el = lx.el;
    const li = (children: unknown[], extra: Record<string, unknown> = {}) => el("listitem", children, { value: 1, ...extra });
    const cms: Record<string, unknown> = {
      align_center: lx.root(el("paragraph", [t("canh giữa")], { format: "center", textFormat: 0, textStyle: "" })),
      align_right_heading: lx.root(el("heading", [t("tiêu đề phải")], { tag: "h2", format: "right" })),
      indent_2: lx.root(el("paragraph", [t("thụt lề")], { indent: 2, textFormat: 0, textStyle: "" })),
      underline: lx.root(lx.p(t("gạch dưới", 8))),
      strikethrough: lx.root(lx.p(t("gạch ngang", 4))),
      inline_code: lx.root(lx.p(t("mã", 16))),
      subscript: lx.root(lx.p(t("dưới", 32))),
      superscript: lx.root(lx.p(t("trên", 64))),
      text_style_color: lx.root(lx.p({ ...(t("màu") as object), style: "color: red" })),
      link_newtab: lx.root(
        lx.p(el("link", [t("tab mới")], { version: 3, id: "aa11", fields: { linkType: "custom", url: "https://example.com/x", newTab: true } })),
      ),
      link_internal: lx.root(
        lx.p(el("link", [t("nội bộ")], { version: 3, id: "bb22", fields: { linkType: "internal", doc: { relationTo: "articles", value: 1 }, newTab: false } })),
      ),
      checklist: lx.root(el("list", [li([t("việc 1")], { checked: true }), li([t("việc 2")], { checked: false, value: 2 })], { listType: "check", start: 1, tag: "ul" })),
      ordered_start3: lx.root(el("list", [li([t("ba")], { value: 3 })], { listType: "number", start: 3, tag: "ol" })),
      hr: lx.root(lx.p(t("trên")), { type: "horizontalrule", version: 1 }, lx.p(t("dưới"))),
      upload: lx.root(lx.p(t("ảnh:")), lx.upload("media", 1)),
      relationship: lx.root(lx.p(t("quan hệ:")), lx.rel("articles", 1)),
      plain_reference: lx.root(lx.p(t("đoạn thường "), t("đậm", 1), t(" và "), t("nghiêng", 2))),
    };
    const lost = new Set<string>();
    for (const [name, lex] of Object.entries(cms)) {
      const r = await tryW(async () => {
        const md = lex2md(lex);
        const back = md2lex(md);
        const d = new Set<string>();
        diffKeyNames(lex, back, "root", d);
        const sIn = treeStats(lex);
        const sBack = treeStats(back);
        return { md, diffKeys: [...d], typesIn: sIn.types, typesBack: sBack.types, textEq: sIn.text === sBack.text };
      });
      if (r.ok) {
        r.v.diffKeys.filter((k) => !ignoreKeys.has(k)).forEach((k) => lost.add(k));
        Object.keys(r.v.typesIn).forEach((k) => allTypes.add(`(cms-admin) ${k}`));
      }
      if (want("P-1b")) obs(`P-1b ${name}`, r.ok ? { ...r.v, lostBeyondIgnore: r.v.diffKeys.filter((k) => !ignoreKeys.has(k)) } : r);
    }
    if (want("P-1b")) obs("P-1b union of keys differing on CMS-admin samples beyond the P-1 ignore set (candidate LOST set)", [...lost]);
  }

  // ── P-2 images, P-3 raw HTML + disguised links, P-4 syntax coverage ─────
  if (want("P-2") || want("P-3") || want("P-4")) {
    const probeMd = (label: string, md: string) => {
      const r = (() => {
        try {
          const lex = md2lex(md);
          const s = treeStats(lex);
          addTypes(s);
          const out = lex2md(lex);
          return { types: s.types, links: s.links, text: s.text.slice(0, 120), mdOut: out.slice(0, 200), readRegexHits: countDangerousLinkTargets(out) };
        } catch (e) {
          return { threw: (e as Error).name, msg: String((e as Error).message).slice(0, 120) };
        }
      })();
      obs(label, r);
    };
    if (want("P-2")) {
      probeMd("P-2 inline image", "![alt chữ](https://example.com/a.png)");
      probeMd("P-2 reference image", "![alt][ref]\n\n[ref]: https://example.com/b.png");
      probeMd("P-2 image inside link", "[![a](https://e.com/i.png)](https://e.com)");
    }
    if (want("P-3")) {
      const v: Record<string, string> = {
        html_b: "chữ <b>đậm</b> html",
        html_script: "trước <script>alert(1)</script> sau",
        html_img: "<img src=x onerror=alert(1)>",
        js: "[x](javascript:alert(1))",
        js_upper: "[x](JaVaScRiPt:alert(1))",
        js_tab: "[x](java\tscript:alert(1))",
        js_newline: "[x](java\nscript:alert(1))",
        js_nbsp: "[x](java script:alert(1))",
        js_space_before: "[x]( javascript:alert(1))",
        js_angle: "[x](<javascript:alert(1)>)",
        ref_def: "[x][r]\n\n[r]: javascript:alert(1)",
        autolink_js: "<javascript:alert(1)>",
        entity_j: "[x](&#106;avascript:alert(1))",
        entity_mixed: "[x](java&#115;cript&#58;alert(1))",
        c0_lead: "[x](\u0001javascript:alert(1))",
        proto_rel: "[x](//evil.com)",
        backslash: "[x](\\/\\/evil.com)",
        data_html: "[x](data:text/html,<script>alert(1)</script>)",
        vbscript: "[x](vbscript:msgbox(1))",
        bare_url: "xem https://example.com/z nhé",
        autolink_https: "<https://example.com/y>",
      };
      for (const [k, md] of Object.entries(v)) probeMd(`P-3 ${k}`, md);
    }
    if (want("P-4")) {
      probeMd(
        "P-4 syntax coverage",
        "# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n\n---\n\n```js\nconst a = 1;\n```\n\n`inline` ~~gạch~~ <u>u</u> <sub>s</sub> <sup>s</sup>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] việc\n- [x] xong\n\n<https://auto.example>\n\nhttps://bare.example\n\n***\n\ndòng  \nngắt\n\n> > lồng quote",
      );
      obs("P-4 union of node types seen (markdown imports + (cms-admin) samples)", [...allTypes].sort());
    }
  }

  // ── P-5 required fields on draft + lastEngine persistence ──────────────
  if (want("P-5")) {
    const engId = await engineIdByName(payload, R_ENGINES.read);
    const a = await tryW(() => mk({ workflowStatus: "draft" }, { draft: true, noDefaults: true }));
    obs("P-5 create draft:true WITHOUT pillar/author", a.ok ? { id: a.v.id, pillar: a.v.pillar ?? null, author: a.v.author ?? null, _status: a.v._status } : a);
    const b = await tryW(() => mk({ workflowStatus: "draft" }, { noDefaults: true }));
    obs("P-5 create (no draft flag) WITHOUT pillar/author", b.ok ? { id: b.v.id } : b);
    if (a.ok) obs("P-5 GET hub detail of pillar-less draft", await hubGet(a.v.id as number));
    const c = await tryW(() => mk({ lastEngine: engId }));
    if (c.ok) {
      const id = c.v.id as number;
      const r0 = (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true })) as unknown as Doc;
      await payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", context: { disableRevalidate: true }, data: { title: "P5 edited" } as never });
      const r1 = (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true })) as unknown as Doc;
      await payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true, hubAuthor: { actor: "probe" }, engineId: engId }, data: { title: "P5 draft edit" } as never });
      const r2 = (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, draft: true })) as unknown as Doc;
      obs("P-5 lastEngine passed in create data", { engineId: engId, afterCreate: r0.lastEngine, afterPlainUpdate: r1.lastEngine, afterDraftUpdateWithUnknownCtx: r2.lastEngine, version: [r0.version, r1.version, r2.version], _status: r0._status });
    } else obs("P-5 lastEngine create", c);
  }

  // ── P-6a two concurrent Local-API creates with the same slug ────────────
  if (want("P-6a")) {
    const res: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const slug = uniq("race");
      const rr = await Promise.allSettled([mk({ slug }), mk({ slug })]);
      const n = (await payload.find({ collection: "articles", where: { and: [{ tenant: { equals: T } }, { slug: { equals: slug } }] }, depth: 0, limit: 5, overrideAccess: true, locale: "en" })).totalDocs;
      res.push({ fulfilled: rr.filter((x) => x.status === "fulfilled").length, rowsWithSlug: n, errors: rr.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason?.message ?? "").slice(0, 90)) });
    }
    obs("P-6a 5 trials of 2 parallel creates same slug", res);
  }

  // ── P-10 exclusive / translationAssisted with overrideAccess ───────────
  if (want("P-10")) {
    const r = await tryW(() => mk({ exclusive: true, translationAssisted: true }));
    obs("P-10 create with exclusive:true translationAssisted:true (overrideAccess)", r.ok ? { exclusive: r.v.exclusive, translationAssisted: r.v.translationAssisted } : r);
  }

  // ── P-11 locale + sourceLanguage ─────────────────────────────────────────
  if (want("P-11")) {
    const tDoc = (await payload.findByID({ collection: "tenants", id: T, depth: 0, overrideAccess: true })) as unknown as Doc;
    const slug = uniq("p11");
    const created = (await payload.create({
      collection: "articles",
      overrideAccess: true,
      context: { disableRevalidate: true },
      data: { tenant: T, title: "P11 tiêu đề không locale", slug, pillar: pillarDoc.id, author: authorDoc.id, workflowStatus: "draft", sourceLanguage: tDoc.defaultLanguage } as never,
    })) as unknown as Doc;
    const en = (await payload.findByID({ collection: "articles", id: created.id as number, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
    const noSrc = await mk({});
    obs("P-11", { tenantDefaultLanguage: tDoc.defaultLanguage, titleReadEn: en.title, slugReadEn: en.slug, sourceLanguage: en.sourceLanguage, sourceLanguageWhenNotPassed: noSrc.sourceLanguage ?? null });
  }

  // ── P-12 disableRevalidate really suppresses the webhook (+ positive control) ─
  if (want("P-12")) {
    const http = await import("node:http");
    let hits = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST") hits++;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const tDoc = (await payload.findByID({ collection: "tenants", id: T, depth: 0, overrideAccess: true })) as unknown as Doc;
    const prevUrl = tDoc.frontendUrl ?? null;
    await payload.update({ collection: "tenants", id: T, overrideAccess: true, context: { disableRevalidate: true }, data: { frontendUrl: `http://127.0.0.1:${port}` } as never });
    const counts: Record<string, number> = { signingSecretSet: process.env.CENTRAL_SIGNING_SECRET ? 1 : 0 };
    try {
      let h0 = hits;
      const a = await mk({}, { context: { disableRevalidate: true } });
      counts.createWithFlag = hits - h0;
      h0 = hits;
      await payload.update({ collection: "articles", id: a.id as number, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true }, data: { dek: "x" } as never });
      counts.draftUpdateWithFlag = hits - h0;
      h0 = hits;
      const b = (await payload.create({ collection: "articles", overrideAccess: true, locale: "en", data: { tenant: T, title: "P12 control", slug: uniq("p12"), pillar: pillarDoc.id, author: authorDoc.id, workflowStatus: "draft" } as never })) as unknown as Doc;
      counts.createNoFlag_positiveControl = hits - h0;
      h0 = hits;
      await payload.update({ collection: "articles", id: b.id as number, overrideAccess: true, locale: "en", draft: true, data: { dek: "y" } as never });
      counts.draftUpdateNoFlag = hits - h0;
    } finally {
      await payload.update({ collection: "tenants", id: T, overrideAccess: true, context: { disableRevalidate: true }, data: { frontendUrl: prevUrl } as never });
      server.close();
    }
    obs("P-12 webhook POSTs received", counts);
  }

  // public read token for dtw (sha256 stored, raw kept in memory only)
  const pubTok = randomBytes(24).toString("hex");
  let pubAdded = false;
  const ensurePub = async () => {
    if (pubAdded) return;
    const tDoc = (await payload.findByID({ collection: "tenants", id: T, depth: 0, overrideAccess: true })) as unknown as Doc;
    const prev = (tDoc.readTokens as unknown[] | undefined) ?? [];
    await payload.update({
      collection: "tenants",
      id: T,
      overrideAccess: true,
      context: { disableRevalidate: true },
      data: { readTokens: [...prev, { label: "explore6", tokenHash: sha256Hex(pubTok), tokenPrefix: pubTok.slice(0, 6), status: "active" }] } as never,
    });
    pubAdded = true;
  };
  const pubGet = async (slug: string) => {
    await ensurePub();
    const res = await fetch(`${BASE}/api/public/articles/${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${pubTok}` } });
    const j = (await res.json().catch(() => ({}))) as { title?: string; data?: { title?: string }; doc?: { title?: string } };
    return { status: res.status, title: j.title ?? j.data?.title ?? j.doc?.title ?? null };
  };

  // ── P-14 two faces of a Payload draft; branch A (no draft flag) vs B (draft:true) ─
  if (want("P-14")) {
    const upd = (id: number, data: Record<string, unknown>, draft: boolean) =>
      tryW(() => payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", ...(draft ? { draft: true } : {}), context: { disableRevalidate: true }, data: data as never }));
    for (const scen of [
      { name: "S1 SaveDraft{title:X}", save: { title: "X" } },
      { name: "S2 SaveDraft{title:X,workflowStatus:published}", save: { title: "X", workflowStatus: "published" } },
    ]) {
      for (const branch of ["A", "B"] as const) {
        const a = await mk({ dek: "d0" });
        const id = a.id as number;
        const created = await both(id);
        const sd = await upd(id, scen.save, true);
        const afterSave = await both(id);
        const patch = await upd(id, { dek: `${branch}-dek`, workflowStatus: "draft", _status: "draft" }, branch === "B");
        const afterPatch = await both(id);
        obs(`P-14 ${scen.name} branch ${branch}`, { created, saveDraftOk: sd.ok, afterSave, patchOk: patch.ok ? true : patch, afterPatch, publicGet: await pubGet(a.slug as string) });
      }
    }
    // validation behaviour per branch: sponsored without sponsor
    for (const branch of ["A", "B"] as const) {
      const a = await mk({});
      const r = await upd(a.id as number, { sponsored: true, workflowStatus: "draft", _status: "draft" }, branch === "B");
      obs(`P-14 validation sponsored-without-sponsor branch ${branch}`, r.ok ? { ok: true, stored: await both(a.id as number) } : r);
    }
  }

  // ── P-14b the "unpublish a live article" case ───────────────────────────
  if (want("P-14b")) {
    const upd = (id: number, data: Record<string, unknown>, draft: boolean) =>
      tryW(() => payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", ...(draft ? { draft: true } : {}), context: { disableRevalidate: true }, data: data as never }));
    for (const branch of ["A", "B"] as const) {
      const a = await mk({ dek: "d0", title: `P14b live ${branch}` });
      const id = a.id as number;
      const slug = a.slug as string;
      const pub = await upd(id, { _status: "published", workflowStatus: "published" }, false);
      const afterPublish = await both(id);
      const pubAfterPublish = await pubGet(slug);
      const sd = await upd(id, { title: "Y-draft", workflowStatus: "draft" }, true);
      const afterSave = await both(id);
      const pubAfterSave = await pubGet(slug);
      const patch = await upd(id, { dek: `${branch}-dek`, workflowStatus: "draft", _status: "draft" }, branch === "B");
      const afterPatch = await both(id);
      obs(`P-14b branch ${branch}`, { publishOk: pub.ok ? true : pub, afterPublish, pubAfterPublish, saveDraftOk: sd.ok, afterSave, pubAfterSave, patchOk: patch.ok ? true : patch, afterPatch, pubAfterPatch: await pubGet(slug) });
    }
  }

  // ── P-15 timings on adversarial / large bodies ──────────────────────────
  if (want("P-15")) {
    const rep = (s: string, n: number) => s.repeat(n);
    const C = (cp: number) => String.fromCharCode(cp);
    const vec: Record<string, () => string> = {};
    for (const [k, c] of [["20", " "], ["a0", C(0xa0)], ["3000", C(0x3000)], ["feff", C(0xfeff)], ["2028", C(0x2028)]] as const) {
      vec[`w${k}_190k_x`] = () => "](" + rep(c, 190000) + "x)";
      vec[`w${k}_190k_bare`] = () => "](" + rep(c, 190000);
    }
    vec.walt_190k_x = () => "](" + rep(" " + C(0xa0), 95000) + "x)";
    for (const [k, cp] of [["180e", 0x180e], ["200b", 0x200b], ["0085", 0x85], ["2060", 0x2060]] as const) vec[`nonw${k}_190k_x`] = () => "](" + rep(C(cp), 190000) + "x)";
    const deepList = (indent: (lvl: number) => string, levels: number, target = 200000) => {
      let s = "";
      while (s.length < target) for (let l = 0; l < levels && s.length < target; l++) s += indent(l) + "- x](\n";
      return s;
    };
    vec.deep_tab_256 = () => deepList((l) => "\t".repeat(l), 256);
    vec.deep_tab_64 = () => deepList((l) => "\t".repeat(l), 64);
    vec.deep_sp4_63 = () => deepList((l) => "    ".repeat(l), 63);
    vec.deep_sp4_70 = () => deepList((l) => "    ".repeat(l), 70);
    vec.zigzag_tab63 = () => {
      let s = "";
      while (s.length < 200000) s += "\t".repeat(63) + "- x\n- y\n";
      return s.slice(0, 200000);
    };
    vec.lbracket_100k = () => rep("[", 100000);
    vec.star_100k = () => rep("*", 100000);
    vec.underscore_100k = () => rep("_", 100000);
    vec.quote_nest_10k = () => rep(">", 10000) + " x";
    vec.quote_nest_100k = () => rep(">", 100000) + " x";
    vec.dash_nest_50k = () => rep("- ", 50000) + "x";
    vec.one_line_200k = () => rep("lorem ", 33333);
    vec.normal_200k = () => {
      const para = "Đây là một đoạn văn **bình thường** với [liên kết](https://example.com/a) và *nghiêng*, dài vừa phải cho một bài báo. ";
      let s = "";
      while (s.length < 199000) s += rep(para, 4) + "\n\n";
      return s;
    };
    vec.links_40k = () => rep("[a](b)", 40000);
    vec.links_rel_28k = () => rep("[a](/b) ", 24000);
    vec.bold_30k = () => rep("**a**", 30000);
    vec.lines_100k = () => rep("a\n", 100000);
    vec.dash_lines_50k = () => rep("- a\n", 50000);
    vec.crlf_33k = () => rep("line\r\n", 33000);
    vec.ws256_block_775 = () => rep("](" + rep(" ", 256), 775);
    vec.ws256_x = () => "](" + rep(" ", 256) + "x)";
    vec.ws257_x = () => "](" + rep(" ", 257) + "x)";
    vec.nl300_end = () => "Bài.\n" + rep("\n", 300);
    vec.nl300_mid = () => "Bài.\n" + rep("\n", 300) + "Tiếp.";
    // scaling curves for the slow importer cases (chars = n × unit)
    for (const n of [10000, 25000, 50000]) vec[`star_${n}`] = () => rep("*", n);
    for (const n of [12500, 25000, 50000]) vec[`lines_${n}`] = () => rep("a\n", n);
    for (const n of [5000, 10000, 20000]) vec[`bold_${n}`] = () => rep("**a**", n);
    for (const n of [12500, 25000]) vec[`dash_lines_${n}`] = () => rep("- a\n", n);
    for (const n of [10000, 20000]) vec[`para_lines_${n}`] = () => rep("Một câu văn bình thường có độ dài vừa phải.\n", n);

    for (const [name, gen] of Object.entries(vec)) {
      if (vecOnly && vecOnly !== name) continue;
      const raw = gen();
      const rec: Record<string, unknown> = { inputLen: raw.length };
      // Frozen order, partially simulated (size, C0/surrogate, trim, W-run, image). The linear link scanner does not exist at base.
      const trimmed = raw.trim();
      const c0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw);
      const verdict = raw.length > 200000 ? "422 too_large" : c0 ? "422 c0" : trimmed === "" ? "201 empty" : maxWsRun(trimmed) > 256 ? "422 ws_run" : trimmed.includes("![") ? "422 image" : "pass-pure(1)(2) (link scan not simulated)";
      rec.predicted = verdict;
      rec.maxWsRunIn = maxWsRun(trimmed);
      let t0 = performance.now();
      const lex = md2lex(trimmed);
      rec.md2lexMs = ms(t0);
      const st = treeStats(lex);
      rec.lexJsonLen = JSON.stringify(lex).length;
      rec.nodes = st.nodes;
      rec.maxDepth = st.maxDepth;
      rec.maxListNest = st.maxListNest;
      t0 = performance.now();
      let out = "";
      try {
        out = lex2md(lex);
      } catch (e) {
        rec.exportThrew = (e as Error).name;
      }
      rec.lex2mdMs = ms(t0);
      rec.exportLen = out.length;
      rec.maxWsRunOut = maxWsRun(out);
      t0 = performance.now();
      try {
        md2lex(out);
      } catch (e) {
        rec.reimportThrew = (e as Error).name;
      }
      rec.roundTripMs = (rec.lex2mdMs as number) + ms(t0);
      rec.E14_stop = raw.length <= 200000 && ((rec.lexJsonLen as number) > 2_000_000 || st.nodes > 50_000);
      const store = verdict.startsWith("201") || verdict.startsWith("pass") || arg("store-all") === name;
      if (store) {
        t0 = performance.now();
        const c = await tryW(() => mk({ body: lex }));
        rec.createMs = ms(t0);
        if (c.ok) rec.get = await hubGet(c.v.id as number);
        else rec.createError = c;
      }
      obs(`P-15 ${name}`, rec);
    }
  }

  // ── P-16 URL validation / sanitisation vs the importer ──────────────────
  if (want("P-16")) {
    const urls = [
      "\u0001javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x",
      "java&#115;cript&#58;alert(1)", "&#106;avascript:alert(1)", "//evil.com", "\\/\\/evil.com", "?q=1", "tel:+84123",
      "mailto:a@b.c", "/rel", "#h", "foo/bar", "https://ok.com/a", "http://ok.com", " javascript:x",
    ];
    for (const u of urls) {
      const lex = md2lex(`[x](${u})`);
      const st = treeStats(lex);
      const v = (lexical as unknown as { validateUrl: (s: string) => boolean }).validateUrl(u);
      const s = (lexical as unknown as { sanitizeUrl: (s: string) => string }).sanitizeUrl(u);
      const nonDraft = await tryW(() => mk({ body: lex }));
      const draft = await tryW(() => mk({ body: lex }, { draft: true }));
      obs(`P-16 ${JSON.stringify(u)}`, { validateUrl: v, sanitizeUrl: s, importedLinks: st.links, types: st.types, createNoDraft: nonDraft.ok ? "ok" : nonDraft.msg, createDraft: draft.ok ? "ok" : draft.msg });
    }
  }

  // ── P-18 findByID with select on `version` / `origin` ───────────────────
  if (want("P-18")) {
    const a = await mk({});
    const id = a.id as number;
    for (const sel of [{ version: true }, { origin: true }, { version: true, origin: true, lastEngine: true, workflowStatus: true }]) {
      for (const draft of [false, true]) {
        const r = await tryW(() => payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, ...(draft ? { draft: true } : {}), select: sel as never }));
        obs(`P-18 select ${JSON.stringify(sel)} draft=${draft}`, r.ok ? r.v : r);
      }
    }
  }

  // ── P-19 (+ P-17) slug pre-check over main table vs latest draft ────────
  if (want("P-19") || want("P-17")) {
    const X = uniq("slugx");
    const Y = uniq("slugy");
    const a = await mk({ slug: X });
    const id = a.id as number;
    await payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true }, data: { slug: Y } as never });
    const q = async (slug: string, draft: boolean) => {
      const r = await payload.find({ collection: "articles", ...(draft ? { draft: true } : {}), where: { and: [{ tenant: { equals: T } }, { slug: { equals: slug } }] }, limit: 2, depth: 0, locale: "en", overrideAccess: true });
      return r.docs.map((d) => ({ id: (d as unknown as Doc).id, slug: (d as unknown as Doc).slug }));
    };
    const { scopedFind } = await import("../src/lib/scoped");
    const sf = async (slug: string) =>
      (await (scopedFind as unknown as (a: Record<string, unknown>) => Promise<{ docs: Doc[] }>)({ payload, collection: "articles", tenantId: T, where: { slug: { equals: slug } }, limit: 2, depth: 0, locale: "en" })).docs.map((d) => ({ id: d.id, slug: d.slug }));
    if (want("P-19"))
      obs("P-19", {
        articleId: id,
        both: await both(id),
        i_findDraft_Y: await q(Y, true),
        ii_findDraft_X: await q(X, true),
        findMain_X: await q(X, false),
        findMain_Y: await q(Y, false),
        iii_scopedFind_X: await sf(X).catch((e) => String(e).slice(0, 100)),
        iii_scopedFind_Y: await sf(Y).catch((e) => String(e).slice(0, 100)),
      });
    if (want("P-17")) {
      const engTok = process.env.SEED_ENGINE_TOKEN;
      const intake = async (slug: string) => {
        const res = await fetch(`${BASE}/api/engine/intake`, {
          method: "POST",
          headers: { Authorization: `Bearer ${engTok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ publicationId: "dtw", title: `P17 ${slug}`, pillarSlug: pillarDoc.slug, body_markdown: "Thân P17.", byline: "P17 Probe Byline", slug, engineDraftId: uniq("eng") }),
        });
        const j = (await res.json().catch(() => ({}))) as { status?: string; reason?: string; id?: unknown };
        return { http: res.status, status: j.status, reason: typeof j.reason === "string" ? j.reason.slice(0, 120) : j.reason };
      };
      obs("P-17 intake with slug X (main table of hub draft still X)", engTok ? await intake(X) : "SEED_ENGINE_TOKEN unset");
      obs("P-17 intake with slug Y (only on latest draft)", engTok ? await intake(Y) : "SEED_ENGINE_TOKEN unset");
      obs("P-17 rows per slug after intake", { X: await q(X, false), Y: await q(Y, false) });
    }
  }

  // ── slugify vector table (hub copies these into hub-composer-draft.test.ts) ─
  if (want("slugify")) {
    const inputs = [
      "Hello World", "  Trim  me  ", "Spain's Best Beaches", "Rock ’n’ Roll", "O‘Brien`s ʼTest", "Málaga & Córdoba",
      "Đà Nẵng đẹp", "ĐỒNG ĐỀU", "Việt Nam 2026: Tăng trưởng 6,5%", "a--b__c", "---", "!!!", "", "Ñandú über straße",
      "x".repeat(100), `${"word ".repeat(30)}end`, "C++ / C# — guide", "émoji 😀 test", "UPPER lower 123",
    ];
    obs("slugify vectors", inputs.map((i) => [i, slugify(i)]));
  }

  if (pubAdded) {
    const tDoc = (await payload.findByID({ collection: "tenants", id: T, depth: 0, overrideAccess: true })) as unknown as Doc;
    const kept = ((tDoc.readTokens as Doc[] | undefined) ?? []).filter((r) => r.label !== "explore6");
    await payload.update({ collection: "tenants", id: T, overrideAccess: true, context: { disableRevalidate: true }, data: { readTokens: kept } as never });
  }
  console.log("\n[explore6] done (observations only — no assertions)");
  process.exit(0);
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
                : flag("setup4")
                  ? setup4
                  : flag("check4")
                    ? check4
                    : flag("check5")
                      ? check5
                      : flag("explore6")
                        ? explore6
                        : null;
if (!run) {
  console.error(
    "usage: tsx scripts/hub-probe.ts --setup | --check --token <t> [--nohub-token <t>] | --paging [--token <t>] | --setup2 | --nullorder | --check2 --token <t> [--nohub-token <t>] | --setup3 --out <file> | --check3 --in <file> [--hooks-only] | --setup4 --out <file> | --check4 --in <file> [--unit-only] | --check5 --in <file> --in3 <file> [--unit-only] | --explore6 --in4 <file> [--only P-1,P-15,P-20..P-24] [--vec <name>] [--list] [--lim lines,starUnd,links]",
  );
  process.exit(2);
}
run().catch((err) => {
  console.error("[probe] failed", err);
  process.exit(1);
});
