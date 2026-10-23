/**
 * Tests of the network-legacy bundle (tenant profiles aer and agr). Run: npm run test:migrate-network.
 * Every test that switches the profile restores the GTP default afterwards.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planEntry, EntryError } from "./network-legacy";
import { GTP_PROFILE, parseProfile, setProfile, profile, type NetworkProfile } from "../lib/network-profile";
import { validateMapping } from "../lib/gtp-mapping";
import { CURSOR_TS, LegacyReadOnlyDb, keysetPage, type MinimalPgClient } from "../lib/legacy-sql";
import { LiveLegacyReader, assertGtpSite, type LegacyReader } from "../lib/legacy-reader";
import { legacyTags, resolveTaxonomy, stableFilename } from "../lib/gtp-transform";
import { assignByRule, bodyImageUrls, slugHashAuthor } from "../lib/network-authors";
import { buildSlugPlan, pinPriorSlugs } from "../lib/slug-plan";
import { generateTimestampsFix } from "../lib/gtp-timestamps";
import { legacyBanner, legacySsl } from "../lib/db-banner";
import { expectedFromSource } from "../lib/gtp-expected";
import { buildRedirects } from "../lib/gtp-redirects";
import { missingR2Vars, r2GuardMessage } from "../lib/r2-guard";
import type { AuthorItem } from "../lib/gtp-author-distribution";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const readJ = (p: string) => JSON.parse(readFileSync(path.join(HERE, p), "utf8"));
const AER: NetworkProfile = parseProfile(readJ("profiles/aer.json"));
const SITE = AER.fixtureSiteId;
const FIX_OVERLAY = readJ("fixtures/aer-legacy/overlay.fixture.json");
afterEach(() => setProfile(GTP_PROFILE));

/* ── entry ── */
test("entry: --tenant required, gtp refused, unknown tenant refused", () => {
  assert.throws(() => planEntry(["import", "--site", "x"]), EntryError);
  assert.throws(() => planEntry(["import", "--tenant", "gtp", "--site", "gtp"]), /migrate:gtp/);
  assert.throws(() => planEntry(["import", "--tenant", "nope", "--site", "x"]), /no tenant profile/);
  assert.throws(() => planEntry(["verify", "--tenant", "aer"]), /--site/);
});
test("entry: strips --tenant/--site, a slug becomes the only accepted legacy slug", () => {
  const p = planEntry(["import", "--tenant=aer", "--site", "aer-old", "--apply", "--run-id", "aer-real-1"]);
  assert.deepEqual(p.argv, ["--apply", "--run-id", "aer-real-1"]);
  assert.deepEqual([...p.profile.legacySiteSlugs], ["aer-old"]);
  assert.equal(p.profile.tenant, "aer");
});
test("entry: a site uuid must equal the overlay siteFilter; discover gets --site-id", () => {
  const files: Record<string, string> = { [path.resolve("ov.json")]: JSON.stringify(FIX_OVERLAY) };
  const rf = (p: string) => (p in files ? (files[p] as string) : readFileSync(p, "utf8"));
  assert.doesNotThrow(() => planEntry(["import", "--tenant", "aer", "--site", SITE, "--mapping-overlay", "ov.json"], rf));
  assert.throws(() => planEntry(["import", "--tenant", "aer", "--site", "11111111-2222-3333-4444-555555555555", "--mapping-overlay", "ov.json"], rf), /differ/);
  assert.deepEqual(planEntry(["discover", "--tenant", "aer", "--site", SITE]).argv, ["--site-id", SITE]);
  assert.deepEqual(planEntry(["validate-mapping", "--tenant", "aer"]).argv, ["--mapping", AER.mappingPath]);
});

