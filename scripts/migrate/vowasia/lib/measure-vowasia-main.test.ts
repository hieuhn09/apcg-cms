import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ALLOWED_HOST, BODY_MARK, FAKE_SITE_ID, FakeLegacyClient, TITLE_MARK } from "../fixtures/vowasia-legacy/fake-legacy";
import { OUTSIDE_REPO_MESSAGES } from "./assert-outside-repo";
import { MEASURE_LIMITS, MEASURE_MESSAGES, measureRows, publishableReport, renderMeasure, runMeasure, shapeOf } from "./measure-vowasia-main";
import { repoRoot } from "./out-dir";
import { SNAPSHOT_MESSAGES, runSnapshot } from "./snapshot-vowasia-main";
import { LiveVowasiaReader } from "./vowasia-reader";
import { VowasiaReadOnlyDb } from "./vowasia-sql";

const HERE = path.dirname(new URL(import.meta.url).pathname);

async function makeSnapshot(d: string): Promise<string> {
  const ov = path.join(d, "overlay.json");
  writeFileSync(ov, JSON.stringify({ source: { siteFilter: FAKE_SITE_ID } }));
  const snap = path.join(d, "snap");
  const fake = new FakeLegacyClient();
  await runSnapshot(["--mapping-overlay", ov, "--out", snap], {
    env: { LEGACY_VOWASIA_DB_URL: "postgresql://vowasia_migrator:x@localhost:5432/legacy" },
    log: () => {},
    openReader: (_u, _s, reg, site) => new LiveVowasiaReader(new VowasiaReadOnlyDb(reg, () => fake), site),
  });
  return snap;
}

test("shapeOf describes jsonb shapes without values", () => {
  assert.equal(shapeOf(null), "null");
  assert.equal(shapeOf("hello"), "string");
  assert.equal(shapeOf({ en: "x", vi: "y" }), "object{en,vi}");
  assert.equal(shapeOf('{"en":"x"}'), "string(json:object{en})");
  assert.equal(shapeOf([{ a: 1 }, { b: 2 }, { a: 3 }]), "array<object{a}|object{b}>");
  assert.equal(shapeOf([]), "array<>");
  assert.equal(shapeOf(3), "number");
});

test("should never open a DB connection in measure", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vowasia-measure-"));
  const original = pg.Client.prototype.connect;
  let connects = 0;
  pg.Client.prototype.connect = function () {
    connects++;
    throw new Error("measure must not connect");
  } as typeof original;
  try {
    const snap = await makeSnapshot(d);
    const printed: string[] = [];
    // no legacy URL in the environment at all
    assert.equal(await runMeasure(["--snapshot", snap], { env: {}, log: (l) => printed.push(l) }), 0);
    assert.equal(connects, 0);
    const src = readFileSync(path.join(HERE, "measure-vowasia-main.ts"), "utf8") + readFileSync(path.join(HERE, "..", "measure-vowasia.ts"), "utf8");
    assert.ok(!/from "pg"|vowasia-reader|vowasia-db-banner|LEGACY_VOWASIA_DB_URL/.test(src), "measure imports no DB code");
    const files = readdirSync(snap).filter((f) => f.startsWith("measure-report"));
    assert.deepEqual(files.sort(), ["measure-report.json", "measure-report.md"]);
    for (const f of files) assert.equal(statSync(path.join(snap, f)).mode & 0o777, 0o600);
    const all = printed.join("\n") + files.map((f) => readFileSync(path.join(snap, f), "utf8")).join("\n");
    for (const needle of [TITLE_MARK, BODY_MARK, FAKE_SITE_ID, ALLOWED_HOST, "other.example.invalid", "author1@example.invalid"]) assert.ok(!all.includes(needle), needle);
  } finally {
    pg.Client.prototype.connect = original;
    rmSync(d, { recursive: true, force: true });
  }
});

