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
// P5.1 (--setup6 / --check6 / --guard-child).
import { spawnSync } from "node:child_process";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
// P5.1b (--pb / --n10): the stronger local-DB guard (read / import only, never edited here).
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

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
  // Stage 0.5b (OQ41): defaults = the seven frozen 1b thresholds + tree caps (Public Contracts), so the §9.2 D2 vectors are right BY NAME.
  const d = { lines: 1000, starUnd: 5000, runs: 2500, links: 500, unitRuns: 30, unitLinks: 20, markChars: 5000, nodes: 9000, json: 1_200_000, indent: 16 };
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
  units: number;
  maxUnitLines: number;
  maxUnitRuns: number;
  maxUnitLinks: number;
  backticks: number;
  tildes: number;
  markChars: number;
  maxIndent: number;
}

/** The W class (JS `\s` minus LF, which splits lines): what leading indentation is counted in. */
function isW6(c: number): boolean {
  return c === 9 || c === 11 || c === 12 || c === 13 || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** `s[i]` is a space or tab and `i` is inside the line (`i < end`). */
function spAt6(s: string, i: number, end: number): boolean {
  if (i >= end) return false;
  const c = s.charCodeAt(i);
  return c === 32 || c === 9;
}

/**
 * Executable reference (oracle) of `precheckBodyLinear` (CMS) and `mdPrecheckLinear` (hub) — Stage 0.5b, "1b unit definition"
 * (Public Contracts; OQ15 / OQ33 / OQ36). Both must return the SAME counts as this function on the shared vector table.
 * O(n): every character is looked at a bounded number of times.
 *  (i)   lines: each LF, CR, U+2028, U+2029 is one break (CRLF = 2); lines = breaks + 1.
 *  (ii)  units are split ONLY on LF.
 *  (iii) a blank line is `^[\t ]*$` (space / tab only); a line of only CR / NBSP / other W is NOT blank and merges.
 *  (iv)  a non-blank line opens a NEW unit only if it matches `^>[ \t]`, `^#{1,6}[ \t]`, `^[ \t]*[-*+][ \t]` or `^[ \t]*[0-9]{1,9}\.[ \t]`;
 *        any other non-blank line continues the current unit; a blank line ends it.
 *  (v)   `1)`, `[ ]`, table rows, HTML, fences are NOT fences (merge = stricter).
 *  (vi)  mark runs (maximal runs of ONE of `*` `_` `` ` `` `~`) and `](` add up over every line of a unit; any other
 *        character (CR, NBSP, LF included) cuts a run.
 *  indent = leading W characters of each LF line that has a non-W character (whitespace-only lines are NOT counted, D23); markChars = `*`+`_` + backticks + tildes.
 */
function pre6(s: string): Pre6 {
  const n = s.length;
  let lf = 0, cr = 0, ls = 0, ps = 0, starUnd = 0, links = 0, runs = 0, maxRun = 0, backticks = 0, tildes = 0, maxIndent = 0, units = 0;
  let ul = 0, ur = 0, uk = 0, mul = 0, mur = 0, muk = 0, inUnit = false;
  const flush = () => {
    if (inUnit) {
      units++;
      if (ul > mul) mul = ul;
      if (ur > mur) mur = ur;
      if (uk > muk) muk = uk;
    }
    ul = ur = uk = 0;
    inUnit = false;
  };
  let start = 0;
  while (start <= n) {
    let end = s.indexOf("\n", start);
    if (end === -1) end = n;
    else lf++;
    // leading [ \t] (blank test + list / ordered fences) and leading W (indent)
    let p = start;
    while (p < end && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
    let w = start;
    while (w < end && isW6(s.charCodeAt(w))) w++;
    if (w < end && w - start > maxIndent) maxIndent = w - start;
    if (p === end) {
      flush(); // blank line ends the unit
    } else {
      const c0 = s.charCodeAt(start);
      let fence = false;
      if (c0 === 62 && spAt6(s, start + 1, end)) fence = true; // ^>[ \t]
      else if (c0 === 35) {
        let h = start;
        while (h < end && h - start <= 6 && s.charCodeAt(h) === 35) h++;
        if (h - start <= 6 && spAt6(s, h, end)) fence = true; // ^#{1,6}[ \t]
      }
      if (!fence) {
        const c = s.charCodeAt(p);
        if ((c === 45 || c === 42 || c === 43) && spAt6(s, p + 1, end)) fence = true; // ^[ \t]*[-*+][ \t]
        else {
          let d = p;
          while (d < end && d - p <= 9 && s.charCodeAt(d) >= 48 && s.charCodeAt(d) <= 57) d++;
          if (d > p && d - p <= 9 && d < end && s.charCodeAt(d) === 46 && spAt6(s, d + 1, end)) fence = true; // ^[ \t]*[0-9]{1,9}\.[ \t]
        }
      }
      if (fence) flush();
      inUnit = true;
      ul++;
      let curCh = 0, curRun = 0;
      for (let i = start; i < end; i++) {
        const c = s.charCodeAt(i);
        if (c === 13) cr++;
        else if (c === 0x2028) ls++;
        else if (c === 0x2029) ps++;
        if (c === 42 || c === 95 || c === 96 || c === 126) {
          if (c === 42 || c === 95) starUnd++;
          else if (c === 96) backticks++;
          else tildes++;
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
          if (c === 93 && i + 1 < end && s.charCodeAt(i + 1) === 40) {
            links++;
            uk++;
          }
        }
      }
    }
    if (end === n) break;
    start = end + 1;
  }
  flush();
  return {
    len: n, lines: lf + cr + ls + ps + 1, lf, cr, ls, ps, starUnd, runs, maxRun, links, units, maxUnitLines: mul, maxUnitRuns: mur, maxUnitLinks: muk,
    backticks, tildes, markChars: starUnd + backticks + tildes, maxIndent,
  };
}

/** `s` repeated `n` times (file level since Stage 0.5b, OQ41: `--check6` builds the §9.2 D2 vectors from these). */
function rep(s: string, n: number): string {
  return s.repeat(n);
}

/** `k` units, each = `unit` repeated `n` times joined by ONE space then trimmed; units joined by a blank line (§9.2 D2(c)). */
function unitsJoin(unit: string, n: number, k: number): string {
  return Array.from({ length: k }, () => rep(unit + " ", n).trim()).join("\n\n");
}

/** (`\t`×tabs + `- x\n- y\n`) repeated up to `lines` lines, cut at `cap` chars (§9.2 D2(g)). */
function zig(tabs: number, lines: number, cap = 200000): string {
  let s = "";
  let l = 0;
  while (l < lines && s.length < cap) {
    s += rep("\t", tabs) + "- x\n- y\n";
    l += 2;
  }
  return s.slice(0, cap);
}

/** Synthetic dense body `normal_200k` (§9.2 D2(d); ⇒ 422 `too_large`): the paragraph × 4 + blank line, until ≥ 199,000 chars. */
function normal200k(): string {
  const para = "Đây là một đoạn văn **bình thường** với [liên kết](https://example.com/a) và *nghiêng*, dài vừa phải cho một bài báo. ";
  let s = "";
  while (s.length < 199000) s += rep(para, 4) + "\n\n";
  return s;
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
  const nLinkUnits = Math.floor(REV6.links / REV6.unitLinks);
  const nRunUnits = Math.floor(REV6.runs / REV6.unitRuns);
  add("P-24", "p24_cap_f13_units", () => unitsJoin("[a](/b)[a][a](/b)*\\**a", Math.floor(REV6.unitLinks / 2), nLinkUnits));
  add("P-24", "p24_cap_f13b_units", () => unitsJoin("[a](/b)*\\**", Math.floor(REV6.unitRuns / 2), nLinkUnits));
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
  add("P-24", "p24_cap_combo_table_f13b", () => rep("|a|b|\n", REV6.lines - 100) + "\n" + unitsJoin("[a](/b)*\\**", Math.floor(REV6.unitRuns / 2), nLinkUnits));
  add("P-24", "p24_cap_combo_zigzag15_f13b", () => zig(REV6.indent, REV6.lines - 80) + "\n\n" + unitsJoin("[a](/b)*\\**", Math.floor(REV6.unitRuns / 2), nLinkUnits));
  // OQ55 upper edge: same formula, unit repeated 16 times = 32 mark runs per unit > unitRuns 30 ⇒ MUST be blocked by 1b.
  add("P-24", "p24_cap_combo_zigzag15_f13b_x16", () => zig(REV6.indent, REV6.lines - 80) + "\n\n" + unitsJoin("[a](/b)*\\**", Math.floor(REV6.unitRuns / 2) + 1, nLinkUnits));
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
    vec.normal_200k = normal200k;
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


// ─────────────────────────────────────────────────────────────────────────────
// P5.1 / Stage 2 (CMS-B1) — `--setup6` / `--check6` / `--guard-child`
// (APCGHub P5.1, hub draft authoring: POST /api/hub/articles, PATCH
// /api/hub/articles/{id}, GET …?view=edit, taxonomy composer kinds).
//
//   npx tsx scripts/hub-probe.ts --setup6 --out <file>         # fixtures + one token FILE per engine (0o600)
//   npx tsx scripts/hub-probe.ts --check6 --in <file>          # every group (dev server on HUB_PROBE_BASE)
//   npx tsx scripts/hub-probe.ts --check6 --unit-only          # group U only: no DB, no dev server
//   npx tsx scripts/hub-probe.ts --check6 --hooks-only         # group H Local-API hook OBS only (DB, no server)
//
// LOCAL DATABASE ONLY: `--setup6` / `--check6` (except `--unit-only`) refuse to run
// unless DATABASE_URL and HUB_PROBE_BASE both point at localhost / 127.0.0.1 / ::1.
// Error bodies are compared VERBATIM (`status` + `reason` + extras, deep equality).
// ─────────────────────────────────────────────────────────────────────────────

/** The §9.2 D2 vector table (frozen; counts after `trim`, same formulas as the 0.5b oracle table). */
const D2_F13 = "[a](/b)[a][a](/b)*\\**a";
const D2_QUOTE_U = "\\**a <u>*[a](/b) ***`a ***";
const D2_URLS = [
  "[t](ssh://x)",
  "[t](about:blank)",
  "[t](C:\\x\\y)",
  "[t](chrome://settings)",
  "[t](blob:https://x/u)",
  "[t](ws://x)",
  "[t](intent://x#Intent;end)",
  "[t](whatsapp://send)",
];
type D2Expect = "pass" | "block" | "obs";
interface D2Vec {
  name: string;
  md: () => string;
  /** 1b verdict. */
  v: D2Expect;
  /** Expected HTTP outcome in group D2: 201, or a 422 code. */
  http?: 201 | "too_large" | "too_slow" | "url" | "unstable";
}
function d2Vectors(): D2Vec[] {
  const b3 = rep("*[a](/b) ", 15);
  const v: D2Vec[] = [
    // (c) the seven thresholds, below / at and just above
    { name: "c_lines_1000", md: () => "a" + rep("\na", 999), v: "pass", http: 201 },
    { name: "c_lines_1001", md: () => "a" + rep("\na", 1000), v: "block", http: "too_large" },
    { name: "c_mark_5000", md: () => rep("*", 5000), v: "pass" },
    { name: "c_mark_5001", md: () => rep("*", 5001), v: "block", http: "too_large" },
    { name: "c_runs_2500", md: () => unitsJoin("*a", 30, 83) + "\n\n" + unitsJoin("*a", 10, 1), v: "pass", http: 201 },
    { name: "c_runs_2501", md: () => unitsJoin("*a", 30, 83) + "\n\n" + unitsJoin("*a", 11, 1), v: "block", http: "too_large" },
    { name: "c_links_500", md: () => unitsJoin(D2_F13, 10, 25), v: "pass", http: 201 },
    { name: "c_links_501", md: () => unitsJoin(D2_F13, 10, 25) + "\n\n[a](/b)", v: "block", http: "too_large" },
    { name: "c_unitRuns_30", md: () => unitsJoin("*a", 30, 1), v: "pass", http: 201 },
    { name: "c_unitRuns_31", md: () => unitsJoin("*a", 31, 1), v: "block", http: "too_large" },
    { name: "c_unitLinks_20", md: () => unitsJoin("[a](/b)", 20, 1), v: "pass", http: 201 },
    { name: "c_unitLinks_21", md: () => unitsJoin("[a](/b)", 21, 1), v: "block", http: "too_large" },
    { name: "c_indent_16", md: () => "- a\n" + rep("\t", 16) + "- x", v: "pass", http: 201 },
    { name: "c_indent_17", md: () => "- a\n" + rep("\t", 17) + "- x", v: "block", http: "too_large" },
    // D23: indent counts only on lines with a non-W character (a whitespace-only line is not counted)
    { name: "c_wsline_20", md: () => "a\n\n" + rep(" \t", 10) + "\n\nb", v: "pass", http: 201 },
    { name: "c_indent_sp16", md: () => "a\n" + rep(" ", 16) + "x", v: "pass" },
    { name: "c_indent_sp17", md: () => "a\n" + rep(" ", 17) + "x", v: "block", http: "too_large" },
    // (d) real-looking bodies vs the synthetic dense body
    { name: "d_real_40k", md: () => realBody6(40000, { line: 150, bold: 300, link: 1000, ital: 600, seed: 40 }), v: "pass", http: 201 },
    { name: "d_real_200k_para", md: () => realBody6(200000, { line: 600, bold: 300, link: 1000, ital: 600, seed: 203 }), v: "pass", http: 201 },
    { name: "d_normal_200k", md: normal200k, v: "block", http: "too_large" },
    // (b) blocked fast by 1b
    { name: "b_star_a_3000", md: () => rep("*a ", 3000), v: "block", http: "too_large" },
    { name: "b_starlink_200", md: () => rep("*[a](/b) ", 200), v: "block", http: "too_large" },
    { name: "b_bt_200k", md: () => rep("`", 200000), v: "block", http: "too_large" },
    { name: "b_tilde_33333", md: () => rep("~~a~~ ", 33333), v: "block", http: "too_large" },
    { name: "b_fence_5000", md: () => rep("```\n", 5000), v: "block", http: "too_large" },
    { name: "b_table_5000", md: () => rep("|a|b|\n", 5000), v: "block", http: "too_large" },
    { name: "b_star_100k", md: () => rep("*", 100000), v: "block", http: "too_large" },
    { name: "b_bold_30k", md: () => rep("**a**", 30000), v: "block", http: "too_large" },
    { name: "b_lines_100k", md: () => rep("a\n", 100000), v: "block", http: "too_large" },
    { name: "b_zig63", md: () => zig(63, 1e9), v: "block", http: "too_large" },
    // W-run family (§9.2 D(b))
    { name: "ws_450x253_nn", md: () => rep("](" + rep(" ", 253) + "\n\n", 450), v: "pass", http: 201 },
    { name: "ws_775x253_nn", md: () => rep("](" + rep(" ", 253) + "\n\n", 775), v: "block", http: "too_large" },
    // (g) the two worst KNOWN bodies that pass 1b, and the upper edge
    { name: "g_zigzag15_units", md: () => zig(16, 920) + "\n\n" + unitsJoin(D2_F13, 10, 25), v: "pass", http: 201 },
    { name: "g_zigzag15_f13b", md: () => zig(16, 920) + "\n\n" + unitsJoin("[a](/b)*\\**", 15, 25), v: "pass", http: 201 },
    { name: "g_zigzag15_f13b_x16", md: () => zig(16, 920) + "\n\n" + unitsJoin("[a](/b)*\\**", 16, 25), v: "block", http: "too_large" },
    { name: "g_table_f13", md: () => rep("|a|b|\n", 900) + "\n" + unitsJoin(D2_F13, 10, 25), v: "pass", http: 201 },
    // (h) B-3 family and CRLF line counting
    { name: "h1_1paren", md: () => Array.from({ length: 14 }, () => "1) " + b3).join("\n"), v: "block", http: "too_large" },
    { name: "h2_nbsp", md: () => Array.from({ length: 14 }, () => b3).join("\n\u00a0\n"), v: "block", http: "too_large" },
    { name: "h3_crcr", md: () => Array.from({ length: 14 }, () => b3).join("\r\r"), v: "block", http: "too_large" },
    { name: "h4_crlfcrlf", md: () => Array.from({ length: 14 }, () => b3).join("\r\n\r\n"), v: "block", http: "too_large" },
    { name: "h_crlf_500", md: () => rep("a\r\n", 500), v: "pass", http: 201 },
    { name: "h_crlf_501", md: () => rep("a\r\n", 501), v: "block", http: "too_large" },
    // (i) / (j) guard-fire vectors (pass 1b; the vm guard is the defence)
    { name: "i_quote_x80", md: () => "> " + Array(80).fill(D2_QUOTE_U).join("\n> "), v: "pass", http: "too_slow" },
    { name: "i_quote_x70(obs)", md: () => "> " + Array(70).fill(D2_QUOTE_U).join("\n> "), v: "pass" },
    { name: "i_quote_x60(obs)", md: () => "> " + Array(60).fill(D2_QUOTE_U).join("\n> "), v: "pass" },
    { name: "j_table_x30", md: () => "a\n" + rep("| ", 30) + "x", v: "pass", http: "too_slow" },
  ];
  // (k) eight exotic-scheme URLs (E31)
  D2_URLS.forEach((u, i) => v.push({ name: `k_url${i}`, md: () => u, v: "pass", http: "url" }));
  return v;
}

/** One OBS JSON line per call; never a token, never body text beyond a short label. */
const obs6 = (label: string, v: unknown) => console.log(`OBS   ${label}  ${JSON.stringify(v)}`);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Every file under `dir` (recursive), repo-relative POSIX paths. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out.sort();
}

/** A fake Payload for the handler / lookup unit checks (no DB). Records every call. */
function fakePayload6(o: {
  tenant?: Doc;
  articles?: Record<string, { latest: Doc; main: Doc }>;
  engines?: Record<string, Doc>;
  finds?: (args: Doc) => Doc[];
}) {
  const calls: { op: string; args: Doc }[] = [];
  const logs: string[] = [];
  const tenant = o.tenant ?? { id: 1, slug: "dtw", status: "active", defaultLanguage: "en", features: { articles: true } };
  const fake = {
    calls,
    logs,
    config: {},
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    async findByID(args: Doc) {
      calls.push({ op: "findByID", args });
      if (args.collection === "tenants") return tenant;
      if (args.collection === "content-engines") return o.engines?.[String(args.id)] ?? null;
      if (args.collection === "articles") {
        const a = o.articles?.[String(args.id)];
        if (!a) return null;
        return args.draft ? a.latest : a.main;
      }
      return null;
    },
    async find(args: Doc) {
      calls.push({ op: "find", args });
      const docs = o.finds ? o.finds(args) : [];
      return { docs, totalDocs: docs.length };
    },
    async create(args: Doc) {
      calls.push({ op: "create", args });
      return { id: 999, version: 1, slug: (args.data as Doc | undefined)?.slug };
    },
    async update(args: Doc) {
      calls.push({ op: "update", args });
      return { id: args.id, version: 2 };
    },
    async count() {
      return { totalDocs: 0 };
    },
  };
  return fake;
}

// V-LINK — the shared link-vector table (plan §9.2 + contract round 9). The hub copy
// (`mdDangerousLink` + `hub-composer-draft.test.ts`) uses the SAME ids and strings.
const VLINK_REJECT: Record<string, string> = {
  VL1: "[x](java&#115;cript&#58;alert(1))",
  VL2: "[x](java&#115;cript&#58;alert)",
  VL3: "[x](&#106;avascript:alert(1))",
  VL4: "[x](&#x6A;avascript:alert(1))",
  VL6: "[x]: java&#115;cript&#58;alert(1)",
  VL7: "[x](   java&#115;cript:alert(1))",
  VL7b: "[x](\u00a0java&#115;cript:alert(1))",
  VL8: "[x](https://a.com/?a=1&amp;b=2)",
  VL9: "[x](https://a.com/?a&copy;b)",
  VL11: "[x](<&#106;avascript:alert(1)>)",
  VL12: "[x](< &#106;avascript:alert(1)>)",
  VL13: "[x](<\t&#106;avascript:alert(1)>)",
  VR1: "[x](https://a.com)&mdash;great",
  VR2: "[x](https://a.com)&nbsp;now",
  VR3: "(see [a](https://a.com/x)&nbsp;now)",
  VR4: "|[a](https://a.com)&nbsp;|",
};
const VLINK_OK: Record<string, string> = {
  VC1: "[x](https://a.com/?a=1&b=2)",
  VC2: "Tom & Jerry",
  VC3: "Tom &amp; Jerry",
  VC4: "a < b && c > d",
  VC5: "[x](https://a.com/a_b?c=d&e=f#g)",
  VC6: "[x](https://a.com) &amp; text",
  VC7: "<java&#115;cript:alert(1)>",
  VC8: "<https://a.com/?a=1&amp;b=2>",
  VC9: "<b>R&amp;D</b>",
  VC10: "<br>&nbsp;",
  VC11: "a<b&amp;c",
  VC12: "I <3&hearts; you",
};
const VLINK_BUDGET: Record<string, () => string> = {
  "(1) < ×200,000": () => "<".repeat(200000),
  "(2) ]( + & ×200,000": () => "](" + "&".repeat(200000),
  "(3) ]( + &a ×100,000": () => "](" + "&a".repeat(100000),
  "(4) ](& + a ×199,990 + x)": () => "](&" + "a".repeat(199990) + "x)",
  "(5) ]( ×100,000": () => "](".repeat(100000),
  "(6) ](&a ×50,000": () => "](&a".repeat(50000),
};
// Lexical-escaped backslash vectors (E37; observed codes, "≠ 201").
const VLINK_BACKSLASH: Record<string, string> = {
  BS1: "[x](javascript\\:alert(1))",
  BS2: "[x](java\\script:alert(1))",
  BS3: "[x](javascript\\&#58;alert(1))",
  BS4: "<javascript\\:alert(1)>",
  BS5: "[x]: javascript\\:alert(1)",
  BS1b: "[x](javascript\\:alert)",
};

async function check6Unit(expect: (label: string, actual: unknown, wanted: unknown) => void): Promise<void> {
  const limits = await import("../src/lib/hub-author-limits");
  const core = await import("../src/lib/hub-author-convert-core");
  const body = await import("../src/lib/hub-author-body");
  const input = await import("../src/lib/hub-author-input");
  const refs = await import("../src/lib/hub-author-refs");
  const authM = await import("../src/lib/hub-author-auth");
  const handlers = await import("../src/lib/hub-author-handlers");
  const query = await import("../src/lib/hub-query");
  const blocks = await import("../src/lib/hub-taxonomy-blocks");
  const editSel = await import("../src/lib/hub-article-edit-select");
  const { isHubArticleId, PG_INT4_MAX } = await import("../src/lib/hub-article-id");
  const { countDangerousLinkTargets, loadHubEditorConfig } = await import("../src/lib/hub-article-markdown");
  const editorConfig = (await loadHubEditorConfig(await config)) as never;
  const realConv = core.lexicalConverters(editorConfig);

  // ── (x) resolveConvertTimeoutMs — 13 inputs (E29 / OQ45) ──
  const toTable: [string | undefined, number][] = [
    [undefined, 1500], ["", 1500], ["1e3", 1500], ["0x10", 1500], [" 5 ", 1500], ["-1", 1500], ["NaN", 1500],
    ["Infinity", 1500], ["0", 1500], ["99999", 1500], ["1501", 1500], ["1", 1], ["1500", 1500],
  ];
  expect("U-x resolveConvertTimeoutMs 13-input table", toTable.map(([i]) => limits.resolveConvertTimeoutMs(i)), toTable.map(([, o]) => o));
  {
    const prev = process.env.HUB_BODY_CONVERT_TIMEOUT_MS;
    process.env.HUB_BODY_CONVERT_TIMEOUT_MS = "7";
    const seven = limits.currentConvertTimeoutMs();
    delete process.env.HUB_BODY_CONVERT_TIMEOUT_MS;
    const dflt = limits.currentConvertTimeoutMs();
    if (prev !== undefined) process.env.HUB_BODY_CONVERT_TIMEOUT_MS = prev;
    expect("U-x currentConvertTimeoutMs reads the env AT CALL TIME (7, then default 1500)", [seven, dflt], [7, 1500]);
  }
  expect("U closed field-code list = 23 (15 common + 8 body)", [limits.HUB_FIELD_CODES.length, limits.HUB_FIELD_CODES_COMMON.length, limits.HUB_FIELD_CODES_BODY.length, new Set(limits.HUB_FIELD_CODES).size], [23, 15, 8, 23]);
  expect("U frozen 1b / tree / size constants", [limits.BODY_MAX_LINES, limits.BODY_MAX_MARK_CHARS, limits.BODY_MAX_MARK_RUNS, limits.BODY_MAX_LINK_OPENERS, limits.BODY_PARA_MAX_MARK_RUNS, limits.BODY_PARA_MAX_LINK_OPENERS, limits.BODY_MAX_INDENT, limits.BODY_MAX_NODES, limits.BODY_MAX_JSON_CHARS, limits.MAX_REQUEST_BYTES, limits.HUB_AUTHOR_LIMITS.body], [1000, 5000, 2500, 500, 30, 20, 16, 9000, 1200000, 1000000, 200000]);

  // ── isWs parity ∀c ∈ [0, 0xFFFF] (AC7) ──
  {
    const bad: number[] = [];
    let members = 0;
    for (let c = 0; c <= 0xffff; c++) {
      const want = /\s/.test(String.fromCharCode(c)) || c <= 0x1f;
      if (core.isWs(c) !== want) bad.push(c);
      if (want) members++;
    }
    expect("U isWs(c) === (/\\s/ || c<=0x1f) for every code unit 0..0xFFFF (52 members)", [bad.slice(0, 10), members], [[], 52]);
    expect("U not W: U+0085, U+180E, U+200B–200D, U+2060", [0x85, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060].map(core.isWs), [false, false, false, false, false, false]);
  }

  // ── hasLongWhitespaceRun: 256 ok / 257 hit, called DIRECTLY (no trim) ──
  {
    const cs = [0xa0, 0x3000, 0xfeff, 0x2028, 0x2029, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f];
    const res = cs.map((c) => {
      const ch = String.fromCharCode(c);
      return [core.hasLongWhitespaceRun("](" + rep(ch, 256) + "x)"), core.hasLongWhitespaceRun("](" + rep(ch, 257) + "x)")];
    });
    expect("U hasLongWhitespaceRun 256 → false / 257 → true for 10 W characters", res, cs.map(() => [false, true]));
    const alt = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? "\u00a0" : " ")).join("");
    expect("U hasLongWhitespaceRun alternating ' ' + U+00A0: 256 / 257", [core.hasLongWhitespaceRun("x" + alt(256) + "x"), core.hasLongWhitespaceRun("x" + alt(257) + "x")], [false, true]);
  }

  // ── hasImageSyntax ──
  expect("U hasImageSyntax", ["![a](b)", "![a][r]", "a ! [b]", "plain"].map(body.hasImageSyntax), [true, true, false, false]);

  // ── hasDangerousLinkSyntax (+ write ⊇ read; + M14 time budget) ──
  {
    const hits = [
      "[x](javascript:alert(1))", "]( javascript:x)", "]( <javascript:x>", "<javascript:alert(1)>", "[x]: javascript:alert(1)",
      "[x](java\tscript:a)", "[x](JaVaScRiPt:a)", "[x](vbscript:a)", "[x](data:text/html,a)", "[x](\u00a0javascript :a)",
      "[x](data:image/png;base64,AAAA)", "[x]: <vbscript:a>",
    ];
    const safe = ["[x](https://a.b)", "[a](/b)", "<https://a.b>", "[x]: https://a", "javascript is fun", "a: b", "[x](mailto:a@b.c)"];
    expect("U hasDangerousLinkSyntax known hits", hits.map(core.hasDangerousLinkSyntax), hits.map(() => true));
    expect("U hasDangerousLinkSyntax known safe strings", safe.map(core.hasDangerousLinkSyntax), safe.map(() => false));
    // write ⊇ read: every string the read regex flags is flagged by the scanner.
    const atoms = ["](", "<", "]", "(", " ", "\t", "\n", "\u00a0", "\u3000", "javascript", "JAVASCRIPT", "vbscript", "data", "data:image/png;base64,", ":", "x", "java", "script", "]:", "\u2028", "\ufeff"];
    const rnd = seeded6(6);
    let flaggedByRead = 0;
    const missed: string[] = [];
    for (let i = 0; i < 30000; i++) {
      let s = "";
      const n = 1 + Math.floor(rnd() * 8);
      for (let k = 0; k < n; k++) s += atoms[Math.floor(rnd() * atoms.length)];
      if (countDangerousLinkTargets(s) > 0) {
        flaggedByRead++;
        if (!core.hasDangerousLinkSyntax(s)) missed.push(JSON.stringify(s));
      }
    }
    const fixed = ["](javascript:", "](  <  javascript  :", "](\u00a0data:text/html", "](VBSCRIPT:", "](\tjavascript\t:"];
    for (const s of fixed) if (countDangerousLinkTargets(s) > 0 && !core.hasDangerousLinkSyntax(s)) missed.push(JSON.stringify(s));
    obs6("U write⊇read corpus", { strings: 30000, flaggedByRead });
    expect("U write ⊇ read: every string countDangerousLinkTargets flags is caught by hasDangerousLinkSyntax", missed.slice(0, 5), []);
    // M14: direct call, 190,000 spaces after `](` (bypasses rule (1)) — linear, ≤ 500 ms.
    const big = "](" + rep(" ", 190000) + "javascript:x";
    const ms: number[] = [];
    let hit = false;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      hit = core.hasDangerousLinkSyntax(big);
      ms.push(performance.now() - t0);
    }
    obs6("U M14 scanner ms on ]( + 190,000 spaces (median of 5)", Math.round(median(ms) * 100) / 100);
    expect("U M14 scanner flags ]( + 190,000 spaces + javascript: within 500 ms", [hit, median(ms) <= 500], [true, true]);
  }

  // ── V-LINK (shared table, PLAN-SUPPLEMENT 7 / 7b + contract round 9 E33-E35/E38): entity rule ──
  {
    const rejIds = Object.keys(VLINK_REJECT);
    const okIds = Object.keys(VLINK_OK);
    expect("U V-LINK reject (VL1-VL4, VL6-VL13, VR1-VR4) ⇒ hasDangerousLinkSyntax true",
      rejIds.map((k) => [k, core.hasDangerousLinkSyntax(VLINK_REJECT[k]!)]), rejIds.map((k) => [k, true]));
    expect("U V-LINK reject ⇒ checkExportedMarkdown link",
      rejIds.map((k) => [k, core.checkExportedMarkdown(VLINK_REJECT[k]!)]), rejIds.map((k) => [k, { ok: false, code: "link" }]));
    expect("U V-LINK controls (VC1-VC12) ⇒ hasDangerousLinkSyntax false",
      okIds.map((k) => [k, core.hasDangerousLinkSyntax(VLINK_OK[k]!)]), okIds.map((k) => [k, false]));
    const budget: Doc = {};
    const over: string[] = [];
    for (const [k, mk] of Object.entries(VLINK_BUDGET)) {
      const s = mk();
      const ms: number[] = [];
      let hit = true;
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        hit = core.hasDangerousLinkSyntax(s);
        ms.push(performance.now() - t0);
      }
      const med = Math.round(median(ms) * 100) / 100;
      budget[k] = { len: s.length, ms: med, hit };
      if (hit || med > 50) over.push(`${k}: hit=${hit} ms=${med}`);
    }
    obs6("U V-LINK budget cases (median of 5, ms)", budget);
    expect("U V-LINK six budget cases ⇒ false, each ≤ 50 ms (E33: (5) ]( ×100,000 and (6) ](&a ×50,000 kill a per-opener rescan)", over, []);
    // E38: seeded parity with a brute-force reference. The alphabet has no letters that can
    // spell a dangerous scheme, so the reference only has to model the entity rule.
    const isW = (ch: string) => core.isWs(ch.charCodeAt(0));
    const refEntity = (s: string): boolean => {
      const n = s.length;
      for (let i = 0; i + 1 < n; i++) {
        if (s[i] !== "]" || (s[i + 1] !== "(" && s[i + 1] !== ":")) continue;
        let t = i + 2;
        while (t < n && isW(s[t]!)) t++;
        if (t < n && s[t] === "<") { t++; while (t < n && isW(s[t]!)) t++; }
        for (let p = t; p < n && !isW(s[p]!); p++) {
          if (s[p] !== "&") continue;
          if (/^&(#|[A-Za-z0-9]+;)/.test(s.slice(p))) return true;
        }
      }
      return false;
    };
    const alpha = ["]", "(", ")", "<", ">", ":", "&", "#", ";", "a", "b", "Z", "1", "9", " ", "\t", "\u00a0", "\n", "&#", "&amp;", "](", "]:"];
    const frnd = seeded6(38);
    const diff: string[] = [];
    let positives = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      let s = "";
      const len = 1 + Math.floor(frnd() * 14);
      for (let k = 0; k < len; k++) s += alpha[Math.floor(frnd() * alpha.length)];
      const want = refEntity(s);
      if (want) positives++;
      if (core.hasDangerousLinkSyntax(s) !== want) diff.push(JSON.stringify(s));
    }
    obs6("U V-LINK fuzz parity (seed 38)", { strings: N, referencePositives: positives });
    expect("U V-LINK fuzz: linear scanner == brute-force entity reference on 20,000 seeded strings", diff.slice(0, 5), []);
  }

  // ── checkExportedMarkdown ──
  expect("U checkExportedMarkdown ws_run / link / ok", [
    core.checkExportedMarkdown("](\n" + rep(" ", 1024) + "- x"),
    core.checkExportedMarkdown("[x](javascript:alert(1))"),
    core.checkExportedMarkdown("[x](https://a.b) ok"),
  ], [{ ok: false, code: "ws_run" }, { ok: false, code: "link" }, { ok: true }]);

  // ── checkLexicalTree (allowlist, URL allowlist, caps, iterative) ──
  {
    const T = (...children: unknown[]) => ({ root: { type: "root", children } });
    const p = (...children: unknown[]) => ({ type: "paragraph", children });
    const t = (text: string) => ({ type: "text", text, format: 0 });
    const link = (url: string) => ({ type: "link", fields: { url, linkType: "custom", newTab: false }, children: [t("l")] });
    const r = (x: unknown) => {
      const c = core.checkLexicalTree(x);
      return c.ok ? "ok" : c.code;
    };
    expect("U checkLexicalTree allowlisted tree → ok", r(T(p(t("a")), { type: "heading", tag: "h2", children: [t("h")] }, { type: "horizontalrule" })), "ok");
    expect("U checkLexicalTree upload / relationship / autolink / unknown → node", [
      r(T({ type: "upload", value: 1 })), r(T({ type: "relationship", value: 1 })), r(T(p({ type: "autolink", fields: { url: "https://a" }, children: [] }))), r(T({ type: "block" })), r({}),
    ], ["node", "node", "node", "node", "node"]);
    const allowed = ["https://a.b/c", "http://a", "HTTPS://A", "mailto:a@b.c", "tel:+1", "/path", "#frag", "?q=1"];
    const refused = ["javascript:alert(1)", "java&#115;cript&#58;alert(1)", "&amp;", "//evil", "\\/\\/evil", "foo/bar", "x y", "\u0001https://a", "ftp://a", "data:text/html,a", "vbscript:a", "", " https://a", "https:x"];
    expect("U checkLexicalTree URL allowlist: allowed", allowed.map((u) => r(T(p(link(u))))), allowed.map(() => "ok"));
    expect("U checkLexicalTree URL allowlist: refused", refused.map((u) => r(T(p(link(u))))), refused.map(() => "url"));
    expect("U checkLexicalTree entity clause (step 5): hand-built link node java&#115;cript:x ⇒ url", r(T(p(link("java&#115;cript:x")))), "url");
    // caps (M26)
    const many = T(...Array.from({ length: 9001 }, () => ({ type: "linebreak" })));
    const atCap = T(...Array.from({ length: 8999 }, () => ({ type: "linebreak" })));
    const bigText = T(p(t(rep("a", 1200001))));
    let deep: Doc = { type: "paragraph", children: [] };
    const deepRoot = { root: { type: "root", children: [deep] } };
    for (let i = 0; i < 100000; i++) {
      const next: Doc = { type: "paragraph", children: [] };
      (deep.children as unknown[]).push(next);
      deep = next;
    }
    let deepRes: unknown;
    try {
      deepRes = r(deepRoot);
    } catch (e) {
      deepRes = `threw ${(e as Error).name}`;
    }
    expect("U M26 tree caps: 9,001 nodes → node, 9,000 → ok, JSON > 1,200,000 → node, 100,000-level tree → node (no RangeError)", [r(many), r(atCap), r(bigText), deepRes], ["node", "ok", "node", "node"]);
  }

  // ── comparator (M27) + isRoundTripSafeBody on samples ──
  {
    const md = "Read [this](https://example.com/a) and **bold** text.\n\n- one\n- two";
    const l1 = realConv.toLexical(md);
    const l2 = realConv.toLexical(md);
    expect("U M27 same Markdown converted twice: raw trees differ (random link id), comparator says equal", [JSON.stringify(l1) !== JSON.stringify(l2), core.lexicalTreesEqual(l1, l2)], [true, true]);
    const linkMd = "A [link](https://example.com/x) here.";
    const stored = body.convertBodyGuarded(editorConfig, linkMd);
    expect("U isRoundTripSafeBody: hub-saved body with a link → true; empty body → true", [stored.ok && body.isRoundTripSafeBody(editorConfig, stored.lexical), body.isRoundTripSafeBody(editorConfig, null)], [true, true]);
    const relBody = { root: { type: "root", format: "", indent: 0, version: 1, children: [{ type: "paragraph", format: "", indent: 0, version: 1, children: [{ type: "text", text: "x", format: 0, version: 1 }] }, { type: "relationship", relationTo: "articles", value: 1, version: 2, format: "" }] } };
    const newTab = { root: { type: "root", format: "", indent: 0, version: 1, children: [{ type: "paragraph", format: "", indent: 0, version: 1, children: [{ type: "link", version: 3, id: "aa11", fields: { linkType: "custom", url: "https://example.com/x", newTab: true }, format: "", indent: 0, children: [{ type: "text", text: "t", format: 0, version: 1 }] }] }] } };
    const centered = { root: { type: "root", format: "", indent: 0, version: 1, children: [{ type: "paragraph", format: "center", indent: 0, version: 1, children: [{ type: "text", text: "c", format: 0, version: 1 }] }] } };
    expect("U isRoundTripSafeBody: relationship node / new-tab link / centered paragraph → false", [body.isRoundTripSafeBody(editorConfig, relBody), body.isRoundTripSafeBody(editorConfig, newTab), body.isRoundTripSafeBody(editorConfig, centered)], [false, false, false]);
  }

  // ── precheckBodyLinear / validateBodyPure + pre6 ORACLE (OQ33) ──
  {
    const vecs = d2Vectors();
    const mism: string[] = [];
    const verdictBad: string[] = [];
    for (const vec of vecs) {
      const md = vec.md().trim();
      const o = pre6(md);
      const c = body.countBodyLinear(md);
      const want = { lines: o.lines, markChars: o.markChars, runs: o.runs, links: o.links, maxUnitRuns: o.maxUnitRuns, maxUnitLinks: o.maxUnitLinks, maxIndent: o.maxIndent };
      if (JSON.stringify(c) !== JSON.stringify(want)) mism.push(`${vec.name} cms=${JSON.stringify(c)} pre6=${JSON.stringify(want)}`);
      const ok = body.precheckBodyLinear(md).ok;
      if (vec.v !== "obs" && ok !== (vec.v === "pass")) verdictBad.push(`${vec.name}:${ok ? "pass" : "block"}`);
    }
    obs6("U oracle vectors", vecs.length);
    expect("U oracle: countBodyLinear === pre6 on every shared D2 vector (7 counts)", mism.slice(0, 3), []);
    expect("U 1b verdicts match the frozen table (7 below/at pass, 7 above blocked, real 40k/200k pass, f13b ×15 pass, ×16 blocked, B-3/CRLF blocked …)", verdictBad, []);
    // breaks: LF, CR, U+2028, U+2029 each one; CRLF = 2
    expect("U 1b line counting: a\\nb / a\\rb / a\\u2028b / a\\u2029b / a\\r\\nb", ["a\nb", "a\rb", "a\u2028b", "a\u2029b", "a\r\nb"].map((s) => body.countBodyLinear(s).lines), [2, 2, 2, 2, 3]);
    // validateBodyPure: seven boundary pairs through the real pure pipeline
    const edges = vecs.filter((x) => x.name.startsWith("c_"));
    expect("U AC30 7 below/at vectors pass validateBodyPure; 7 above → too_large", edges.map((x) => { const r = body.validateBodyPure(x.md()); return r.ok ? "ok" : r.code; }), edges.map((x) => (x.v === "pass" ? "ok" : "too_large")));
    const h = vecs.filter((x) => x.name.startsWith("h"));
    expect("U (ix) B-3 / CRLF family through validateBodyPure", h.map((x) => { const r = body.validateBodyPure(x.md()); return r.ok ? "ok" : r.code; }), h.map((x) => (x.v === "pass" ? "ok" : "too_large")));
    // scan time ≤ 20 ms target, FAIL > 50 ms (median of 5) at 200,000 chars
    const real200 = realBody6(200000, { line: 600, bold: 300, link: 1000, ital: 600, seed: 203 });
    const ms: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      body.precheckBodyLinear(real200);
      ms.push(performance.now() - t0);
    }
    const hms: number[] = [];
    for (const x of h) {
      const s = x.md();
      const t0 = performance.now();
      body.validateBodyPure(s);
      hms.push(performance.now() - t0);
    }
    obs6("U 1b scan ms (real 200k, median of 5; B-3 max)", { real200k: Math.round(median(ms) * 100) / 100, b3max: Math.round(Math.max(...hms) * 100) / 100 });
    expect("U 1b scan at 200,000 chars ≤ 50 ms (target ≤ 20) and each B-3 vector ≤ 20 ms", [median(ms) <= 50, Math.max(...hms) <= 20], [true, true]);
  }

  // ── validateBodyPure order (size → C0 → surrogate → trim → empty → W run → 1b → ![ → link) ──
  {
    const r = (s: string) => {
      const v = body.validateBodyPure(s);
      return v.ok ? `ok:${v.body.length}` : v.code;
    };
    expect("U validateBodyPure frozen order", [
      r(rep("a", 200001)), r("a\u0000b"), r("a\ud800b"), r(rep("\u00a0", 300)), r("](" + rep("\u00a0", 257) + "x)"), r("](" + rep("\u00a0", 257)),
      r("](" + rep(" ", 256) + "x)"), r("Bài.\n" + rep("\n", 300)), r("Bài.\n" + rep("\n", 300) + "Tiếp."), r(rep("\u000b", 300)), r(rep("\u0001", 300)),
      r("![a](b)"), r("[a](javascript:x)"), r(rep("a", 200000)),
    ], [
      "too_large", "c0", "surrogate", "ok:0", "ws_run", "ok:2",
      "ok:260", "ok:4", "ws_run", "c0", "c0",
      "image", "link", "ok:200000",
    ]);
  }

  // ── convertBodyGuarded with injected converters (S4-2, M20, M24, M26, M28, E13) ──
  {
    const lexOf = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text, format: 0 }] }] } });
    const g = (deps: Partial<{ toLexical: (m: string) => unknown; toMarkdown: (l: unknown) => string }>, md = "x", T = 1500) => {
      const r = body.convertBodyGuarded(editorConfig, md, T, deps as never);
      return r.ok ? "ok" : r.reason;
    };
    expect("U M20 step (6): exporter → ](+LF+1,024 spaces+- x ⇒ ws_run; → [x](javascript:…) ⇒ link; → '' ⇒ node; throws ⇒ node; clean ⇒ ok", [
      g({ toLexical: () => lexOf("x"), toMarkdown: () => "](\n" + rep(" ", 1024) + "- x" }),
      g({ toLexical: () => lexOf("x"), toMarkdown: () => "[x](javascript:alert(1))" }),
      g({ toLexical: () => lexOf("x"), toMarkdown: () => "" }),
      g({ toLexical: () => lexOf("x"), toMarkdown: () => { throw new Error("boom"); } }),
      g({ toLexical: () => lexOf("x"), toMarkdown: () => "x" }),
    ], ["ws_run", "link", "node", "node", "ok"]);
    expect("U V-LINK VL10: injected exporter returns VL1 ⇒ link at step (6)", g({ toLexical: () => lexOf("x"), toMarkdown: () => VLINK_REJECT.VL1! }), "link");
    expect("U E13 toLexical throws ⇒ node (not 500); err.code other than timeout ⇒ node", [
      g({ toLexical: () => { throw new RangeError("x"); }, toMarkdown: () => "x" }),
      g({ toLexical: () => { throw Object.assign(new Error("y"), { code: "ERR_OTHER" }); }, toMarkdown: () => "x" }),
    ], ["node", "node"]);
    let n = 0;
    expect("U M24 gate F: md2 !== md1 ⇒ unstable", g({ toLexical: (m) => lexOf(m), toMarkdown: () => `m${n++}` }), "unstable");
    const tree9001 = { root: { type: "root", children: Array.from({ length: 9001 }, () => ({ type: "linebreak" })) } };
    expect("U M26 injected tree > 9,000 nodes ⇒ node", g({ toLexical: () => tree9001, toMarkdown: () => "x" }), "node");
    // (vii-b) M28: lex1 ≠ lex2 but md2 === md1 ⇒ the STORED tree is lex2
    let calls = 0;
    const r28 = body.convertBodyGuarded(editorConfig, "x", 1500, { toLexical: () => (calls++ === 0 ? lexOf("first") : lexOf("second")), toMarkdown: () => "same" } as never);
    expect("U M28 stored tree = lex2 (second import)", r28.ok ? (((r28.lexical as Doc).root as Doc).children as Doc[])[0]!.children : r28, [{ type: "text", text: "second", format: 0 }]);
    const star = body.convertBodyGuarded(editorConfig, "The **Grand** is a 5* hotel with *great* views.");
    expect("U M28 real `5*` sentence ⇒ ok and the stored lexical is round-trip safe", [star.ok, star.ok && body.isRoundTripSafeBody(editorConfig, star.lexical)], [true, true]);
    if (star.ok) obs6("U `5*` md1 (OBS only, gap hub-p5-1-importer-misparses-lone-emphasis-markers)", star.markdownOut);
  }

  // ── (v) the vm timeout error is NOT `instanceof Error` and still maps to too_slow; (vi) round trip times out ⇒ false ──
  {
    let err: unknown;
    try {
      body.runWithHardTimeout(() => {
        for (;;) {
          /* spin */
        }
      }, null, 50);
    } catch (e) {
      err = e;
    }
    const code = (err as { code?: unknown } | undefined)?.code;
    expect("U (v) vm timeout: err.code === ERR_SCRIPT_EXECUTION_TIMEOUT, err instanceof Error === false, isVmTimeoutError true", [code, err instanceof Error, body.isVmTimeoutError(err)], ["ERR_SCRIPT_EXECUTION_TIMEOUT", false, true]);
    const spin = (): never => {
      for (;;) {
        /* spin */
      }
    };
    expect("U (vi) isRoundTripSafeBody with a never-ending importer (T = 50) ⇒ false", body.isRoundTripSafeBody(editorConfig, { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "a" }] }] } }, 50, { toLexical: spin, toMarkdown: () => "a" }), false);
  }

  // ── (i) M25: the hard guard in a CHILD process (outer timeout ≥ 30 s, SIGKILL, PID orphan check) ──
  {
    const t0 = performance.now();
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/hub-probe.ts", "--guard-child"], {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: process.env,
      maxBuffer: 1 << 20,
    });
    const wall = Math.round(performance.now() - t0);
    let line: Doc = {};
    try {
      line = JSON.parse((child.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}") as Doc;
    } catch {
      line = {};
    }
    let orphan = true;
    try {
      if (child.pid) process.kill(child.pid, 0);
    } catch (e) {
      orphan = (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
    obs6("U (i) guard child", { status: child.status, signal: child.signal, wallMs: wall, line });
    expect("U (i) M25 never-ending importer, T = 100 ⇒ too_slow within T + 100 ms; next call ok; child exited 0; no orphan (kill -0 ⇒ ESRCH)", [line.first, typeof line.ms === "number" && (line.ms as number) <= 200, line.second, child.status, orphan], ["too_slow", true, "ok", 0, false]);
  }

  // ── (viii) TEXT scans (OQ35 / OQ43 / OQ54 / E23 / N19) ──
  {
    const read = (p: string) => readFileSync(p, "utf8");
    const routes = walkFiles("src/app/api/hub/articles").filter((p) => p.endsWith("/route.ts"));
    const edge = routes.filter((p) => /export\s+const\s+runtime\s*=\s*['"](experimental-)?edge['"]/.test(read(p)));
    const authorLibs = walkFiles("src/lib").filter((p) => /\/hub-author-[a-z-]+\.ts$/.test(p));
    const edgeLibs = authorLibs.filter((p) => /export\s+const\s+runtime\s*=/.test(read(p)));
    expect("U (viii-a) no Edge runtime in any route.ts under src/app/api/hub/articles nor in hub-author-*.ts", [routes.length >= 3, edge, edgeLibs], [true, [], []]);
    const srcFiles = walkFiles("src").filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
    const vmFiles = srcFiles.filter((p) => /from ['"](node:)?vm['"]|require\(['"](node:)?vm['"]\)/.test(read(p)));
    expect("U (viii-b) exactly ONE file imports vm: src/lib/hub-author-body.ts", vmFiles, ["src/lib/hub-author-body.ts"]);
    const coreText = read("src/lib/hub-author-convert-core.ts");
    const forbidden = coreText.match(/\b(await|async|Promise|setTimeout|setInterval|setImmediate|nextTick|queueMicrotask)\b/g) ?? [];
    expect("U (viii-c) core file: non-empty, exports convertCore (plain function), no async word anywhere (comments included), no vm / read-regex import", [
      coreText.length > 1000, /export function convertCore\(/.test(coreText), /export async function convertCore/.test(coreText), forbidden,
      /from ['"](node:)?vm['"]/.test(coreText), /countDangerousLinkTargets/.test(coreText),
    ], [true, true, false, [], false, false]);
    const bodyText = read("src/lib/hub-author-body.ts");
    expect("U (viii-d) body file: script is exactly \"fn(a)\", runInNewContext(VM_SCRIPT…), no Promise.race / setTimeout (comments included), no read-path regex / body converter import", [
      body.VM_SCRIPT, /runInNewContext\(VM_SCRIPT, \{ fn, a: arg \}, \{ timeout: timeoutMs \}\)/.test(bodyText), (bodyText.match(/Promise\.race|setTimeout/g) ?? []).length,
      /countDangerousLinkTargets|hubArticleBodyToMarkdown/.test(bodyText),
    ], ["fn(a)", true, 0, false]);
    const coreUsers = srcFiles.filter((p) => /\bconvertCore\b/.test(read(p)));
    expect("U (iv) `convertCore` appears only in the core file and hub-author-body.ts", coreUsers, ["src/lib/hub-author-body.ts", "src/lib/hub-author-convert-core.ts"]);
    // async_hooks: running convertCore with synchronous fakes creates 0 async resources; positive control ≥ 1.
    const lexOf = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text, format: 0 }] }] } });
    let created = 0;
    const hook = createHook({ init: () => { created++; } });
    hook.enable();
    const res = core.convertCore({ md: "x", toLexical: () => lexOf("x"), toMarkdown: () => "x" });
    const rt = core.roundTripCore({ lexical: lexOf("x"), toLexical: () => lexOf("x"), toMarkdown: () => "x" });
    hook.disable();
    const coreCreated = created;
    created = 0;
    hook.enable();
    void Promise.resolve(1);
    hook.disable();
    expect("U (viii-c) async_hooks: convertCore + roundTripCore create 0 async resources (control ≥ 1); results are not thenable", [coreCreated, created >= 1, typeof (res as { then?: unknown }).then, typeof rt], [0, true, "undefined", "boolean"]);
  }

  // ── (xi) route wrappers: POST takes one parameter, PATCH two, production never passes deps ──
  {
    const listRoute = await import("../src/app/api/hub/articles/route");
    const idRoute = await import("../src/app/api/hub/articles/[id]/route");
    const srcFiles = walkFiles("src").filter((p) => /\.(ts|tsx)$/.test(p));
    const withUsers = srcFiles.filter((p) => /handleHubDraft(Create|Update)With\(/.test(readFileSync(p, "utf8")));
    const listText = readFileSync("src/app/api/hub/articles/route.ts", "utf8");
    const idText = readFileSync("src/app/api/hub/articles/[id]/route.ts", "utf8");
    expect("U (xi) POST.length === 1, PATCH.length === 2, maxDuration 30 on both, wrappers call the lib without deps", [
      listRoute.POST.length, idRoute.PATCH.length, listRoute.maxDuration, idRoute.maxDuration,
      /export const POST = \(request: Request\) => handleHubDraftCreate\(request\);/.test(listText),
      /export const PATCH = \(request: Request, ctx: \{ params: Promise<\{ id: string \}> \}\) => handleHubDraftUpdate\(request, ctx\);/.test(idText),
    ], [1, 2, 30, 30, true, true]);
    expect("U (xi) `handleHubDraft(Create|Update)With(` only in hub-author-handlers.ts (text scan — names only, N18)", withUsers, ["src/lib/hub-author-handlers.ts"]);
  }

  // ── (xii) URL check on lex1 with the REAL converters (OQ50 / M29 / E31) ──
  expect("U (xii) eight exotic-scheme URLs ⇒ url (not ok with https://)", D2_URLS.map((u) => { const r = body.convertBodyGuarded(editorConfig, u); return r.ok ? `ok:${r.markdownOut}` : r.reason; }), D2_URLS.map(() => "url"));

  // ── gate F (D25) vectors with the real converters (fast, no HTTP) ──
  {
    const r = (s: string) => {
      const x = body.convertBodyGuarded(editorConfig, s);
      return x.ok ? "ok" : x.reason;
    };
    const unstable = ["***x***", "**_x_**", "*__x__*", "_**x**_", "a\\b", "C:\\Users\\a\\b", "a \\ b", "\\|", "\\<", "\\[", "\\#", "\\.", "\\$", "\\\\", "a\\"];
    const stable = ["**đậm** *nghiêng*", "*nghiêng **đậm** nghiêng*", "**đậm *nghiêng* đậm**", "a *b **c** d* e", "\\*", "\\_", "\\~", "\\`", "5\\* hotel", "_x_", "__x__", "snake\\_case"];
    expect("U gate F: the measured `unstable` list", unstable.map(r), unstable.map(() => "unstable"));
    expect("U gate F: the controls pass", stable.map(r), stable.map(() => "ok"));
  }

  // ── parseCreateBody / parseUpdateBody (AC3, AC4, AC7 pure part) ──
  {
    const base = () => ({ tenant: "dtw", title: "Tiêu đề", pillarSlug: "p", authorId: 3, actor: { email: "a@b.co", role: "editor" } }) as Doc;
    const pc = (o: Doc) => input.parseCreateBody(o);
    const fields = (r: ReturnType<typeof pc>) => (r.ok ? "ok" : r.status === 422 ? (r.body.fields as Doc) : `${r.status}:${(r.body as Doc).reason}`);
    expect("U parse 400s: not an object / array / tenant missing / tenant not a string / blank", [
      fields(pc(null as unknown as Doc)), fields(pc([] as unknown as Doc)), fields(pc({ title: "x" })), fields(pc({ ...base(), tenant: 5 })), fields(pc({ ...base(), tenant: "  " })),
    ], ["400:body must be a JSON object", "400:body must be a JSON object", "400:tenant is required", "400:tenant is required", "400:tenant is required"]);
    const forbiddenKeys = ["exclusive", "translationAssisted", "workflowStatus", "_status", "origin", "publishedAt", "scheduledFor", "engineDraftId", "version", "id", "heroImage", "body", "pinnedToLatest", "pinnedUntil", "expectedVersion"];
    expect("U parse K: every forbidden root key ⇒ 400 unknown field(s): <key>", forbiddenKeys.map((k) => fields(pc({ ...base(), [k]: true }))), forbiddenKeys.map((k) => `400:unknown field(s): ${k}`));
    const proto = JSON.parse('{"tenant":"dtw","__proto__":{"x":1},"flags":{"__proto__":true,"exclusive":true,"pinnedToLatest":true}}') as Doc;
    expect("U parse K: __proto__ (root + flags), flags.exclusive / pinnedToLatest ⇒ 400 with prefixes", fields(pc(proto)), "400:unknown field(s): __proto__, flags.__proto__, flags.exclusive, flags.pinnedToLatest");
    expect("U parse K: actor / secondary unknown keys get prefixes", fields(pc({ ...base(), actor: { email: "a@b.co", role: "editor", x: 1 }, secondary: [{ pillarSlug: "q", y: 2 }] })), "400:unknown field(s): actor.x, secondary[0].y");
    const thousand: Doc = { ...base() };
    for (let i = 0; i < 1000; i++) thousand[`k${i}_${rep("z", 70)}`] = 1;
    const r1000 = pc(thousand);
    const reason1000 = r1000.ok ? "" : String(r1000.body.reason);
    expect("U parse K: 1,000 unknown keys ⇒ ONE 400, ≤ 20 keys, each cut to 64 chars, ends ', …'", [r1000.ok ? 0 : r1000.status, reason1000.replace("unknown field(s): ", "").replace(/, …$/, "").split(", ").length, reason1000.endsWith(", …"), reason1000.split(", ")[1]!.length], [400, 20, true, 64]);
    // 422 type / ranges
    expect("U parse types: flags.breaking 'false' ⇒ type; authorId '12' / 1.5 / 1e21 ⇒ type; 2147483648 / -1 / 0 ⇒ out_of_range", [
      fields(pc({ ...base(), flags: { breaking: "false" } })),
      ...["12", 1.5, 1e21].map((x) => fields(pc({ ...base(), authorId: x }))),
      ...[PG_INT4_MAX + 1, -1, 0].map((x) => fields(pc({ ...base(), authorId: x }))),
      fields(pc({ ...base(), coAuthorIds: [1, "2"] })),
    ], [{ "flags.breaking": "type" }, { authorId: "type" }, { authorId: "type" }, { authorId: "type" }, { authorId: "out_of_range" }, { authorId: "out_of_range" }, { authorId: "out_of_range" }, { coAuthorIds: "type" }]);
    let nest: unknown = "x";
    for (let i = 0; i < 100000; i++) nest = [nest];
    let nestObj: unknown = 1;
    for (let i = 0; i < 100000; i++) nestObj = { a: nestObj };
    expect("U parse: 100,000-level nesting under takeaways / flags.breaking / secondary ⇒ 422 type at the first level (no RangeError)", [
      fields(pc({ ...base(), takeaways: [nest] })), fields(pc({ ...base(), flags: { breaking: nestObj } })), fields(pc({ ...base(), secondary: [{ pillarSlug: nest }] })),
    ], [{ takeaways: "type" }, { "flags.breaking": "type" }, { "secondary[0].pillarSlug": "type" }]);
    expect("U parse: nesting under an UNKNOWN key ⇒ 400 unknown field(s)", fields(pc({ ...base(), deep: nestObj })), "400:unknown field(s): deep");
    // limits / too_many (E1)
    const s = (n: number) => rep("a", n);
    expect("U parse limits: title 300 ok / 301 too_long; dek 600 / 601; sponsor 120 / 121", [
      fields(pc({ ...base(), title: s(300) })), fields(pc({ ...base(), title: s(301) })), fields(pc({ ...base(), dek: s(600) })), fields(pc({ ...base(), dek: s(601) })),
      fields(pc({ ...base(), sponsor: s(120) })), fields(pc({ ...base(), sponsor: s(121) })),
    ], ["ok", { title: "too_long" }, "ok", { dek: "too_long" }, "ok", { sponsor: "too_long" }]);
    const arr = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    expect("U E1 too_many: tagSlugs 21, coAuthorIds 11, secondary 6, countrySlugs 11, citySlugs 11, takeaways 6", [
      fields(pc({ ...base(), tagSlugs: arr(21, (i) => `t${i}`) })), fields(pc({ ...base(), coAuthorIds: arr(11, (i) => i + 1) })),
      fields(pc({ ...base(), secondary: arr(6, (i) => ({ pillarSlug: `s${i}` })) })), fields(pc({ ...base(), countrySlugs: arr(11, (i) => `c${i}`) })),
      fields(pc({ ...base(), citySlugs: arr(11, (i) => `y${i}`) })), fields(pc({ ...base(), takeaways: arr(6, (i) => `k${i}`) })),
    ], [{ tagSlugs: "too_many" }, { coAuthorIds: "too_many" }, { secondary: "too_many" }, { countrySlugs: "too_many" }, { citySlugs: "too_many" }, { takeaways: "too_many" }]);
    const dedup = pc({ ...base(), tagSlugs: ["a", "b", "a"], coAuthorIds: [5, 5, 6], countrySlugs: arr(25, () => "vn") });
    expect("U parse: arrays de-duplicated silently, order kept", dedup.ok ? [dedup.value.tagSlugs, dedup.value.coAuthorIds, dedup.value.countrySlugs] : dedup, [["a", "b"], [5, 6], ["vn"]]);
    // characters
    expect("U parse chars: NUL in title / dek / takeaways / body / sponsor / slug / actor.email ⇒ c0; bidi in title / dek / sponsor ⇒ bidi; lone surrogate ⇒ surrogate; takeaways newline ⇒ newline", [
      fields(pc({ ...base(), title: "a\u0000" })), fields(pc({ ...base(), dek: "a\u0001" })), fields(pc({ ...base(), takeaways: ["a\u0002"] })), fields(pc({ ...base(), bodyMarkdown: "a\u0000" })),
      fields(pc({ ...base(), sponsor: "a\u001f" })), fields(pc({ ...base(), slug: "a\u0000" })), fields(pc({ ...base(), actor: { email: "a\u0000@b.co", role: "editor" } })),
      fields(pc({ ...base(), title: "a\u202e" })), fields(pc({ ...base(), dek: "a\u2066" })), fields(pc({ ...base(), sponsor: "a\u202a" })),
      fields(pc({ ...base(), title: "a\ud800" })), fields(pc({ ...base(), bodyMarkdown: "a\udc00" })), fields(pc({ ...base(), takeaways: ["a\nb"] })),
    ], [
      { title: "c0" }, { dek: "c0" }, { takeaways: "c0" }, { bodyMarkdown: "c0" }, { sponsor: "c0" }, { slug: "c0" }, { "actor.email": "c0" },
      { title: "bidi" }, { dek: "bidi" }, { sponsor: "bidi" }, { title: "surrogate" }, { bodyMarkdown: "surrogate" }, { takeaways: "newline" },
    ]);
    // slug
    const derived = pc({ ...base(), title: "Đà Nẵng đẹp" });
    expect("U parse slug: derived from title when absent (slugify; Đ dropped); title of only 'Đ' ⇒ slug required; '' ⇒ required; bad shape ⇒ format; 97 ⇒ too_long", [
      derived.ok ? derived.value.slug : derived, fields(pc({ ...base(), title: "Đ" })), fields(pc({ ...base(), slug: "" })), fields(pc({ ...base(), slug: "A b" })), fields(pc({ ...base(), slug: rep("a", 97) })),
    ], ["a-nang-ep", { slug: "required" }, { slug: "required" }, { slug: "format" }, { slug: "too_long" }]);
    // readMin, required, actor, sponsor, secondary
    expect("U parse readMin: 0 / 121 ⇒ out_of_range, '5' ⇒ type, 1 / 120 ok", [fields(pc({ ...base(), readMin: 0 })), fields(pc({ ...base(), readMin: 121 })), fields(pc({ ...base(), readMin: "5" })), fields(pc({ ...base(), readMin: 1 })), fields(pc({ ...base(), readMin: 120 }))], [{ readMin: "out_of_range" }, { readMin: "out_of_range" }, { readMin: "type" }, "ok", "ok"]);
    expect("U parse required (create): title, actor", fields(pc({ tenant: "dtw" })), { title: "required", actor: "required" });
    // P5.1b: pillarSlug / authorId are optional on create; '' / null keep their codes.
    expect("U parse title-only parse ok (create)", fields(pc({ tenant: "dtw", title: "Chỉ tiêu đề", actor: { email: "a@b.co", role: "editor" } })), "ok");
    expect("U parse POST pillarSlug '' ⇒ required", fields(pc({ ...base(), pillarSlug: "" })), { pillarSlug: "required" });
    expect("U parse POST pillarSlug null ⇒ type", fields(pc({ ...base(), pillarSlug: null })), { pillarSlug: "type" });
    expect("U parse actor: email 255 ⇒ too_long, 'ab' ⇒ format, 'a@@b.c' ⇒ format, role 'viewer' ⇒ format, id 65 ⇒ too_long, actor 'x' ⇒ type", [
      fields(pc({ ...base(), actor: { email: rep("a", 250) + "@b.co", role: "editor" } })), fields(pc({ ...base(), actor: { email: "ab", role: "editor" } })),
      fields(pc({ ...base(), actor: { email: "a@@b.c", role: "editor" } })), fields(pc({ ...base(), actor: { email: "a@b.co", role: "viewer" } })),
      fields(pc({ ...base(), actor: { email: "a@b.co", role: "editor", id: rep("i", 65) } })), fields(pc({ ...base(), actor: "x" })),
    ], [{ "actor.email": "too_long" }, { "actor.email": "format" }, { "actor.email": "format" }, { "actor.role": "format" }, { "actor.id": "too_long" }, { actor: "type" }]);
    expect("U parse sponsor required when flags.sponsored (create); secondary duplicate / contains the primary pillar", [
      fields(pc({ ...base(), flags: { sponsored: true } })), fields(pc({ ...base(), flags: { sponsored: true }, sponsor: "Acme" })),
      fields(pc({ ...base(), secondary: [{ pillarSlug: "q" }, { pillarSlug: "q" }] })), fields(pc({ ...base(), secondary: [{ pillarSlug: "p" }] })),
    ], [{ sponsor: "required" }, "ok", { secondary: "duplicate" }, { secondary: "duplicate" }]);
    expect("U parse: several fields of one tier in ONE 422 (N7)", fields(pc({ ...base(), title: s(301), bodyMarkdown: "![a](b)", pillarSlug: "zzz-unknown" })), { title: "too_long", bodyMarkdown: "image" });
    const full = pc({ ...base(), bodyMarkdown: "  x  ", takeaways: [" a ", ""], flags: { breaking: true }, dek: "  ", subSectionSlug: null });
    expect("U parse value: body W-trimmed, takeaways trimmed + empties dropped, blank dek ⇒ null, present keys in order", full.ok ? [full.value.bodyMarkdown, full.value.takeaways, full.value.dek, full.value.present] : full, ["x", ["a"], null, ["title", "pillarSlug", "authorId", "bodyMarkdown", "takeaways", "flags", "dek", "subSectionSlug"]]);
    const pu = (o: Doc) => input.parseUpdateBody(o);
    expect("U parseUpdateBody: expectedVersion required / type / out_of_range; tenant + actor only is valid", [
      fields(pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" } })), fields(pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" }, expectedVersion: "1" })),
      fields(pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" }, expectedVersion: 0 })), fields(pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" }, expectedVersion: 3 })),
    ], [{ expectedVersion: "required" }, { expectedVersion: "type" }, { expectedVersion: "out_of_range" }, "ok"]);
    expect("U parseUpdateBody: null clears dek / sponsor / subSectionSlug; null title ⇒ type", [
      (() => { const r = pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" }, expectedVersion: 1, dek: null, sponsor: null, subSectionSlug: null }); return r.ok ? [r.value.dek, r.value.sponsor, r.value.subSectionSlug] : r; })(),
      fields(pu({ tenant: "dtw", actor: { email: "a@b.co", role: "admin" }, expectedVersion: 1, title: null })),
    ], [[null, null, null], { title: "type" }]);
    expect("U parse: unknownFieldsReason cut format", input.unknownFieldsReason(["a", "b"]), "unknown field(s): a, b");
  }

  // ── mapWriteError (M16) ──
  expect("U M16 mapWriteError: ValidationError ⇒ 422 invalid (paths, never the message); class 22 ⇒ 422; class 23 / slug hook ⇒ 409; other ⇒ 500", [
    handlers.mapWriteError({ name: "ValidationError", message: "secret text", data: { errors: [{ path: "pillar", message: "x" }, { path: "secondarySections.0.pillar", message: "y" }] } }),
    handlers.mapWriteError({ name: "DatabaseError", code: "22P02" }),
    handlers.mapWriteError({ name: "Error", cause: { code: "23505" } }),
    handlers.mapWriteError(new Error('slug "x" already exists for this tenant. Choose a unique slug.')),
    handlers.mapWriteError(new TypeError("boom")),
  ], [
    { kind: "invalid", status: 422, fields: { pillar: "invalid", "secondarySections.0.pillar": "invalid" } },
    { kind: "invalid", status: 422, fields: {} },
    { kind: "slug_conflict", status: 409 },
    { kind: "slug_conflict", status: 409 },
    { kind: "internal", status: 500, name: "TypeError" },
  ]);
  expect("U estimateReadMin: empty ⇒ 1, 220 words ⇒ 1, 2,200 ⇒ 10, 40,000 ⇒ 120 (clamped)", [handlers.estimateReadMin(""), handlers.estimateReadMin(rep("w ", 220)), handlers.estimateReadMin(rep("w ", 2200)), handlers.estimateReadMin(rep("w ", 40000))], [1, 1, 10, 120]);

  // ── parseKinds / hubBlock / isHubArticleId reuse ──
  expect("U parseKinds: absent ⇒ pillars+authors (unchanged); new kinds accepted in fixed order; unknown ⇒ 400 reason", [
    query.parseKinds(null), query.parseKinds("cities,tags,pillars"), query.parseKinds("subsections,countries"), query.parseKinds("foo,tags"),
  ], [
    { ok: true, kinds: ["pillars", "authors"] }, { ok: true, kinds: ["pillars", "tags", "cities"] }, { ok: true, kinds: ["subsections", "countries"] }, { ok: false, reason: "unknown kind", values: ["foo"] },
  ]);
  {
    const docs = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, slug: `s${i}` }));
    const sani = (d: Doc) => ({ id: d.id });
    expect("U hubBlock: cut to cap + truncated; under cap not truncated; disabledBlock shape", [
      blocks.hubBlock(docs, 10, 3, sani), blocks.hubBlock(docs.slice(0, 2), 2, 3, sani), blocks.disabledBlock(),
    ], [
      { items: [{ id: 1 }, { id: 2 }, { id: 3 }], count: 3, totalDocs: 10, truncated: true }, { items: [{ id: 1 }, { id: 2 }], count: 2, totalDocs: 2, truncated: false }, { items: [], count: 0, totalDocs: 0, truncated: false, disabled: true },
    ]);
  }
  expect("U isHubArticleId reused (int4)", ["1", "2147483647", "2147483648", "01", "-1"].map(isHubArticleId), [true, true, false, false, false]);

  // ── isHubAuthoredDoc (pure lookup with a fake) ──
  {
    const fp = fakePayload6({ engines: { "7": { id: 7, hubAuthor: true }, "8": { id: 8, hubAuthor: false }, "9": { id: 9, hubAuthor: null } } });
    const r = await Promise.all([
      authM.isHubAuthoredDoc(fp as never, { lastEngine: 7 }), authM.isHubAuthoredDoc(fp as never, { lastEngine: { id: 7 } }), authM.isHubAuthoredDoc(fp as never, { lastEngine: 8 }),
      authM.isHubAuthoredDoc(fp as never, { lastEngine: 9 }), authM.isHubAuthoredDoc(fp as never, { lastEngine: null }), authM.isHubAuthoredDoc(fp as never, { lastEngine: 404 }),
    ]);
    expect("U isHubAuthoredDoc: hubAuthor true (id / populated) ⇒ true; false / NULL / no engine / missing ⇒ false", r, [true, true, false, false, false, false]);
  }

  // ── findSlugConflict: the draft lookup ALWAYS carries the tenant clause (M21, E16) ──
  {
    const fp = fakePayload6({
      finds: (a) => {
        const where = JSON.stringify(a.where);
        if (a.draft === true && where.includes('"tenant":{"equals":2}') && where.includes('"slug":{"equals":"y"}')) return [{ id: 77 }];
        if (a.draft === true && where.includes('"tenant":{"equals":1}') && where.includes('"slug":{"equals":"self"}')) return [{ id: 5 }];
        return [];
      },
    });
    const otherTenant = await refs.findSlugConflict({ payload: fp as never, tenantId: 1, slug: "y" });
    const self = await refs.findSlugConflict({ payload: fp as never, tenantId: 1, slug: "self", excludeId: 5 });
    const hit = await refs.findSlugConflict({ payload: fp as never, tenantId: 2, slug: "y" });
    const draftCalls = fp.calls.filter((c) => c.op === "find" && c.args.draft === true);
    const allHaveTenant = draftCalls.every((c) => JSON.stringify(c.args.where).includes('"tenant":{"equals":'));
    const mainCalls = fp.calls.filter((c) => c.op === "find" && c.args.draft !== true);
    expect("U M21 findSlugConflict: draft lookup has {tenant:{equals:T}} every time; other tenant's draft slug ⇒ null (no leak); itself excluded by id; same tenant ⇒ {id}", [
      allHaveTenant, draftCalls.length, mainCalls.every((c) => JSON.stringify(c.args.where).includes('"tenant":{"equals":')), otherTenant, self, hit,
    ], [true, 3, true, null, null, { id: 77 }]);
  }

  // ── handler seams (vii-c AC29 handler, M22 E7, E22 getPayload) ──
  {
    const tenantDoc = { id: 1, slug: "dtw", status: "active", defaultLanguage: "en", features: { articles: true } };
    const okAuth = (async () => ({ ok: true, engine: { id: 7, name: "author", status: "active", hubRead: true, hubAuthor: true }, tenants: [{ id: 1, slug: "dtw" }] })) as never;
    const finds = (a: Doc) => {
      if (a.collection === "pillars") return [{ id: 11, slug: "p" }];
      if (a.collection === "authors") return [{ id: 3 }];
      return [];
    };
    const req = (method: string, b: unknown) => new Request("http://localhost/api/hub/articles", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const actor = { email: "a@b.co", role: "editor" };
    // POST + convert ⇒ too_slow
    const fp = fakePayload6({ tenant: tenantDoc, finds });
    const res = await handlers.handleHubDraftCreateWith(req("POST", { tenant: "dtw", title: "T", pillarSlug: "p", authorId: 3, actor, bodyMarkdown: "hello" }), {
      getPayload: async () => fp as never,
      authenticate: okAuth,
      convert: async () => ({ ok: false, reason: "too_slow", error: { name: "Error", code: "ERR_SCRIPT_EXECUTION_TIMEOUT" } }),
    });
    const rb = await res.json();
    const creates = fp.calls.filter((c) => c.op === "create").length;
    const updates = fp.calls.filter((c) => c.op === "update").length;
    const logClean = fp.logs.every((l) => !l.includes("hello")) && fp.logs.some((l) => l.includes("reason=too_slow") && l.includes("code=ERR_SCRIPT_EXECUTION_TIMEOUT"));
    expect("U (vii-c) handler + convert too_slow ⇒ 422 fields.bodyMarkdown = too_slow; 0 create (incl. ActivityLog / integration_error), 0 update; log = reason + name + code only", [res.status, rb, creates, updates, logClean], [422, { ok: false, status: "invalid", reason: "one or more fields are invalid", fields: { bodyMarkdown: "too_slow" } }, 0, 0, true]);
    // PATCH: main row turns published between the gate read and the write ⇒ 422 not_editable status (M22)
    const draftDoc = { id: 5, tenant: 1, origin: "manual", workflowStatus: "draft", version: 3, lastEngine: 7, title: "Old", pillar: 11 };
    const fp2 = fakePayload6({ tenant: tenantDoc, finds, engines: { "7": { id: 7, hubAuthor: true } }, articles: { "5": { latest: draftDoc, main: draftDoc } } });
    let mainReads = 0;
    const res2 = await handlers.handleHubDraftUpdateWith(req("PATCH", { tenant: "dtw", actor, expectedVersion: 3, title: "New" }), { params: Promise.resolve({ id: "5" }) }, {
      getPayload: async () => fp2 as never,
      authenticate: okAuth,
      findMain: async () => (mainReads++ === 0 ? draftDoc : { ...draftDoc, workflowStatus: "published" }),
    });
    expect("U M22 PATCH re-reads the main row right before the write: became published ⇒ 422 not_editable status, 0 update", [res2.status, await res2.json(), mainReads, fp2.calls.filter((c) => c.op === "update").length], [422, { ok: false, status: "not_editable", reason: "status" }, 2, 0]);
    expect("U M22 assertStillEditable", [handlers.assertStillEditable(draftDoc), handlers.assertStillEditable({ ...draftDoc, workflowStatus: "published" }), handlers.assertStillEditable(null)], [{ ok: true }, { ok: false, reason: "status" }, { ok: false, reason: "status" }]);
    // PATCH happy path through the seams: draft:true update, changed by request key, context hubAuthor fields
    const fp3 = fakePayload6({ tenant: tenantDoc, finds, engines: { "7": { id: 7, hubAuthor: true } }, articles: { "5": { latest: draftDoc, main: draftDoc } } });
    const res3 = await handlers.handleHubDraftUpdateWith(req("PATCH", { tenant: "dtw", actor, expectedVersion: 3, title: "New", dek: null }), { params: Promise.resolve({ id: "5" }) }, { getPayload: async () => fp3 as never, authenticate: okAuth });
    const up = fp3.calls.find((c) => c.op === "update")?.args ?? {};
    expect("U PATCH via seams: 200 changed [title]; update uses draft:true, forces draft, context.hubAuthor.fields = [title], disableRevalidate", [
      res3.status, await res3.json(), up.draft, (up.data as Doc | undefined)?.workflowStatus, (up.data as Doc | undefined)?._status, ((up.context as Doc | undefined)?.hubAuthor as Doc | undefined)?.fields, (up.context as Doc | undefined)?.disableRevalidate,
    ], [200, { ok: true, id: 5, tenant: "dtw", workflowStatus: "draft", version: 2, changed: ["title"] }, true, "draft", "draft", ["title"], true]);
    // P5.1b D6: the create handler saves in Payload draft mode (draft:true), like the PATCH above.
    const fpc = fakePayload6({ tenant: tenantDoc, finds });
    const resC = await handlers.handleHubDraftCreateWith(req("POST", { tenant: "dtw", title: "T", pillarSlug: "p", authorId: 3, actor }), { getPayload: async () => fpc as never, authenticate: okAuth });
    const createCalls = fpc.calls.filter((c) => c.op === "create" && c.args.collection === "articles");
    expect("U create via seams: 201; payload.create of the article called ONCE with args.draft === true (D6)", [resC.status, createCalls.length, createCalls[0]?.args.draft === true], [201, 1, true]);
    // version conflict, not hub-authored, 404 shapes, 413, bad JSON — through seams
    const res4 = await handlers.handleHubDraftUpdateWith(req("PATCH", { tenant: "dtw", actor, expectedVersion: 2, title: "N" }), { params: Promise.resolve({ id: "5" }) }, { getPayload: async () => fakePayload6({ tenant: tenantDoc, finds, engines: { "7": { id: 7, hubAuthor: true } }, articles: { "5": { latest: draftDoc, main: draftDoc } } }) as never, authenticate: okAuth });
    const res5 = await handlers.handleHubDraftUpdateWith(req("PATCH", { tenant: "dtw", actor, expectedVersion: 3, title: "N" }), { params: Promise.resolve({ id: "5" }) }, { getPayload: async () => fakePayload6({ tenant: tenantDoc, finds, engines: { "7": { id: 7, hubAuthor: false } }, articles: { "5": { latest: draftDoc, main: draftDoc } } }) as never, authenticate: okAuth });
    const res6 = await handlers.handleHubDraftUpdateWith(req("PATCH", { tenant: "dtw", actor, expectedVersion: 3 }), { params: Promise.resolve({ id: "2147483648" }) }, { getPayload: async () => fakePayload6({ tenant: tenantDoc }) as never, authenticate: okAuth });
    const big = new Request("http://localhost/api/hub/articles", { method: "POST", body: rep("a", 1_000_001) });
    const res7 = await handlers.handleHubDraftCreateWith(big, { getPayload: async () => fakePayload6({}) as never, authenticate: okAuth });
    const res8 = await handlers.handleHubDraftCreateWith(new Request("http://localhost/api/hub/articles", { method: "POST", body: "{nope" }), { getPayload: async () => fakePayload6({}) as never, authenticate: okAuth });
    const res9 = await handlers.handleHubDraftCreateWith(req("POST", { tenant: "wad", title: "T", pillarSlug: "p", authorId: 3, actor }), { getPayload: async () => fakePayload6({}) as never, authenticate: okAuth });
    const res10 = await handlers.handleHubDraftCreateWith(req("POST", { tenant: "dtw", title: "T", pillarSlug: "p", authorId: 3, actor }), { getPayload: async () => fakePayload6({ tenant: { ...tenantDoc, features: { articles: false } } }) as never, authenticate: okAuth });
    expect("U frozen bodies via seams: 409 version_conflict / 422 not_hub_authored / 404 int4 / 413 / 400 bad JSON / 403 tenant / 403 feature_disabled", [
      [res4.status, await res4.json()], [res5.status, await res5.json()], [res6.status, await res6.json()], [res7.status, await res7.json()], [res8.status, await res8.json()], [res9.status, await res9.json()], [res10.status, await res10.json()],
    ], [
      [409, { ok: false, status: "version_conflict", reason: "article version changed", currentVersion: 3 }],
      [422, { ok: false, status: "not_editable", reason: "not_hub_authored" }],
      [404, { ok: false, status: "not_found", reason: "article not found for tenant" }],
      [413, { ok: false, status: "too_large", reason: "request body exceeds 1000000 bytes" }],
      [400, { ok: false, status: "bad_request", reason: "body must be valid JSON" }],
      [403, { ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: ["dtw"] }],
      [403, { ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }],
    ]);
  }

  // ── view=edit sanitizer + gate reasons ──
  expect("U editableReasonOf + sanitizeHubArticleEdit(editable:false) has ONLY two keys", [
    editSel.editableReasonOf({ origin: "engine", workflowStatus: "draft" }), editSel.editableReasonOf({ origin: "manual", workflowStatus: "published" }), editSel.editableReasonOf({ origin: "manual", workflowStatus: "draft" }),
    editSel.sanitizeHubArticleEdit({ title: "x", origin: "manual" }, { bodyEditable: true, editable: false, editableReason: "status" }),
  ], ["origin", "status", null, { editable: false, editableReason: "status" }]);
  {
    const e = editSel.sanitizeHubArticleEdit(
      { origin: "manual", version: 4, pillar: { id: 1, slug: "p" }, subSection: null, secondarySections: [{ pillar: { slug: "q" }, subSection: { slug: "s" } }], tags: [{ slug: "t" }], countries: [{ slug: "vn" }], cities: [], author: { id: 3, name: "A" }, coAuthors: [4, { id: 5 }], breaking: true, exclusive: true, sponsor: null, lastEngine: { id: 9, tokenHash: "x" } },
      { bodyEditable: true, editable: true, editableReason: "ok" },
    );
    expect("U sanitizeHubArticleEdit(editable:true): fresh object, slugs + ids, read-only flags, never lastEngine", e, {
      origin: "manual", version: 4, editable: true, editableReason: "ok", bodyEditable: true, pillarSlug: "p", subSectionSlug: null, secondary: [{ pillarSlug: "q", subSectionSlug: "s" }],
      tagSlugs: ["t"], countrySlugs: ["vn"], citySlugs: [], authorId: 3, coAuthorIds: [4, 5],
      flags: { aiAssisted: false, breaking: true, sponsored: false, affiliate: false, deepDive: false, longHaul: false, pinnedToLatest: false, exclusive: true }, sponsor: null,
    });
  }
}