/* ── profile + mapping ── */
test("profile: aer parses; gtp tenant and non-pillar single-home refused", () => {
  assert.equal(AER.tenant, "aer");
  assert.throws(() => parseProfile({ ...readJ("profiles/aer.json"), tenant: "gtp" }), /gtp/);
  assert.throws(() => parseProfile({ ...readJ("profiles/aer.json"), singleHomePillars: ["press-room"] }), /singleHome/);
});
test("mapping: committed aer mapping is FINAL (owner 20-10-26) and passes --require-final; the fixture mapping is final", () => {
  setProfile(AER);
  const m = readJ("mappings/aer.mapping.json");
  assert.deepEqual(validateMapping(m, FIX_OVERLAY, { requireFinal: true }).provisional, []);
  assert.throws(() => validateMapping({ ...m, _provisional: ["categories.map"] }, FIX_OVERLAY, { requireFinal: true }), /require-final/);
  assert.doesNotThrow(() => validateMapping(readJ("fixtures/aer-legacy/aer.mapping.fixture.json"), FIX_OVERLAY, { requireFinal: true }));
  // Published only; old sub-sections survive (briefings/corporate-asia pass through, essays -> asia-watch keeps its sub).
  assert.deepEqual(Object.entries(m.status.map).filter(([, v]) => v !== "SKIP").map(([k]) => k), ["published"]);
  assert.equal(m.body.reflowMaxChars, 380);
  const tx = (sec: string, sub: string) => resolveTaxonomy(sec, sub, m);
  assert.deepEqual(tx("briefings", "policy"), { ok: true, t: { pillar: "briefings", subSection: "policy", rehomed: false, oldSection: "briefings", oldSub: "policy" } });
  assert.deepEqual(tx("corporate-asia", "capital"), { ok: true, t: { pillar: "corporate-asia", subSection: "capital", rehomed: false, oldSection: "corporate-asia", oldSub: "capital" } });
  assert.deepEqual(tx("briefings", ""), { ok: true, t: { pillar: "briefings", rehomed: false, oldSection: "briefings", oldSub: "" } });
  for (const sub of ["growth-policy", "money-finance", "technology-industry"]) {
    assert.deepEqual(tx("essays", sub), { ok: true, t: { pillar: "asia-watch", subSection: sub, rehomed: true, oldSection: "essays", oldSub: sub } });
  }
  assert.throws(() => validateMapping({ ...m, categories: { map: { "x/*": { pillar: "news" } } } }, FIX_OVERLAY), /pillar "news" is not one of the 6 aer pillars/);
  assert.throws(() => validateMapping({ ...m, authors: { ...m.authors, bySection: { essays: "Nobody" } } }, FIX_OVERLAY), /not in authors.staff/);
});
test("mapping: the same aer mapping is refused under the GTP profile (pillars are per tenant)", () => {
  assert.throws(() => validateMapping(readJ("mappings/aer.mapping.json"), FIX_OVERLAY), /6 gtp pillars|_provisional/);
});

