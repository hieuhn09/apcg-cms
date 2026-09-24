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
            : null;
if (!run) {
  console.error(
    "usage: tsx scripts/hub-probe.ts --setup | --check --token <t> [--nohub-token <t>] | --paging [--token <t>] | --setup2 | --nullorder | --check2 --token <t> [--nohub-token <t>]",
  );
  process.exit(2);
}
run().catch((err) => {
  console.error("[probe] failed", err);
  process.exit(1);
});