test("measure reports Q2 shapes, Q3 image paths, KB-2 pairs and the tags column", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vowasia-measure-"));
  try {
    const snap = await makeSnapshot(d);
    const ov = path.join(d, "ov.json");
    writeFileSync(ov, JSON.stringify({ source: { siteFilter: FAKE_SITE_ID }, media: { hostAllowlist: [ALLOWED_HOST] } }));
    await runMeasure(["--snapshot", snap, "--mapping-overlay", ov, "--out", path.join(d, "m")], { env: {}, log: () => {} });
    const r = JSON.parse(readFileSync(path.join(d, "m", "measure-report.json"), "utf8"));
    assert.equal(r.articles, 8);
    assert.deepEqual(r.status, { archived: 1, draft: 1, published: 5, rejected: 1 });
    assert.equal(r.title["object{en}"], 8);
    assert.deepEqual(r.excerpt, { "object{en}": 7, string: 1 });
    assert.equal(r.body.container["array<object{body,heading}>"], 6);
    assert.equal(r.body.container["string(json:array<object{image}>)"], 1);
    // image URL positions: allow-listed vs other, by normalised JSON path; never the host name
    assert.equal(r.body.urlPaths["[].pic.src"].allowlisted, 1);
    assert.equal(r.body.urlPaths["[].body"].allowlisted, 1);
    assert.equal(r.body.urlPaths["[].body"].other, 2);
    assert.equal(r.body.urlPaths["(json)[].image"].allowlisted, 1);
    assert.equal(r.body.articlesWithAllowlistedImage, 2);
    // KB-2 cross table with the C8 verdict
    assert.deepEqual(r.pairs["venues|"], { n: 1, verdict: "venues" });
    // unmapped pairs are printed as a short hash only (G22 M5): the raw legacy values never appear
    assert.ok(!("venues|honeymoons" in r.pairs));
    assert.ok(Object.entries(r.pairs).some(([k, v]) => /^unmapped:[0-9a-f]{10}$/.test(k) && (v as { verdict: string }).verdict.startsWith("REJECT")));
    assert.deepEqual(r.pairs["wedding-business|people"], { n: 1, verdict: "wedding-business/people-planners" });
    assert.deepEqual(r.pairs["style|rings-jewelry"], { n: 1, verdict: "style/rings-jewellery" });
    assert.equal(r.pairs["style|beauty"].n, 3);
    assert.deepEqual(r.tags.shape, { "array<string>": 7, "array<>": 1 });
    assert.deepEqual(r.tags.values, { "fixture-tag": 7 });
    assert.equal(r.dates.withoutPublishedAt, 1);
    assert.equal(r.images.featured.missing, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("measure refuses a tampered snapshot and an --out inside the repo", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vowasia-measure-"));
  try {
    const snap = await makeSnapshot(d);
    await assert.rejects(runMeasure(["--snapshot", snap, "--out", path.join(repoRoot(), "scripts", "migrate", "out", "vowasia-measure-probe")], { env: {}, log: () => {} }), { message: OUTSIDE_REPO_MESSAGES.inside });
    writeFileSync(path.join(snap, "snapshot.ndjson"), readFileSync(path.join(snap, "snapshot.ndjson"), "utf8") + "\n");
    await assert.rejects(runMeasure(["--snapshot", snap], { env: {}, log: () => {} }), { message: SNAPSHOT_MESSAGES.snapshotDigest });
    await assert.rejects(runMeasure([], { env: {}, log: () => {} }), { message: MEASURE_MESSAGES.needSnapshot });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("measureRows is pure (no I/O) and tolerates odd rows", () => {
  const r = measureRows([{ status: null, section: null, subsection: null, title: null, excerpt: null, body_sections: null, tags: null, featured_image: "" }], { status: "status", section: "section", subsection: "subsection", title: "title", excerpt: "excerpt", body: "body_sections", tags: "tags", image: "featured_image", publishedAt: "published_at" }, () => false);
  assert.equal(r.articles, 1);
  assert.equal(r.title.null, 1);
  assert.ok(r.pairs["(null)|(null)"]?.verdict.startsWith("REJECT") === true);
});

/* ── Fix cycle 1 (G22 review M4-M6, N3) ────────────────────────────────── */

const ROLES = { status: "status", section: "section", subsection: "subsection", title: "title", excerpt: "excerpt", body: "body_sections", tags: "tags", image: "featured_image", publishedAt: "published_at" };

test("M4: __proto__ / constructor values are counted and never touch Object.prototype", () => {
  const protoKeys = Object.getOwnPropertyNames(Object.prototype).sort();
  const rows = [
    { status: "__proto__", section: "__proto__", subsection: "constructor", title: "t", excerpt: "e", tags: ["__proto__", "constructor", "toString"], body_sections: '{"__proto__":{"src":"https://x.example.invalid/a.jpg"}}', featured_image: "" },
    { status: "__proto__", section: "constructor", subsection: "", title: "t", excerpt: "e", tags: ["__proto__"], body_sections: null, featured_image: "" },
    { status: "constructor", section: "style", subsection: "beauty", title: "t", excerpt: "e", tags: "constructor,hasOwnProperty", body_sections: null, featured_image: "" },
  ];
  const r = measureRows(rows, ROLES, () => false);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoKeys);
  assert.equal(({} as Record<string, unknown>).src, undefined);
  assert.equal(r.status["__proto__"], 2);
  assert.equal(r.status["constructor"], 1);
  assert.equal(r.tags.values["__proto__"], 2);
  assert.equal(r.tags.values["constructor"], 2);
  assert.equal(r.tags.values["toString"], 1);
  assert.equal(r.pairs["__proto__|constructor"]?.n, 1);
  assert.equal(r.pairs["constructor|"]?.n, 1);
  assert.equal(r.body.urlPaths["(json).__proto__.src"]?.other, 1);
});

test("M5: printed categorical values are capped (length and count) and unmapped pairs are hashed", async () => {
  const long = "x".repeat(500);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 80; i++) rows.push({ status: `${long}-${i}`, section: `secret-section-${i}`, subsection: "", title: "t", excerpt: "e", tags: [`tag-${i}`], body_sections: null, featured_image: "" });
  rows.push({ status: "published", section: "style", subsection: "beauty", title: "t", excerpt: "e", tags: [{ secret: "SECRET-IN-TAG" }], body_sections: null, featured_image: "" });
  const pub = publishableReport(measureRows(rows, ROLES, () => false));
  const md = renderMeasure(pub, "0".repeat(64), false);
  assert.ok(Object.keys(pub.status).length <= MEASURE_LIMITS.topN, "top N only");
  for (const k of Object.keys(pub.status)) assert.ok(k.length <= MEASURE_LIMITS.valueChars + 1, k);
  assert.ok(pub.truncated.includes("status"));
  assert.match(md, /## status \(truncated/);
  assert.ok(!md.includes(long));
  // unmapped (REJECT) pairs: count + short hash, never the raw legacy values
  assert.ok(!md.includes("secret-section-"));
  assert.ok(!JSON.stringify(pub.pairs).includes("secret-section-"));
  assert.ok(Object.keys(pub.pairs).some((k) => /^unmapped:[0-9a-f]{10}$/.test(k)));
  assert.equal(pub.pairs["style|beauty"]?.verdict, "style/beauty");
  // tags values are withheld when the column is not an array of short strings
  assert.equal(Object.keys(pub.tags.values).length, 0);
  assert.equal(pub.tags.valuesWithheld, true);
  assert.ok(!md.includes("SECRET-IN-TAG"));
});

test("M6: relative and protocol-relative image references are counted; URLs with balanced parentheses are kept whole", () => {
  const rows = [
    {
      status: "published", section: "style", subsection: "beauty", title: "t", excerpt: "e", tags: [],
      body_sections: [
        { body: `<p><img src="/media/a.jpg"> <img src='//cdn.example.invalid/b.png'> https://img.example.invalid/photo(1).jpg</p>` },
        { image: "/uploads/c.webp" },
        { image: "//cdn.example.invalid/d.jpg" },
      ],
      featured_image: "/uploads/cover.jpg",
    },
    { status: "published", section: "style", subsection: "beauty", title: "t", excerpt: "e", tags: [], body_sections: null, featured_image: "//cdn.example.invalid/cover.jpg" },
  ];
  const seen: string[] = [];
  const r = measureRows(rows, ROLES, (u) => {
    seen.push(u);
    return u.startsWith("https://img.example.invalid/");
  });
  assert.deepEqual(seen, ["https://img.example.invalid/photo(1).jpg"]);
  assert.equal(r.body.relativeRefs, 2);
  assert.equal(r.body.protocolRelativeRefs, 2);
  assert.equal(r.images.featured.relative, 1);
  assert.equal(r.images.featured.protocolRelative, 1);
  assert.equal(r.images.featured.other, 0);
});

test("N3: measure validates the snapshot before creating --out", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vowasia-measure-"));
  try {
    const out = path.join(d, "never-created");
    await assert.rejects(runMeasure(["--snapshot", path.join(d, "no-such-snap"), "--out", out], { env: {}, log: () => {} }), { message: SNAPSHOT_MESSAGES.noSnapshot });
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(d, "no-such-snap")), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