/* ── keyset paging on aer_ro views, microsecond timestamps (red-first: fails if the cursor uses the ms Date) ── */
function micros(s: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|\+00)$/.exec(s);
  if (!m) throw new Error(`fake pg: bad timestamptz ${s}`);
  return BigInt(Date.parse(`${m[1]}T${m[2]}Z`)) * 1000n + BigInt(((m[3] ?? "") + "000000").slice(0, 6));
}
function pgText(us: bigint): string {
  const frac = (us % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${new Date(Number(us / 1000n)).toISOString().slice(0, 19).replace("T", " ")}${frac ? `.${frac}` : ""}+00`;
}
interface FakeRow { id: string; us: bigint }
function fakeClient(rows: FakeRow[], seen: string[]): MinimalPgClient {
  const sorted = [...rows].sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : a.id < b.id ? -1 : 1));
  return {
    connect: async () => {},
    end: async () => {},
    query: async (text: string, params: unknown[] = []) => {
      if (!text.startsWith("SELECT")) return { rows: [] };
      seen.push(text);
      const limit = Number(params[params.length - 1]);
      let list = sorted;
      if (text.includes(") > (")) {
        const cu = micros(String(params[2]));
        const ci = String(params[3]);
        list = sorted.filter((r) => r.us > cu || (r.us === cu && r.id > ci));
      }
      return { rows: list.slice(0, limit).map((r) => ({ id: r.id, created_at: new Date(Number(r.us / 1000n)), ...(text.includes(`"${CURSOR_TS}"`) ? { [CURSOR_TS]: pgText(r.us) } : {}) })) };
    },
  };
}
function reader(rows: FakeRow[], seen: string[]): LiveLegacyReader {
  const db = new LegacyReadOnlyDb(() => fakeClient(rows, seen));
  const r = new (LiveLegacyReader as unknown as new (...a: unknown[]) => LiveLegacyReader)(db, "aer_ro", SITE, ["articles", "sites", "site_authors"]);
  (r as unknown as { catalog: Map<string, Set<string>> }).catalog.set("articles", new Set(["id", "created_at"]));
  return r;
}
function microFixture(n = 60): FakeRow[] {
  const t0 = 1_767_254_400_000_000n; // 2026-01-01
  const out: FakeRow[] = [];
  for (let i = 0; i < n; i++) out.push({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`, us: t0 + BigInt(Math.floor(i / 4)) * 1000n + BigInt((i % 4) * 123 + 1) });
  for (let k = 0; k < 3; k++) out.push({ id: `bbbbbbbb-0000-4000-8000-${String(k).padStart(12, "0")}`, us: t0 + 999_999n }); // same microsecond
  return out.reverse();
}
for (const size of [1, 3, 7, 50]) {
  test(`keyset (aer_ro, microseconds): paged read = unpaged ORDER BY, page size ${size}`, async () => {
    setProfile(AER);
    const rows = microFixture();
    const seen: string[] = [];
    const got: string[] = [];
    for await (const page of reader(rows, seen).pages("articles", ["id"], size)) {
      got.push(...page.map((r) => String(r.id)));
      if (got.length > rows.length * 2) break;
    }
    const want = [...rows].sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : a.id < b.id ? -1 : 1)).map((r) => r.id);
    assert.deepEqual(got, want);
    assert.ok(seen.every((t) => t.includes(`FROM "aer_ro"."articles" WHERE "site_id" = $1`)), "every read is site-filtered on the aer_ro view");
  });
}
test("keyset: the builder renders the aer_ro schema and the exact text cursor", () => {
  const q = keysetPage("aer_ro", "articles", ["id"], SITE, ["2026-01-01 00:00:00.000123+00", "x"], 10, ["articles", "sites", "site_authors"]);
  assert.match(q.text, /FROM "aer_ro"\."articles" WHERE "site_id" = \$1\) AS t WHERE/);
  assert.equal(q.params[2], "2026-01-01 00:00:00.000123+00");
});

/* ── site guard ── */
const siteReader = (row: Record<string, unknown>) => ({ siteRow: async () => row }) as unknown as LegacyReader;
test("site guard: aer by slug accepts its slug and refuses another site; by id accepts the row the id points at", async () => {
  setProfile({ ...AER, legacySiteSlugs: ["asia-economic-review-legacy"] });
  await assert.doesNotReject(assertGtpSite(siteReader({ id: SITE, slug: "asia-economic-review-legacy" })));
  await assert.rejects(assertGtpSite(siteReader({ id: SITE, slug: "theasiaspotlight" })), /expected legacy site/);
  setProfile(AER);
  await assert.doesNotReject(assertGtpSite(siteReader({ id: SITE, slug: "anything" })));
  setProfile(GTP_PROFILE);
  await assert.rejects(assertGtpSite(siteReader({ id: SITE, slug: "asia-economic-review-legacy" })), /slug gtp/);
});