/** Hidden mode for the M25 unit (i): the never-ending importer under T = 100 ms, then a normal call. */
async function guardChild6(): Promise<void> {
  const body = await import("../src/lib/hub-author-body");
  const lexOf = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text, format: 0 }] }] } });
  const t0 = performance.now();
  const first = body.convertBodyGuarded({} as never, "x", 100, {
    toLexical: () => {
      for (;;) {
        /* never ends */
      }
    },
    toMarkdown: () => "x",
  });
  const ms = Math.round(performance.now() - t0);
  const second = body.convertBodyGuarded({} as never, "x", 100, { toLexical: () => lexOf("x"), toMarkdown: () => "x" });
  console.log(JSON.stringify({ first: first.ok ? "ok" : first.reason, ms, second: second.ok ? "ok" : second.reason }));
  process.exit(0);
}

// ── --setup6 / --check6 (HTTP + Local API groups) ───────────────────────────

const A6_ENGINES = {
  author: "apcghub-cms6-author",
  noauthor: "apcghub-cms6-noauthor",
  nullauthor: "apcghub-cms6-nullauthor",
  writeonly: "apcghub-cms6-writeonly",
  limited: "apcghub-cms6-limited",
} as const;
type A6Key = keyof typeof A6_ENGINES;

/** The frozen `--setup6 --out <file>` shape (Public Contracts §Cấu trúc `--setup6 --out`). */
interface Setup6 {
  version: 1;
  base: string;
  engines: Record<A6Key, { id: number; name: string; tokenFile: string }>;
  tenants: Record<string, { id: number; articlesEnabled: boolean; citiesMap: boolean }>;
  articles: Record<
    "engine" | "published" | "manualDraftByCmsUser" | "manualDraftRelationBody" | "hubDraftPublishedThenSavedDraft",
    { id: number; tenant: string; slug: string }
  >;
  fixtures: Record<string, { pillars: string[]; subsections: { slug: string; pillar: string }[]; tags: string[]; cities: string[]; countries: string[]; authors: number[] }>;
  publicReadTokenFile: Record<string, string>;
}

