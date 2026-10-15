import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRedirects, coverage, gtpWebFiles } from "./gtp-redirects";
import { validateGtpWebRedirectFiles, type KnownRoutes } from "./gtp-redirect-contract";
import type { SlugMapEntry } from "./run-dir";
import { repoRoot } from "./out-dir";

const KR = JSON.parse(readFileSync(path.join(repoRoot(), "scripts/migrate/fixtures/gtp-legacy/known-routes.json"), "utf8")) as KnownRoutes;
const base = { articleId: 1, createdVersion: 1, createdUpdatedAt: "x", baselineVersion: 1, baselineUpdatedAt: "x", legacyCreatedAt: null, legacyUpdatedAt: null };
const E = (legacyId: string, slug: string, status: string, oldUrl: string, oldSection: string, oldSub: string, pillar = oldSection, subSection: string | undefined = oldSub || undefined): SlugMapEntry => ({
  ...base, legacyId, kind: "article", slug, status, oldUrl, oldSection, oldSub, pillar, subSection,
});
const M = { urls: { oldOrigin: "https://www.globaltravelpost.com", articlePathTemplate: "/{section}/{slug}", sectionPaths: {}, extraLegacyPaths: ["/about-us", "/contact-us"] }, archivedAs: "section" as const };

test("C6/G35: published -> /article/<slug>, identity dropped, archived -> NEW section page, re-homed from = ORIGINAL old URL, drafts no rule", () => {
  const b = buildRedirects([
    E("1", "a", "published", "/news/a", "news", "aviation"),
    E("2", "b", "published", "/article/b", "news", "hotels"),
    E("3", "c", "archived", "/news/c", "news", "destination-marketing", "business-of-travel", "destination-marketing"),
    E("4", "d", "published", "/business-of-travel/d", "business-of-travel", "travel-tech", "news", "travel-tech"),
    E("5", "e", "draft", "/news/e", "news", "aviation"),
  ], M, KR);
  assert.deepEqual(b.errors, []);
  const by = Object.fromEntries(b.rules.map((r) => [r.from, r.to]));
  assert.equal(by["/news/a"], "/article/a");
  assert.equal(by["/article/b"], undefined);
  assert.equal(b.counts.identityDropped! >= 1, true);
  assert.equal(by["/news/c"], "/business-of-travel/destination-marketing");
  assert.equal(by["/business-of-travel/d"], "/article/d");
  assert.equal(by["/business-of-travel/travel-tech"], "/news/travel-tech");
  assert.equal(by["/news/e"], undefined);
  assert.equal(by["/about-us"], "/about");
  const { map, rules } = gtpWebFiles(b);
  assert.deepEqual(validateGtpWebRedirectFiles(map, rules, KR), []);
  const g410 = buildRedirects([E("3", "c", "archived", "/news/c", "news", "aviation")], { ...M, archivedAs: "410" }, KR);
  assert.deepEqual(gtpWebFiles(g410).map["/news/c"], { status: 410 });
});

test("C6/G35: chains, dangling targets and colliding old URLs are detected; coverage reported", () => {
  const b = buildRedirects([E("1", "x", "published", "/news/x", "news", ""), E("2", "x-2", "published", "/NEWS/x/", "news", "")], M, KR);
  assert.equal(b.collisions.length, 1);
  assert.deepEqual(b.errors, []);
  const cov = coverage(["https://www.globaltravelpost.com/news/x", "/nope"], b);
  assert.deepEqual([cov.matched, cov.total], [1, 2]);
  assert.ok(validateGtpWebRedirectFiles({ "/a": "/b", "/b": "/article/c" }, [], KR).some((e) => e.startsWith("chain")));
  assert.ok(validateGtpWebRedirectFiles({ "/a": "/nowhere/x/y" }, [], KR).some((e) => e.startsWith("unknown destination")));
  assert.ok(validateGtpWebRedirectFiles({ "/A/": "/news" }, [], KR).some((e) => e.startsWith("key not in normalised")));
  assert.ok(validateGtpWebRedirectFiles({ "/a": "/a" }, [], KR).length > 0);
  assert.ok(validateGtpWebRedirectFiles({ "/a": { status: 404 } }, [], KR).some((e) => e.startsWith("bad value")));
  assert.ok(validateGtpWebRedirectFiles({}, Array.from({ length: 201 }, () => ({ source: "/a/:x", destination: "/b/:x", permanent: true })), KR).length > 0);
});