/* ── transforms ── */
test("taxonomy: sec/* wildcard maps every subsection of an old section (importer and independent verify agree)", () => {
  const m = { categories: { map: { "essays/*": { pillar: "asia-watch" } }, fallback: null, unmapped: "reject" as const } };
  const r = resolveTaxonomy("Essays", "policy", m);
  assert.ok(r.ok && r.t.pillar === "asia-watch" && r.t.subSection === undefined && r.t.rehomed);
  const e = expectedFromSource([{ id: "1", status: "published", section: "essays", subsection: "policy" }], { status: { map: { published: "published" }, unknown: "reject" }, categories: m.categories });
  assert.deepEqual(e.bySub, { "asia-watch/": 1 });
});
test("tags: keepOnly keeps only approved tags after renames (D6)", () => {
  const m = { tags: { normalize: "lowercase-trim-dedupe" as const, maxPerArticle: 12, drop: [], renames: { korea: "south-korea" }, keepOnly: ["china", "south-korea"] } };
  assert.deepEqual(legacyTags(["China", "trade", "Korea", "inflation"], m).map((t) => t.slug), ["china", "south-korea"]);
  assert.deepEqual(legacyTags(["China", "trade"], { tags: { ...m.tags, keepOnly: undefined } }).map((t) => t.slug), ["china", "trade"], "absent keepOnly = old behaviour");
});
test("body images: urls counted from body_sections[].image (string or {url})", () => {
  assert.deepEqual(bodyImageUrls([{ image: "https://h/x.jpg" }, { image: { url: "https://h/y.png" } }, { image: "rel.jpg" }, {}]), ["https://h/x.jpg", "https://h/y.png"]);
  assert.deepEqual(bodyImageUrls("not json"), []);
});
test("media filename: aer prefix; gtp default unchanged", () => {
  assert.match(stableFilename("https://h/a.jpg", "aer"), /^aer-[0-9a-f]{8}-a\.jpg$/);
  assert.match(stableFilename("https://h/a.jpg"), /^gtp-/);
});

