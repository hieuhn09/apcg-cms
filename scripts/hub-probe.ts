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

const run = flag("setup") ? setup : flag("check") ? check : flag("paging") ? paging : null;
if (!run) {
  console.error("usage: tsx scripts/hub-probe.ts --setup | --check --token <t> [--nohub-token <t>]");
  process.exit(2);
}
run().catch((err) => {
  console.error("[probe] failed", err);
  process.exit(1);
});