const SETUP6_TENANTS = ["dtw", "gcv", "world-travel-brief"] as const;

async function ensureBySlug6(payload: P, collection: "pillars" | "tags" | "cities", tenantId: number, slug: string, data: Doc): Promise<number> {
  const found = (await payload.find({ collection, where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
  if (found) return found.id;
  return ((await payload.create({ collection, overrideAccess: true, context: { disableRevalidate: true }, data: { tenant: tenantId, slug, ...data } as never })) as unknown as { id: number }).id;
}

async function ensureSub6(payload: P, tenantId: number, pillarId: number, slug: string): Promise<number> {
  const found = (await payload.find({ collection: "subsections", where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }, { pillar: { equals: pillarId } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
  if (found) return found.id;
  return ((await payload.create({ collection: "subsections", overrideAccess: true, data: { tenant: tenantId, slug, title: slug, pillar: pillarId } as never })) as unknown as { id: number }).id;
}

async function setup6() {
  assertLocalTargets();
  const out = arg("out");
  if (!out) throw new Error("--out <file> required (tokens go to <file>.<key>.token, never printed)");
  const payload = await getPayload({ config });
  const db = rawDb(payload);
  const tenants = await tenantsBySlug(payload);
  const grant = SETUP6_TENANTS.map((s) => need(tenants, s));
  need(tenants, "wad"); // present, deliberately NOT granted
  const dtw = need(tenants, "dtw");
  const engines = {} as Setup6["engines"];
  const flags: Record<A6Key, Doc> = {
    author: { hubRead: true, hubAuthor: true, hubWrite: false, allowedTenants: grant },
    noauthor: { hubRead: true, hubAuthor: false, hubWrite: false, allowedTenants: grant },
    nullauthor: { hubRead: true, hubAuthor: false, hubWrite: false, allowedTenants: grant },
    writeonly: { hubRead: true, hubAuthor: false, hubWrite: true, allowedTenants: grant },
    limited: { hubRead: true, hubAuthor: true, hubWrite: false, allowedTenants: [dtw] },
  };
  for (const key of Object.keys(A6_ENGINES) as A6Key[]) {
    const name = A6_ENGINES[key];
    const token = randomBytes(24).toString("hex");
    const data = { rawToken: token, status: "active", ...flags[key] };
    let id = await engineIdByName(payload, name);
    if (id != null) await payload.update({ collection: "content-engines", id, overrideAccess: true, data: data as never });
    else id = ((await payload.create({ collection: "content-engines", overrideAccess: true, data: { name, engineType: "other", allowedActions: ["import"], ...data } as never })) as unknown as { id: number }).id;
    const tokenFile = `${out}.${key}.token`;
    writeFileSync(tokenFile, token, { mode: 0o600 });
    engines[key] = { id, name, tokenFile };
  }
  // hubAuthor NULL needs raw SQL (create fills the checkbox default).
  await db.execute(sql`UPDATE content_engines SET hub_author = NULL WHERE id = ${engines.nullauthor.id}`);
  const nullRes = (await db.execute(sql`SELECT (hub_author IS NULL) AS n FROM content_engines WHERE id = ${engines.nullauthor.id}`)) as { rows?: { n: boolean }[] };
  if (nullRes.rows?.[0]?.n !== true) throw new Error("nullauthor engine: hub_author is not NULL");

  // Taxonomy fixtures on the three granted tenants.
  const fixtures: Setup6["fixtures"] = {};
  const tenantInfo: Setup6["tenants"] = {};
  for (const slug of [...SETUP6_TENANTS, "wad", "brief-asia"]) {
    const id = tenants.get(slug);
    if (id == null) continue;
    const t = (await payload.findByID({ collection: "tenants", id, depth: 0, overrideAccess: true })) as unknown as Doc;
    const f = (t.features ?? {}) as Doc;
    tenantInfo[slug] = { id, articlesEnabled: f.articles !== false, citiesMap: f.citiesMap === true };
    if (!(SETUP6_TENANTS as readonly string[]).includes(slug)) continue;
    const pMain = await ensurePillar(payload, id, "p6-main", "P6 Main", 90);
    const pOther = await ensurePillar(payload, id, "p6-other", "P6 Other", 91);
    await ensureSub6(payload, id, pMain, "p6-sub");
    await ensureSub6(payload, id, pOther, "p6-sub"); // same sub-section slug under two pillars (resolved by PAIR)
    await ensureSub6(payload, id, pMain, "p6-sub2");
    const tags = ["p6-tag-a", "p6-tag-b"];
    for (const s of tags) await ensureBySlug6(payload, "tags", id, s, { title: s });
    const cities: string[] = [];
    if (tenantInfo[slug].citiesMap) {
      await ensureBySlug6(payload, "cities", id, "p6-city-a", { name: "P6 City" });
      cities.push("p6-city-a");
    }
    const a1 = await ensureAuthor(payload, id, "p6-author-1", "P6 Author One");
    const a2 = await ensureAuthor(payload, id, "p6-author-2", "P6 Author Two");
    const pillars = ["p6-main", "p6-other"];
    if (slug === "gcv") {
      await ensurePillar(payload, id, "exclusive", "Exclusive", 99);
      pillars.push("exclusive");
    }
    fixtures[slug] = {
      pillars,
      subsections: [{ slug: "p6-sub", pillar: "p6-main" }, { slug: "p6-sub", pillar: "p6-other" }, { slug: "p6-sub2", pillar: "p6-main" }],
      tags,
      cities,
      countries: ["vietnam", "singapore"],
      authors: [a1, a2],
    };
  }

  // Seeded articles (dtw).
  const stamp = Date.now().toString(36);
  const pMain = await ensurePillar(payload, dtw, "p6-main", "P6 Main", 90);
  const a1 = fixtures.dtw!.authors[0]!;
  const mkArt = async (slug: string, data: Doc, opts: { draft?: boolean; context?: Doc } = {}) =>
    ((await payload.create({
      collection: "articles",
      overrideAccess: true,
      locale: "en",
      ...(opts.draft ? { draft: true } : {}),
      context: { disableRevalidate: true, ...(opts.context ?? {}) },
      data: { tenant: dtw, title: `S6 ${slug}`, slug, pillar: pMain, author: a1, ...data } as never,
    })) as unknown as { id: number }).id;
  const sEngine = `s6-engine-${stamp}`;
  const sPub = `s6-published-${stamp}`;
  const sCms = `s6-cms-draft-${stamp}`;
  const sRel = `s6-rel-draft-${stamp}`;
  const sLive = `s6-live-${stamp}`;
  const engineId = await mkArt(sEngine, { origin: "engine", workflowStatus: "pending_review" }, { context: { engineWrite: true, engineId: engines.author.id } });
  const pubId = await mkArt(sPub, { origin: "manual", workflowStatus: "published", _status: "published" });
  const cmsId = await mkArt(sCms, { origin: "manual", workflowStatus: "draft" }, { draft: true });
  const relBody = {
    root: {
      type: "root", format: "", indent: 0, version: 1, direction: null,
      children: [
        { type: "paragraph", format: "", indent: 0, version: 1, direction: null, textFormat: 0, textStyle: "", children: [{ type: "text", text: "quan hệ:", format: 0, detail: 0, mode: "normal", style: "", version: 1 }] },
        { type: "relationship", format: "", version: 2, relationTo: "articles", value: pubId },
      ],
    },
  };
  const relId = await mkArt(sRel, { origin: "manual", workflowStatus: "draft", lastEngine: engines.author.id, body: relBody }, { draft: true });
  // Hub-created draft → CMS admin Publish → CMS admin Save Draft (workflowStatus draft): the "live" case (P-c).
  const liveId = await mkArt(sLive, { origin: "manual", workflowStatus: "draft", lastEngine: engines.author.id, editedByHuman: true }, { context: { hubAuthor: { actor: { email: "setup6@example.com", role: "editor" }, action: "create" }, engineId: engines.author.id } });
  await payload.update({ collection: "articles", id: liveId, overrideAccess: true, locale: "en", context: { disableRevalidate: true }, data: { _status: "published", workflowStatus: "published" } as never });
  await payload.update({ collection: "articles", id: liveId, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true }, data: { title: "S6 live saved draft", workflowStatus: "draft" } as never });

  // Public read token for dtw (sha256 stored; raw only in a 0o600 file).
  const pubTok = randomBytes(24).toString("hex");
  const tDoc = (await payload.findByID({ collection: "tenants", id: dtw, depth: 0, overrideAccess: true })) as unknown as Doc;
  const prevTokens = ((tDoc.readTokens as Doc[] | undefined) ?? []).filter((r) => r.label !== "probe6");
  await payload.update({
    collection: "tenants",
    id: dtw,
    overrideAccess: true,
    context: { disableRevalidate: true },
    data: { readTokens: [...prevTokens, { label: "probe6", tokenHash: sha256Hex6(pubTok), tokenPrefix: pubTok.slice(0, 6), status: "active" }] } as never,
  });
  const pubFile = `${out}.public-dtw.token`;
  writeFileSync(pubFile, pubTok, { mode: 0o600 });

  const setupOut: Setup6 = {
    version: 1,
    base: BASE,
    engines,
    tenants: tenantInfo,
    articles: {
      engine: { id: engineId, tenant: "dtw", slug: sEngine },
      published: { id: pubId, tenant: "dtw", slug: sPub },
      manualDraftByCmsUser: { id: cmsId, tenant: "dtw", slug: sCms },
      manualDraftRelationBody: { id: relId, tenant: "dtw", slug: sRel },
      hubDraftPublishedThenSavedDraft: { id: liveId, tenant: "dtw", slug: sLive },
    },
    fixtures,
    publicReadTokenFile: { dtw: pubFile },
  };
  writeFileSync(out, JSON.stringify(setupOut, null, 2), { mode: 0o600 });
  console.log(`[setup6] written ${out} (+ one 0600 token file per engine; tokens NOT printed). author grant = dtw,gcv,world-travel-brief; wad present, not granted`);
  process.exit(0);
}

/** Deep copy with object keys sorted (jsonb columns do not keep insertion order). */
function sortKeys6(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys6);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Doc).sort().map((k) => [k, sortKeys6((v as Doc)[k])]));
  return v;
}

function sha256Hex6(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function check6() {
  const unitOnly = flag("unit-only");
  const hooksOnly = flag("hooks-only");
  const { state, expect } = makeExpect();

  if (unitOnly) {
    await check6Unit(expect);
    console.log(`\n[check6] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`} (unit-only)`);
    process.exit(state.failures === 0 ? 0 : 1);
  }
  assertLocalTargets();
  const payload = await getPayload({ config });

  if (hooksOnly) {
    await check6Hooks(payload, expect);
    console.log(`\n[check6 --hooks-only] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
    process.exit(state.failures === 0 ? 0 : 1);
  }

  const inFile = arg("in");
  if (!inFile) throw new Error("--in <file from --setup6> required (or --unit-only / --hooks-only)");
  const s6 = JSON.parse(readFileSync(inFile, "utf8")) as Setup6;
  const tok = (k: A6Key) => readFileSync(s6.engines[k].tokenFile, "utf8").trim();
  const T = { author: tok("author"), noauthor: tok("noauthor"), nullauthor: tok("nullauthor"), writeonly: tok("writeonly"), limited: tok("limited") };
  const pubTok = readFileSync(s6.publicReadTokenFile.dtw!, "utf8").trim();
  const stamp = Date.now().toString(36);
  let seq = 0;
  const uniq = (p: string) => `${p}-${stamp}-${seq++}`;
  const fx = s6.fixtures.dtw!;
  const actor = { email: "probe6@example.com", role: "editor", id: "hub-user-6" };

  type Reply = { status: number; text: string; body: Doc; ms: number };
  const call = async (method: string, path: string, body?: unknown, token: string | null = T.author, raw?: string, signal?: AbortSignal): Promise<Reply> => {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal,
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    let parsed: Doc = {};
    try {
      parsed = JSON.parse(text) as Doc;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, text, body: parsed, ms };
  };
  const post = (b: Doc, token: string | null = T.author) => call("POST", "/api/hub/articles", b, token);
  const patch = (id: number | string, b: Doc, token: string | null = T.author) => call("PATCH", `/api/hub/articles/${id}`, b, token);
  const getA = (id: number | string, q = "", token: string | null = T.author) => call("GET", `/api/hub/articles/${id}?tenant=dtw${q}`, undefined, token);
  const draft = (extra: Doc = {}): Doc => ({ tenant: "dtw", title: `P6 ${uniq("t")}`, slug: uniq("p6"), pillarSlug: "p6-main", authorId: fx.authors[0], actor, ...extra });
  const logCount = async () => (await payload.count({ collection: "activityLog", overrideAccess: true })).totalDocs;
  const errCount = async () => (await payload.count({ collection: "activityLog", where: { eventType: { equals: "integration_error" } }, overrideAccess: true })).totalDocs;
  const artCount = async () => (await payload.count({ collection: "articles", overrideAccess: true })).totalDocs;
  const readMain = async (id: number) => (await payload.findByID({ collection: "articles", id, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
  const readLatest = async (id: number) => (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
  const INVALID = (fields: Doc) => ({ ok: false, status: "invalid", reason: "one or more fields are invalid", fields });
  const NOT_FOUND = { ok: false, status: "not_found", reason: "article not found for tenant" };

  // ══ A — authentication ═══════════════════════════════════════════════════
  {
    const before = await logCount();
    const r0 = await post(draft(), null);
    const r1 = await post(draft(), "not-a-real-token");
    expect("A 401 no token / wrong token (POST)", [[r0.status, r0.body], [r1.status, r1.body]], [[401, { ok: false, status: "unauthorized" }], [401, { ok: false, status: "unauthorized" }]]);
    const pa = await patch(s6.articles.manualDraftByCmsUser.id, { tenant: "dtw", actor, expectedVersion: 1 }, null);
    expect("A 401 no token (PATCH)", [pa.status, pa.body], [401, { ok: false, status: "unauthorized" }]);
    const NOAUTH = { ok: false, status: "forbidden", reason: "hub author not allowed for this engine" };
    const denials: Reply[] = [];
    for (const k of ["noauthor", "nullauthor", "writeonly"] as const) denials.push(await post(draft(), T[k]));
    expect("A 403 hubAuthor false / NULL / hubWrite-only ⇒ hub author not allowed", denials.map((r) => [r.status, r.body]), [[403, NOAUTH], [403, NOAUTH], [403, NOAUTH]]);
    const deniedRows = (await payload.find({ collection: "activityLog", where: { eventType: { equals: "engine_action_denied" } }, sort: "-id", limit: 3, depth: 0, overrideAccess: true })).docs as unknown as Doc[];
    expect("A each hubAuthor denial logged engine_action_denied {action: hub_author}", deniedRows.map((d) => (d.detail as Doc | undefined)?.action), ["hub_author", "hub_author", "hub_author"]);
    obs6("A log delta for 2×401 + 1×401 + 3×403", (await logCount()) - before);
    // hubRead false (temporarily on the noauthor engine) ⇒ the read gate answers first.
    await payload.update({ collection: "content-engines", id: s6.engines.noauthor.id, overrideAccess: true, data: { hubRead: false } as never });
    const nr = await post(draft(), T.noauthor);
    await payload.update({ collection: "content-engines", id: s6.engines.noauthor.id, overrideAccess: true, data: { hubRead: true } as never });
    expect("A 403 hubRead false ⇒ hub read not allowed (checked before hubAuthor)", [nr.status, nr.body], [403, { ok: false, status: "forbidden", reason: "hub read not allowed for this engine" }]);
    // tenant outside the grant
    const tBefore = await logCount();
    const wad = await post({ ...draft(), tenant: "wad" });
    const wadAllowed = ((wad.body.allowedTenants as string[] | undefined) ?? []).slice().sort();
    expect("A 403 tenant outside grant (wad) + allowedTenants", [wad.status, { ...wad.body, allowedTenants: wadAllowed }], [403, { ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: ["dtw", "gcv", "world-travel-brief"] }]);
    const lastDenied = ((await payload.find({ collection: "activityLog", where: { eventType: { equals: "engine_tenant_denied" } }, sort: "-id", limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined)?.detail as Doc | undefined;
    expect("A tenant denial logged engine_tenant_denied {scope: hub/articles/author, requested: wad}", [(await logCount()) - tBefore >= 1, lastDenied?.scope, lastDenied?.requested], [true, "hub/articles/author", "wad"]);
    const huge = await post({ ...draft(), tenant: rep("z", 900000) });
    const hugeRow = ((await payload.find({ collection: "activityLog", where: { eventType: { equals: "engine_tenant_denied" } }, sort: "-id", limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined)?.detail as Doc | undefined;
    expect("A E15 tenant of 900,000 chars ⇒ 403 and logged requested.length ≤ 64", [huge.status, String(hugeRow?.requested ?? "").length <= 64], [403, true]);
    // feature_disabled (transient: gcv features.articles = false, restored in finally)
    const gcvId = s6.tenants.gcv!.id;
    const gDoc = (await payload.findByID({ collection: "tenants", id: gcvId, depth: 0, overrideAccess: true })) as unknown as Doc;
    let fd: Reply;
    try {
      await payload.update({ collection: "tenants", id: gcvId, overrideAccess: true, context: { disableRevalidate: true }, data: { features: { ...((gDoc.features as Doc) ?? {}), articles: false } } as never });
      fd = await post({ ...draft(), tenant: "gcv" });
    } finally {
      await payload.update({ collection: "tenants", id: gcvId, overrideAccess: true, context: { disableRevalidate: true }, data: { features: gDoc.features } as never });
    }
    expect("A 403 feature_disabled (gcv articles off, transient)", [fd.status, fd.body], [403, { ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }]);
    // the author token cannot use intake or /status
    const intake = await call("POST", "/api/engine/intake", { publicationId: "dtw", title: "x", pillarSlug: "p6-main", body_markdown: "x", byline: "x" }, T.author);
    expect("A author token ⇒ POST /api/engine/intake = 403 action not allowed", [intake.status, intake.body.status, String(intake.body.reason ?? "").startsWith("action not allowed")], [403, "forbidden", true]);
    const st = await call("POST", `/api/hub/articles/${s6.articles.published.id}/status`, { tenant: "dtw", to: "archived", expectedStatus: "published", reason: "probe reason", actor }, T.author);
    expect("A author token ⇒ POST /api/hub/articles/{id}/status = 403 hub write not allowed", [st.status, st.body], [403, { ok: false, status: "forbidden", reason: "hub write not allowed for this engine" }]);
    const lim = await post({ ...draft(), tenant: "gcv" }, T.limited);
    expect("A limited engine (dtw only) ⇒ gcv 403 with allowedTenants [dtw]", [lim.status, lim.body.allowedTenants], [403, ["dtw"]]);
  }

  // ══ C — create ═══════════════════════════════════════════════════════════
  let createdId = 0;
  let createdSlug = "";
  {
    const b = draft({ dek: "Dek một", bodyMarkdown: "Xin chào **đậm** và [liên kết](https://example.com/a).\n\n- một\n- hai", takeaways: ["Ý một", "Ý hai"], countrySlugs: ["vietnam", "singapore"], tagSlugs: ["p6-tag-a"], subSectionSlug: "p6-sub", flags: { aiAssisted: true }, readMin: 3 });
    const logBefore = await logCount();
    const r = await post(b);
    createdId = r.body.id as number;
    createdSlug = b.slug as string;
    expect("C 201 shape", [r.status, Object.keys(r.body).sort(), r.body.tenant, r.body.slug, r.body.workflowStatus, r.body.version], [201, ["id", "ok", "slug", "tenant", "version", "workflowStatus"], "dtw", b.slug, "draft", 1]);
    const d = await readMain(createdId);
    const vn = (await payload.find({ collection: "countries", where: { slug: { equals: "vietnam" } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc;
    expect("C DB: tenant, origin manual, workflowStatus draft, _status draft, editedByHuman, version 1, contentType, sourceLanguage, lastEngine, country = countries[0], takeaways joined", [
      String(toId6(d.tenant)), d.origin, d.workflowStatus, d._status, d.editedByHuman, d.version, d.contentType, typeof d.sourceLanguage === "string", toId6(d.lastEngine), toId6(d.country), d.takeaways,
    ], [String(s6.tenants.dtw!.id), "manual", "draft", "draft", true, 1, "article", true, s6.engines.author.id, vn.id, "Ý một\nÝ hai"]);
    expect("H POST ⇒ exactly ONE ActivityLog row (article_created, detail via hub + actor + action create)", (await logCount()) - logBefore, 1);
    const row = (await payload.find({ collection: "activityLog", where: { and: [{ targetId: { equals: String(createdId) } }, { eventType: { equals: "article_created" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined;
    // jsonb does not keep key order: compare with keys sorted on both sides (same values, same keys)
    expect("H article_created row: actorType engine, detail {via, actor, action}", [row?.actorType, sortKeys6(row?.detail)], ["engine", sortKeys6({ via: "hub", actor, action: "create" })]);
    const g = await getA(createdId);
    expect("C GET detail round trip: 200, draft, bodyState ok", [g.status, (g.body.article as Doc | undefined)?.workflowStatus, (g.body.article as Doc | undefined)?.bodyState], [200, "draft", "ok"]);
    const list = await call("GET", "/api/hub/articles?tenants=dtw&status=draft&limit=200", undefined, T.author);
    const listed = ((list.body.articles ?? list.body.docs ?? list.body.items) as Doc[] | undefined) ?? [];
    expect("C listed in the hub list with workflowStatus draft", listed.some((a) => a.id === createdId && a.workflowStatus === "draft"), true);
    const pub = await call("GET", `/api/public/articles/${createdSlug}`, undefined, pubTok);
    const pubList = await call("GET", "/api/public/articles?limit=100", undefined, pubTok);
    expect("C NOT public: /api/public/articles/{slug} 404, absent from the public list", [pub.status, pubList.text.includes(createdSlug)], [404, false]);
    const viewsSlug = await call("POST", "/api/public/views", { slug: createdSlug }, pubTok);
    const viewsId = await call("POST", "/api/public/views", { id: createdId }, pubTok);
    obs6("C /api/public/views slug branch / id branch (K31: id branch OBS only)", { slug: [viewsSlug.status, viewsSlug.body], id: [viewsId.status, viewsId.body] });
    const n0 = await artCount();
    const wf = await post({ ...draft(), workflowStatus: "published" });
    expect("C/K workflowStatus in the body ⇒ 400 unknown field(s), no article created", [wf.status, wf.body, (await artCount()) - n0], [400, { ok: false, status: "bad_request", reason: "unknown field(s): workflowStatus" }, 0]);
  }

  // ══ K — forbidden keys + strict types over HTTP ══════════════════════════
  {
    const n0 = await artCount();
    const e0 = await errCount();
    const keys = ["exclusive", "translationAssisted", "_status", "origin", "publishedAt", "scheduledFor", "engineDraftId", "version", "id", "heroImage", "body", "pinnedToLatest", "pinnedUntil"];
    const rs: unknown[] = [];
    for (const k of keys) {
      const r = await post({ ...draft(), [k]: true });
      rs.push([r.status, r.body.reason]);
    }
    expect("K every forbidden root key ⇒ 400 unknown field(s): <key>", rs, keys.map((k) => [400, `unknown field(s): ${k}`]));
    const fl = await post({ ...draft(), flags: { exclusive: true, pinnedToLatest: true } });
    const pr = await call("POST", "/api/hub/articles", undefined, T.author, `{"tenant":"dtw","__proto__":{"x":1}}`);
    const tn = await post({ ...draft(), tenant: 5 });
    const ty = await post({ ...draft(), flags: { breaking: "false" } });
    // 100,000-level nesting is sent as RAW JSON text: JSON.stringify of such a value overflows the probe's own stack.
    const nest = "[".repeat(100000) + '"x"' + "]".repeat(100000);
    const withRaw = (extra: string) => JSON.stringify(draft()).slice(0, -1) + "," + extra + "}";
    const deep = await call("POST", "/api/hub/articles", undefined, T.author, withRaw(`"takeaways":[${nest}]`));
    const deepFlag = await call("POST", "/api/hub/articles", undefined, T.author, withRaw(`"flags":{"breaking":${nest}}`));
    const deepUnknown = await call("POST", "/api/hub/articles", undefined, T.author, withRaw(`"deep":${nest}`));
    const many: Doc = draft();
    for (let i = 0; i < 1000; i++) many[`k${i}_${rep("z", 70)}`] = 1;
    const kk = await post(many);
    expect("K flags.exclusive / pinnedToLatest, __proto__, tenant non-string, flags.breaking 'false', 100k nesting (known / unknown key), 1,000 unknown keys", [
      [fl.status, fl.body.reason], [pr.status, pr.body.reason], [tn.status, tn.body.reason], [ty.status, ty.body], [deep.status, deep.body], [deepFlag.status, deepFlag.body], [deepUnknown.status, deepUnknown.body.reason],
      [kk.status, String(kk.body.reason).endsWith(", …"), String(kk.body.reason).split(", ").length],
    ], [
      [400, "unknown field(s): flags.exclusive, flags.pinnedToLatest"], [400, "unknown field(s): __proto__"], [400, "tenant is required"], [422, INVALID({ "flags.breaking": "type" })],
      [422, INVALID({ takeaways: "type" })], [422, INVALID({ "flags.breaking": "type" })], [400, "unknown field(s): deep"], [400, true, 21],
    ]);
    expect("K no article created, 0 integration_error rows", [(await artCount()) - n0, (await errCount()) - e0], [0, 0]);
  }

  // ══ R — tenant isolation + ids ═══════════════════════════════════════════
  {
    const e0 = await errCount();
    const gfx = s6.fixtures.gcv!;
    const r = async (extra: Doc) => (await post(draft(extra))).body.fields;
    const tag = await r({ tagSlugs: ["p6-tag-zzz-nope"] });
    const crossAuthor = await r({ authorId: gfx.authors[0] });
    const crossCo = await r({ coAuthorIds: [gfx.authors[0]] });
    const subOther = await r({ subSectionSlug: "p6-sub2", pillarSlug: "p6-other" });
    const city = await r({ citySlugs: ["p6-city-a"] });
    const pair = await post(draft({ pillarSlug: "p6-other", subSectionSlug: "p6-sub" }));
    expect("R refs: unknown tag, other-tenant author / co-author ⇒ unknown_ref; sub-section of another pillar ⇒ unknown_ref; city at dtw (no citiesMap) ⇒ not_enabled; shared sub slug by PAIR ⇒ 201", [
      tag, crossAuthor, crossCo, subOther, city, pair.status,
    ], [{ tagSlugs: "unknown_ref" }, { authorId: "unknown_ref" }, { coAuthorIds: "unknown_ref" }, { subSectionSlug: "unknown_ref" }, { citySlugs: "not_enabled" }, 201]);
    expect("R refs: unknown countrySlugs ⇒ unknown_ref", await r({ countrySlugs: ["p6-country-zzz-nope"] }), { countrySlugs: "unknown_ref" });
    const ids = await Promise.all([PG_INT4_MAX6 + 1, 1e21, -1, 0, "12", 1.5].map(async (x) => (await post(draft({ authorId: x }))).body.fields));
    expect("R authorId 2147483648 / 1e21 / -1 / 0 / '12' / 1.5", ids, [{ authorId: "out_of_range" }, { authorId: "type" }, { authorId: "out_of_range" }, { authorId: "out_of_range" }, { authorId: "type" }, { authorId: "type" }]);
    const gcvArticle = await post({ ...draft(), tenant: "gcv", pillarSlug: "p6-main", authorId: gfx.authors[0] });
    const nf = await Promise.all([gcvArticle.body.id as number, 999999999, "abc", "2147483648", "01"].map(async (id) => {
      const x = await patch(id, { tenant: "dtw", actor, expectedVersion: 1, title: "x" });
      return [x.status, x.text];
    }));
    expect("R PATCH: other tenant's id / missing / malformed / > int4 / leading zero ⇒ SAME 404 body", nf, nf.map(() => [404, JSON.stringify(NOT_FOUND)]));
    expect("R 0 integration_error rows", (await errCount()) - e0, 0);
    // M21 (HTTP part): slug that exists ONLY in another tenant's latest draft ⇒ this tenant may use it.
    const ySlug = uniq("p6-other-tenant-y");
    const g = await post({ ...draft(), tenant: "gcv", pillarSlug: "p6-main", authorId: gfx.authors[0] });
    const gv = (g.body.version as number) ?? 1;
    await patch(g.body.id as number, { tenant: "gcv", actor, expectedVersion: gv, slug: ySlug });
    const mine = await post(draft({ slug: ySlug }));
    expect("R/M21 slug present only in ANOTHER tenant's latest draft ⇒ POST here 201, no existing.id leak", [mine.status, "existing" in mine.body], [201, false]);
  }

  // ══ L — data checks ══════════════════════════════════════════════════════
  {
    const e0 = await errCount();
    const f = async (extra: Doc) => {
      const x = await post(draft(extra));
      return x.status === 201 ? 201 : x.body.fields ?? `${x.status}:${x.body.status}`;
    };
    expect("L title 300 ⇒ 201 / 301 ⇒ too_long; body 200,000 ⇒ 201 / 200,001 ⇒ too_large", [
      await f({ title: rep("a", 300) }), await f({ title: rep("a", 301) }), await f({ bodyMarkdown: rep("a", 199998) + "😀" }), await f({ bodyMarkdown: rep("a", 199999) + "😀" }),
    ], [201, { title: "too_long" }, 201, { bodyMarkdown: "too_large" }]);
    const big = await call("POST", "/api/hub/articles", undefined, T.author, JSON.stringify({ ...draft(), dek: rep("a", 1_000_001) }));
    expect("L body > 1 MB ⇒ 413", [big.status, big.body], [413, { ok: false, status: "too_large", reason: "request body exceeds 1000000 bytes" }]);
    const linkVecs = [
      "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](vbscript:a)", "[x](data:text/html,a)", "[x](java\tscript:a)", "[x](java\nscript:a)", "[x](\u00a0javascript:a)",
      "[x]: javascript:alert(1)", "<javascript:alert(1)>", "[x](\u0001javascript:a)",
    ];
    const lr = [];
    for (const v of linkVecs) lr.push(await f({ bodyMarkdown: v }));
    expect("L dangerous link syntax ⇒ link (or c0 for the C0-prefixed one)", lr, [...linkVecs.slice(0, -1).map(() => ({ bodyMarkdown: "link" })), { bodyMarkdown: "c0" }]);
    expect("L entity target [x](java&#115;cript&#58;alert(1)) ⇒ link (entity rule, step 3)", await f({ bodyMarkdown: "[x](java&#115;cript&#58;alert(1))" }), { bodyMarkdown: "link" });
    const urlVecs = ["[x](//evil)", "[x](\\/\\/evil)", "[x](foo/bar)", "[x](ftp://a)"];
    const ur = [];
    for (const v of urlVecs) ur.push(await f({ bodyMarkdown: v }));
    obs6("L non-entity URL vectors (allowlist on the tree; observed codes)", ur);
    expect("L non-entity URL vectors refused (≠ 201)", ur.every((x) => x !== 201), true);
    // V-LINK over HTTP (E35 / E37): every reject ⇒ 422 link, no new article; every control ⇒ not link.
    {
      const n0 = await artCount();
      const rj: unknown[] = [];
      for (const [k, v] of Object.entries(VLINK_REJECT)) rj.push([k, await f({ bodyMarkdown: v })]);
      expect("L V-LINK reject (VL1-VL4, VL6-VL13, VR1-VR4) ⇒ 422 bodyMarkdown link", rj, Object.keys(VLINK_REJECT).map((k) => [k, { bodyMarkdown: "link" }]));
      expect("L V-LINK reject ⇒ no article created", (await artCount()) - n0, 0);
      const ok: unknown[] = [];
      for (const [k, v] of Object.entries(VLINK_OK)) ok.push([k, await f({ bodyMarkdown: v })]);
      obs6("L V-LINK controls VC1-VC12 (observed)", ok);
      expect("L V-LINK controls VC1-VC12 ⇒ never link (expected 201)", ok.filter((x) => JSON.stringify((x as unknown[])[1]) === JSON.stringify({ bodyMarkdown: "link" })), []);
      expect("L V-LINK controls VC1-VC12 ⇒ 201", ok, Object.keys(VLINK_OK).map((k) => [k, 201]));
      const base = await post(draft({ bodyMarkdown: "Plain body." }));
      const pr = await patch(base.body.id as number, { tenant: "dtw", actor, expectedVersion: 1, bodyMarkdown: VLINK_REJECT.VL1 });
      const after = (await payload.findByID({ collection: "articles", id: base.body.id as number, depth: 0, locale: "en", overrideAccess: true, draft: true })) as unknown as Doc;
      expect("L V-LINK PATCH VL1 ⇒ 422 link; version unchanged; stored body has no link node", [base.status, pr.status, pr.body.fields, after.version, JSON.stringify(after.body).includes('"type":"link"')], [201, 422, { bodyMarkdown: "link" }, 1, false]);
      const bs: unknown[] = [];
      for (const [k, v] of Object.entries(VLINK_BACKSLASH)) bs.push([k, await f({ bodyMarkdown: v })]);
      obs6("L backslash vectors BS1-BS5 + BS1b (observed codes)", bs);
      expect("L backslash vectors BS1-BS5 + BS1b ⇒ ≠ 201", bs.filter((x) => (x as unknown[])[1] === 201), []);
    }
    expect("L image / NUL dek / NUL takeaways / bidi title / lone surrogate title + body / takeaways newline", [
      await f({ bodyMarkdown: "![a](b)" }), await f({ dek: "a\u0000" }), await f({ takeaways: ["a\u0001"] }), await f({ title: "a\u202e" }), await f({ title: "a\ud800" }), await f({ bodyMarkdown: "a\ud800" }), await f({ takeaways: ["a\nb"] }),
    ], [{ bodyMarkdown: "image" }, { dek: "c0" }, { takeaways: "c0" }, { title: "bidi" }, { title: "surrogate" }, { bodyMarkdown: "surrogate" }, { takeaways: "newline" }]);
    const W = [0x20, 0xa0, 0x3000, 0xfeff, 0x2028].map((c) => String.fromCharCode(c));
    const wr = [];
    for (const c of W) wr.push([await f({ bodyMarkdown: "](" + rep(c, 257) + "x)" }), await f({ bodyMarkdown: "](" + rep(c, 257) }), await f({ bodyMarkdown: "](" + rep(c, 256) + "x)" })]);
    expect("L W run: ](+257×c+x) ⇒ ws_run; no suffix ⇒ 201 (trimmed); ](+256×c+x) ⇒ 201", wr, W.map(() => [{ bodyMarkdown: "ws_run" }, 201, 201]));
    expect("L whole-W body ⇒ 201 empty; 300 LF at end ⇒ 201; 300 LF in the middle ⇒ ws_run; 300 VT / U+0001 ⇒ c0", [
      await f({ bodyMarkdown: rep("\u00a0", 300) }), await f({ bodyMarkdown: "Bài.\n" + rep("\n", 300) }), await f({ bodyMarkdown: "Bài.\n" + rep("\n", 300) + "Tiếp." }), await f({ bodyMarkdown: rep("\u000b", 300) }), await f({ bodyMarkdown: rep("\u0001", 300) }),
    ], [201, 201, { bodyMarkdown: "ws_run" }, { bodyMarkdown: "c0" }, { bodyMarkdown: "c0" }]);
    expect("L sponsored without sponsor / secondary duplicate + primary / blocked pillar (gcv exclusive, primary + secondary) / readMin 0 / 121 / slug derived empty", [
      await f({ flags: { sponsored: true } }), await f({ secondary: [{ pillarSlug: "p6-main" }] }),
      (await post({ ...draft(), tenant: "gcv", pillarSlug: "exclusive", authorId: s6.fixtures.gcv!.authors[0] })).body.fields,
      (await post({ ...draft(), tenant: "gcv", pillarSlug: "p6-main", secondary: [{ pillarSlug: "exclusive" }], authorId: s6.fixtures.gcv!.authors[0] })).body.fields,
      await f({ readMin: 0 }), await f({ readMin: 121 }), await f({ title: "Đ", slug: undefined }),
    ], [{ sponsor: "required" }, { secondary: "duplicate" }, { pillarSlug: "blocked_pillar" }, { "secondary[0].pillarSlug": "blocked_pillar" }, { readMin: "out_of_range" }, { readMin: "out_of_range" }, { slug: "required" }]);
    const derived = draft({ title: `Đường ${uniq("đ")}` });
    delete derived.slug;
    const dr = await post(derived);
    expect("L slug derived from the title (Đ/đ dropped by slugify)", [dr.status, typeof dr.body.slug === "string" && /^[a-z0-9-]+$/.test(dr.body.slug as string)], [201, true]);
    const clash = await post(draft({ slug: createdSlug }));
    expect("L slug in use ⇒ 409 slug_conflict with existing.id", [clash.status, clash.body], [409, { ok: false, status: "slug_conflict", reason: "slug already exists for this tenant", existing: { id: createdId } }]);
    expect("L actor: unknown key ⇒ 400; email 255 ⇒ too_long; role viewer ⇒ format", [
      (await post({ ...draft(), actor: { ...actor, x: 1 } })).body.reason, await f({ actor: { email: rep("a", 250) + "@b.co", role: "editor" } }), await f({ actor: { email: "a@b.co", role: "viewer" } }),
    ], ["unknown field(s): actor.x", { "actor.email": "too_long" }, { "actor.role": "format" }]);
    expect("L E1 too_many: tagSlugs 21", await f({ tagSlugs: Array.from({ length: 21 }, (_, i) => `t${i}`) }), { tagSlugs: "too_many" });
    expect("L 0 integration_error rows", (await errCount()) - e0, 0);
  }

  // ══ D2 — frozen vectors over HTTP (timing recorded) ══════════════════════
  const timings: Doc[] = [];
  {
    const vecs = d2Vectors().filter((v) => v.http !== undefined);
    for (const v of vecs) {
      const md = v.md();
      const runs = v.http === 201 ? 1 : v.http === "too_slow" ? 3 : 5;
      const ms: number[] = [];
      let last: Reply | null = null;
      let created = 0;
      for (let k = 0; k < runs; k++) {
        const n0 = await artCount();
        try {
          last = await call("POST", "/api/hub/articles", draft({ bodyMarkdown: md }), T.author, undefined, AbortSignal.timeout(8_000));
        } catch (e) {
          last = { status: 0, text: String((e as Error).name), body: {}, ms: 8000 };
        }
        ms.push(last.ms);
        created += (await artCount()) - n0;
        if (v.http === 201) break;
      }
      const med = median(ms);
      const got = last!.status === 201 ? 201 : (last!.body.fields as Doc | undefined)?.bodyMarkdown ?? `${last!.status}`;
      const t: Doc = { name: v.name, got, medianMs: med, runs: ms.length };
      if (last!.status === 201) {
        const id = last!.body.id as number;
        const g1 = await getA(id);
        const e1 = await getA(id, "&view=edit");
        t.getMs = g1.ms;
        t.editMs = e1.ms;
        t.bodyEditable = ((e1.body.edit as Doc | undefined) ?? {}).bodyEditable;
      }
      timings.push(t);
      if (v.http === "too_slow") {
        expect(`D2 ${v.name} ⇒ 422 too_slow in [T-50, T+300] (median of 3), DB unchanged`, [got, med >= 1450 && med <= 1800, created], ["too_slow", true, 0]);
      } else if (v.http === 201) {
        expect(`D2 ${v.name} ⇒ 201 (≤ 2,000 ms), GET + view=edit 200 within budget, bodyEditable true`, [got, med <= 2000, (t.getMs as number) <= 2000, (t.editMs as number) <= 2000, t.bodyEditable], [201, true, true, true, true]);
      } else {
        expect(`D2 ${v.name} ⇒ 422 ${v.http}, DB unchanged`, [got, created], [v.http, 0]);
      }
    }
    // (a) gate F over HTTP
    const fv = async (md: string) => {
      const x = await post(draft({ bodyMarkdown: md }));
      return x.status === 201 ? 201 : (x.body.fields as Doc | undefined)?.bodyMarkdown;
    };
    const unstableV = ["***x***", "**_x_**", "*__x__*", "a\\b", "C:\\Users\\a\\b"];
    const stableV = ["**đậm** *nghiêng*", "*nghiêng **đậm** nghiêng*", "5\\* hotel", "\\_", "\\~"];
    const uo = [];
    for (const m of unstableV) uo.push(await fv(m));
    const so = [];
    for (const m of stableV) so.push(await fv(m));
    expect("D2(a) gate F over HTTP: unstable list ⇒ unstable; controls ⇒ 201", [uo, so], [unstableV.map(() => "unstable"), stableV.map(() => 201)]);
    // (a) lex2 vector: 201 → view=edit bodyEditable → PATCH body 200; read back by Local API equals the stored lex2
    const sentence = "The **Grand** is a 5* hotel with *great* views.";
    const c = await post(draft({ bodyMarkdown: sentence }));
    const cid = c.body.id as number;
    const ed = await getA(cid, "&view=edit");
    const pv = ((ed.body.edit as Doc | undefined)?.version as number) ?? 1;
    const pb = await patch(cid, { tenant: "dtw", actor, expectedVersion: pv, bodyMarkdown: sentence.replace("Grand", "Grande") });
    expect("D2(a) lex2 vector: 201, view=edit bodyEditable true, PATCH body ⇒ 200 (not body_not_editable)", [c.status, (ed.body.edit as Doc | undefined)?.bodyEditable, pb.status, pb.body.changed], [201, true, 200, ["bodyMarkdown"]]);
    obs6("D2(a) `5*` md1 after save (OBS only)", (ed.body.article as Doc | undefined)?.bodyMarkdown);
    // (e) after 201: two GETs equal; PATCH title only keeps bodyMarkdown; stored tree = re-import of md1 (ES-14)
    const real = await post(draft({ bodyMarkdown: realBody6(40000, { line: 150, bold: 300, link: 1000, ital: 600, seed: 40 }) }));
    const rid = real.body.id as number;
    const ga = await getA(rid, "&view=edit");
    const gb = await getA(rid, "&view=edit");
    const rv = ((ga.body.edit as Doc | undefined)?.version as number) ?? 1;
    const pt = await patch(rid, { tenant: "dtw", actor, expectedVersion: rv, title: `retitled ${uniq("r")}` });
    const gc = await getA(rid, "&view=edit");
    const latest = await readLatest(rid);
    const body = await import("../src/lib/hub-author-body");
    const { loadHubEditorConfig } = await import("../src/lib/hub-article-markdown");
    const ec = (await loadHubEditorConfig(payload.config)) as never;
    const md1 = (ga.body.article as Doc | undefined)?.bodyMarkdown as string;
    const reimport = body.convertBodyGuarded(ec, md1.trim());
    expect("D2(e) real 40k: two GETs equal; PATCH title only ⇒ changed [title], same bodyMarkdown; Local-API tree equals lex2 (ignoring id / direction / textFormat / textStyle)", [
      (ga.body.article as Doc).bodyMarkdown === (gb.body.article as Doc).bodyMarkdown, pt.body.changed, (gc.body.article as Doc).bodyMarkdown === md1,
      reimport.ok && body.lexicalTreesEqual(latest.body, reimport.lexical),
    ], [true, ["title"], true, true]);
  }
  obs6("D2 timings", timings);

  // ══ D — adversarial bodies over HTTP, time budget (§9.2 D; each case ≤ 2,000 ms, 2xx / 4xx, never 5xx) ══
  {
    const dt: Doc[] = [];
    const e0 = await errCount();
    const one = async (name: string, md: string) => {
      let r: Reply;
      try {
        r = await call("POST", "/api/hub/articles", draft({ bodyMarkdown: md }), T.author, undefined, AbortSignal.timeout(8_000));
      } catch (e) {
        r = { status: 0, text: String((e as Error).name), body: {}, ms: 8000 };
      }
      const got = r.status === 201 ? 201 : (r.body.fields as Doc | undefined)?.bodyMarkdown ?? `${r.status}`;
      const t: Doc = { name, got, ms: r.ms, status: r.status };
      if (r.status === 201) {
        const g = await getA(r.body.id as number);
        const e = await getA(r.body.id as number, "&view=edit");
        t.getMs = g.ms;
        t.editMs = e.ms;
        t.getStatus = [g.status, e.status];
      }
      dt.push(t);
      return t;
    };
    const fine = (t: Doc) => (t.status as number) >= 200 && (t.status as number) < 500 && (t.ms as number) <= 2000 &&
      (t.status !== 201 || (JSON.stringify(t.getStatus) === "[200,200]" && (t.getMs as number) <= 2000 && (t.editMs as number) <= 2000));
    // adversarial list: any 2xx / 4xx within budget (201 ⇒ GET + view=edit 200 within budget)
    const adv = [
      await one("190k_spaces_x", "](" + rep(" ", 190000) + "x)"), await one("brackets_100k", rep("[", 100000)), await one("stars_100k", rep("*", 100000)),
      await one("underscores_100k", rep("_", 100000)), await one("quote_nest_5000", rep("> ", 5000) + "x"), await one("dash_nest_5000", rep("- ", 5000) + "x"),
      await one("one_line_200k", rep("ab", 100000)),
    ];
    expect("D adversarial bodies: 2xx / 4xx (never 5xx) ≤ 2,000 ms; any 201 ⇒ GET + view=edit 200 ≤ 2,000 ms", adv.filter((t) => !fine(t)).map((t) => t.name), []);
    // (a) W class: 257×c+x ⇒ ws_run; 190,000×c+x ⇒ ws_run; bare 190,000×c ⇒ 201 (trimmed) + fast reads; bare 257×c ⇒ 201
    const Wc = [0xa0, 0x3000, 0xfeff, 0x2028, 0x2029, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f].map((c) => [c.toString(16), (n: number) => rep(String.fromCharCode(c), n)] as const);
    const alt = (n: number) => { let x = ""; for (let i = 0; i < n; i++) x += i % 2 ? "\u00a0" : " "; return x; };
    const wa: unknown[] = [];
    const wbad: string[] = [];
    for (const [k, g] of [...Wc, ["alt", alt] as const]) {
      const r = [await one(`a_${k}_257x`, "](" + g(257) + "x)"), await one(`a_${k}_190kx`, "](" + g(190000) + "x)"), await one(`a_${k}_190k_bare`, "](" + g(190000)), await one(`a_${k}_257_bare`, "](" + g(257))];
      wa.push(r.map((t) => t.got));
      for (const t of r) if (!fine(t)) wbad.push(t.name as string);
    }
    expect("D(a) W class (10 chars + ' '/U+00A0 alternation): 257+x ⇒ ws_run; 190k+x ⇒ ws_run; bare 190k ⇒ 201; bare 257 ⇒ 201", wa, Wc.concat([["alt", alt]]).map(() => ["ws_run", "ws_run", 201, 201]));
    expect("D(a) every W case within budget (≤ 2,000 ms; 201 ⇒ GET + view=edit 200 ≤ 2,000 ms)", wbad, []);
    // (b) 256×c + x ⇒ 201 then fast reads
    const wb = [];
    for (const [k, g] of [...Wc, ["alt", alt] as const]) wb.push(await one(`b_${k}_256x`, "](" + g(256) + "x)"));
    expect("D(b) ](+256×c+x) ⇒ 201, GET + view=edit 200 within budget", wb.map((t) => [t.got, fine(t)]), wb.map(() => [201, true]));
    // (c) NOT W: U+180E / U+200B / U+0085 / U+2060 × 190,000 + x) ⇒ 201, fast reads
    const wc = [];
    for (const cp of [0x180e, 0x200b, 0x85, 0x2060]) wc.push(await one(`c_${cp.toString(16)}_190kx`, "](" + rep(String.fromCharCode(cp), 190000) + "x)"));
    expect("D(c) non-W ×190,000 ⇒ 201, GET + view=edit 200 within budget", wc.map((t) => [t.got, fine(t)]), wc.map(() => [201, true]));
    // (d) many lines / list lines / deep tab list / CRLF ⇒ too_large (1b)
    let deepTab = "";
    for (let lvl = 64; deepTab.length < 199000 && lvl <= 255; lvl++) deepTab += "](\n" + rep("\t", lvl) + "- x\n";
    const wd = [await one("d_lines_100k", rep("a\n", 100000).slice(0, 199999)), await one("d_list_66k", rep("- a\n", 66000).slice(0, 199999)), await one("d_deep_tab", deepTab), await one("d_crlf", rep("a\r\n", 66000))];
    expect("D(d) 100k lines / 66k `- a` / deep tab list / CRLF ⇒ 422 too_large within budget", wd.map((t) => [t.got, fine(t)]), wd.map(() => ["too_large", true]));
    expect("D 0 integration_error rows", (await errCount()) - e0, 0);
    obs6("D timings", dt.map((t) => ({ n: t.name, got: t.got, ms: t.ms, get: t.getMs, edit: t.editMs })));
  }

  // ══ P — PATCH ════════════════════════════════════════════════════════════
  {
    const mk = async (extra: Doc = {}) => {
      const r = await post(draft(extra));
      return { id: r.body.id as number, version: r.body.version as number, slug: r.body.slug as string };
    };
    const a = await mk({ dek: "d0", sponsor: "S", flags: { breaking: true }, readMin: 7, bodyMarkdown: "A [link](https://example.com/x) here." });
    const vc = await patch(a.id, { tenant: "dtw", actor, expectedVersion: a.version + 5, title: "x" });
    expect("P expectedVersion stale ⇒ 409 version_conflict currentVersion", [vc.status, vc.body], [409, { ok: false, status: "version_conflict", reason: "article version changed", currentVersion: a.version }]);
    const l0 = await logCount();
    const t = await patch(a.id, { tenant: "dtw", actor, expectedVersion: a.version, title: "New title", flags: { affiliate: true } });
    const after = await readLatest(a.id);
    expect("P title + flags: 200 changed [title, flags], version +1, flags merged per key, absent keys unchanged (dek, readMin, sponsor, breaking)", [
      t.status, t.body.changed, t.body.version, after.affiliate, after.breaking, after.dek, after.readMin, after.sponsor,
    ], [200, ["title", "flags"], a.version + 1, true, true, "d0", 7, "S"]);
    expect("H PATCH with a change ⇒ ONE human_edit row with field NAMES", (await logCount()) - l0, 1);
    const he = (await payload.find({ collection: "activityLog", where: { and: [{ targetId: { equals: String(a.id) } }, { eventType: { equals: "human_edit" } }] }, sort: "-id", limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined;
    expect("H human_edit detail {via hub, actor, action update, fields}", sortKeys6(he?.detail), sortKeys6({ via: "hub", actor, action: "update", fields: ["title", "flags"] }));
    const l1 = await logCount();
    const same = await patch(a.id, { tenant: "dtw", actor, expectedVersion: a.version + 1, title: "New title" });
    expect("P no change ⇒ 200 changed [], version unchanged, 0 log rows", [same.status, same.body.changed, same.body.version, (await logCount()) - l1], [200, [], a.version + 1, 0]);
    const cl = await patch(a.id, { tenant: "dtw", actor, expectedVersion: a.version + 1, dek: null, flags: { sponsored: false }, sponsor: null });
    const afterCl = await readLatest(a.id);
    expect("P null clears dek / sponsor", [cl.status, afterCl.dek ?? null, afterCl.sponsor ?? null], [200, null, null]);
    const t2 = await patch(a.id, { tenant: "dtw", actor, expectedVersion: (cl.body.version as number) ?? 0, title: "Third" });
    expect("P title only on a hub draft whose body has an https link ⇒ 200 [title] (not body_not_editable)", [t2.status, t2.body.changed], [200, ["title"]]);
    const v3 = t2.body.version as number;
    expect("P merge rules: pillar change without subSectionSlug ⇒ subSectionSlug required; sponsor null while sponsored ⇒ sponsor required", [
      (await patch(a.id, { tenant: "dtw", actor, expectedVersion: v3, pillarSlug: "p6-other" })).body.fields,
      (await patch(a.id, { tenant: "dtw", actor, expectedVersion: v3, flags: { sponsored: true }, sponsor: null })).body.fields,
    ], [{ subSectionSlug: "required" }, { sponsor: "required" }]);
    const ne = async (k: keyof Setup6["articles"]) => {
      const x = await patch(s6.articles[k].id, { tenant: "dtw", actor, expectedVersion: 1, title: "x" });
      return [x.status, x.body];
    };
    expect("P not_editable: engine ⇒ origin; published ⇒ status; CMS-user draft ⇒ not_hub_authored; P-c live then saved-draft ⇒ status", [
      await ne("engine"), await ne("published"), await ne("manualDraftByCmsUser"), await ne("hubDraftPublishedThenSavedDraft"),
    ], [
      [422, { ok: false, status: "not_editable", reason: "origin" }], [422, { ok: false, status: "not_editable", reason: "status" }],
      [422, { ok: false, status: "not_editable", reason: "not_hub_authored" }], [422, { ok: false, status: "not_editable", reason: "status" }],
    ]);
    const live = s6.articles.hubDraftPublishedThenSavedDraft;
    const livePub = await call("GET", `/api/public/articles/${live.slug}`, undefined, pubTok);
    expect("P-c the live article is still public (200) after the refused PATCH", livePub.status, 200);
    const rel = s6.articles.manualDraftRelationBody;
    const relLatest = await readLatest(rel.id);
    const bn = await patch(rel.id, { tenant: "dtw", actor, expectedVersion: relLatest.version as number, bodyMarkdown: "x" });
    expect("P body_not_editable for a stored body with a relationship node", [bn.status, bn.body], [422, { ok: false, status: "body_not_editable", reason: "existing body cannot be edited as Markdown" }]);
    // P-a: CMS admin Save Draft (title X) ⇒ view=edit sees the latest; stale version ⇒ 409; right version ⇒ keeps X
    const b = await mk();
    await payload.update({ collection: "articles", id: b.id, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true }, data: { title: "X-saved" } as never });
    const be = await getA(b.id, "&view=edit");
    const bv = (be.body.edit as Doc | undefined)?.version as number;
    const stale = await patch(b.id, { tenant: "dtw", actor, expectedVersion: b.version, dek: "y" });
    const good = await patch(b.id, { tenant: "dtw", actor, expectedVersion: bv, dek: "y" });
    const bl = await readLatest(b.id);
    expect("P-a Save Draft: view=edit shows the latest (title X-saved, newer version), stale ⇒ 409, right version ⇒ 200 keeping X-saved, still not public", [
      (be.body.article as Doc | undefined)?.title, bv > b.version, stale.status, good.status, bl.title, (await call("GET", `/api/public/articles/${b.slug}`, undefined, pubTok)).status,
    ], ["X-saved", true, 409, 200, "X-saved", 404]);
    // P-b: Save Draft with workflowStatus published ⇒ not editable
    const c = await mk();
    await payload.update({ collection: "articles", id: c.id, overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true }, data: { title: "X-pub", workflowStatus: "published" } as never });
    const ce = await getA(c.id, "&view=edit");
    const cp = await patch(c.id, { tenant: "dtw", actor, expectedVersion: 99, dek: "z" });
    expect("P-b Save Draft workflowStatus published ⇒ edit {editable:false, status}, article.title from MAIN, PATCH 422 before the version check", [
      ce.body.edit, (ce.body.article as Doc | undefined)?.title === "X-pub", cp.status, cp.body.reason,
    ], [{ editable: false, editableReason: "status" }, false, 422, "status"]);
    // Slug two sources (S4-3)
    const d = await mk();
    const ySlug = uniq("p6-y");
    const dv = await patch(d.id, { tenant: "dtw", actor, expectedVersion: d.version, slug: ySlug });
    const postY = await post(draft({ slug: ySlug }));
    const postX = await post(draft({ slug: d.slug }));
    const other = await mk();
    const toOther = await patch(other.id, { tenant: "dtw", actor, expectedVersion: other.version, slug: ySlug });
    const keep = await patch(d.id, { tenant: "dtw", actor, expectedVersion: dv.body.version as number, slug: ySlug, title: "keep own slug" });
    expect("P slug two sources: PATCH X→Y; POST Y ⇒ 409 (existing = that article); POST X ⇒ 409 (main table still X, OBS-intended); PATCH another to Y ⇒ 409; keep own slug ⇒ 200", [
      dv.status, [postY.status, (postY.body.existing as Doc | undefined)?.id], postX.status, toOther.status, keep.status,
    ], [200, [409, d.id], 409, 409, 200]);
    const intakeY = await call("POST", "/api/engine/intake", { publicationId: "dtw", title: "intake y", pillarSlug: "p6-main", body_markdown: "x", byline: "Probe", slug: ySlug }, process.env.SEED_ENGINE_TOKEN ?? null);
    const intakeX = await call("POST", "/api/engine/intake", { publicationId: "dtw", title: "intake x", pillarSlug: "p6-main", body_markdown: "x", byline: "Probe", slug: d.slug }, process.env.SEED_ENGINE_TOKEN ?? null);
    obs6("P-17 intake with Y (only in the latest draft) / X (main table)", { y: [intakeY.status, intakeY.body.status], x: [intakeX.status, intakeX.body.status] });
  }

  // ══ T — taxonomy + view=edit ═════════════════════════════════════════════
  {
    const dflt = await call("GET", "/api/hub/taxonomy?tenants=dtw", undefined, T.author);
    const entry = ((dflt.body.tenants as Doc[] | undefined) ?? [])[0] ?? {};
    expect("T default kinds: only pillars + authors keys", Object.keys(entry).sort(), ["authors", "pillars", "tenant"]);
    const all = await call("GET", "/api/hub/taxonomy?tenants=dtw,world-travel-brief&kinds=subsections,tags,countries,cities", undefined, T.author);
    const [d, w] = (all.body.tenants as Doc[] | undefined) ?? [];
    const sub = ((d?.subsections as Doc | undefined)?.items as Doc[] | undefined) ?? [];
    expect("T new kinds: shapes, countries global, cities disabled at dtw / enabled at wtb", [
      all.status, Object.keys(sub[0] ?? {}).sort(), Object.keys((((d?.tags as Doc | undefined)?.items as Doc[] | undefined) ?? [])[0] ?? {}).sort(),
      Object.keys((((d?.countries as Doc | undefined)?.items as Doc[] | undefined) ?? [])[0] ?? {}).sort(), (d?.cities as Doc | undefined)?.disabled,
      JSON.stringify(d?.countries) === JSON.stringify(w?.countries), Array.isArray((w?.cities as Doc | undefined)?.items) && (w?.cities as Doc | undefined)?.disabled === undefined,
    ], [200, ["id", "order", "pillarId", "slug", "title"], ["id", "slug", "title"], ["code", "id", "name", "slug"], true, true, true]);
    const bad = await call("GET", "/api/hub/taxonomy?kinds=foo", undefined, T.author);
    expect("T kinds=foo ⇒ 400 unknown kind", [bad.status, bad.body.reason], [400, "unknown kind"]);
    const again = await call("GET", "/api/hub/taxonomy?tenants=dtw&kinds=tags,subsections", undefined, T.author);
    expect("T deterministic order (two reads equal)", again.text === (await call("GET", "/api/hub/taxonomy?tenants=dtw&kinds=tags,subsections", undefined, T.author)).text, true);
    for (const k of ["published", "engine", "manualDraftByCmsUser"] as const) {
      const art = s6.articles[k];
      const plain = await getA(art.id);
      const xyz = await getA(art.id, "&view=xyz");
      const edit = await getA(art.id, "&view=edit");
      expect(`T ${k}: no view ⇒ no edit key, view=xyz byte-identical to no view; view=edit ⇒ edit has only {editable,editableReason}, article from MAIN`, [
        "edit" in plain.body, plain.text === xyz.text, Object.keys((edit.body.edit as Doc | undefined) ?? {}).sort(), JSON.stringify(edit.body.article) === JSON.stringify(plain.body.article),
      ], [false, true, ["editable", "editableReason"], true]);
    }
    const rel = await getA(s6.articles.manualDraftRelationBody.id, "&view=edit");
    expect("T relationship body ⇒ editable true, bodyEditable false", [(rel.body.edit as Doc | undefined)?.editable, (rel.body.edit as Doc | undefined)?.bodyEditable], [true, false]);
    const mine = await getA(createdId, "&view=edit");
    const e = (mine.body.edit ?? {}) as Doc;
    const dbv = (await readLatest(createdId)).version;
    // createdId's body carries an https link: a hub-saved body must stay bodyEditable (§9.2 T, M27).
    expect("T hub draft view=edit: editable true, version matches DB, slugs back, https-link body ⇒ bodyEditable true", [e.editable, e.editableReason, e.version, e.pillarSlug, e.subSectionSlug, e.countrySlugs, e.tagSlugs, e.bodyEditable], [true, "ok", dbv, "p6-main", "p6-sub", ["vietnam", "singapore"], ["p6-tag-a"], true]);
  }

  // ══ W — webhook suppressed (D8; positive control) ════════════════════════
  {
    const http = await import("node:http");
    let hits = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST") hits++;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dtwId = s6.tenants.dtw!.id;
    const tDoc = (await payload.findByID({ collection: "tenants", id: dtwId, depth: 0, overrideAccess: true })) as unknown as Doc;
    try {
      await payload.update({ collection: "tenants", id: dtwId, overrideAccess: true, context: { disableRevalidate: true }, data: { frontendUrl: `http://127.0.0.1:${port}` } as never });
      let h0 = hits;
      const w = await post(draft());
      await patch(w.body.id as number, { tenant: "dtw", actor, expectedVersion: w.body.version as number, title: "w2" });
      await new Promise((r) => setTimeout(r, 300));
      const routeHits = hits - h0;
      h0 = hits;
      await payload.update({ collection: "articles", id: w.body.id as number, overrideAccess: true, locale: "en", draft: true, data: { dek: "control" } as never });
      await new Promise((r) => setTimeout(r, 300));
      const controlHits = hits - h0;
      expect("W route POST + PATCH ⇒ 0 webhook; Local API update without the flag ⇒ ≥ 1 (positive control)", [routeHits, controlHits >= 1], [0, true]);
    } finally {
      await payload.update({ collection: "tenants", id: dtwId, overrideAccess: true, context: { disableRevalidate: true }, data: { frontendUrl: tDoc.frontendUrl ?? null } as never });
      server.close();
    }
  }

  // ══ X — concurrency (OBS + no 5xx) ═══════════════════════════════════════
  {
    const slug = uniq("p6-race");
    const [x1, x2] = await Promise.all([post(draft({ slug })), post(draft({ slug }))]);
    obs6("X1 two POSTs, same slug (P-6b)", [x1.status, x2.status]);
    const base = await post(draft());
    const [y1, y2] = await Promise.all([
      patch(base.body.id as number, { tenant: "dtw", actor, expectedVersion: base.body.version as number, title: "race A" }),
      patch(base.body.id as number, { tenant: "dtw", actor, expectedVersion: base.body.version as number, title: "race B" }),
    ]);
    const fin = await readLatest(base.body.id as number);
    obs6("X2 two PATCHes, same expectedVersion (P-7)", { statuses: [y1.status, y2.status], finalVersion: fin.version });
    expect("X no 5xx", [x1.status, x2.status, y1.status, y2.status].every((s) => s < 500), true);
  }

  // ══ N — P5.1b title-only drafts (D1, D2, D4, D6; N1–N9). Labels "Nk: " (colon) for the EVL grep ══
  {
    const db = rawDb(payload);
    const one = async (q: ReturnType<typeof sql>): Promise<Doc | null> => (((await db.execute(q)) as { rows?: Doc[] }).rows ?? [])[0] ?? null;
    const num = async (q: ReturnType<typeof sql>): Promise<number> => Number((await one(q))?.n ?? -1);
    const dtwId = s6.tenants.dtw!.id;
    const authorEngine = s6.engines.author.id;
    const idOf = (r: Reply) => (typeof r.body.id === "number" ? (r.body.id as number) : -1);
    const mainRow = async (id: number) => one(sql`SELECT pillar_id, author_id, sub_section_id, _status::text AS s, workflow_status::text AS w, origin::text AS o, last_engine_id FROM articles WHERE id = ${id}`);
    const latestV = async (id: number) => one(sql`SELECT id, version_pillar_id AS p, version_author_id AS a, version_workflow_status::text AS w, version__status::text AS s, latest, version_version AS v FROM _articles_v WHERE parent_id = ${id} ORDER BY id DESC LIMIT 1`);
    const pillarId = async (slug: string) => (await one(sql`SELECT id FROM pillars WHERE tenant_id = ${dtwId} AND slug = ${slug}`))?.id as number;
    const pMain = await pillarId("p6-main");
    const pOther = await pillarId("p6-other");
    const subMain = (await one(sql`SELECT id FROM subsections WHERE tenant_id = ${dtwId} AND slug = 'p6-sub' AND pillar_id = ${pMain}`))?.id as number;
    // Fixture: a hub-authored null/null draft (Local API, draft:true; lastEngine = the author engine).
    const mkNull = async (extra: Doc = {}, tenant = dtwId) => {
      const slug = uniq("n-fx");
      const c = (await payload.create({
        collection: "articles", overrideAccess: true, locale: "en", draft: true, context: { disableRevalidate: true },
        data: { tenant, title: `N fixture ${slug}`, slug, readMin: 1, origin: "manual", workflowStatus: "draft", _status: "draft", editedByHuman: true, lastEngine: authorEngine, ...extra } as never,
      })) as unknown as { id: number; slug?: string };
      return { id: c.id, slug };
    };
    const vOf = async (id: number) => ((await readLatest(id)).version as number) ?? 0;
    const errOf = (e: unknown) => ({ name: (e as Error)?.name, paths: ((((e as { data?: { errors?: { path?: string }[] } })?.data?.errors) ?? []).map((x) => x.path)).sort() });

    // N1 — POST {tenant, title, actor} only
    const l0 = await logCount();
    const n1 = await post({ tenant: "dtw", title: `N1 ${uniq("t")}`, actor });
    const n1Id = idOf(n1);
    expect("N1: title-only POST ⇒ 201, version 1, workflowStatus draft", [n1.status, n1.body.version, n1.body.workflowStatus], [201, 1, "draft"]);
    expect("N1: DB main row pillar NULL, author NULL, _status draft, workflowStatus draft, origin manual, lastEngine = author engine", await mainRow(n1Id), { pillar_id: null, author_id: null, sub_section_id: null, s: "draft", w: "draft", o: "manual", last_engine_id: authorEngine });
    expect("N1: exactly ONE activity_log article_created, ONE log row in total, ONE _articles_v row", [
      await num(sql`SELECT count(*)::int AS n FROM activity_log WHERE target_id = ${String(n1Id)} AND event_type = 'article_created'`), (await logCount()) - l0, await num(sql`SELECT count(*)::int AS n FROM _articles_v WHERE parent_id = ${n1Id}`),
    ], [1, 1, 1]);

    // N2 — reads of a null/null hub draft (Local-API fixture)
    {
      const f = await mkNull();
      const g = await getA(f.id);
      const art = (g.body.article ?? {}) as Doc;
      expect("N2: GET detail ⇒ 200, pillar null, author null, bodyState empty, no edit key", [g.status, art.pillar, art.author, art.bodyState, "edit" in g.body], [200, null, null, "empty", false]);
      const list = await call("GET", `/api/hub/articles?tenants=dtw&status=draft&q=${encodeURIComponent(f.slug!)}`, undefined, T.author);
      const row = (((list.body.articles ?? []) as Doc[]).find((a) => a.id === f.id)) ?? null;
      expect("N2: GET list (q = fixture slug) ⇒ 200, the draft listed with pillar null", [list.status, row ? row.pillar : "absent"], [200, null]);
      const e = await getA(f.id, "&view=edit");
      const ed = (e.body.edit ?? {}) as Doc;
      expect("N2: GET view=edit ⇒ editable true, pillarSlug null, authorId null, secondary [], bodyEditable true", [e.status, ed.editable, ed.pillarSlug, ed.authorId, ed.secondary, ed.bodyEditable], [200, true, null, null, [], true]);
    }

    // N3 — PATCH a null/null hub draft (fixture); D2: secondary without a primary pillar
    {
      const f = await mkNull();
      const v = await vOf(f.id);
      const la = await logCount();
      const t = await patch(f.id, { tenant: "dtw", actor, expectedVersion: v, title: `N3 retitled ${uniq("t")}` });
      const he = await num(sql`SELECT count(*)::int AS n FROM activity_log WHERE target_id = ${String(f.id)} AND event_type = 'human_edit'`);
      expect("N3: PATCH title only ⇒ 200 changed [title], version +1, ONE human_edit row (one log row in total)", [t.status, t.body.changed, t.body.version, he, (await logCount()) - la], [200, ["title"], v + 1, 1, 1]);
      const d = await patch(f.id, { tenant: "dtw", actor, expectedVersion: v + 1, dek: "N3 dek" });
      const lb = await logCount();
      const same = await patch(f.id, { tenant: "dtw", actor, expectedVersion: v + 2, dek: "N3 dek" });
      expect("N3: PATCH dek ⇒ 200 [dek]; PATCH with no change ⇒ 200 changed [], version kept, 0 log rows", [d.status, d.body.changed, same.status, same.body.changed, same.body.version, (await logCount()) - lb], [200, ["dek"], 200, [], v + 2, 0]);
      const g = await mkNull();
      const gv = await vOf(g.id);
      const sp = await patch(g.id, { tenant: "dtw", actor, expectedVersion: gv, secondary: [{ pillarSlug: "p6-other" }] });
      const lv = await latestV(g.id);
      const vSec = await num(sql`SELECT count(*)::int AS n FROM _articles_v_version_secondary_sections WHERE _parent_id = ${(lv?.id as number) ?? -1} AND pillar_id = ${pOther}`);
      const mSec = await num(sql`SELECT count(*)::int AS n FROM articles_secondary_sections WHERE _parent_id = ${g.id}`);
      expect("N3: PATCH secondary on a null/null draft ⇒ 200 [secondary], version +1; main pillar_id still NULL; latest version: pillar NULL + ONE secondary row (pillar p6-other)", [
        sp.status, sp.body.changed, sp.body.version, (await mainRow(g.id))?.pillar_id, lv?.p, vSec,
      ], [200, ["secondary"], gv + 1, null, null, 1]);
      obs6("N3 main-table articles_secondary_sections rows after the draft PATCH (draft saves write the latest version only — P-14 branch B)", mSec);
    }

    // N3b — POST sub-section without a pillar ⇒ 422 subSectionSlug unknown_ref, no new article
    {
      const n0 = await artCount();
      const a = await post({ tenant: "dtw", title: `N3b ${uniq("t")}`, actor, subSectionSlug: "p6-sub" });
      const b = await post({ tenant: "dtw", title: `N3b ${uniq("t")}`, actor, subSectionSlug: "p6-sub", authorId: fx.authors[0] });
      expect("N3b: POST subSectionSlug without pillarSlug (without / with authorId) ⇒ 422 subSectionSlug unknown_ref", [[a.status, a.body], [b.status, b.body]], [[422, INVALID({ subSectionSlug: "unknown_ref" })], [422, INVALID({ subSectionSlug: "unknown_ref" })]]);
      expect("N3b: the refused POSTs create 0 articles", (await artCount()) - n0, 0);
    }

    // N4 — POST with one of pillar / author, or secondary without a pillar ⇒ 201 (D2: the CMS stays permissive)
    {
      const a = await post({ tenant: "dtw", title: `N4 ${uniq("t")}`, actor, pillarSlug: "p6-main" });
      const b = await post({ tenant: "dtw", title: `N4 ${uniq("t")}`, actor, authorId: fx.authors[0] });
      const c = await post({ tenant: "dtw", title: `N4 ${uniq("t")}`, actor, secondary: [{ pillarSlug: "p6-other" }] });
      expect("N4: POST pillar without author / author without pillar / secondary without pillar ⇒ 201 ×3", [a.status, b.status, c.status], [201, 201, 201]);
      const cSec = await num(sql`SELECT count(*)::int AS n FROM articles_secondary_sections WHERE _parent_id = ${idOf(c)} AND pillar_id = ${pOther}`);
      expect("N4: DB shapes: (a) pillar p6-main + author NULL; (b) pillar NULL + author set; (c) pillar NULL, ONE secondary row (p6-other)", [
        [(await mainRow(idOf(a)))?.pillar_id, (await mainRow(idOf(a)))?.author_id], [(await mainRow(idOf(b)))?.pillar_id, (await mainRow(idOf(b)))?.author_id], [(await mainRow(idOf(c)))?.pillar_id, cSec],
      ], [[pMain, null], [null, fx.authors[0]], [null, 1]]);
    }

    // N5 — merge rule D4 (subSectionSlug only required when the latest already had a pillar or a sub-section)
    {
      const f = await mkNull();
      const v = await vOf(f.id);
      const first = await patch(f.id, { tenant: "dtw", actor, expectedVersion: v, pillarSlug: "p6-main" });
      expect("N5: null/null draft: PATCH first pillarSlug WITHOUT subSectionSlug ⇒ 200 [pillarSlug]", [first.status, first.body.changed], [200, ["pillarSlug"]]);
      const second = await patch(f.id, { tenant: "dtw", actor, expectedVersion: await vOf(f.id), pillarSlug: "p6-other" });
      expect("N5: change an existing pillar WITHOUT subSectionSlug ⇒ 422 subSectionSlug required", [second.status, second.body], [422, INVALID({ subSectionSlug: "required" })]);
      const s = await mkNull({ subSection: subMain });
      const sp = await patch(s.id, { tenant: "dtw", actor, expectedVersion: await vOf(s.id), pillarSlug: "p6-main" });
      expect("N5: draft with a sub-section but no pillar: set pillar WITHOUT subSectionSlug ⇒ 422 subSectionSlug required (guard latest.subSection)", [sp.status, sp.body], [422, INVALID({ subSectionSlug: "required" })]);
      const a = await mkNull();
      const ap = await patch(a.id, { tenant: "dtw", actor, expectedVersion: await vOf(a.id), authorId: fx.authors[0] });
      expect("N5: null/null draft: PATCH authorId ⇒ 200 [authorId]", [ap.status, ap.body.changed], [200, ["authorId"]]);
      const r = await mkNull({ secondarySections: [{ pillar: pOther }] });
      const rp = await patch(r.id, { tenant: "dtw", actor, expectedVersion: await vOf(r.id), pillarSlug: "p6-other" });
      expect("N5: (R5) null/null draft with a secondary row on X: PATCH pillarSlug X ⇒ 422 secondary duplicate", [rp.status, rp.body], [422, INVALID({ secondary: "duplicate" })]);
    }

    // N6 — set-only (D1): no clearing through PATCH
    {
      const f = await mkNull({ pillar: pMain, author: fx.authors[0] });
      const v = await vOf(f.id);
      const r = async (b: Doc) => {
        const x = await patch(f.id, { tenant: "dtw", actor, expectedVersion: v, ...b });
        return [x.status, x.body.fields];
      };
      expect("N6: PATCH pillarSlug null ⇒ type; authorId null ⇒ type; pillarSlug '' ⇒ required; authorId '' ⇒ type", [
        await r({ pillarSlug: null }), await r({ authorId: null }), await r({ pillarSlug: "" }), await r({ authorId: "" }),
      ], [[422, { pillarSlug: "type" }], [422, { authorId: "type" }], [422, { pillarSlug: "required" }], [422, { authorId: "type" }]]);
      const lv = await latestV(f.id);
      expect("N6: DB unchanged after the refused PATCHes (version, pillar, author of the latest version)", [Number(lv?.v), lv?.p, lv?.a], [v, pMain, fx.authors[0]]);
    }

    // N7 — publish-blocking is a NON-draft save property (Local API; basis for P5.2)
    {
      const tryUp = async (id: number, data: Doc, draft = false) => {
        try {
          await payload.update({ collection: "articles", id, overrideAccess: true, locale: "en", ...(draft ? { draft: true } : {}), context: { disableRevalidate: true }, data: data as never });
          return { name: "ok", paths: [] as (string | undefined)[] };
        } catch (e) {
          return errOf(e);
        }
      };
      const a = await mkNull();
      const both = await tryUp(a.id, { _status: "published", workflowStatus: "published" });
      const wfOnly = await tryUp(a.id, { workflowStatus: "published" });
      const am = await mainRow(a.id);
      expect("N7: non-draft save of a null/null draft (_status+workflowStatus published / workflowStatus only) ⇒ ValidationError [author, pillar] both; main row still draft/draft", [both, wfOnly, am?.s, am?.w], [
        { name: "ValidationError", paths: ["author", "pillar"] }, { name: "ValidationError", paths: ["author", "pillar"] }, "draft", "draft",
      ]);
      obs6("N7 error message (null/null, published save)", await (async () => { try { await payload.update({ collection: "articles", id: a.id, overrideAccess: true, locale: "en", context: { disableRevalidate: true }, data: { _status: "published", workflowStatus: "published" } as never }); return "no error"; } catch (e) { return (e as Error).message; } })());
      const b = await mkNull({ pillar: pMain });
      expect("N7: non-draft save, pillar set, author missing ⇒ ValidationError [author]", await tryUp(b.id, { _status: "published", workflowStatus: "published" }), { name: "ValidationError", paths: ["author"] });
      const gcvId = s6.tenants.gcv!.id;
      const press = await ensurePillar(payload, gcvId, "pressroom", "Pressroom", 98);
      const c = await mkNull({ pillar: press }, gcvId);
      const pr = await tryUp(c.id, { _status: "published", workflowStatus: "published" });
      expect("N7: Pressroom (gcv single-home) without author: non-draft save ⇒ NO author error", pr.paths.includes("author"), false);
      obs6("N7 Pressroom non-draft save result", pr);
      // draft:true + workflowStatus published on a null/null draft: record main row, latest version, public API.
      const d = await mkNull();
      const dr = await tryUp(d.id, { workflowStatus: "published" }, true);
      const dm = await mainRow(d.id);
      const dv = await latestV(d.id);
      const pub = await call("GET", `/api/public/articles/${d.slug}`, undefined, pubTok);
      const pubList = await call("GET", "/api/public/articles?limit=100", undefined, pubTok);
      obs6("N7 draft:true + workflowStatus published (null/null): update result / main / latest version / public", { update: dr, main: dm, latestVersion: dv, public: pub.status, inList: pubList.text.includes(d.slug!) });
      expect("N7: draft:true + workflowStatus published: main row stays draft/draft and the public API answers 404 (not listed)", [dm?.s, dm?.w, pub.status, pubList.text.includes(d.slug!)], ["draft", "draft", 404, false]);
    }

    // N8 — public API never shows a hub title-only draft (positive control: a published article)
    {
      const f = await mkNull();
      const slugs = [f.slug!, ...(typeof n1.body.slug === "string" ? [n1.body.slug as string] : [])];
      const pubList = await call("GET", "/api/public/articles?limit=100", undefined, pubTok);
      const det = [];
      for (const s of slugs) det.push((await call("GET", `/api/public/articles/${s}`, undefined, pubTok)).status);
      const ctrl = await call("GET", `/api/public/articles/${s6.articles.published.slug}`, undefined, pubTok);
      expect("N8: public detail of the null/null draft (+ N1 when created) ⇒ 404, absent from the public list", [det, slugs.some((s) => pubList.text.includes(s))], [slugs.map(() => 404), false]);
      expect("N8: positive control: the published fixture ⇒ public detail 200", ctrl.status, 200);
    }

    // N9 — regression: intake still needs a pillar; /status unchanged; kill-switch unchanged
    {
      const intake = await call("POST", "/api/engine/intake", { publicationId: "dtw", title: `N9 intake ${uniq("i")}`, body_markdown: "x", byline: "Probe" }, process.env.SEED_ENGINE_TOKEN ?? null);
      expect("N9: /api/engine/intake without pillarSlug ⇒ 400 missing: pillarSlug (unchanged)", [intake.status, intake.body], [400, { ok: false, status: "bad_request", reason: "missing: pillarSlug" }]);
      const f = await mkNull();
      const st = async (id: number, to: string, expectedStatus: string) => {
        const x = await call("POST", `/api/hub/articles/${id}/status`, { tenant: "dtw", to, expectedStatus, reason: "probe n9 reason", actor }, T.writeonly);
        return [x.status, x.body];
      };
      expect("N9: /status Ẩn / Đăng lại on a null/null hub draft ⇒ 422 invalid_transition (unchanged)", [await st(f.id, "archived", "draft"), await st(f.id, "published", "draft")], [
        [422, { ok: false, status: "invalid_transition", reason: "cannot change draft to archived" }], [422, { ok: false, status: "invalid_transition", reason: "cannot change draft to published" }],
      ]);
      const arch = await mkNull({ workflowStatus: "archived" });
      const re = await call("POST", `/api/hub/articles/${arch.id}/status`, { tenant: "dtw", to: "published", expectedStatus: "archived", reason: "probe n9 reason", actor }, T.writeonly);
      const am = await mainRow(arch.id);
      const ap = await call("GET", `/api/public/articles/${arch.slug}`, undefined, pubTok);
      obs6("N9 /status Đăng lại on an archived null/null draft (gap hub-p5-1b-status-republish-blank-pillar)", { status: re.status, body: re.body, main: am, public: ap.status });
      expect("N9: /status Đăng lại an archived null/null article ⇒ refused (≥ 400), main row stays archived, public 404", [re.status >= 400, am?.w, ap.status], [true, "archived", 404]);
      const NOAUTH = { ok: false, status: "forbidden", reason: "hub author not allowed for this engine" };
      const k1 = await post({ tenant: "dtw", title: `N9 ${uniq("t")}`, actor }, T.noauthor);
      const k2 = await post({ tenant: "dtw", title: `N9 ${uniq("t")}`, actor }, T.nullauthor);
      expect("N9: kill-switch: title-only POST with hubAuthor false / NULL ⇒ 403 hub author not allowed", [[k1.status, k1.body], [k2.status, k2.body]], [[403, NOAUTH], [403, NOAUTH]]);
    }
  }

  // ══ I — intake regression (path in production use) ═══════════════════════
  {
    const tokI = process.env.SEED_ENGINE_TOKEN ?? null;
    const r = await call("POST", "/api/engine/intake", { publicationId: "dtw", title: `Intake ${uniq("i")}`, pillarSlug: "p6-main", body_markdown: "Một bài intake.", byline: "Probe Intake" }, tokI);
    obs6("I intake POST", [r.status, r.body.status]);
    expect("I intake still answers 201 for a valid draft (seed engine token)", r.status, 201);
  }

  console.log(`\n[check6] ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`}`);
  process.exit(state.failures === 0 ? 0 : 1);
}

const PG_INT4_MAX6 = 2147483647;

function toId6(v: unknown): number | string | null {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  const id = (v as { id?: unknown }).id;
  return typeof id === "number" || typeof id === "string" ? id : null;
}

/** Group H, `--hooks-only` (AC10 / 3.3): OBS of `detail` + `actorEngine` of `article_created` for five
 *  non-hub-author contexts (compare base vs branch with `diff`), plus the hubAuthor rows (branch only). */
async function check6Hooks(payload: P, expect: (label: string, actual: unknown, wanted: unknown) => void): Promise<void> {
  const tenants = await tenantsBySlug(payload);
  const dtw = need(tenants, "dtw");
  const pillar = await ensurePillar(payload, dtw, "p6-main", "P6 Main", 90);
  const author = await ensureAuthor(payload, dtw, "p6-author-1", "P6 Author One");
  const admin = (await payload.find({ collection: "users", where: { role: { equals: "systemAdmin" } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as (Doc & { id: number }) | undefined;
  if (!admin) throw new Error("no systemAdmin user — run `npm run db:seed` first");
  const engine = (await payload.find({ collection: "content-engines", limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number } | undefined;
  const stamp = Date.now().toString(36);
  const row = async (id: number, ev: string) => {
    const d = (await payload.find({ collection: "activityLog", where: { and: [{ targetId: { equals: String(id) } }, { eventType: { equals: ev } }] }, sort: "-id", limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined;
    return d ? { actorType: d.actorType, actorEngineSet: d.actorEngine != null, detail: d.detail ?? null } : null;
  };
  const base = (k: string) => ({ tenant: dtw, title: `H6 ${k} ${stamp}`, slug: `h6-${k}-${stamp}`, pillar, author, workflowStatus: "draft" });
  const scen: [string, () => Promise<number>][] = [
    ["human", async () => ((await payload.create({ collection: "articles", locale: "en", overrideAccess: false, user: admin as never, context: { disableRevalidate: true }, data: base("human") as never })) as unknown as { id: number }).id],
    ["engine", async () => ((await payload.create({ collection: "articles", locale: "en", overrideAccess: true, context: { disableRevalidate: true, engineWrite: true, engineId: engine?.id }, data: base("engine") as never })) as unknown as { id: number }).id],
    ["translationWrite", async () => ((await payload.create({ collection: "articles", locale: "en", overrideAccess: true, context: { disableRevalidate: true, translationWrite: true }, data: base("tr") as never })) as unknown as { id: number }).id],
    ["hubWrite", async () => ((await payload.create({ collection: "articles", locale: "en", overrideAccess: true, context: { disableRevalidate: true, hubWrite: { actor: { email: "h@example.com", role: "editor" }, reason: "probe" }, engineId: engine?.id }, data: base("hw") as never })) as unknown as { id: number }).id],
    ["systemWrite", async () => ((await payload.create({ collection: "articles", locale: "en", overrideAccess: true, context: { disableRevalidate: true, systemWrite: true }, data: base("sys") as never })) as unknown as { id: number }).id],
  ];
  for (const [name, fn] of scen) {
    const id = await fn();
    console.log(`OBS   H-hooks ${name} article_created  ${JSON.stringify(await row(id, "article_created"))}`);
  }
  // hubAuthor (branch only): create ⇒ detail {via, actor, action create}; draft update ⇒ ONE human_edit with fields
  const actor = { email: "h6@example.com", role: "editor" };
  const hid = ((await payload.create({ collection: "articles", locale: "en", overrideAccess: true, context: { disableRevalidate: true, hubAuthor: { actor, action: "create" }, engineId: engine?.id }, data: { ...base("ha"), origin: "manual", lastEngine: engine?.id } as never })) as unknown as { id: number }).id;
  const c = await row(hid, "article_created");
  const before = (await payload.count({ collection: "activityLog", where: { targetId: { equals: String(hid) } }, overrideAccess: true })).totalDocs;
  await payload.update({ collection: "articles", id: hid, draft: true, locale: "en", overrideAccess: true, context: { disableRevalidate: true, hubAuthor: { actor, action: "update", fields: ["title"] }, engineId: engine?.id }, data: { title: `H6 ha2 ${stamp}`, workflowStatus: "draft", _status: "draft" } as never });
  const after = (await payload.count({ collection: "activityLog", where: { targetId: { equals: String(hid) } }, overrideAccess: true })).totalDocs;
  const u = await row(hid, "human_edit");
  expect("H hubAuthor create ⇒ article_created actorType engine, detail {via hub, actor, action create}", sortKeys6(c), sortKeys6({ actorType: "engine", actorEngineSet: engine != null, detail: { via: "hub", actor, action: "create" } }));
  expect("H hubAuthor draft update ⇒ exactly ONE new row: human_edit with field names", [after - before, sortKeys6(u)], [1, sortKeys6({ actorType: "engine", actorEngineSet: engine != null, detail: { via: "hub", actor, action: "update", fields: ["title"] } })]);
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.1b (APCGHub, "Lưu nháp chỉ cần Tiêu đề") — two STANDALONE write modes,
// never part of any `--check*` count:
//
//   npx tsx scripts/hub-probe.ts --pb --in <setup6.json>
//       P-b1 / P-b2: Local API observations (OBS only). P-b1 create({draft:true})
//       without pillar / author + a draft title update with the route's context;
//       P-b2 the SAME create WITHOUT draft:true (expected: ValidationError).
//   npx tsx scripts/hub-probe.ts --n10 --in <setup6.json> --out <json>
//   npx tsx scripts/hub-probe.ts --n10 --in <setup6.json> --compare <json> [--require-new-code]
//       N10 equivalence gate (D6b / AC-b16): full-field creates over the route,
//       whole rows of every `%articles%` table + activity_log + translation_jobs,
//       normalised (N10_NORMALISE below) and written to / compared with a
//       baseline JSON kept OUTSIDE the repo. Exit 0 = identical, 1 = an assertion
//       failed or a table / key differs, 3 = baseline / environment error
//       (missing argument, unreadable / malformed / foreign-schema baseline,
//       table set mismatch, preflight not 201). Exit 2 = usage / local guard.
//
// Both modes WRITE to the database (they create articles): local-only guard
// (assertLocalTargets + assertLocalDb) runs FIRST, before any DB / HTTP call.
// ─────────────────────────────────────────────────────────────────────────────

function refuseLocalDb6(e: unknown): never {
  if (e instanceof LocalDbGuardError) {
    console.error(`[explore6] refusing: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

/** `[a-z0-9]+` only, so slugify never reshapes it. */
function runId6(): string {
  let s = "";
  for (const b of randomBytes(12)) s += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return s.slice(0, 10);
}

async function pb6() {
  assertLocalTargets();
  try { assertLocalDb(process.env.DATABASE_URL); } catch (e) { refuseLocalDb6(e); }
  const inFile = arg("in");
  if (!inFile) {
    console.error("usage: tsx scripts/hub-probe.ts --pb --in <file from --setup6>");
    process.exit(2);
  }
  const s6 = JSON.parse(readFileSync(inFile, "utf8")) as Setup6;
  const payload = await getPayload({ config });
  const db = rawDb(payload);
  const dtw = s6.tenants.dtw!.id;
  const engineId = s6.engines.author.id;
  const tDoc = (await payload.findByID({ collection: "tenants", id: dtw, depth: 0, overrideAccess: true })) as unknown as Doc;
  const actor = { email: "pb@example.invalid", role: "editor" };
  const run = runId6();
  const data = (tag: string): Doc => ({
    tenant: dtw, _status: "draft", workflowStatus: "draft", origin: "manual", editedByHuman: true, contentType: "article",
    sourceLanguage: tDoc.defaultLanguage, lastEngine: engineId, title: `PB ${tag} ${run}`, slug: `pb-${tag}-${run}`, readMin: 1,
  });
  const ctx = (action: string, fields?: string[]): Doc => ({ hubAuthor: { actor, action, ...(fields ? { fields } : {}) }, engineId, disableRevalidate: true });
  const errInfo = (e: unknown) => ({
    name: (e as Error)?.name,
    message: (e as Error)?.message,
    paths: (((e as { data?: { errors?: { path?: string }[] } })?.data?.errors) ?? []).map((x) => x.path),
  });
  const mainRow = async (id: number) =>
    ((await db.execute(sql`SELECT pillar_id, author_id, _status::text AS s, workflow_status::text AS w, version FROM articles WHERE id = ${id}`)) as { rows?: Doc[] }).rows?.[0] ?? null;

  // P-b1
  let b1ok = false;
  try {
    const c = (await payload.create({ collection: "articles", data: data("b1") as never, draft: true, depth: 0, overrideAccess: true, context: ctx("create") })) as unknown as Doc;
    const id = c.id as number;
    console.log(`OBS   P-b1 create({draft:true}) without pillar / author  ${JSON.stringify({ ok: true, id, version: c.version, main: await mainRow(id) })}`);
    const before = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true })) as unknown as Doc;
    await payload.update({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, data: { title: `PB b1 retitled ${run}`, workflowStatus: "draft", _status: "draft" } as never, context: ctx("update", ["title"]) });
    const after = (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true })) as unknown as Doc;
    b1ok = after.version === (before.version as number) + 1 && after.title === `PB b1 retitled ${run}` && after.pillar == null && after.author == null;
    console.log(`OBS   P-b1 update({draft:true}) title, route context  ${JSON.stringify({ ok: true, versionBefore: before.version, versionAfter: after.version, title: after.title, pillar: after.pillar ?? null, author: after.author ?? null, _status: after._status })}`);
  } catch (e) {
    console.log(`OBS   P-b1 FAILED  ${JSON.stringify(errInfo(e))}`);
  }

  // P-b2
  let b2validation = false;
  try {
    const c = (await payload.create({ collection: "articles", data: data("b2") as never, depth: 0, overrideAccess: true, context: ctx("create") })) as unknown as Doc;
    console.log(`OBS   P-b2 create WITHOUT draft:true, no pillar / author  ${JSON.stringify({ ok: true, id: c.id, main: await mainRow(c.id as number) })}`);
  } catch (e) {
    const info = errInfo(e);
    b2validation = info.name === "ValidationError";
    console.log(`OBS   P-b2 create WITHOUT draft:true, no pillar / author  ${JSON.stringify({ ok: false, ...info })}`);
  }
  console.log(`\n[pb] P-b1 draft create + draft update ok = ${b1ok}; P-b2 non-draft create ⇒ ValidationError = ${b2validation} (OBS only; not counted in any --check*)`);
  process.exit(0);
}

const N10_SCHEMA = "p5-1b-n10/v1";
/**
 * N10 normalisation (printed at the start of every run). Rule: ONLY values the
 * system generates (auto ids / random strings, timestamps, the run ids) are
 * normalised; ids of SEED data (pillar / author / sub-section / tag / country /
 * city / engine / tenant) are compared RAW. Every column not listed is RAW.
 */
const N10_NORMALISE = {
  familyArticle: ["articles.id", "_articles_v.parent_id", "articles_*._parent_id", "articles_*.parent_id", "activity_log.target_id", "translation_jobs.article_id"],
  familyVersion: ["_articles_v.id", "_articles_v_*._parent_id", "_articles_v_*.parent_id"],
  familyArrayRow: ["articles_*.id (varchar)", "_articles_v_version_*._uuid"],
  serialIdConstant: ["<child table>.id (integer) ⇒ <id>", "activity_log.id ⇒ <id>", "translation_jobs.id ⇒ <id>"],
  timeFlag: ["every timestamp / date column ⇒ null | not-null"],
  runId: ["every [a-z0-9]+ run id inside ANY string value (deep) ⇒ <RUN>"],
} as const;

type N10Rows = Record<string, Doc[]>;
interface N10File {
  schema: string;
  normalise: typeof N10_NORMALISE;
  tables: string[];
  scenarios: Record<"i" | "ii" | "iii_nodraft" | "iii_draft", N10Rows>;
}

async function n10() {
  assertLocalTargets();
  try { assertLocalDb(process.env.DATABASE_URL); } catch (e) { refuseLocalDb6(e); }
  const die3 = (msg: string): never => {
    console.error(`[n10] baseline / environment error: ${msg}`);
    process.exit(3);
  };
  const inFile = arg("in");
  const outFile = arg("out");
  const cmpFile = arg("compare");
  const requireNew = flag("require-new-code");
  if (!inFile) die3("--in <file from --setup6> required");
  if ((outFile ? 1 : 0) + (cmpFile ? 1 : 0) !== 1) die3("exactly one of --out <json> / --compare <json> required");
  if (requireNew && !cmpFile) die3("--require-new-code applies to --compare only");
  let s6: Setup6 = undefined as never;
  let authorTok = "";
  try {
    s6 = JSON.parse(readFileSync(inFile!, "utf8")) as Setup6;
    authorTok = readFileSync(s6.engines.author.tokenFile, "utf8").trim();
  } catch (e) {
    die3(`cannot read --in / author token: ${(e as Error).message}`);
  }
  const fx = s6.fixtures?.dtw;
  if (!fx || !s6.tenants?.gcv || !s6.fixtures?.gcv) die3("--in has no dtw / gcv fixtures");
  let baseline: N10File | null = null;
  if (cmpFile) {
    try {
      baseline = JSON.parse(readFileSync(cmpFile, "utf8")) as N10File;
    } catch (e) {
      die3(`cannot read / parse baseline ${cmpFile}: ${(e as Error).message}`);
    }
    const sc = baseline?.scenarios as Record<string, unknown> | undefined;
    if (!baseline || baseline.schema !== N10_SCHEMA || !Array.isArray(baseline.tables) || !sc || !["i", "ii", "iii_nodraft", "iii_draft"].every((k) => sc[k] && typeof sc[k] === "object")) {
      die3(`baseline ${cmpFile} is not a ${N10_SCHEMA} file`);
    }
    for (const k of ["i", "ii"] as const) {
      for (const t of [...baseline!.tables, "activity_log", "translation_jobs"]) {
        if (!Array.isArray(baseline!.scenarios[k][t])) die3(`baseline scenario (${k}) has no rows array for table ${t}`);
      }
    }
  }

  const payload = await getPayload({ config });
  const db = rawDb(payload);
  const q = async (text: string): Promise<Doc[]> => (((await db.execute(sql.raw(text))) as { rows?: Doc[] }).rows ?? []);
  const tables = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%articles%' ORDER BY table_name")).map((r) => String(r.table_name));
  const colRows = await q(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND (table_name LIKE '%articles%' OR table_name IN ('activity_log', 'translation_jobs')) ORDER BY table_name, ordinal_position`,
  );
  const cols = new Map<string, Map<string, string>>();
  for (const r of colRows) {
    const t = String(r.table_name);
    if (!cols.has(t)) cols.set(t, new Map());
    cols.get(t)!.set(String(r.column_name), String(r.data_type));
  }
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) die3(`unexpected table name ${JSON.stringify(t)}`);
    if (!(t === "articles" || t === "_articles_v" || t.startsWith("articles_") || t.startsWith("_articles_v_"))) die3(`table ${t} matches %articles% but is not an articles / _articles_v table (unknown shape)`);
  }
  console.log(`[n10] mode=${cmpFile ? "compare" : "out"}${requireNew ? " --require-new-code" : ""}; tables (${tables.length}): ${tables.join(", ")} (+ activity_log, translation_jobs)`);
  console.log(`[n10] normalise constant: ${JSON.stringify(N10_NORMALISE)}`);
  if (baseline) {
    const missing = baseline.tables.filter((t) => !tables.includes(t));
    const extra = tables.filter((t) => !baseline!.tables.includes(t));
    if (missing.length) die3(`table(s) recorded in the baseline are missing from the DB: ${missing.join(", ")}`);
    if (extra.length) die3(`table(s) in the DB are not in the baseline (schema changed): ${extra.join(", ")}`);
  }

  const { state, expect } = makeExpect();
  const actor = { email: "n10@example.invalid", role: "editor" };
  const runs: string[] = [];
  const newRun = () => {
    const r = runId6();
    runs.push(r);
    return r;
  };
  const post = async (b: Doc) => {
    const res = await fetch(`${BASE}/api/hub/articles`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authorTok}` }, body: JSON.stringify(b) });
    const text = await res.text();
    let body: Doc = {};
    try {
      body = JSON.parse(text) as Doc;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body };
  };

  if (requireNew) {
    const pre = await post({ tenant: "dtw", title: `n10 preflight ${newRun()}`, actor });
    if (pre.status !== 201) die3(`preflight title-only POST answered ${pre.status} (${JSON.stringify(pre.body)}) — the dev server is not running the new code`);
    console.log(`[n10] preflight title-only POST ⇒ 201 (article ${String(pre.body.id)} excluded from the comparison surface)`);
  }

  // ── dump + normalise ──
  const timeType = (dt: string) => dt.startsWith("timestamp") || dt === "date";
  const parentCol = (t: string) => (cols.get(t)?.has("_parent_id") ? "_parent_id" : "parent_id");
  const orderBy = (t: string): string => {
    const c = cols.get(t)!;
    if (t === "articles" || t === "_articles_v") return "id";
    if (c.has("_order")) return `${parentCol(t)}, _order`;
    if (c.has("_locale")) return `${parentCol(t)}, _locale`;
    if (t.endsWith("_rels")) return [`parent_id`, `path`, `"order"`, ...[...c.keys()].filter((k) => k.endsWith("_id") && k !== "parent_id").sort()].join(", ");
    return "id";
  };
  const dump = async (id: number): Promise<N10Rows> => {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`bad article id ${String(id)}`);
    const out: N10Rows = {};
    for (const t of tables) {
      let where: string;
      if (t === "articles") where = `id = ${id}`;
      else if (t === "_articles_v") where = `parent_id = ${id}`;
      else if (t.startsWith("_articles_v_")) where = `${parentCol(t)} IN (SELECT id FROM _articles_v WHERE parent_id = ${id})`;
      else where = `${parentCol(t)} = ${id}`;
      out[t] = (await q(`SELECT to_jsonb(x) AS j FROM "${t}" x WHERE ${where} ORDER BY ${orderBy(t)}`)).map((r) => r.j as Doc);
    }
    out.activity_log = (await q(`SELECT to_jsonb(x) AS j FROM activity_log x WHERE target_collection = 'articles' AND target_id = '${id}' ORDER BY created_at, event_type, id`)).map((r) => r.j as Doc);
    out.translation_jobs = (await q(`SELECT to_jsonb(x) AS j FROM translation_jobs x WHERE article_id = ${id} ORDER BY created_at, target_locale, id`)).map((r) => r.j as Doc);
    return out;
  };
  const family = (t: string, k: string): "A" | "V" | "R" | "ID" | null => {
    const dt = cols.get(t)?.get(k) ?? "";
    if ((t === "articles" && k === "id") || (t === "_articles_v" && k === "parent_id") || (t.startsWith("articles_") && (k === "_parent_id" || k === "parent_id")) || (t === "activity_log" && k === "target_id") || (t === "translation_jobs" && k === "article_id")) return "A";
    if ((t === "_articles_v" && k === "id") || (t.startsWith("_articles_v_") && (k === "_parent_id" || k === "parent_id"))) return "V";
    if ((t.startsWith("articles_") && k === "id" && dt === "character varying") || k === "_uuid") return "R";
    if (k === "id") return "ID";
    return null;
  };
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const r of runs) s = s.split(r).join("<RUN>");
      return s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  const normalise = (rows: N10Rows): N10Rows => {
    const maps: Record<"A" | "V" | "R", Map<string, string>> = { A: new Map(), V: new Map(), R: new Map() };
    const fam = (f: "A" | "V" | "R", v: unknown) => {
      if (v == null) return null;
      const key = String(v);
      if (!maps[f].has(key)) maps[f].set(key, `<${f}${maps[f].size}>`);
      return maps[f].get(key)!;
    };
    const out: N10Rows = {};
    for (const t of Object.keys(rows).sort()) {
      out[t] = rows[t]!.map((row) => {
        const n: Doc = {};
        for (const k of Object.keys(row).sort()) {
          const dt = cols.get(t)?.get(k) ?? "";
          const f = family(t, k);
          if (timeType(dt)) n[k] = row[k] == null ? "null" : "not-null";
          else if (f === "ID") n[k] = "<id>";
          else if (f) n[k] = fam(f, row[k]);
          else n[k] = scrub(row[k]);
        }
        return n;
      });
    }
    return out;
  };
  const counts = (label: string, rows: N10Rows, opts: { secondarySent?: number } = {}) => {
    const n = (t: string) => rows[t]?.length ?? -1;
    const created = (rows.activity_log ?? []).filter((r) => r.event_type === "article_created").length;
    const got: Doc = {
      articles: n("articles"), _articles_v: n("_articles_v"), articles_locales_ge1: n("articles_locales") >= 1, _articles_v_locales_ge1: n("_articles_v_locales") >= 1,
      articles_rels_ge1: n("articles_rels") >= 1, _articles_v_rels_ge1: n("_articles_v_rels") >= 1, activity_log_article_created: created,
    };
    const want: Doc = { articles: 1, _articles_v: 1, articles_locales_ge1: true, _articles_v_locales_ge1: true, articles_rels_ge1: true, _articles_v_rels_ge1: true, activity_log_article_created: 1 };
    if (opts.secondarySent !== undefined) {
      got.articles_secondary_sections = n("articles_secondary_sections");
      got._articles_v_version_secondary_sections_ge1 = n("_articles_v_version_secondary_sections") >= 1;
      want.articles_secondary_sections = opts.secondarySent;
      want._articles_v_version_secondary_sections_ge1 = true;
    }
    expect(`N10: ${label} row counts of the must-cover tables (> 0, per scenario)`, got, want);
  };
  const diffRows = (label: string, now: Doc[], base: Doc[]) => {
    const len = Math.max(now.length, base.length);
    for (let i = 0; i < len; i++) {
      const a = now[i];
      const b = base[i];
      if (a === undefined || b === undefined) {
        console.log(`DIFF  ${label} row ${i}: ${a === undefined ? "missing now" : "missing in baseline"}`);
        continue;
      }
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`DIFF  ${label} row ${i} key ${k}: baseline=${JSON.stringify(b[k])} now=${JSON.stringify(a[k])}`.slice(0, 600));
      }
    }
  };
  const same = (label: string, now: Doc[], base: Doc[]) => {
    const ok = JSON.stringify(now) === JSON.stringify(base);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  rows=${now.length} baselineRows=${base.length}`);
    if (!ok) {
      state.failures++;
      diffRows(label, now, base);
    }
  };

  // ── (i) dtw: pillar + author + tag + country, no secondary ──
  const r1 = newRun();
  const p1 = await post({
    tenant: "dtw", title: `N10 i ${r1}`, slug: `n10-i-${r1}`, pillarSlug: "p6-main", authorId: fx!.authors[0], tagSlugs: ["p6-tag-a"], countrySlugs: ["vietnam"],
    dek: "N10 dek một", bodyMarkdown: "N10 thân bài **đậm** một.", takeaways: ["Ý một"], readMin: 3, actor,
  });
  expect("N10: (i) full-field POST ⇒ 201", p1.status, 201);
  // ── (ii) dtw: + sub-section + one secondary row (with its sub-section) ──
  const r2 = newRun();
  const p2 = await post({
    tenant: "dtw", title: `N10 ii ${r2}`, slug: `n10-ii-${r2}`, pillarSlug: "p6-main", subSectionSlug: "p6-sub", secondary: [{ pillarSlug: "p6-other", subSectionSlug: "p6-sub" }],
    authorId: fx!.authors[0], coAuthorIds: [fx!.authors[1]], tagSlugs: ["p6-tag-a", "p6-tag-b"], countrySlugs: ["vietnam", "singapore"], dek: "N10 dek hai", bodyMarkdown: "N10 thân bài hai.", readMin: 4,
    flags: { aiAssisted: true }, actor,
  });
  expect("N10: (ii) full-field POST with secondary ⇒ 201", p2.status, 201);
  if (p1.status !== 201 || p2.status !== 201) {
    console.log(`[n10] POST failed: (i) ${JSON.stringify(p1.body)} (ii) ${JSON.stringify(p2.body)}`);
    console.log(`\n[n10] N10: ${state.failures} FAILED (POST did not create)`);
    process.exit(1);
  }
  const d1 = normalise(await dump(p1.body.id as number));
  const d2 = normalise(await dump(p2.body.id as number));
  counts("(i)", d1);
  counts("(ii)", d2, { secondarySent: 1 });

  // ── (iii) gcv Pressroom (single-home, blocked over HTTP): Local API "pseudo-route" create, no draft vs draft:true ──
  // Rebuilds the handler's `data` + `context` here: proves Payload draft:true ≡ no-draft for this shape, NOT the handler.
  const gcvId = s6.tenants.gcv!.id;
  const pressroom = await ensurePillar(payload, gcvId, "pressroom", "Pressroom", 98);
  const gTag = ((await payload.find({ collection: "tags", where: { and: [{ tenant: { equals: gcvId } }, { slug: { equals: "p6-tag-a" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined)?.id;
  const vn = ((await payload.find({ collection: "countries", where: { slug: { equals: "vietnam" } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc | undefined)?.id;
  const gDoc = (await payload.findByID({ collection: "tenants", id: gcvId, depth: 0, overrideAccess: true })) as unknown as Doc;
  const r3 = newRun();
  const r3b = newRun();
  const iiiData = (run: string): Doc => ({
    tenant: gcvId, _status: "draft", workflowStatus: "draft", origin: "manual", editedByHuman: true, contentType: "article", sourceLanguage: gDoc.defaultLanguage,
    lastEngine: s6.engines.author.id, title: `N10 iii ${run}`, slug: `n10-iii-${run}`, readMin: 2, pillar: pressroom, author: undefined,
    dek: "N10 dek ba", tags: gTag != null ? [gTag] : undefined, countries: vn != null ? [vn] : undefined, country: vn ?? null,
  });
  const iiiCtx = () => ({ hubAuthor: { actor, action: "create" }, engineId: s6.engines.author.id, disableRevalidate: true });
  let iiiNo: N10Rows | null = null;
  let iiiDr: N10Rows | null = null;
  const iiiErr: Doc = {};
  try {
    const a = (await payload.create({ collection: "articles", data: iiiData(r3) as never, depth: 0, overrideAccess: true, context: iiiCtx() })) as unknown as Doc;
    iiiNo = normalise(await dump(a.id as number));
  } catch (e) {
    iiiErr.nodraft = `${(e as Error).name}: ${(e as Error).message}`;
  }
  try {
    const b = (await payload.create({ collection: "articles", data: iiiData(r3b) as never, draft: true, depth: 0, overrideAccess: true, context: iiiCtx() })) as unknown as Doc;
    iiiDr = normalise(await dump(b.id as number));
  } catch (e) {
    iiiErr.draft = `${(e as Error).name}: ${(e as Error).message}`;
  }
  expect("N10: (iii) Pressroom Local-API pseudo-route creates (no draft / draft:true) both succeed", iiiErr, {});
  if (iiiNo && iiiDr) {
    counts("(iii) no-draft", iiiNo);
    counts("(iii) draft:true", iiiDr);
    for (const t of [...tables, "activity_log", "translation_jobs"]) same(`N10: (iii) ${t}: draft:true ≡ no-draft (same run)`, iiiDr[t] ?? [], iiiNo[t] ?? []);
  }

  const result: N10File = { schema: N10_SCHEMA, normalise: N10_NORMALISE, tables, scenarios: { i: d1, ii: d2, iii_nodraft: iiiNo ?? {}, iii_draft: iiiDr ?? {} } };
  if (baseline) {
    for (const k of ["i", "ii"] as const) {
      for (const t of [...tables, "activity_log", "translation_jobs"]) same(`N10: (${k}) ${t} ≡ baseline`, result.scenarios[k][t] ?? [], baseline.scenarios[k][t] ?? []);
    }
    console.log(`\n[n10] N10: ${state.failures === 0 ? "ALL CHECKS PASSED" : `${state.failures} CHECK(S) FAILED`} (compare)`);
    process.exit(state.failures === 0 ? 0 : 1);
  }
  if (state.failures !== 0) {
    console.log(`\n[n10] N10: ${state.failures} CHECK(S) FAILED — baseline NOT written`);
    process.exit(1);
  }
  writeFileSync(outFile!, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`\n[n10] N10: ALL CHECKS PASSED (out) — baseline written to ${outFile}`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// --pb7 — APCGHub P5.2 Stage 0 PROBE (content-engine plan
// process/features/apcg-hub/active/apcg-hub-p5-2-publish-schedule-unpublish_PLAN_30-09-26.md §5).
//
//   npx tsx scripts/hub-probe.ts --pb7 --in <setup6.json> [--only PB-1,PB-3,…]
//   npx tsx scripts/hub-probe.ts --pb7 --only GATE      (local guards only, then exit 0)
//
// Measures, BEFORE any P5.2 product code exists, what Payload / Postgres do for
// the P5.2 write shapes (plan K3) through a PROTOTYPE of the CMS-A lock helper
// (plan K6): one Payload transaction, SET LOCAL lock_timeout +
// idle_in_transaction_session_timeout, pg_advisory_xact_lock(int4,int4) on the
// transaction's own connection, a Local-API `req` carrying the transaction id.
// The prototype lives in this probe only; it is NOT product code.
//
// Output: `PB7 <id> <ĐẠT|ĐỎ|GHI|KXN|LỖI> <label>  <json>` (GHI = record only,
// KXN = could not be confirmed, LỖI = the probe itself failed). Exit 0 = ran;
// 1 = crash; 2 = usage / local guard.
//
// WRITES to the database, spawns short-lived local `node` children that hold
// Postgres locks, and listens on 127.0.0.1 — LOCAL ONLY: assertLocalTargets +
// assertLocalDb run FIRST, before any DB / HTTP call.
// ─────────────────────────────────────────────────────────────────────────────

type Id7 = string | number;
interface Exec7 {
  execute: (q: unknown) => Promise<unknown>;
}
interface Db7 {
  beginTransaction: () => Promise<Id7 | null>;
  commitTransaction: (id: Id7) => Promise<void>;
  rollbackTransaction: (id: Id7) => Promise<void>;
  sessions: Record<string, { db: Exec7 } | undefined>;
  drizzle: Exec7;
  pool?: { options?: { max?: number }; totalCount?: number; idleCount?: number; waitingCount?: number };
}
type Req7 = Doc & { transactionID?: unknown };
interface PgSide7 {
  on: (ev: "error", f: (e: unknown) => void) => void;
  connect: () => Promise<void>;
  query: (q: string, p?: unknown[]) => Promise<{ rows: Doc[] }>;
  end: () => Promise<void>;
}
interface Ctx7 {
  req: Req7;
  tx: Exec7;
  txId: Id7;
  pid: number;
  lockSlug: (tenantId: Id7, slug: string) => Promise<void>;
}
type FnRes7 = { ok: boolean; value: unknown };
interface Lock7Out {
  kind: "ok" | "fail" | "busy" | "thrown" | "lost";
  value?: unknown;
  code?: string;
  err?: Doc;
  commitThrew?: Doc;
  killThrew?: Doc;
  pid?: number;
  acquiredMs?: number;
  ms: number;
  enteredAt?: number;
  endedAt?: number;
  txIdAfterFn?: boolean;
  sessionAfterFn?: boolean;
}

const PB7_NS_ARTICLE = "apcghub.p52.article";
const PB7_NS_SLUG = "apcghub.p52.slug";
const PB7_BUSY = new Set(["55P03", "40P01", "40001"]);
const PB7_ACTOR = { email: "pb7@example.invalid", role: "editor", id: "hub-user-7" };

/** FNV-1a 32-bit over the UTF-8 bytes, as a signed int32 (`|0`) — plan K6. */
function fnv1a32x7(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
/** Same rule as hub-author-handlers `errCode`: `err.code`, then ONE level of `cause`. */
function pgCode7(err: unknown): string | undefined {
  const o = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; cause?: unknown };
  if (typeof o.code === "string") return o.code;
  const c = (typeof o.cause === "object" && o.cause !== null ? o.cause : {}) as { code?: unknown };
  return typeof c.code === "string" ? c.code : undefined;
}
/** Error shape for the report: name, code, short message, nested `cause` (max 3 levels). Never a token. */
function errShape7(err: unknown, depth = 0): Doc {
  const e = (typeof err === "object" && err !== null ? err : { message: String(err) }) as Doc;
  const out: Doc = {
    name: typeof e.name === "string" ? e.name : typeof err,
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? (e.message as string).slice(0, 220) : undefined,
  };
  const paths = ((e.data as { errors?: { path?: string }[] } | undefined)?.errors ?? []).map((x) => x.path);
  if (paths.length) out.paths = paths;
  if (depth < 3 && e.cause !== undefined) out.cause = errShape7(e.cause, depth + 1);
  return out;
}
const sleep7 = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The CMS-A helper PROTOTYPE (plan K6), probe-only. */
async function protoLock7(
  payload: P,
  args: { tenantId: Id7; articleId?: number },
  fn: (c: Ctx7) => Promise<FnRes7>,
  opt: { outsideTx?: boolean; lockTimeout?: string; idleTimeout?: string } = {},
): Promise<Lock7Out> {
  const D = payload.db as unknown as Db7;
  const { createLocalReq } = await import("payload");
  const t0 = performance.now();
  const out: Lock7Out = { kind: "fail", ms: 0 };
  let txId: Id7 | null = null;
  const kill = async () => {
    if (txId == null) return;
    try {
      await D.rollbackTransaction(txId);
    } catch (e) {
      out.killThrew = errShape7(e);
    }
  };
  try {
    txId = await D.beginTransaction();
    if (txId == null) throw new Error("beginTransaction returned no id");
    const tx = D.sessions[String(txId)]?.db;
    if (!tx) throw new Error("no session for the new transaction");
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${opt.lockTimeout ?? "3s"}'`));
    await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '${opt.idleTimeout ?? "30s"}'`));
    out.pid = Number(((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as { rows?: { pid: number }[] }).rows?.[0]?.pid);
    const lockOn: Exec7 = opt.outsideTx ? D.drizzle : tx;
    if (args.articleId != null) {
      await lockOn.execute(sql`SELECT pg_advisory_xact_lock(${fnv1a32x7(`${PB7_NS_ARTICLE}\u0000${args.tenantId}`)}::int4, ${args.articleId}::int4)`);
    }
    out.acquiredMs = Math.round(performance.now() - t0);
    const req = (await createLocalReq({ context: {} } as never, payload)) as unknown as Req7;
    req.transactionID = txId;
    let slugTaken = false;
    const ctx: Ctx7 = {
      req,
      tx,
      txId,
      pid: out.pid ?? -1,
      lockSlug: async (tenantId, slug) => {
        if (slugTaken) throw new Error("lockSlug called twice");
        slugTaken = true;
        await lockOn.execute(sql`SELECT pg_advisory_xact_lock(${fnv1a32x7(PB7_NS_SLUG)}::int4, ${fnv1a32x7(`${tenantId}\u0000${slug}`)}::int4)`);
      },
    };
    out.enteredAt = Date.now();
    const r = await fn(ctx);
    out.value = r.value;
    out.txIdAfterFn = Boolean(req.transactionID);
    out.sessionAfterFn = Boolean(D.sessions[String(txId)]);
    if (!r.ok) {
      await kill();
      out.kind = "fail";
    } else if (!out.txIdAfterFn || !out.sessionAfterFn) {
      await kill();
      out.kind = "lost"; // the product helper would throw HubLockTransactionLost ⇒ 500
    } else {
      try {
        await D.commitTransaction(txId);
        out.kind = "ok";
      } catch (e) {
        out.commitThrew = errShape7(e);
        out.kind = "thrown";
      }
    }
  } catch (e) {
    out.code = pgCode7(e);
    out.err = errShape7(e);
    await kill();
    out.kind = out.code && PB7_BUSY.has(out.code) ? "busy" : "thrown";
  }
  out.endedAt = Date.now();
  out.ms = Math.round(performance.now() - t0);
  return out;
}

async function pb7() {
  assertLocalTargets();
  try { assertLocalDb(process.env.DATABASE_URL); } catch (e) { refuseLocalDb6(e); }
  const only = (arg("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (only.includes("GATE")) {
    console.log("[pb7] local guards passed (GATE only, no DB / HTTP call made)");
    process.exit(0);
  }
  const inFile = arg("in");
  if (!inFile) {
    console.error("usage: tsx scripts/hub-probe.ts --pb7 --in <file from --setup6> [--only PB-1,PB-3,…] | --pb7 --only GATE");
    process.exit(2);
  }
  const want = (id: string) => only.length === 0 || only.includes(id);
  const s6 = JSON.parse(readFileSync(inFile, "utf8")) as Setup6;
  const tok = (k: A6Key) => readFileSync(s6.engines[k].tokenFile, "utf8").trim();
  const T = { author: tok("author"), writeonly: tok("writeonly"), noauthor: tok("noauthor") };
  const pubTokDtw = readFileSync(s6.publicReadTokenFile.dtw!, "utf8").trim();
  const payload = await getPayload({ config });
  const { mapWriteError } = await import("../src/lib/hub-author-handlers");
  const db = rawDb(payload);
  const D = payload.db as unknown as Db7;
  const tid = { dtw: s6.tenants.dtw!.id, gcv: s6.tenants.gcv!.id, "world-travel-brief": s6.tenants["world-travel-brief"]!.id } as const;
  type T7 = keyof typeof tid;
  const authorEngine = s6.engines.author.id;
  const writeEngine = s6.engines.writeonly.id;
  const run = runId6();
  let seq = 0;

  const uncaught: Doc[] = [];
  process.on("uncaughtException", (e) => {
    uncaught.push(errShape7(e));
    console.log(`PB7 UNCAUGHT uncaughtException  ${JSON.stringify(errShape7(e))}`);
  });
  process.on("unhandledRejection", (e) => {
    uncaught.push(errShape7(e));
    console.log(`PB7 UNCAUGHT unhandledRejection  ${JSON.stringify(errShape7(e))}`);
  });

  const results: { id: string; verdict: string; label: string }[] = [];
  const rec = (id: string, verdict: string, label: string, v: unknown) => {
    console.log(`PB7 ${id} ${verdict} ${label}  ${JSON.stringify(v)}`);
    results.push({ id, verdict, label });
  };
  const section = async (id: string, f: () => Promise<void>) => {
    if (!want(id)) return;
    console.log(`\n══ ${id} ══`);
    try {
      await f();
    } catch (e) {
      rec(id, "LỖI", "probe section threw", errShape7(e));
    }
  };

  type Reply = { status: number; text: string; body: Doc; ms: number; headers: Record<string, string> };
  const call = async (method: string, path: string, body?: unknown, token: string | null = T.author): Promise<Reply> => {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Doc = {};
    try {
      parsed = JSON.parse(text) as Doc;
    } catch {
      /* non-JSON */
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, text, body: parsed, ms: Math.round(performance.now() - t0), headers };
  };
  const rows7 = async (q: unknown): Promise<Doc[]> => ((await db.execute(q)) as { rows?: Doc[] }).rows ?? [];
  const nowIso = () => new Date().toISOString();
  const fx = (t: T7) => s6.fixtures[t]!;
  const mkDraft = async (t: T7, extra: Doc = {}) => {
    const slug = `pb7-${run}-${seq++}`;
    const body: Doc = { tenant: t, title: `PB7 ${slug}`, slug, pillarSlug: "p6-main", authorId: fx(t).authors[0], bodyMarkdown: "Đoạn thân bài thử P5.2.", actor: PB7_ACTOR, ...extra };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const r = await call("POST", "/api/hub/articles", body);
    if (r.status !== 201) throw new Error(`mkDraft ${t} ⇒ ${r.status} ${r.text.slice(0, 300)}`);
    return { id: r.body.id as number, slug: (r.body.slug as string) ?? slug, version: r.body.version as number, tenant: t };
  };
  const patchDraft = (t: T7, id: number, expectedVersion: number, fields: Doc) =>
    call("PATCH", `/api/hub/articles/${id}`, { tenant: t, actor: PB7_ACTOR, expectedVersion, ...fields });
  const latest7 = async (id: number) => (await payload.findByID({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc;
  const main7 = async (id: number) => (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc;
  const mainRaw = async (id: number) =>
    (await rows7(sql`SELECT _status::text AS s, workflow_status::text AS w, version::int AS v, published_at AS "publishedAt", scheduled_for AS "scheduledFor", xmin::text AS xmin FROM articles WHERE id = ${id}`))[0] ?? null;
  const verRows = async (id: number) => rows7(sql`SELECT id, latest, xmin::text AS xmin, version__status::text AS s, version_workflow_status::text AS w FROM _articles_v WHERE parent_id = ${id} ORDER BY id`);
  const maxLogId = async () => Number((await rows7(sql`SELECT coalesce(max(id), 0)::int AS m FROM activity_log`))[0]?.m ?? 0);
  const logsFor = async (id: number, since: number) =>
    rows7(sql`SELECT event_type::text AS e, from_status AS f, to_status AS t, detail FROM activity_log WHERE target_id = ${String(id)} AND id > ${since} ORDER BY id`);
  const advisory = async () => rows7(sql`SELECT pid, granted FROM pg_locks WHERE locktype = 'advisory' ORDER BY pid`);
  const tjobs = async (id: number) => Number((await rows7(sql`SELECT count(*)::int AS n FROM translation_jobs WHERE article_id = ${id}`))[0]?.n ?? 0);
  const tstatus = async (id: number) => rows7(sql`SELECT locale::text AS l, state::text AS s FROM articles_translation_status WHERE _parent_id = ${id} ORDER BY locale`);
  const ctxW = (reason: string, extra: Doc = {}): Doc => ({ hubWrite: { actor: PB7_ACTOR, reason }, engineId: writeEngine, ...extra });
  const opPublish = (req: Req7, id: number, at: string) =>
    payload.update({ collection: "articles", id, req: req as never, depth: 0, overrideAccess: true, data: { _status: "published", workflowStatus: "published", publishedAt: at } as never, context: ctxW("hub composer publish") });
  const opSchedule = (req: Req7, id: number, at: string) =>
    payload.update({ collection: "articles", id, req: req as never, draft: true, depth: 0, overrideAccess: true, data: { workflowStatus: "scheduled", scheduledFor: at, publishedAt: at, _status: "draft" } as never, context: ctxW("hub composer schedule", { disableRevalidate: true }) });
  const opUnschedule = (req: Req7, id: number, at: string) =>
    payload.update({ collection: "articles", id, req: req as never, draft: true, depth: 0, overrideAccess: true, data: { workflowStatus: "draft", scheduledFor: null, publishedAt: at, _status: "draft" } as never, context: ctxW("hub composer unschedule", { disableRevalidate: true }) });
  const viaLock = (t: T7, id: number, op: (req: Req7) => Promise<unknown>) =>
    protoLock7(payload, { tenantId: tid[t], articleId: id }, async (c) => ({ ok: true, value: await op(c.req) }));
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const brief = (o: Lock7Out) => ({ kind: o.kind, code: o.code, err: o.err, ms: o.ms, acquiredMs: o.acquiredMs, killThrew: o.killThrew, commitThrew: o.commitThrew });
  const snap = async (id: number) => {
    const l = await latest7(id);
    return {
      version: l.version,
      lastEngine: l.lastEngine ?? null,
      editedByHuman: l.editedByHuman ?? null,
      lastEditedBy: l.lastEditedBy ?? null,
      workflowStatus: l.workflowStatus,
      translationStatus: ((l.translationStatus as Doc[] | undefined) ?? []).map((r) => `${r.locale}:${r.state}`).length,
      pending: ((l.translationStatus as Doc[] | undefined) ?? []).filter((r) => r.state === "pending").length,
    };
  };
  const cron = async () => {
    const r = await call("GET", "/api/cron/publish-scheduled", undefined, null);
    return { status: r.status, ms: r.ms, published: (r.body.published as Doc[] | undefined)?.map((p) => p.id) ?? null, failed: r.body.failed ?? null };
  };
  const pubGet = async (slug: string) => call("GET", `/api/public/articles/${encodeURIComponent(slug)}`, undefined, pubTokDtw);

  console.log(`[pb7] run=${run} base=${BASE} tenants=${JSON.stringify(tid)} pool.max=${D.pool?.options?.max ?? "?"} (pg Pool default when the adapter sets none)`);

  // ══ PB-3 (FIRST): the prototype itself ═════════════════════════════════════
  await section("PB-3", async () => {
    const g = await mkDraft("gcv");
    // (a) `req` carries the transaction + the advisory lock lives on the transaction's backend.
    const vBefore = (await verRows(g.id)).length;
    let seenInside = -1;
    let lockSeen: Doc[] = [];
    const a = await protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, async (c) => {
      await payload.update({ collection: "articles", id: g.id, req: c.req as never, draft: true, depth: 0, overrideAccess: true, data: { title: `PB7 3a ${run}`, workflowStatus: "draft", _status: "draft" } as never, context: ctxW("pb7 3a", { disableRevalidate: true }) });
      seenInside = (await verRows(g.id)).length;
      lockSeen = (await advisory()).filter((r) => Number(r.pid) === c.pid);
      return { ok: true, value: null };
    });
    const vAfter = (await verRows(g.id)).length;
    const okA = a.kind === "ok" && seenInside === vBefore && vAfter === vBefore + 1 && lockSeen.length === 1 && lockSeen[0]?.granted === true && (await advisory()).length === 0;
    rec("PB-3", okA ? "ĐẠT" : "ĐỎ", "(a) req carries the tx: a version row written through req is invisible to another connection until commit; advisory lock granted on the tx backend; released after commit", { lock: brief(a), versionsBefore: vBefore, seenFromOtherConnInsideFn: seenInside, versionsAfterCommit: vAfter, lockOnTxPid: lockSeen, advisoryAfter: (await advisory()).length });

    // (b) serialization, A commits / A kills.
    for (const endA of ["commit", "kill"] as const) {
      const marks: Doc = {};
      const pA = protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, async () => {
        marks.aIn = Date.now();
        await sleep7(1500);
        return { ok: endA === "commit", value: null };
      });
      await sleep7(250);
      const pB = protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, async () => {
        marks.bIn = Date.now();
        return { ok: false, value: null };
      });
      await sleep7(500);
      const during = await advisory();
      const [ra, rb] = await Promise.all([pA, pB]);
      const after = await advisory();
      const waited = Number(marks.bIn) >= Number(ra.endedAt) - 20;
      const ok = waited && during.length === 2 && during.filter((r) => r.granted === true).length === 1 && after.length === 0 && ra.kind === (endA === "commit" ? "ok" : "fail") && rb.kind === "fail";
      rec("PB-3", ok ? "ĐẠT" : "ĐỎ", `(b) two concurrent tx on the same article key: B waits until A ${endA}s`, { A: brief(ra), B: brief(rb), bEnteredAfterAEndedMs: Number(marks.bIn) - Number(ra.endedAt), pgLocksDuring: during, pgLocksAfter: after.length, deadlockCodes: [ra.code, rb.code].filter((c) => c === "40P01") });
    }

    // (c) NEGATIVE: the same lock taken OUTSIDE the transaction (autocommit) must NOT serialize.
    {
      const marks: Doc = {};
      const pA = protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, async () => {
        marks.aIn = Date.now();
        await sleep7(1500);
        marks.aOut = Date.now();
        return { ok: false, value: null };
      }, { outsideTx: true });
      await sleep7(250);
      const pB = protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, async () => {
        marks.bIn = Date.now();
        return { ok: false, value: null };
      }, { outsideTx: true });
      const [ra, rb] = await Promise.all([pA, pB]);
      const overlap = Number(marks.bIn) < Number(marks.aOut);
      rec("PB-3", overlap ? "ĐẠT" : "ĐỎ", "(c) NEGATIVE control: lock outside the tx ⇒ B enters while A still holds ⇒ the probe SEES the race (expected red of the negative case)", { overlapDetected: overlap, bEnteredBeforeAEndedMs: Number(marks.aOut) - Number(marks.bIn), A: brief(ra), B: brief(rb) });
    }
  });

  // ══ PB-3v: a plain JS throw after a real write in the helper ═══════════════
  await section("PB-3v", async () => {
    const st = async (id: number) => ({ main: await mainRaw(id), versions: (await verRows(id)).length, tjobs: await tjobs(id), tstatus: (await tstatus(id)).length, latestVersion: (await latest7(id)).version });
    for (const t of ["world-travel-brief", "gcv"] as const) {
      const d = await mkDraft(t);
      const before = await st(d.id);
      const log0 = await maxLogId();
      let inner: Doc = {};
      const r = await protoLock7(payload, { tenantId: tid[t], articleId: d.id }, async (c) => {
        await opPublish(c.req, d.id, nowIso());
        inner = { tjobsInsideTx: Number((((await c.tx.execute(sql`SELECT count(*)::int AS n FROM translation_jobs WHERE article_id = ${d.id}`)) as { rows?: Doc[] }).rows?.[0]?.n) ?? 0), txIdAfterWrite: Boolean(c.req.transactionID) };
        throw new Error("probe");
      });
      const after = await st(d.id);
      const orphanLogs = await logsFor(d.id, log0);
      const same = JSON.stringify({ ...before, main: { ...before.main, xmin: null } }) === JSON.stringify({ ...after, main: { ...after.main, xmin: null } });
      rec("PB-3v", same && (await advisory()).length === 0 ? "ĐẠT" : "ĐỎ", `(${t}) real publish through req, then throw ⇒ kill ⇒ DB unchanged`, { lock: brief(r), inner, before, after, orphanActivityRows: orphanLogs.map((l) => `${l.e}:${l.f ?? ""}->${l.t ?? ""}`), advisoryAfter: (await advisory()).length });
    }
    // Variant: the translation hook itself throws (tenant with translations ON), injected in-process.
    {
      const d = await mkDraft("world-travel-brief");
      const before = await st(d.id);
      const log0 = await maxLogId();
      const realCreate = payload.create.bind(payload);
      (payload as unknown as { create: unknown }).create = async (a: { collection: string }) => {
        if (a.collection === "translationJobs") throw new Error("pb7 injected translation hook failure");
        return realCreate(a as never);
      };
      let r: Lock7Out;
      let inner: Doc = {};
      try {
        r = await protoLock7(payload, { tenantId: tid["world-travel-brief"], articleId: d.id }, async (c) => {
          try {
            await opPublish(c.req, d.id, nowIso());
          } catch (e) {
            inner = { thrown: errShape7(e), txIdAfter: Boolean(c.req.transactionID), sessionAfter: Boolean(D.sessions[String(c.txId)]) };
            throw e;
          }
          return { ok: true, value: null };
        });
      } finally {
        (payload as unknown as { create: unknown }).create = realCreate;
      }
      const after = await st(d.id);
      const same = JSON.stringify({ ...before, main: { ...before.main, xmin: null } }) === JSON.stringify({ ...after, main: { ...after.main, xmin: null } });
      rec("PB-3v", same && (await advisory()).length === 0 ? "ĐẠT" : "ĐỎ", "(variant) translation hook throws after the row write (injected) ⇒ DB unchanged", { lock: brief(r), inner, before, after, orphanActivityRows: (await logsFor(d.id, log0)).map((l) => `${l.e}:${l.f ?? ""}->${l.t ?? ""}`) });
    }
  });

  // ══ PB-3vi: nested Payload error inside the helper's transaction ═══════════
  await section("PB-3vi", async () => {
    for (const ending of ["ok:false (422)", "ok:true after the nested error"] as const) {
      const r0 = await call("POST", "/api/hub/articles", { tenant: "gcv", title: `PB7 3vi ${run} ${seq}`, slug: `pb7-${run}-${seq++}`, actor: PB7_ACTOR });
      if (r0.status !== 201) throw new Error(`title-only draft ⇒ ${r0.status} ${r0.text.slice(0, 200)}`);
      const id = r0.body.id as number;
      const before = { main: await mainRaw(id), versions: (await verRows(id)).length };
      let inner: Doc = {};
      const r = await protoLock7(payload, { tenantId: tid.gcv, articleId: id }, async (c) => {
        try {
          await opPublish(c.req, id, nowIso());
          inner = { nested: "NO ERROR (unexpected)" };
        } catch (e) {
          const locks = (await advisory()).filter((x) => Number(x.pid) === c.pid);
          inner = { nested: errShape7(e), mapped: mapWriteError(e), txIdAfterNested: Boolean(c.req.transactionID), sessionAfterNested: Boolean(D.sessions[String(c.txId)]), advisoryStillHeldByTxPid: locks.length };
        }
        return ending === "ok:false (422)" ? { ok: false, value: 422 } : { ok: true, value: 200 };
      });
      const after = { main: await mainRaw(id), versions: (await verRows(id)).length };
      const unchanged = JSON.stringify({ ...before, main: { ...before.main, xmin: null } }) === JSON.stringify({ ...after, main: { ...after.main, xmin: null } });
      const noThrow = !r.killThrew && !r.commitThrew;
      const txKept = inner.txIdAfterNested === true && inner.sessionAfterNested === true;
      const verdict = !noThrow || !unchanged ? "ĐỎ" : ending === "ok:true after the nested error" && r.kind === "ok" && !txKept ? "ĐỎ" : txKept ? "ĐẠT" : "GHI";
      rec("PB-3vi", verdict, `nested ValidationError (non-draft publish without pillar/author), fn ⇒ ${ending}`, { lock: brief(r), txIdAfterFn: r.txIdAfterFn, sessionAfterFn: r.sessionAfterFn, inner, unchanged, before, after, advisoryAfter: (await advisory()).length });
    }
  });

  // ══ PB-1: base of a non-draft update on a hub draft ════════════════════════
  await section("PB-1", async () => {
    const f = fx("gcv");
    const d = await mkDraft("gcv", { dek: "Dek một", takeaways: ["Ý một"], readMin: 3, tagSlugs: ["p6-tag-a"], countrySlugs: ["vietnam"] });
    const p = await patchDraft("gcv", d.id, d.version, {
      title: `PB7 1 retitled ${run}`, bodyMarkdown: "Thân bài MỚI sau PATCH.\n\nĐoạn hai.", dek: "Dek hai", takeaways: ["Ý hai", "Ý ba"], readMin: 4,
      pillarSlug: "p6-other", subSectionSlug: "p6-sub", authorId: f.authors[1], coAuthorIds: [f.authors[0]],
      secondary: [{ pillarSlug: "p6-main", subSectionSlug: "p6-sub2" }], tagSlugs: ["p6-tag-a", "p6-tag-b"], countrySlugs: ["vietnam", "singapore"], flags: { aiAssisted: true },
    });
    if (p.status !== 200) throw new Error(`PATCH ⇒ ${p.status} ${p.text.slice(0, 300)}`);
    const KEYS = ["title", "slug", "dek", "takeaways", "readMin", "pillar", "subSection", "author", "coAuthors", "tags", "countries", "country", "aiAssisted", "body"];
    const pick = (doc: Doc) => {
      const o: Doc = {};
      for (const k of KEYS) o[k] = doc[k] ?? null;
      o.secondary = ((doc.secondarySections as Doc[] | undefined) ?? []).map((r) => [r.pillar, r.subSection ?? null]);
      return sortKeys6(o) as Doc;
    };
    const lat = pick(await latest7(d.id));
    const mainBefore = pick(await main7(d.id));
    const differBefore = KEYS.concat("secondary").filter((k) => JSON.stringify(lat[k]) !== JSON.stringify(mainBefore[k]));
    const r = await viaLock("gcv", d.id, (req) => opPublish(req, d.id, nowIso()));
    const mainAfter = pick(await main7(d.id));
    const diffAfter = KEYS.concat("secondary").filter((k) => JSON.stringify(lat[k]) !== JSON.stringify(mainAfter[k]));
    const childRows = {
      secondaryMain: (await rows7(sql`SELECT count(*)::int AS n FROM articles_secondary_sections WHERE _parent_id = ${d.id}`))[0]?.n,
      relsMain: (await rows7(sql`SELECT path, count(*)::int AS n FROM articles_rels WHERE parent_id = ${d.id} GROUP BY path ORDER BY path`)).map((x) => `${x.path}:${x.n}`),
    };
    const ok = r.kind === "ok" && differBefore.length > 0 && diffAfter.length === 0 && (await mainRaw(d.id))?.s === "published";
    rec("PB-1", ok ? "ĐẠT" : "ĐỎ", "non-draft publish (3 fields) through req takes its base from the LATEST version, child rows included", { lock: brief(r), fieldsThatDifferedBefore: differBefore, fieldsDifferingAfter: diffAfter, main: await mainRaw(d.id), childRows });
  });

  // ══ PB-4 (+PB-11b): activity rows per operation (tenant gcv, translations OFF) ══
  await section("PB-4", async () => {
    const a = await mkDraft("gcv");
    let l0 = await maxLogId();
    const rp = await viaLock("gcv", a.id, (req) => opPublish(req, a.id, nowIso()));
    const lp = await logsFor(a.id, l0);
    rec("PB-4", rp.kind === "ok" && lp.length === 1 && lp[0]?.e === "article_published" && (lp[0]?.detail as Doc | undefined)?.via === "hub" ? "ĐẠT" : "ĐỎ", "publish ⇒ exactly ONE article_published row with detail.via/actor/reason", { lock: brief(rp), rows: lp });

    const b = await mkDraft("gcv");
    l0 = await maxLogId();
    const at = inMinutes(30);
    const rs = await viaLock("gcv", b.id, (req) => opSchedule(req, b.id, at));
    const ls = await logsFor(b.id, l0);
    rec("PB-4", rs.kind === "ok" && ls.length === 1 && ls[0]?.e === "status_changed" && ls[0]?.f === "draft" && ls[0]?.t === "scheduled" ? "ĐẠT" : "ĐỎ", "schedule (draft:true) ⇒ exactly ONE status_changed draft→scheduled (previousDoc = latest)", { lock: brief(rs), rows: ls });
    l0 = await maxLogId();
    const tU = Date.now();
    const unAt = nowIso();
    const ru = await viaLock("gcv", b.id, (req) => opUnschedule(req, b.id, unAt));
    const lu = await logsFor(b.id, l0);
    rec("PB-4", ru.kind === "ok" && lu.length === 1 && lu[0]?.e === "status_changed" && lu[0]?.f === "scheduled" && lu[0]?.t === "draft" ? "ĐẠT" : "ĐỎ", "unschedule (draft:true) ⇒ exactly ONE status_changed scheduled→draft", { lock: brief(ru), rows: lu });
    const lb = await latest7(b.id);
    const pubDelta = Math.abs(Date.parse(String(lb.publishedAt)) - tU);
    rec("PB-11", lb.scheduledFor == null && pubDelta <= 5000 ? "ĐẠT" : "ĐỎ", "after unschedule: scheduledFor null and publishedAt = unschedule time ±5 s (not the old scheduledFor)", { scheduledFor: lb.scheduledFor ?? null, publishedAt: lb.publishedAt, oldScheduledFor: at, deltaMs: pubDelta });

    const c = await mkDraft("gcv");
    l0 = await maxLogId();
    const rk = await protoLock7(payload, { tenantId: tid.gcv, articleId: c.id }, async (x) => {
      await opSchedule(x.req, c.id, inMinutes(40));
      return { ok: false, value: null };
    });
    rec("PB-4", "GHI", "forced rollback: schedule written through req, then kill ⇒ orphan activity rows (logActivity runs on its own connection)", { lock: brief(rk), orphanRows: (await logsFor(c.id, l0)).map((l) => `${l.e}:${l.f}->${l.t}`), latestStatusAfterKill: (await latest7(c.id)).workflowStatus });
  });

  // ══ PB-5 + PB-8: hubWrite context on both tenant kinds; translation fan-out ══
  await section("PB-5", async () => {
    for (const t of ["gcv", "world-travel-brief"] as const) {
      const d = await mkDraft(t);
      const s0 = await snap(d.id);
      const rs = await viaLock(t, d.id, (req) => opSchedule(req, d.id, inMinutes(30)));
      const s1 = await snap(d.id);
      const ru = await viaLock(t, d.id, (req) => opUnschedule(req, d.id, nowIso()));
      const s2 = await snap(d.id);
      const l0 = await maxLogId();
      const j0 = await tjobs(d.id);
      const rp = await viaLock(t, d.id, (req) => opPublish(req, d.id, nowIso()));
      const s3 = await snap(d.id);
      const logs = await logsFor(d.id, l0);
      const tq = logs.filter((l) => l.e === "translation_queued").length;
      const stable = (a: Doc, b: Doc) => a.version === b.version && JSON.stringify(a.lastEngine) === JSON.stringify(b.lastEngine) && a.editedByHuman === b.editedByHuman && JSON.stringify(a.lastEditedBy) === JSON.stringify(b.lastEditedBy);
      const trOk = t === "gcv" ? s3.translationStatus === s0.translationStatus : s3.pending > 0;
      const ok5 = [rs, ru, rp].every((r) => r.kind === "ok") && stable(s0, s1) && stable(s1, s2) && stable(s2, s3) && s1.translationStatus === s0.translationStatus && s2.translationStatus === s0.translationStatus && trOk;
      rec("PB-5", ok5 ? "ĐẠT" : "ĐỎ", `(${t}) version / lastEngine / editedByHuman / lastEditedBy stable over schedule → unschedule → publish`, { s0, s1, s2, s3, kinds: [rs.kind, ru.kind, rp.kind] });
      const jobs = (await tjobs(d.id)) - j0;
      const expectN = t === "gcv" ? 0 : 19;
      const ok8 = rp.kind === "ok" && jobs === expectN && tq === expectN && logs.filter((l) => l.e === "article_published").length === 1 && s3.version === s2.version && (t === "gcv" ? s3.pending === 0 : s3.pending === expectN);
      rec("PB-8", ok8 ? "ĐẠT" : "ĐỎ", `(${t}) publish: translationJobs = targets, rows = 1 article_published + N translation_queued, version unchanged`, { newJobs: jobs, translationQueuedRows: tq, articlePublishedRows: logs.filter((l) => l.e === "article_published").length, otherRows: logs.filter((l) => l.e !== "translation_queued" && l.e !== "article_published").map((l) => l.e), pending: s3.pending, versionBefore: s2.version, versionAfter: s3.version, lockMs: rp.ms });
    }
    // PB-8 third tenant: dtw (translations on, seed: 3 languages ⇒ 2 targets).
    const d = await mkDraft("dtw");
    const v0 = (await latest7(d.id)).version;
    const l0 = await maxLogId();
    const rp = await viaLock("dtw", d.id, (req) => opPublish(req, d.id, nowIso()));
    const logs = await logsFor(d.id, l0);
    const jobs = await tjobs(d.id);
    rec("PB-8", rp.kind === "ok" && jobs === 2 && logs.filter((l) => l.e === "translation_queued").length === 2 && (await latest7(d.id)).version === v0 ? "ĐẠT" : "ĐỎ", "(dtw) publish: 2 targets ⇒ 2 jobs + 2 translation_queued, version unchanged", { lock: brief(rp), jobs, rows: logs.map((l) => l.e), versionBefore: v0, versionAfter: (await latest7(d.id)).version });
  });

  // ══ PB-6 (part before K10) + PB-2 + PB-11a: schedule does not expose; the existing cron ══
  await section("PB-2", async () => {
    const d = await mkDraft("dtw");
    const p = await patchDraft("dtw", d.id, d.version, { title: `PB7 2 retitled ${run}`, bodyMarkdown: "Thân bài sau PATCH cho PB-2." });
    if (p.status !== 200) throw new Error(`PATCH ⇒ ${p.status}`);
    const at = new Date(Math.ceil((Date.now() + 10 * 60_000) / 1000) * 1000 + 250).toISOString();
    const rs = await viaLock("dtw", d.id, (req) => opSchedule(req, d.id, at));
    const lat = await latest7(d.id);
    rec("PB-11", rs.kind === "ok" && lat.scheduledFor === at && lat.publishedAt === at ? "ĐẠT" : "ĐỎ", "(a) scheduledFor / publishedAt read back equal to the input UTC instant (ms precision)", { input: at, scheduledFor: lat.scheduledFor, publishedAt: lat.publishedAt });
    // PB-6 (before K10)
    const pub = await pubGet(d.slug);
    const list = await call("GET", "/api/public/articles?limit=100", undefined, pubTokDtw);
    const inList = JSON.stringify(list.body).includes(d.slug);
    const mr = await mainRaw(d.id);
    const ve = await call("GET", `/api/hub/articles/${d.id}?tenant=dtw&view=edit`);
    const ed = (ve.body.edit ?? {}) as Doc;
    rec("PB-6", pub.status === 404 && !inList && mr?.s === "draft" && mr?.w === "draft" && ve.status === 200 && ed.editable === false && ed.editableReason === "status" && !("scheduledFor" in ed) ? "ĐẠT" : "ĐỎ", "(before K10) scheduled article: public 404 + not listed; main row draft/draft; view=edit editable:false reason status, no scheduledFor", { publicStatus: pub.status, inPublicList: inList, main: mr && { s: mr.s, w: mr.w }, viewEdit: { status: ve.status, editable: ed.editable, editableReason: ed.editableReason, keys: Object.keys(ed).sort() } });
    // Move the schedule into the past (Local API, hubWrite, no lock needed), then run the cron.
    const past = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000 + 125).toISOString();
    await payload.update({ collection: "articles", id: d.id, draft: true, depth: 0, overrideAccess: true, data: { scheduledFor: past, publishedAt: past, workflowStatus: "scheduled", _status: "draft" } as never, context: ctxW("pb7 move schedule into the past", { disableRevalidate: true }) });
    const latBefore = await latest7(d.id);
    const l0 = await maxLogId();
    const err0 = Number((await rows7(sql`SELECT count(*)::int AS n FROM activity_log WHERE event_type = 'integration_error' AND target_id = ${String(d.id)}`))[0]?.n);
    const c = await cron();
    const m = await main7(d.id);
    const err1 = Number((await rows7(sql`SELECT count(*)::int AS n FROM activity_log WHERE event_type = 'integration_error' AND target_id = ${String(d.id)}`))[0]?.n);
    const pub2 = await pubGet(d.slug);
    const pubArt = ((pub2.body.doc ?? {}) as Doc);
    const contentSame = m.title === latBefore.title && JSON.stringify(m.body) === JSON.stringify(latBefore.body) && JSON.stringify(m.pillar) === JSON.stringify(latBefore.pillar);
    const ok = c.status === 200 && (c.published ?? []).map(String).includes(String(d.id)) && m.workflowStatus === "published" && m._status === "published" && m.publishedAt === past && contentSame && err1 === err0 && pub2.status === 200;
    rec("PB-2", ok ? "ĐẠT" : "ĐỎ", "existing cron publishes the hub-scheduled draft: published, publishedAt = scheduledFor, content = latest, 0 integration_error, public 200", { cron: c, main: { w: m.workflowStatus, s: m._status, publishedAt: m.publishedAt, title: m.title }, expectedPublishedAt: past, contentSame, integrationErrors: err1 - err0, publicStatus: pub2.status, publicPublishedAt: pubArt.publishedAt ?? null, activityRows: (await logsFor(d.id, l0)).map((l) => `${l.e}:${l.f ?? ""}->${l.t ?? ""}:${JSON.stringify((l.detail as Doc | null)?.via ?? null)}`) });
    rec("PB-11", pubArt.publishedAt === past ? "ĐẠT" : "ĐỎ", "(b) public API publishedAt = scheduledFor after the cron", { publicPublishedAt: pubArt.publishedAt ?? null, scheduledFor: past });
  });

  // ══ PB-18: CMS-admin fallback for a scheduled hub article ══════════════════
  await section("PB-18", async () => {
    const d = await mkDraft("dtw");
    const rs = await viaLock("dtw", d.id, (req) => opSchedule(req, d.id, inMinutes(30)));
    const users = (await payload.find({ collection: "users", where: { email: { equals: process.env.SEED_ADMIN_EMAIL ?? "" } }, limit: 1, depth: 0, overrideAccess: true })).docs as unknown as Doc[];
    const user = users[0];
    if (!user) {
      rec("PB-18", "KXN", "no seed system-admin user found ⇒ the CMS-admin step of S6 stays MANDATORY", { scheduled: rs.kind });
      return;
    }
    const at = nowIso();
    let res: Doc;
    try {
      await payload.update({ collection: "articles", id: d.id, draft: true, depth: 0, overrideAccess: true, user: user as never, data: { workflowStatus: "draft", scheduledFor: null, publishedAt: at } as never });
      res = { ok: true };
    } catch (e) {
      res = { ok: false, err: errShape7(e) };
    }
    // Move nothing into the past: the article is no longer scheduled. Run the cron anyway.
    const lat = await latest7(d.id);
    const c = await cron();
    const m = await mainRaw(d.id);
    const ok = res.ok === true && lat.workflowStatus === "draft" && lat.scheduledFor == null && lat.publishedAt === at && !(c.published ?? []).map(String).includes(String(d.id)) && m?.w === "draft";
    rec("PB-18", ok ? "ĐẠT" : "ĐỎ", "Local API Save Draft as the seed system admin (workflowStatus draft, scheduledFor null, publishedAt reset) on a hub-scheduled article; cron does not publish it", { scheduled: rs.kind, update: res, latest: { w: lat.workflowStatus, scheduledFor: lat.scheduledFor ?? null, publishedAt: lat.publishedAt, version: lat.version, editedByHuman: lat.editedByHuman }, cron: c, main: m && { s: m.s, w: m.w } });
  });

  // ══ PB-10: slug lock ═══════════════════════════════════════════════════════
  await section("PB-10", async () => {
    const f = fx("gcv");
    const slugOfLatest = async (id: number) => (await latest7(id)).slug;
    // (i) the plan's case: two existing drafts carrying the same slug, published concurrently.
    for (const withLock of [true, false]) {
      const a = await mkDraft("gcv");
      const b = await mkDraft("gcv");
      await db.execute(sql`UPDATE articles_locales SET slug = ${a.slug} WHERE _parent_id = ${b.id}`);
      await db.execute(sql`UPDATE _articles_v_locales SET version_slug = ${a.slug} WHERE _parent_id IN (SELECT id FROM _articles_v WHERE parent_id = ${b.id})`);
      const pubOne = (id: number) =>
        protoLock7(payload, { tenantId: tid.gcv, articleId: id }, async (c) => {
          if (withLock) await c.lockSlug(tid.gcv, a.slug);
          const conflict = await findSlugConflict7(payload, tid.gcv, a.slug, id);
          if (conflict) return { ok: false, value: { status: 409, existing: conflict } };
          await sleep7(400);
          await opPublish(c.req, id, nowIso());
          return { ok: true, value: 200 };
        });
      const [ra, rb] = await Promise.all([pubOne(a.id), pubOne(b.id)]);
      const wins = [ra, rb].filter((r) => r.kind === "ok").length;
      rec("PB-10", wins >= 2 && withLock ? "ĐỎ" : "GHI", `(i) two drafts that ALREADY share a slug, publish concurrently, slug lock ${withLock ? "ON" : "OFF (negative)"}`, { winners: wins, A: { kind: ra.kind, value: ra.value }, B: { kind: rb.kind, value: rb.value }, note: "findSlugConflict also reads LATEST drafts, so each draft already sees the other one" });
    }
    // (ii) two concurrent creates of the SAME new slug, through the prototype.
    for (const withLock of [true, false]) {
      const s = `pb7-${run}-dup-${seq++}`;
      const createOne = (n: number) =>
        protoLock7(payload, { tenantId: tid.gcv }, async (c) => {
          if (withLock) await c.lockSlug(tid.gcv, s);
          const conflict = await findSlugConflict7(payload, tid.gcv, s);
          if (conflict) return { ok: false, value: { status: 409, existing: conflict } };
          await sleep7(400);
          try {
            const created = (await payload.create({
              collection: "articles", req: c.req as never, draft: true, depth: 0, overrideAccess: true,
              data: { tenant: tid.gcv, title: `PB7 dup ${n}`, slug: s, pillar: undefined, author: f.authors[0], origin: "manual", workflowStatus: "draft", _status: "draft", editedByHuman: true, contentType: "article", lastEngine: authorEngine, readMin: 1 } as never,
              context: { hubAuthor: { actor: PB7_ACTOR, action: "create" }, engineId: authorEngine, disableRevalidate: true },
            })) as unknown as Doc;
            return { ok: true, value: created.id };
          } catch (e) {
            return { ok: false, value: { mapped: mapWriteError(e), err: errShape7(e) } };
          }
        });
      const [r1, r2] = await Promise.all([createOne(1), createOne(2)]);
      const n = Number((await rows7(sql`SELECT count(*)::int AS n FROM articles a JOIN articles_locales l ON l._parent_id = a.id WHERE a.tenant_id = ${tid.gcv} AND l.slug = ${s}`))[0]?.n);
      const wins = [r1, r2].filter((r) => r.kind === "ok").length;
      rec("PB-10", withLock ? (wins === 1 && n === 1 ? "ĐẠT" : "ĐỎ") : wins === 2 && n === 2 ? "ĐẠT" : "ĐỎ", `(ii) two concurrent creates of one NEW slug, slug lock ${withLock ? "ON ⇒ exactly one winner" : "OFF ⇒ NEGATIVE control must show two winners"}`, { winners: wins, rowsWithSlug: n, r1: { kind: r1.kind, value: r1.value }, r2: { kind: r2.kind, value: r2.value } });
    }
    // (iii) two drafts change their slug to the SAME new value concurrently (PATCH shape, draft:true).
    for (const withLock of [true, false]) {
      const a = await mkDraft("gcv");
      const b = await mkDraft("gcv");
      const s = `pb7-${run}-to-${seq++}`;
      const reslug = (id: number) =>
        protoLock7(payload, { tenantId: tid.gcv, articleId: id }, async (c) => {
          if (withLock) await c.lockSlug(tid.gcv, s);
          const conflict = await findSlugConflict7(payload, tid.gcv, s, id);
          if (conflict) return { ok: false, value: { status: 409, existing: conflict } };
          await sleep7(400);
          await payload.update({ collection: "articles", id, req: c.req as never, draft: true, depth: 0, overrideAccess: true, data: { slug: s, workflowStatus: "draft", _status: "draft" } as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "update", fields: ["slug"] }, engineId: authorEngine, disableRevalidate: true } });
          return { ok: true, value: 200 };
        });
      const [ra, rb] = await Promise.all([reslug(a.id), reslug(b.id)]);
      const holders = [await slugOfLatest(a.id), await slugOfLatest(b.id)].filter((x) => x === s).length;
      const wins = [ra, rb].filter((r) => r.kind === "ok").length;
      rec("PB-10", withLock ? (wins === 1 && holders === 1 ? "ĐẠT" : "ĐỎ") : wins === 2 && holders === 2 ? "ĐẠT" : "ĐỎ", `(iii) two drafts re-slug to one value concurrently, slug lock ${withLock ? "ON ⇒ exactly one winner" : "OFF ⇒ NEGATIVE control must show two winners"}`, { winners: wins, latestDraftsHoldingSlug: holders, A: { kind: ra.kind, value: ra.value }, B: { kind: rb.kind, value: rb.value } });
    }
  });

  // ══ PB-12: tenant / id isolation on the CMS-3 write auth model (/status) ═══
  await section("PB-12", async () => {
    const name = "apcghub-cms7-writenoread";
    const token = randomBytes(24).toString("hex");
    const data = { rawToken: token, status: "active", hubRead: false, hubAuthor: false, hubWrite: true, allowedTenants: [tid.dtw, tid.gcv, tid["world-travel-brief"]] };
    let eid = await engineIdByName(payload, name);
    if (eid != null) await payload.update({ collection: "content-engines", id: eid, overrideAccess: true, data: data as never });
    else eid = ((await payload.create({ collection: "content-engines", overrideAccess: true, data: { name, engineType: "other", allowedActions: ["import"], ...data } as never })) as unknown as { id: number }).id;
    writeFileSync(`${inFile}.pb7-writenoread.token`, token, { mode: 0o600 });
    const g = await mkDraft("gcv");
    const body = (tenant: string) => ({ tenant, to: "archived", expectedStatus: "published", reason: "pb7 probe twelve", actor: PB7_ACTOR });
    const cases: [string, Reply][] = [
      ["id of another tenant (gcv id, tenant dtw)", await call("POST", `/api/hub/articles/${g.id}/status`, body("dtw"), T.writeonly)],
      ["id > int4 (2147483648)", await call("POST", "/api/hub/articles/2147483648/status", body("dtw"), T.writeonly)],
      ["tenant outside the key (wad)", await call("POST", `/api/hub/articles/${g.id}/status`, body("wad"), T.writeonly)],
      ["hubRead key without hubWrite (noauthor engine)", await call("POST", `/api/hub/articles/${g.id}/status`, body("gcv"), T.noauthor)],
      ["hubWrite key without hubRead (pb7 engine)", await call("POST", `/api/hub/articles/${g.id}/status`, body("gcv"), token)],
      ["author key (hubAuthor) without hubWrite", await call("POST", `/api/hub/articles/${g.id}/status`, body("gcv"), T.author)],
    ];
    const want12 = [404, 404, 403, 403, 403, 403];
    const got = cases.map(([, r]) => r.status);
    rec("PB-12", JSON.stringify(got) === JSON.stringify(want12) ? "ĐẠT" : "ĐỎ", "CMS-3 /status model: 404/404/403/403/403/403, bodies recorded", Object.fromEntries(cases.map(([k, r]) => [k, { status: r.status, body: r.body }])));
  });

  // ══ PB-13: raw HTML in the body after publish ══════════════════════════════
  await section("PB-13", async () => {
    const d = await mkDraft("dtw", { bodyMarkdown: "Dòng có <b>thử</b> và a < b.\n\nMột [liên kết lành tính](https://example.com/)." });
    const r = await viaLock("dtw", d.id, (req) => opPublish(req, d.id, nowIso()));
    const pub = await pubGet(d.slug);
    const art = ((pub.body.doc ?? {}) as Doc);
    const nodes: Doc[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      const o = n as Doc;
      if (typeof o.type === "string") nodes.push({ type: o.type, ...(typeof o.text === "string" ? { text: o.text } : {}), ...(o.fields ? { url: (o.fields as Doc).url ?? null } : {}) });
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(art.body);
    rec("PB-13", "GHI", "public JSON of a published body with `<b>thử</b>` text and one https link", { lock: r.kind, publicStatus: pub.status, bodyType: typeof art.body, nodes: nodes.slice(0, 20), bodyKeys: art.body && typeof art.body === "object" ? Object.keys(art.body as Doc) : null });
  });

  // ══ PB-14: lock_timeout, killed / abandoned holders, row locks inside the block ══
  await section("PB-14", async () => {
    const { spawn } = await import("node:child_process");
    const child = (mode: "advisory" | "row" | "verrow", k1: number, k2: number, extra: { id?: number; idle?: string; sleepStmt?: number } = {}) => {
      const src = `
        const { Client } = require("pg");
        (async () => {
          const c = new Client({ connectionString: process.env.DATABASE_URL });
          c.on("error", (e) => process.stdout.write("CHILD-ERR " + (e && e.code) + "\\n"));
          await c.connect();
          await c.query("BEGIN");
          await c.query("SET LOCAL idle_in_transaction_session_timeout = '${extra.idle ?? "0"}'");
          if (${JSON.stringify(mode)} === "advisory") await c.query("SELECT pg_advisory_xact_lock($1::int4, $2::int4)", [${k1}, ${k2}]);
          if (${JSON.stringify(mode)} === "row") await c.query("SELECT id FROM articles WHERE id = $1 FOR UPDATE", [${extra.id ?? 0}]);
          if (${JSON.stringify(mode)} === "verrow") await c.query("SELECT id FROM _articles_v WHERE id = $1 FOR UPDATE", [${extra.id ?? 0}]);
          const pid = (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p;
          process.stdout.write("HELD " + pid + "\\n");
          ${extra.sleepStmt ? `await c.query("SELECT pg_sleep(${extra.sleepStmt})").catch((e) => process.stdout.write("SLEEP-ERR " + e.code + "\\n"));` : ""}
          setInterval(() => {}, 1000);
        })().catch((e) => { process.stdout.write("CHILD-FAIL " + (e && e.code) + " " + (e && e.message) + "\\n"); process.exit(3); });
      `;
      const cp = spawn(process.execPath, ["-e", src], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let outBuf = "";
      cp.stdout.on("data", (b: Buffer) => (outBuf += b.toString()));
      const held = new Promise<number>((res, rej) => {
        const t = setInterval(() => {
          const m = /HELD (\d+)/.exec(outBuf);
          if (m) {
            clearInterval(t);
            res(Number(m[1]));
          } else if (/CHILD-FAIL/.test(outBuf)) {
            clearInterval(t);
            rej(new Error(outBuf.trim()));
          }
        }, 25);
      });
      return { cp, held, out: () => outBuf };
    };
    const kA = (t: Id7) => fnv1a32x7(`${PB7_NS_ARTICLE}\u0000${t}`);
    const noop = async (): Promise<FnRes7> => ({ ok: false, value: null });

    // (i)+(iii) live holder of the advisory key ⇒ lock_timeout (3 s) fires ⇒ busy, no hang.
    const g = await mkDraft("gcv");
    const h1 = child("advisory", kA(tid.gcv), g.id);
    await h1.held;
    const r1 = await protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, noop);
    rec("PB-14", r1.kind === "busy" && r1.ms >= 2800 && r1.ms <= 6000 ? "ĐẠT" : "ĐỎ", "(i)+(iii) advisory key held by another session ⇒ lock_timeout applies to the advisory wait ⇒ 55P03 ⇒ busy after ~3 s", { lock: brief(r1), errShape: r1.err });
    // (ii-a) holder process SIGKILLed while idle in transaction ⇒ next caller acquires at once.
    h1.cp.kill("SIGKILL");
    await sleep7(300);
    const r2 = await protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, noop);
    rec("PB-14", r2.kind === "fail" && (r2.acquiredMs ?? 99999) < 2000 ? "ĐẠT" : "ĐỎ", "(ii-a) holder process killed (idle in transaction) ⇒ lock released, next caller acquires quickly", { lock: brief(r2) });
    // (ii-b) holder alive but abandoned (idle in transaction, 30 s idle timeout) ⇒ busy inside the window, then OK.
    const h2 = child("advisory", kA(tid.gcv), g.id, { idle: "30s" });
    const t2 = Date.now();
    await h2.held;
    const tries: Doc[] = [];
    let firstOkAfter: number | null = null;
    while (Date.now() - t2 < 60_000) {
      const r = await protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, noop);
      tries.push({ atMs: Date.now() - t2, kind: r.kind, code: r.code });
      if (r.kind === "fail") {
        firstOkAfter = Date.now() - t2;
        break;
      }
      await sleep7(2000);
    }
    h2.cp.kill("SIGKILL");
    rec("PB-14", firstOkAfter != null && firstOkAfter <= 40_000 && tries.slice(0, -1).every((x) => x.kind === "busy") ? "ĐẠT" : "ĐỎ", "(ii-b) abandoned holder (alive, idle in tx) ⇒ busy inside the ~30 s window, released by idle_in_transaction_session_timeout", { firstAcquiredAfterMs: firstOkAfter, tries: tries.length, kinds: [...new Set(tries.map((x) => `${x.kind}:${x.code ?? ""}`))], childSaw: h2.out().trim().split("\n").slice(-2) });
    // (ii-c) holder killed WHILE a statement runs ⇒ backend keeps running until the statement ends.
    const h3 = child("advisory", kA(tid.gcv), g.id, { sleepStmt: 20 });
    const t3 = Date.now();
    await h3.held;
    await sleep7(500);
    h3.cp.kill("SIGKILL");
    let freedAfter: number | null = null;
    const kinds3: string[] = [];
    while (Date.now() - t3 < 45_000) {
      const r = await protoLock7(payload, { tenantId: tid.gcv, articleId: g.id }, noop);
      kinds3.push(r.kind);
      if (r.kind === "fail") {
        freedAfter = Date.now() - t3;
        break;
      }
      await sleep7(1000);
    }
    rec("PB-14", freedAfter != null ? "GHI" : "ĐỎ", "(ii-c) holder killed while running a statement (pg_sleep 20 s) ⇒ how long the lock outlives the client", { freedAfterMs: freedAfter, attempts: kinds3.length, kinds: [...new Set(kinds3)] });

    // (iv-0) which rows each write kind touches.
    const touch: Doc = {};
    const touchOf = async (label: string, id: number, op: () => Promise<Lock7Out>) => {
      const m0 = await mainRaw(id);
      const v0 = await verRows(id);
      const r = await op();
      const m1 = await mainRaw(id);
      const v1 = await verRows(id);
      const oldLatest = v0.find((v) => v.latest === true);
      const oldLatestAfter = v1.find((v) => v.id === oldLatest?.id);
      touch[label] = { ok: r.kind, articlesRowTouched: m0?.xmin !== m1?.xmin, versionRowsAdded: v1.length - v0.length, oldLatestRowTouched: oldLatest ? oldLatest.xmin !== oldLatestAfter?.xmin : null, oldLatestId: oldLatest?.id ?? null };
    };
    const w = await mkDraft("gcv");
    await touchOf("PATCH draft:true (hubAuthor context)", w.id, () =>
      protoLock7(payload, { tenantId: tid.gcv, articleId: w.id }, async (c) => {
        await payload.update({ collection: "articles", id: w.id, req: c.req as never, draft: true, depth: 0, overrideAccess: true, data: { title: `PB7 iv0 ${run}`, workflowStatus: "draft", _status: "draft" } as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "update", fields: ["title"] }, engineId: authorEngine, disableRevalidate: true } });
        return { ok: true, value: null };
      }));
    await touchOf("schedule (draft:true)", w.id, () => viaLock("gcv", w.id, (req) => opSchedule(req, w.id, inMinutes(30))));
    await touchOf("unschedule (draft:true)", w.id, () => viaLock("gcv", w.id, (req) => opUnschedule(req, w.id, nowIso())));
    await touchOf("publish (non-draft)", w.id, () => viaLock("gcv", w.id, (req) => opPublish(req, w.id, nowIso())));
    rec("PB-14", "GHI", "(iv-0) write kind → rows touched (articles row xmin, new version rows, previous latest version row xmin)", touch);

    // (iv) hold a ROW lock on what each kind touches, then run that kind through the prototype ⇒ 55P03 inside the block ⇒ busy.
    const ivRes: Doc = {};
    const kinds: [string, (id: number) => (req: Req7) => Promise<unknown>][] = [
      ["PATCH draft:true", (id) => (req) => payload.update({ collection: "articles", id, req: req as never, draft: true, depth: 0, overrideAccess: true, data: { title: `PB7 iv ${run}`, workflowStatus: "draft", _status: "draft" } as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "update", fields: ["title"] }, engineId: authorEngine, disableRevalidate: true } })],
      ["schedule", (id) => (req) => opSchedule(req, id, inMinutes(30))],
      ["publish", (id) => (req) => opPublish(req, id, nowIso())],
    ];
    for (const [label, mk] of kinds) {
      for (const target of ["articles row", "previous latest version row"] as const) {
        const x = await mkDraft("gcv");
        if (label === "publish" && target === "previous latest version row") {
          /* covered below the same way */
        }
        const v = (await verRows(x.id)).find((r) => r.latest === true);
        const h = child(target === "articles row" ? "row" : "verrow", 0, 0, { id: target === "articles row" ? x.id : Number(v?.id ?? 0) });
        await h.held;
        const r = await viaLock("gcv", x.id, mk(x.id));
        h.cp.kill("SIGKILL");
        await sleep7(200);
        ivRes[`${label} | ${target}`] = { kind: r.kind, code: r.code, ms: r.ms, errShape: r.err };
      }
    }
    const iv0 = touch as Record<string, Doc>;
    const expectBusy = (label: string, target: string) => {
      const key = label === "PATCH draft:true" ? "PATCH draft:true (hubAuthor context)" : label === "schedule" ? "schedule (draft:true)" : "publish (non-draft)";
      const t = iv0[key] ?? {};
      return target === "articles row" ? t.articlesRowTouched === true : t.oldLatestRowTouched === true;
    };
    const bad = Object.entries(ivRes).filter(([k, v]) => {
      const [label, target] = k.split(" | ") as [string, string];
      return expectBusy(label, target) ? (v as Doc).kind !== "busy" : false;
    });
    rec("PB-14", bad.length === 0 ? "ĐẠT" : "ĐỎ", "(iv) row lock held on a touched row ⇒ 55P03 inside the block ⇒ busy (not 500); rows NOT touched per iv-0 are 'không áp dụng'", { results: ivRes, applicable: Object.keys(ivRes).filter((k) => expectBusy(...(k.split(" | ") as [string, string]))) });
    rec("PB-14", uncaught.length === 0 ? "ĐẠT" : "ĐỎ", "probe process alive, no uncaught error / unhandled rejection through PB-14", { uncaught });
  });

  // ══ PB-9: revalidate webhook per operation × tenant kind × webhook speed ══
  await section("PB-9", async () => {
    const http = await import("node:http");
    let hits = 0;
    let hang = false;
    const srv = http.createServer((rq, rs) => {
      if (rq.method === "POST" && (rq.url ?? "").startsWith("/api/revalidate")) hits++;
      rq.resume();
      const done = () => {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end("{}");
      };
      if (hang) setTimeout(done, 7000);
      else done();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const setFront = (t: T7, url: string | null) => payload.update({ collection: "tenants", id: tid[t], overrideAccess: true, context: { disableRevalidate: true }, data: { frontendUrl: url } as never });
    if (!process.env.CENTRAL_SIGNING_SECRET) rec("PB-9", "KXN", "CENTRAL_SIGNING_SECRET not set in the probe env ⇒ webhook skipped ⇒ '0 POST' would be meaningless", {});
    try {
      for (const t of ["gcv", "world-travel-brief"] as const) await setFront(t, `http://127.0.0.1:${port}`);
      for (const mode of ["fast", "hang"] as const) {
        hang = mode === "hang";
        for (const t of ["gcv", "world-travel-brief"] as const) {
          const x = await mkDraft(t);
          const y = await mkDraft(t);
          const m: Doc = {};
          hits = 0;
          const rs = await viaLock(t, x.id, (req) => opSchedule(req, x.id, inMinutes(30)));
          m.schedule = { posts: hits, ms: rs.ms, kind: rs.kind };
          hits = 0;
          const ru = await viaLock(t, x.id, (req) => opUnschedule(req, x.id, nowIso()));
          m.unschedule = { posts: hits, ms: ru.ms, kind: ru.kind };
          hits = 0;
          const rp = await viaLock(t, y.id, (req) => opPublish(req, y.id, nowIso()));
          await sleep7(hang ? 300 : 100);
          m.publish = { posts: hits, ms: rp.ms, kind: rp.kind, lockHeldMs: rp.ms - (rp.acquiredMs ?? 0) };
          m.advisoryAfter = (await advisory()).length;
          const sOk = (m.schedule as Doc).posts === 0 && (m.unschedule as Doc).posts === 0;
          const pPosts = (m.publish as Doc).posts as number;
          const pOk = t === "gcv" ? pPosts === 1 : pPosts >= 1 && pPosts <= 2;
          const kOk = [rs, ru, rp].every((r) => r.kind === "ok");
          const tooSlow = t === "world-travel-brief" && rp.ms >= 15_000;
          const verdict = !sOk || tooSlow || !kOk ? "ĐỎ" : pOk ? "ĐẠT" : "ĐỎ";
          rec("PB-9", verdict, `(${t}, webhook ${mode}) POSTs per op: schedule 0, unschedule 0, publish ${t === "gcv" ? "1" : "1–2"}; publish total time; lock released`, m);
          if (t === "world-travel-brief" && rp.ms > 10_000 && rp.ms < 15_000) rec("PB-9", "GHI", `(${t}, webhook ${mode}) publish took > 10 s — báo orchestrator`, { ms: rp.ms });
        }
      }
    } finally {
      for (const t of ["gcv", "world-travel-brief"] as const) await setFront(t, null);
      srv.close();
    }
  });

  // ══ PB-15: locale of the PATCH-style read vs view=edit ═════════════════════
  await section("PB-15", async () => {
    const out: Doc = {};
    for (const t of ["dtw", "world-travel-brief", "gcv"] as const) {
      const d = await mkDraft(t);
      const a = await latest7(d.id); // PATCH's read: draft:true, no locale
      const ve = await call("GET", `/api/hub/articles/${d.id}?tenant=${t}&view=edit`);
      const art = (ve.body.article ?? {}) as Doc;
      out[t] = { patchRead: [a.title, a.slug], viewEdit: [art.title, art.slug], same: a.title === art.title && a.slug === art.slug };
    }
    const ba = (await tenantsBySlug(payload)).get("brief-asia");
    if (ba != null) {
      const c = (await payload.create({ collection: "articles", draft: true, depth: 0, overrideAccess: true, data: { tenant: ba, title: `PB7 15 ba ${run}`, slug: `pb7-${run}-ba`, origin: "manual", workflowStatus: "draft", _status: "draft", lastEngine: authorEngine, readMin: 1 } as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "create" }, engineId: authorEngine, disableRevalidate: true } })) as unknown as Doc;
      const a = await latest7(c.id as number);
      const e = (await payload.findByID({ collection: "articles", id: c.id as number, draft: true, depth: 0, locale: "en", overrideAccess: true })) as unknown as Doc;
      out["brief-asia"] = { patchRead: [a.title, a.slug], localeEn: [e.title, e.slug], same: a.title === e.title && a.slug === e.slug, note: "brief-asia is not in the author key grant ⇒ Local API locale:'en' read, not HTTP view=edit" };
    }
    const langs = await rows7(sql`SELECT slug, default_language::text AS d FROM tenants ORDER BY id`);
    const allSame = Object.values(out).every((v) => (v as Doc).same === true);
    rec("PB-15", allSame ? "ĐẠT" : "GHI", "title/slug: PATCH-style read (no locale) vs view=edit (locale en), per seed tenant", { out, tenantDefaultLanguage: langs, payloadDefaultLocale: (payload.config as unknown as { localization?: { defaultLocale?: string } }).localization?.defaultLocale ?? null });
  });

  // ══ PB-16: isHubAuthoredDoc on an infrastructure error ═════════════════════
  await section("PB-16", async () => {
    const { isHubAuthoredDoc } = await import("../src/lib/hub-author-auth");
    const fake = { findByID: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }); } };
    const r = await isHubAuthoredDoc(fake as never, { lastEngine: authorEngine });
    const real = await isHubAuthoredDoc(payload as never, { lastEngine: authorEngine });
    rec("PB-16", "GHI", "isHubAuthoredDoc when the content-engines lookup throws (infra error) ⇒ value returned (route would map false ⇒ 422 not_editable not_hub_authored)", { onInfraError: r, controlRealLookup: real });
  });

  // ══ PB-19: updatedAt across schedule / unschedule / PATCH; view=edit exposure ══
  await section("PB-19", async () => {
    const d = await mkDraft("gcv");
    const u = async () => (await latest7(d.id)).updatedAt;
    const v0 = await u();
    await sleep7(20);
    await viaLock("gcv", d.id, (req) => opSchedule(req, d.id, inMinutes(30)));
    const v1 = await u();
    await sleep7(20);
    await viaLock("gcv", d.id, (req) => opUnschedule(req, d.id, nowIso()));
    const v2 = await u();
    await sleep7(20);
    const ver = (await latest7(d.id)).version as number;
    const p = await patchDraft("gcv", d.id, ver, { title: `PB7 19 ${run}` });
    const v3 = await u();
    const ve = await call("GET", `/api/hub/articles/${d.id}?tenant=gcv&view=edit`);
    rec("PB-19", "GHI", "updatedAt v0 (create) → v1 (schedule) → v2 (unschedule) → v3 (PATCH); view=edit exposure", { v0, v1, v2, v3, changedOnSchedule: v0 !== v1, changedOnUnschedule: v1 !== v2, changedOnPatch: v2 !== v3, patchStatus: p.status, viewEditArticleUpdatedAt: (ve.body.article as Doc | undefined)?.updatedAt ?? "(absent)", viewEditEditHasUpdatedAt: "updatedAt" in ((ve.body.edit ?? {}) as Doc) });
  });

  // ══ PB-7a: validators the cron's non-draft update runs, vs K4 (a…l) / K13 ══
  await section("PB-7a", async () => {
    // Step 1 (a): the MANUAL list — Articles.ts read 07-10-26 (grep required|validate:|min|max|maxRows|minRows|minLength|maxLength|hooks).
    const manual = [
      { item: "title required (Articles.ts:135)", k4: "a" },
      { item: "slug required (:139) + uniqueWithinTenant field hook (:142)", k4: "g" },
      { item: "readMin required, min 1 (:171)", k4: "h" },
      { item: "briefs maxRows 4 (:187); briefs[].label/value/source required (:190-192)", k4: "l" },
      { item: "workflowStatus required select (:201-206)", k4: "(system — route always writes it)" },
      { item: "publishedAt required date (:210-213)", k4: "(system — cron/route always write it)" },
      { item: "pillar required (:245)", k4: "c" },
      { item: "subSection validate: belongs to pillar (:261-279)", k4: "d" },
      { item: "secondarySections[].pillar required + secondaryRowPillarValidate (:300,:304)", k4: "i" },
      { item: "secondarySections[].subSection validate: belongs to the row pillar (:318-336)", k4: "i" },
      { item: "author articleAuthorValidate (:352; single-home-pillar.ts:152-176)", k4: "e" },
      { item: "sponsor required when sponsored (:374-375)", k4: "f" },
      { item: "contentType required select (:420-424)", k4: "(not in K4)" },
      { item: "origin required select (:432-436)", k4: "(gate: origin !== manual ⇒ not_editable)" },
      { item: "version required number (:450)", k4: "(system)" },
      { item: "translationStatus[].locale/state required selects (:475-476)", k4: "(system)" },
      { item: "heroImage validate: required when video (:500-505)", k4: "j" },
      { item: "videoDescription validate: required when video (:548-553)", k4: "j" },
      { item: "beforeChange singleHomePillar (Articles.ts:124; single-home-pillar.ts:60-93)", k4: "K13 (single-home pillars ⊂ ENGINE_BLOCKED_PILLARS)" },
      { item: "beforeValidate syncNativePublish / syncNativeUnpublish / enforceStatusAuthority (:121) — req.user only; cron has none", k4: "(not reached by cron)" },
      { item: "select options (tone, sourceLanguage, contentType, origin, workflowStatus) + relationship / upload existence (Payload defaults)", k4: "(see step 2 rows sys-*)" },
      { item: "body richText (Lexical default validator)", k4: "corpus (step 3)" },
    ];
    // Step 1 (b): automatic list from the sanitized config — for cross-check only.
    const flat: Doc[] = [];
    const walkF = (fields: unknown[], prefix: string) => {
      for (const f of fields as Doc[]) {
        const name = typeof f.name === "string" ? `${prefix}${f.name}` : prefix;
        const flags = ["required", "min", "max", "maxRows", "minRows", "minLength", "maxLength"].filter((k) => f[k] !== undefined && f[k] !== false).map((k) => `${k}=${String(f[k])}`);
        if (typeof f.name === "string" && (flags.length || typeof f.validate === "function" || ["select", "radio", "relationship", "upload", "richText"].includes(String(f.type)))) flat.push({ field: name, type: f.type, flags, validate: typeof f.validate === "function" });
        if (Array.isArray(f.fields)) walkF(f.fields as unknown[], typeof f.name === "string" ? `${name}.` : prefix);
        if (Array.isArray(f.tabs)) for (const tab of f.tabs as Doc[]) walkF((tab.fields as unknown[]) ?? [], typeof tab.name === "string" ? `${prefix}${tab.name}.` : prefix);
      }
    };
    walkF((payload.collections as unknown as Record<string, { config: { fields: unknown[] } }>).articles!.config.fields, "");
    rec("PB-7a", "GHI", "step 1: manual validator list (authoritative) — K4 mapping", manual);
    rec("PB-7a", "GHI", `step 1: automatic list from payload.collections.articles.config (${flat.length} fields; 'validate' is a function on every field after sanitize ⇒ custom vs default NOT distinguishable this way)`, flat);

    // Step 2: one draft per defect (Local API draft:true, hub-shaped), then the CRON's exact update.
    const f = fx("gcv");
    const gcv = tid.gcv;
    const pMain = (await payload.find({ collection: "pillars", where: { and: [{ tenant: { equals: gcv } }, { slug: { equals: "p6-main" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc;
    const pOther = (await payload.find({ collection: "pillars", where: { and: [{ tenant: { equals: gcv } }, { slug: { equals: "p6-other" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc;
    const subOther = (await payload.find({ collection: "subsections", where: { and: [{ tenant: { equals: gcv } }, { pillar: { equals: pOther.id } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc;
    const exclusive = await ensurePillar(payload, gcv, "exclusive", "Exclusive", 99);
    const press = await ensurePillar(payload, gcv, "pressroom", "Pressroom", 98);
    const wtbId = tid["world-travel-brief"];
    const wtbMain = (await payload.find({ collection: "pillars", where: { and: [{ tenant: { equals: wtbId } }, { slug: { equals: "p6-main" } }] }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as unknown as Doc;
    let videoId: number | null = null;
    let videoNote: Doc = {};
    try {
      const vm = (await payload.create({ collection: "videoMedia", overrideAccess: true, data: { tenant: gcv, alt: "pb7" } as never, file: { data: Buffer.from("0000001866747970", "hex"), mimetype: "video/mp4", name: `pb7-${run}.mp4`, size: 8 } as never })) as unknown as Doc;
      videoId = vm.id as number;
      videoNote = { via: "Local API create", id: videoId };
    } catch (e) {
      videoNote = { localApi: errShape7(e) };
      // Fallback allowed by the plan (PB-7b note): a raw row in video_media of the disposable DB.
      try {
        videoId = Number((await rows7(sql`INSERT INTO video_media (tenant_id, filename, mime_type, filesize, url) VALUES (${gcv}, ${`pb7-${run}.mp4`}, 'video/mp4', 8, ${`/pb7-${run}.mp4`}) RETURNING id`))[0]?.id);
        videoNote = { ...videoNote, via: "raw INSERT into video_media", id: videoId };
      } catch (e2) {
        videoNote = { ...videoNote, rawInsert: errShape7(e2) };
      }
    }
    const base = (tenant: number, pillar: unknown, author: unknown, extra: Doc = {}): Doc => ({
      tenant, title: `PB7 7a ${run} ${seq}`, slug: `pb7-${run}-7a-${seq++}`, origin: "manual", workflowStatus: "draft", _status: "draft", editedByHuman: true,
      contentType: "article", lastEngine: authorEngine, readMin: 2, pillar, author, ...extra,
    });
    const otherMainSlug = (await rows7(sql`SELECT l.slug FROM articles a JOIN articles_locales l ON l._parent_id = a.id WHERE a.tenant_id = ${gcv} AND l.slug IS NOT NULL ORDER BY a.id LIMIT 1`))[0]?.slug as string;
    const cases: { k: string; k4: string; data: Doc; post?: (id: number) => Promise<void> }[] = [
      { k: "a title ''", k4: "a", data: base(gcv, pMain.id, f.authors[0], { title: "" }) },
      { k: "b body absent", k4: "b (route-only)", data: base(gcv, pMain.id, f.authors[0]) },
      { k: "c pillar null", k4: "c", data: base(gcv, null, f.authors[0]) },
      { k: "d1 subSection of another pillar", k4: "d", data: base(gcv, pMain.id, f.authors[0], { subSection: subOther.id }) },
      { k: "d2 subSection null while the pillar has sub-sections", k4: "d (D-SUB, route stricter)", data: base(gcv, pMain.id, f.authors[0], { subSection: null }) },
      { k: "e author null (non single-home)", k4: "e", data: base(gcv, pMain.id, null) },
      { k: "f sponsored without sponsor", k4: "f", data: base(gcv, pMain.id, f.authors[0], { sponsored: true, sponsor: "" }) },
      { k: "g1 slug ''", k4: "g", data: base(gcv, pMain.id, f.authors[0], { slug: "" }) },
      { k: "g2 slug duplicates another article's MAIN slug (set on the version via SQL)", k4: "g", data: base(gcv, pMain.id, f.authors[0]), post: async (id) => { await db.execute(sql`UPDATE _articles_v_locales SET version_slug = ${otherMainSlug} WHERE _parent_id IN (SELECT id FROM _articles_v WHERE parent_id = ${id})`); } },
      { k: "h1 readMin 0", k4: "h", data: base(gcv, pMain.id, f.authors[0], { readMin: 0 }) },
      { k: "h2 readMin null", k4: "h", data: base(gcv, pMain.id, f.authors[0], { readMin: null }) },
      { k: "i1 secondary row pillar null", k4: "i", data: base(gcv, pMain.id, f.authors[0], { secondarySections: [{ pillar: null }] }) },
      { k: "i2 secondary row = single-home pillar (gcv pressroom)", k4: "i / K13", data: base(gcv, pMain.id, f.authors[0], { secondarySections: [{ pillar: press }] }) },
      { k: "i3 secondary row sub of another pillar", k4: "i", data: base(gcv, pMain.id, f.authors[0], { secondarySections: [{ pillar: pMain.id, subSection: subOther.id }] }) },
      { k: "j1 video without heroImage", k4: "j", data: base(gcv, pMain.id, f.authors[0], { video: videoId, videoDescription: "mô tả" }) },
      { k: "j2 video without heroImage and without videoDescription", k4: "j", data: base(gcv, pMain.id, f.authors[0], { video: videoId }) },
      { k: "k1 primary pillar engine-blocked (gcv exclusive)", k4: "k / K13 (route-only)", data: base(gcv, exclusive, f.authors[0]) },
      { k: "k2 primary pillar single-home (gcv pressroom), author null", k4: "K13 (route-only)", data: base(gcv, press, null) },
      { k: "l1 briefs row without source (wtb)", k4: "l", data: base(wtbId, wtbMain.id, fx("world-travel-brief").authors[0], { briefs: [{ label: "a", value: "1" }] }) },
      { k: "l2 briefs 5 rows (wtb)", k4: "l", data: base(wtbId, wtbMain.id, fx("world-travel-brief").authors[0], { briefs: [1, 2, 3, 4, 5].map((i) => ({ label: `l${i}`, value: `${i}`, source: "s" })) }) },
      { k: "sys1 contentType null", k4: "(not in K4)", data: base(gcv, pMain.id, f.authors[0], { contentType: null }) },
      { k: "sys2 tone outside options", k4: "(not in K4)", data: base(gcv, pMain.id, f.authors[0], { tone: "zz" }) },
      { k: "sys3 sourceLanguage outside options", k4: "(not in K4)", data: base(gcv, pMain.id, f.authors[0], { sourceLanguage: "xx" }) },
      { k: "sys4 publishedAt null on the draft", k4: "(cron writes publishedAt)", data: base(gcv, pMain.id, f.authors[0], { publishedAt: null }) },
      { k: "sys5 translationStatus row without state", k4: "(system)", data: base(gcv, pMain.id, f.authors[0], { translationStatus: [{ locale: "vi" }] }) },
      { k: "sys6 tag id that does not exist", k4: "(route resolves slugs)", data: base(gcv, pMain.id, f.authors[0], { tags: [99999999] }) },
      { k: "sys7 workflowStatus scheduled with no scheduledFor (cron skips it)", k4: "(none)", data: base(gcv, pMain.id, f.authors[0], { workflowStatus: "scheduled" }) },
      { k: "control: fully valid hub draft", k4: "—", data: base(gcv, pMain.id, f.authors[0]) },
    ];
    const step2: Doc[] = [];
    for (const c of cases) {
      if ((c.k.startsWith("j1") || c.k.startsWith("j2")) && videoId == null) {
        step2.push({ case: c.k, k4: c.k4, draftSave: "KXN (no videoMedia row)", video: videoNote });
        continue;
      }
      let id: number | null = null;
      let draftSave: unknown;
      try {
        id = ((await payload.create({ collection: "articles", draft: true, depth: 0, overrideAccess: true, data: c.data as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "create" }, engineId: authorEngine, disableRevalidate: true } })) as unknown as Doc).id as number;
        if (c.post) await c.post(id);
        draftSave = "ok";
      } catch (e) {
        draftSave = errShape7(e);
      }
      let cronUpdate: unknown = "n/a";
      if (id != null) {
        try {
          const raw = await latest7(id);
          await payload.update({ collection: "articles", id, overrideAccess: true, data: { _status: "published", workflowStatus: "published", publishedAt: raw.publishedAt ?? raw.scheduledFor ?? nowIso() } as never });
          cronUpdate = "ok (Payload accepted)";
        } catch (e) {
          cronUpdate = errShape7(e);
        }
      }
      step2.push({ case: c.k, k4: c.k4, draftSave, cronUpdate });
      console.log(`OBS   PB-7a step2 ${c.k}  ${JSON.stringify({ draftSave, cronUpdate })}`);
    }
    rec("PB-7a", "GHI", "step 2: per-defect draft (draft:true) then the cron's exact non-draft update", { video: videoNote, rows: step2 });

    // Step 3: body corpus generated from HUB_BODY_NODE_TYPES and isAllowedLinkUrl.
    const conv = await import("../src/lib/hub-author-convert-core");
    const urlCandidates = ["https://example.com/a", "HTTPS://EXAMPLE.COM/B", "http://example.com/", "mailto:a@example.com", "tel:+6512345678", "/duong-dan/noi-bo", "#neo", "?q=1", "//example.com/x", "javascript:alert(1)", "duong-dan-tuong-doi"];
    const urls = urlCandidates.filter((u) => conv.isAllowedLinkUrl(u));
    const mdFor: Record<string, string> = {
      root: "Đoạn văn thường.",
      paragraph: "Đoạn một.\n\nĐoạn hai.",
      text: "Chữ **đậm** và *nghiêng* và `mã`.",
      heading: "## Tiêu đề phụ\n\nĐoạn.",
      quote: "> Trích dẫn.\n\nĐoạn.",
      list: "- mục một\n- mục hai\n\n1. số một\n2. số hai",
      listitem: "- mục\n  - mục con",
      link: `Một [liên kết](${urls[0] ?? "https://example.com/"}).`,
      horizontalrule: "Đoạn một.\n\n---\n\nĐoạn hai.",
      linebreak: "Dòng một\\\nDòng hai.",
    };
    const extraVariants: { name: string; md: string; wantType: string }[] = [{ name: "node:linebreak (two trailing spaces)", md: "Dòng một  \nDòng hai.", wantType: "linebreak" }];
    const corpus: { name: string; md: string; wantType: string }[] = [];
    for (const t of conv.HUB_BODY_NODE_TYPES) corpus.push({ name: `node:${t}`, md: mdFor[t] ?? `Đoạn ${t}.`, wantType: t });
    for (const u of urls) corpus.push({ name: `url:${u}`, md: `Liên kết [đây](${u}) trong câu.`, wantType: "link" });
    corpus.push(...extraVariants);
    const step3: Doc[] = [];
    let rejectedByCron = 0;
    for (const c of corpus) {
      const slug = `pb7-${run}-c-${seq++}`;
      const r = await call("POST", "/api/hub/articles", { tenant: "gcv", title: `PB7 corpus ${slug}`, slug, pillarSlug: "p6-main", authorId: f.authors[0], bodyMarkdown: c.md, actor: PB7_ACTOR });
      if (r.status !== 201) {
        step3.push({ case: c.name, post: r.status, body: r.body });
        continue;
      }
      const id = r.body.id as number;
      const types = new Set<string>();
      const walk = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        const o = n as Doc;
        if (typeof o.type === "string") types.add(o.type);
        for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
      };
      const raw = await latest7(id);
      walk(raw.body);
      let cronUpdate: unknown = "ok";
      try {
        await payload.update({ collection: "articles", id, overrideAccess: true, data: { _status: "published", workflowStatus: "published", publishedAt: raw.publishedAt ?? nowIso() } as never });
      } catch (e) {
        cronUpdate = errShape7(e);
        rejectedByCron++;
      }
      step3.push({ case: c.name, post: 201, containsWantedType: types.has(c.wantType), types: [...types].sort(), cronUpdate });
    }
    // A `linebreak` node written directly (Local API, draft:true), in case the hub converter never emits one.
    {
      const lexLb = { root: { type: "root", format: "", indent: 0, version: 1, direction: null, children: [{ type: "paragraph", format: "", indent: 0, version: 1, direction: null, textFormat: 0, textStyle: "", children: [{ type: "text", text: "Dòng một", format: 0, detail: 0, mode: "normal", style: "", version: 1 }, { type: "linebreak", version: 1 }, { type: "text", text: "Dòng hai", format: 0, detail: 0, mode: "normal", style: "", version: 1 }] }] } };
      let cronUpdate: unknown = "ok";
      try {
        const c = (await payload.create({ collection: "articles", draft: true, depth: 0, overrideAccess: true, data: base(gcv, pMain.id, f.authors[0], { body: lexLb }) as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "create" }, engineId: authorEngine, disableRevalidate: true } })) as unknown as Doc;
        const raw = await latest7(c.id as number);
        try {
          await payload.update({ collection: "articles", id: c.id as number, overrideAccess: true, data: { _status: "published", workflowStatus: "published", publishedAt: raw.publishedAt ?? nowIso() } as never });
        } catch (e) {
          cronUpdate = errShape7(e);
          rejectedByCron++;
        }
      } catch (e) {
        cronUpdate = { draftSave: errShape7(e) };
      }
      step3.push({ case: "node:linebreak (Lexical node written directly, Local API draft:true)", post: "n/a", containsWantedType: true, cronUpdate });
    }
    rec("PB-7a", rejectedByCron === 0 ? "ĐẠT" : "ĐỎ", `step 3: body corpus (${corpus.length} bodies: every HUB_BODY_NODE_TYPES entry + every URL form isAllowedLinkUrl accepts) saved via the real POST, then the cron's non-draft update`, { urlsAccepted: urls, urlsRejectedByFilter: urlCandidates.filter((u) => !urls.includes(u)), rejectedByCron, rows: step3 });
  });

  // ══ PB-3 ca N (LAST: it may starve the pool for good) ══════════════════════
  // Post-run checks use a SIDE `pg` Client, never the Payload pool (which may be wedged).
  const uncaughtAt: number[] = [];
  process.on("uncaughtException", () => uncaughtAt.push(Date.now()));
  await section("PB-3N", async () => {
    const poolMax = D.pool?.options?.max ?? 10;
    const low = poolMax - 2;
    const high = poolMax + 2;
    const pg = (await import("pg")) as unknown as { default?: { Client: new (o: Doc) => PgSide7 }; Client?: new (o: Doc) => PgSide7 };
    const ClientC = (pg.Client ?? pg.default?.Client)!;
    const side = async (q: string, params: unknown[] = []): Promise<Doc[]> => {
      const c = new ClientC({ connectionString: process.env.DATABASE_URL });
      c.on("error", () => {});
      await c.connect();
      try {
        return (await c.query(q, params)).rows;
      } finally {
        await c.end().catch(() => {});
      }
    };
    const drafts: number[] = [];
    for (let i = 0; i < high; i++) drafts.push((await mkDraft("gcv")).id);
    const only3n = arg("n-case"); // optional: "low-distinct" | "low-same" | "high-same" | "high-distinct"
    const order: [number, "distinct articles" | "same article", string][] = [
      [low, "distinct articles", "low-distinct"],
      [low, "same article", "low-same"],
      [high, "same article", "high-same"],
      [high, "distinct articles", "high-distinct"],
    ];
    // CONTROL (only with --n-case high-distinct-baseline): today's write shape with NO explicit
    // transaction — Payload opens its own per-operation transaction and the hub_author activity
    // row is written on a 2nd connection from inside it. Measures whether the wedge pre-exists.
    if (only3n === "high-distinct-baseline") order.push([high, "distinct articles", "high-distinct-baseline"]);
    for (const [n, shape, key] of order) {
      if (only3n && only3n !== key) continue;
      const tStart = Date.now();
      const done: (Doc | null)[] = Array.from({ length: n }, () => null);
      const markers: string[] = [];
      const uncaught0 = uncaughtAt.length;
      for (let i = 0; i < n; i++) {
        const id = shape === "same article" ? drafts[0]! : drafts[i]!;
        const marker = `PB7N ${run} ${key} ${i}`;
        markers.push(marker);
        const work: Promise<Lock7Out> =
          key === "high-distinct-baseline"
            ? (async (): Promise<Lock7Out> => {
                const t0 = Date.now();
                await payload.update({ collection: "articles", id, draft: true, depth: 0, overrideAccess: true, data: { title: marker, workflowStatus: "draft", _status: "draft" } as never, context: { hubAuthor: { actor: PB7_ACTOR, action: "update", fields: ["title"] }, engineId: authorEngine, disableRevalidate: true } });
                return { kind: "ok", ms: Date.now() - t0 };
              })()
            : protoLock7(payload, { tenantId: tid.gcv, articleId: id }, async (c) => {
          await payload.find({ collection: "content-engines", limit: 1, depth: 0, overrideAccess: true }); // 2nd connection (no req)
          await payload.update({ collection: "articles", id, req: c.req as never, draft: true, depth: 0, overrideAccess: true, data: { title: marker, workflowStatus: "draft", _status: "draft" } as never, context: ctxW("pb7 N", { disableRevalidate: true }) });
          await payload.count({ collection: "activityLog", overrideAccess: true }); // 2nd connection again
          await sleep7(100);
          return { ok: true, value: marker };
        });
        void work.then(
          (r) => (done[i] = { kind: r.kind, code: r.code, ms: r.ms, at: Date.now() - tStart, err: r.kind === "thrown" ? r.err : undefined }),
          (e) => (done[i] = { kind: "rejected", at: Date.now() - tStart, err: errShape7(e) }),
        );
      }
      const marks: Doc = {};
      for (const at of [10_000, 45_000, 75_000, 120_000]) {
        while (Date.now() - tStart < at && done.some((x) => x === null)) await sleep7(250);
        marks[`unfinishedAt${at / 1000}s`] = done.filter((x) => x === null).length;
        if (done.every((x) => x !== null)) break;
      }
      const unfinished = done.filter((x) => x === null).length;
      const lost: string[] = [];
      for (let i = 0; i < n; i++) {
        if ((done[i] as Doc | null)?.kind !== "ok") continue;
        const id = shape === "same article" ? drafts[0]! : drafts[i]!;
        const hit = Number((await side("SELECT count(*)::int AS n FROM _articles_v_locales l JOIN _articles_v v ON v.id = l._parent_id WHERE v.parent_id = $1 AND l.version_title = $2", [id, markers[i]]))[0]?.n);
        if (hit !== 1) lost.push(markers[i]!);
      }
      const kinds = done.reduce<Record<string, number>>((acc, x) => {
        const k = x ? `${(x as Doc).kind}${(x as Doc).code ? `:${(x as Doc).code}` : ""}` : "unfinished";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      const backends = await side("SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY state ORDER BY state");
      const adv = await side("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      const isLow = n === low;
      const verdict = unfinished > 0 || lost.length > 0 ? "ĐỎ" : isLow ? (Object.keys(kinds).every((k) => k === "ok") ? "ĐẠT" : "ĐỎ") : "GHI";
      rec("PB-3", verdict, `(N) ${n} concurrent requests, ${shape}, each holding the tx + a 2nd connection (pool.max ${poolMax}, ${isLow ? "N ≤ pool − 2 ⇒ must all finish" : "N ≥ pool + 2 ⇒ record only, DỪNG if still unfinished after the 30 s idle timeout"})`, {
        ...marks, totalMs: Date.now() - tStart, kinds, finishedAtMs: done.map((x) => (x as Doc | null)?.at ?? null),
        reportedOkButNotPersisted: lost, uncaughtDuringCase: uncaughtAt.length - uncaught0, uncaughtAtMs: uncaughtAt.slice(uncaught0).map((t) => t - tStart),
        dbBackendsByState: backends, advisoryLocks: adv[0]?.n, pool: { total: D.pool?.totalCount, idle: D.pool?.idleCount, waiting: D.pool?.waitingCount },
        thrownSamples: done.filter((x) => ["thrown", "rejected"].includes(String((x as Doc | null)?.kind))).slice(0, 2),
      });
      if (unfinished > 0) {
        rec("PB-3", "ĐỎ", `(N) ${unfinished}/${n} requests still unfinished after 120 s (idle_in_transaction timeout 30 s long passed) ⇒ DỪNG; the Payload pool is not usable any more, stopping the probe`, {});
        break;
      }
      await sleep7(1500);
    }
    rec("PB-3", uncaught.length === 0 ? "ĐẠT" : "ĐỎ", "(N) no uncaught error / unhandled rejection in the probe process during PB-3N", { uncaughtCount: uncaught.length, sample: uncaught.slice(0, 3) });
  });

  const tally = results.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  console.log(`\n[pb7] summary ${JSON.stringify(tally)}`);
  for (const r of results) if (r.verdict !== "ĐẠT") console.log(`[pb7]   ${r.verdict} ${r.id} ${r.label}`);
  process.exit(0);
}

/** findSlugConflict (hub-author-refs.ts), imported lazily so older trees still load the probe. */
async function findSlugConflict7(payload: P, tenantId: Id7, slug: string, excludeId?: Id7): Promise<{ id: Id7 } | null> {
  const { findSlugConflict } = await import("../src/lib/hub-author-refs");
  return findSlugConflict({ payload: payload as never, tenantId: tenantId as never, slug, excludeId: excludeId as never }) as Promise<{ id: Id7 } | null>;
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
                        : flag("setup6")
                          ? setup6
                          : flag("check6")
                            ? check6
                            : flag("guard-child")
                              ? guardChild6
                              : flag("pb")
                                ? pb6
                                : flag("n10")
                                  ? n10
                                  : flag("pb7")
                                    ? pb7
                                    : null;
if (!run) {
  console.error(
    "usage: tsx scripts/hub-probe.ts --setup | --check --token <t> [--nohub-token <t>] | --paging [--token <t>] | --setup2 | --nullorder | --check2 --token <t> [--nohub-token <t>] | --setup3 --out <file> | --check3 --in <file> [--hooks-only] | --setup4 --out <file> | --check4 --in <file> [--unit-only] | --check5 --in <file> --in3 <file> [--unit-only] | --explore6 --in4 <file> [--only P-1,P-15,P-20..P-24] [--vec <name>] [--list] [--lim lines,starUnd,links] | --setup6 --out <file> | --check6 --in <file> | --check6 --unit-only | --check6 --hooks-only | --pb --in <setup6.json> | --n10 --in <setup6.json> (--out <json> | --compare <json> [--require-new-code]) | --pb7 --in <setup6.json> [--only PB-1,PB-3,…] | --pb7 --only GATE",
  );
  process.exit(2);
}
run().catch((err) => {
  console.error("[probe] failed", err);
  process.exit(1);
});