/* ── authors (D7 / by section) + second run ── */
const item = (i: number, section = "essays"): AuthorItem => ({ legacyId: `l${i}`, slug: `slug-${i}`, publishedAt: null, countries: [], kind: "article", section });
test("authors slugHash: stable per slug, independent of order and of later (delta) items", () => {
  const pool = ["Lena Ho", "Arjun Menon", "Mei Fong Chua", "Rahul Sethi"];
  const first = assignByRule([1, 2, 3, 4, 5, 6].map((i) => item(i)), "slugHash", pool).assign;
  const second = assignByRule([9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => item(i)), "slugHash", pool).assign;
  for (const [k, v] of first) assert.equal(second.get(k), v);
  assert.equal(slugHashAuthor("slug-1", pool), first.get("l1"));
});
test("authors bySection: old section wins, unknown section falls back to slugHash, fixed (Central) authors kept", () => {
  const pool = ["Lena Ho", "Arjun Menon", "Mei Fong Chua", "Rahul Sethi"];
  const r = assignByRule([item(1, "briefings"), item(2, "data-annual"), item(3, "briefings")], "bySection", pool, { briefings: "Lena Ho" }, new Map([["l3", "Rahul Sethi"]]));
  assert.equal(r.assign.get("l1"), "Lena Ho");
  assert.equal(r.assign.get("l2"), slugHashAuthor("slug-2", pool));
  assert.equal(r.assign.get("l3"), "Rahul Sethi");
  assert.equal(r.sectionFallbacks, 1);
});
test("second run (delta): run-1 slugs pinned, only the new rows get new slugs (aer reserved slugs apply)", () => {
  setProfile(AER);
  const m = { status: { map: { published: "published" as const }, unknown: "reject" as const }, slug: { preserve: true, dedupe: "numeric-suffix" as const, reservedSlugs: [] } };
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(3, "0")}`, created_at: `2026-01-01T00:00:00.${String(100 + i).padStart(6, "0")}Z`, status: "published", slug: i === 0 ? "briefings" : `story-${i}`, title: { en: `Story ${i}` } }));
  const run1 = buildSlugPlan(rows(5), m);
  assert.notEqual(run1[0]?.slug, "briefings", "an aer pillar slug is reserved");
  const prior = new Map(run1.map((e) => [e.legacyId, e.slug]));
  const run2 = pinPriorSlugs(buildSlugPlan(rows(8), m), prior);
  for (const e of run1) assert.equal(run2.find((x) => x.legacyId === e.legacyId)?.slug, e.slug);
  assert.equal(run2.filter((e) => !prior.has(e.legacyId)).length, 3);
});

/* ── guards / outputs ── */
test("timestamps-fix: marker is the profile's; an unsafe marker is refused", () => {
  const t = generateTimestampsFix([{ slug: "a-b", legacyCreatedAt: "2026-01-01T00:00:00.000Z" }], { tenantSlug: "aer", runId: "aer-real-1", markerSourceName: AER.markerSourceName });
  assert.ok(t.sql.includes("engine_source_name = 'legacy:asiaeconomicreview'") && t.sql.includes("slug = 'aer'"));
  assert.throws(() => generateTimestampsFix([], { tenantSlug: "aer", runId: "x", markerSourceName: "legacy:x'; drop" }), /marker/);
});
test("legacy env names follow the profile (LEGACY_DB_URL / LEGACY_DB_SSL); GTP names unchanged", () => {
  setProfile(AER);
  assert.throws(() => legacyBanner(undefined), /LEGACY_DB_URL is not set/);
  assert.equal(legacySsl({ LEGACY_DB_SSL: "disable" }, false), false);
  setProfile(GTP_PROFILE);
  assert.throws(() => legacyBanner(undefined), /LEGACY_GTP_DB_URL is not set/);
});
test("redirects: an old section that is not a pillar goes to the pillar its rows were mapped to (no dangling target)", () => {
  setProfile(AER);
  const kr = readJ("fixtures/aer-legacy/known-routes.json");
  const entries = [{ legacyId: "1", kind: "article", slug: "s1", status: "published", oldUrl: "/article/s1", oldSection: "essays", oldSub: "", pillar: "asia-watch" }] as never;
  const b = buildRedirects(entries, { archivedAs: "section", urls: { oldOrigin: "https://x", articlePathTemplate: "/article/{slug}", sectionPaths: { essays: "/essays" }, extraLegacyPaths: [], gonePaths: ["/corrections"] } }, kr);
  assert.deepEqual(b.errors, []);
  assert.ok(b.rules.some((r) => r.from === "/essays" && r.to === "/asia-watch" && r.status === 301));
  assert.equal(profile().tenant, "aer");
});
test("redirects: GTP keeps the old section slug for a non-pillar old section (unchanged behaviour); AER maps it", () => {
  const kr = readJ("fixtures/aer-legacy/known-routes.json");
  const m = { archivedAs: "section", urls: { oldOrigin: "https://x", articlePathTemplate: "/article/{slug}", sectionPaths: { essays: "/essays" }, extraLegacyPaths: [], gonePaths: [] } } as never;
  const row = (pillar: string) => [{ legacyId: "1", kind: "article", slug: "s1", status: "published", oldUrl: "/article/s1", oldSection: "essays", oldSub: "", pillar }] as never;
  setProfile(GTP_PROFILE);
  assert.equal(GTP_PROFILE.redirectNonPillarSectionsToMappedPillar, undefined);
  const g = buildRedirects(row("asia-watch"), m, kr);
  // Old GTP behaviour: target = old section slug, i.e. /essays -> /essays, dropped as identity; never the mapped pillar.
  assert.ok(!g.rules.some((r) => r.from === "/essays"));
  assert.equal(g.counts.identityDropped, 2); // the article path and the section path
  setProfile(AER);
  assert.equal(AER.redirectNonPillarSectionsToMappedPillar, true);
  const a = buildRedirects(row("asia-watch"), m, kr);
  assert.ok(a.rules.some((r) => r.from === "/essays" && r.to === "/asia-watch" && r.status === 301));
  assert.equal(a.counts.identityDropped, 1); // only the article path
});
test("image hosts: AER refuses an overlay whose hostAllowlist lacks the legacy storage host; GTP has no such check", () => {
  setProfile(AER);
  const m = readJ("fixtures/aer-legacy/aer.mapping.fixture.json");
  const bad = { ...FIX_OVERLAY, media: { hostAllowlist: ["other.example.com"], hostRewrite: {} } };
  assert.throws(() => validateMapping(m, bad), /mbolvnwkmkeroqmvbvmt\.supabase\.co/);
  assert.doesNotThrow(() => validateMapping(m, FIX_OVERLAY));
  setProfile(GTP_PROFILE);
  assert.equal(GTP_PROFILE.requiredImageHosts, undefined);
});
test("entry: missing --site error names the profile's discover file", () => {
  assert.throws(() => planEntry(["export", "--tenant", "aer"] as never), /sql\/01-discover-aer\.sql/);
});

/* ── R2 guard: a non-local import must not fall back to local-disk media ── */
test("r2 guard: all four R2 vars required (blank counts as missing); message names the gaps", () => {
  const full = { R2_BUCKET: "b", R2_ENDPOINT: "https://e", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };
  assert.deepEqual(missingR2Vars(full), []);
  assert.deepEqual(missingR2Vars({}), ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  assert.deepEqual(missingR2Vars({ ...full, R2_SECRET_ACCESS_KEY: "  " }), ["R2_SECRET_ACCESS_KEY"]);
  assert.match(r2GuardMessage(["R2_BUCKET"]), /R2_BUCKET is not set; images would be saved to this machine's disk/);
  assert.match(r2GuardMessage(["R2_BUCKET", "R2_ENDPOINT"]), /R2_BUCKET, R2_ENDPOINT are not set/);
});

/* ── agr (AsiaGolfReview) profile + provisional mapping ── */
const AGR: NetworkProfile = parseProfile(readJ("profiles/agr.json"));
const AGR_OVERLAY = { source: { siteFilter: AGR.fixtureSiteId }, media: { hostAllowlist: ["mbolvnwkmkeroqmvbvmt.supabase.co"], hostRewrite: {} } };
test("profile: agr parses; pillars = the 7 agr taxonomy pillars; press-room single-home; matches the constants", async () => {
  const { AGR_PILLARS } = await import("../../lib/agr-taxonomy");
  const { SINGLE_HOME_PILLARS } = await import("../../../src/lib/constants");
  assert.equal(AGR.tenant, "agr");
  assert.deepEqual([...AGR.pillarSlugs], AGR_PILLARS.map((p) => p.slug));
  assert.deepEqual([...AGR.singleHomePillars], SINGLE_HOME_PILLARS.agr);
  assert.deepEqual([...(AGR.requiredImageHosts ?? [])], ["mbolvnwkmkeroqmvbvmt.supabase.co"]);
  assert.equal(AGR.markerSourceName, "legacy:asiagolfreview");
  for (const p of AGR.pillarSlugs) assert.ok(AGR.reservedSlugs?.includes(p), p);
});
test("entry: agr resolves its profile; missing --site names 01-discover-agr.sql", () => {
  const p = planEntry(["import", "--tenant", "agr", "--site", "asiagolfreview", "--apply", "--run-id", "agr-real-1"]);
  assert.equal(p.profile.tenant, "agr");
  assert.deepEqual([...p.profile.legacySiteSlugs], ["asiagolfreview"]);
  assert.deepEqual(planEntry(["validate-mapping", "--tenant", "agr"]).argv, ["--mapping", AGR.mappingPath]);
  assert.throws(() => planEntry(["export", "--tenant", "agr"] as never), /sql\/01-discover-agr\.sql/);
});
test("mapping: committed agr mapping is PROVISIONAL: validates structurally, refused by --require-final", () => {
  setProfile(AGR);
  const m = readJ("mappings/agr.mapping.json");
  const r = validateMapping(m, AGR_OVERLAY);
  assert.deepEqual(r.provisional.map((x) => x.key).sort(), [...m._provisional].sort());
  assert.ok(m._provisional.includes("categories.map"));
  assert.throws(() => validateMapping(m, AGR_OVERLAY, { requireFinal: true }), /require-final/);
  assert.equal(m.source.schema, "agr_ro");
  // events-awards has no entry on purpose: a row there is rejected until the owner decides.
  assert.equal(Object.keys(m.categories.map).some((k) => k.startsWith("events-awards")), false);
  assert.equal(m.categories.unmapped, "reject");
  assert.equal(m.authors.distribute.mode, "slugHash");
  assert.deepEqual(m.authors.staff, ["Rachel Lim", "Arjun Mehta", "Kenji Sato", "Ha Tran", "Daniel Wong"]);
  assert.throws(() => validateMapping(m, { ...AGR_OVERLAY, media: { hostAllowlist: ["x.example.com"], hostRewrite: {} } }), /mbolvnwkmkeroqmvbvmt/);
});
test("mapping: every agr target is a real pillar/sub-section; press-room never gets a sub; addTags are kept tags", async () => {
  const { AGR_SUBSECTIONS } = await import("../../lib/agr-taxonomy");
  const m = readJ("mappings/agr.mapping.json");
  const subs = new Set(AGR_SUBSECTIONS.map((s) => `${s.pillarSlug}/${s.slug}`));
  for (const [k, t] of Object.entries(m.categories.map) as Array<[string, { pillar: string; subSection?: string; addTags?: string[] }]>) {
    assert.ok(AGR.pillarSlugs.includes(t.pillar), k);
    if (t.subSection) assert.ok(subs.has(`${t.pillar}/${t.subSection}`), k);
    if (t.pillar === "press-room") assert.equal(t.subSection, undefined, k);
    for (const tag of t.addTags ?? []) assert.ok(m.tags.keepOnly.includes(tag), `${k} ${tag}`);
  }
  const tx = (sec: string, sub: string) => resolveTaxonomy(sec, sub, m);
  assert.deepEqual(tx("golf-travel", "resorts-stays"), { ok: true, t: { pillar: "golf-travel", subSection: "resorts-stays", rehomed: false, oldSection: "golf-travel", oldSub: "resorts-stays" } });
  assert.deepEqual(tx("course-reviews", "hidden-gems"), { ok: true, t: { pillar: "course-reviews", rehomed: true, oldSection: "course-reviews", oldSub: "hidden-gems", addTags: ["hidden-gems"] } });
  assert.deepEqual(tx("gear-style", "style"), { ok: true, t: { pillar: "gear-style", subSection: "apparel", rehomed: true, oldSection: "gear-style", oldSub: "style" } });
  assert.deepEqual(tx("press-room", "press-releases"), { ok: true, t: { pillar: "press-room", rehomed: true, oldSection: "press-room", oldSub: "press-releases" } });
});
test("addTags: appended after legacy tags under keepOnly/dedupe; no addTags = unchanged list", async () => {
  const { withAddedTags } = await import("../lib/gtp-transform");
  const m = readJ("mappings/agr.mapping.json");
  const tm = { tags: { normalize: "lowercase-trim-dedupe", maxPerArticle: 12, drop: [], renames: m.tags.renames, keepOnly: m.tags.keepOnly } } as never;
  const base = legacyTags(["Hidden Gem", "golf"], tm);
  assert.deepEqual(base.map((t) => t.slug), ["hidden-gems"]);
  assert.deepEqual(withAddedTags(base, ["hidden-gems", "new-renovated", "not-kept"], tm).map((t) => t.slug), ["hidden-gems", "new-renovated"]);
  assert.deepEqual(withAddedTags(base, undefined, tm), base);
});
test("agr SQL Editor files are agr-only (role agr_migrator, schema agr_ro, no aer_ro)", () => {
  for (const f of ["sql/01-discover-agr.sql", "sql/02-create-readonly-role-views-agr.sql", "sql/02p-set-password-agr.sql", "sql/03-drop-role-and-views-agr.sql"]) {
    const s = readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(s, /aer_ro|Asia Economic/, f);
  }
  const s02 = readFileSync(path.join(HERE, "sql/02-create-readonly-role-views-agr.sql"), "utf8");
  assert.match(s02, /CREATE ROLE agr_migrator/);
  assert.match(s02, /CREATE SCHEMA agr_ro/);
  assert.match(readFileSync(path.join(HERE, "sql/01-discover-agr.sql"), "utf8"), /slug::text = 'agr'/);
});
