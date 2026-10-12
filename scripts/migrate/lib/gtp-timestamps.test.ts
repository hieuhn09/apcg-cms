import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateTimestampsFix, TimestampsError } from "./gtp-timestamps";
import { repoRoot } from "./out-dir";

const E = (slug: string, c: string | null = "2026-08-01T01:02:03Z", u: string | null = "2026-08-02T04:05:06Z") => ({ slug, kind: "article", legacyCreatedAt: c, legacyUpdatedAt: u });

test("C13/G54 unit: only SQL-safe slugs are emitted; quote, uppercase, space, ; and -- refused and counted", () => {
  const bad = ["it's", "Upper", "a b", "x;y", "a--b'", "-lead"];
  const out = generateTimestampsFix([E("good-slug"), ...bad.map((b) => E(b))], { tenantSlug: "gtp", runId: "r1" });
  assert.equal(out.counts.blocks, 1);
  assert.equal(out.counts.slugNotSqlSafe, bad.length);
  for (const b of bad) assert.ok(!out.sql.includes(`'${b}'`), b);
  assert.deepEqual(out.skipped.map((s) => s.slug), bad);
});

test("C13/G54 unit: every UPDATE carries tenant, origin, engine_source_name and _locale en predicates; one BEGIN, one COMMIT; Date literals; raise guards", () => {
  const out = generateTimestampsFix([E("a-1"), E("b-2", null, "2026-01-01"), E("c-3", "2026-01-05", null)], { tenantSlug: "gtp", runId: "r1" });
  const updates = out.sql.split("UPDATE ").slice(1);
  assert.equal(updates.length, 6);
  for (const u of updates) {
    assert.match(u, /\(SELECT id FROM tenants WHERE slug = 'gtp'\)/);
    assert.match(u, /a\.origin = 'import' AND a\.engine_source_name = 'legacy:globaltravelpost'/);
    assert.match(u, /l\._locale = 'en'/);
  }
  assert.equal(out.sql.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(out.sql.match(/^COMMIT;$/gm)?.length, 1);
  assert.equal(out.sql.match(/expected 1 article row/g)?.length, 3);
  assert.equal(out.sql.match(/expected 1 latest version row/g)?.length, 3);
  assert.match(out.sql, /created_at = TIMESTAMPTZ '2026-08-01T01:02:03\.000Z', updated_at = TIMESTAMPTZ '2026-08-02T04:05:06\.000Z'/);
  assert.match(out.sql, /SET updated_at = TIMESTAMPTZ '2026-01-01T00:00:00\.000Z' FROM/); // b-2 only updated
  assert.match(out.sql, /SET created_at = TIMESTAMPTZ '2026-01-05T00:00:00\.000Z' FROM/); // c-3 only created
  assert.doesNotMatch(out.sql, /SET[^;]*\bversion\s*=/);
  assert.match(out.sql, /v\.latest = true/);
  assert.match(out.sql, /OWNER-RUN ONLY, never executed by tools/);
  assert.match(out.sql, /psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix\.sql/);
  assert.deepEqual(out.baseline, { "a-1": "2026-08-02T04:05:06.000Z", "b-2": "2026-01-01T00:00:00.000Z" });
});

test("C13 (E13): accounting identity blocks + slugNotSqlSafe + timestampsNoSource = entries (events included)", () => {
  const entries = [E("a"), E("Bad"), E("ev-1", null, null), { slug: "ev-2", kind: "event", legacyCreatedAt: null, legacyUpdatedAt: "2026-02-02" }, E("z", "garbage", "also-garbage")];
  const out = generateTimestampsFix(entries, { tenantSlug: "gtp", runId: "r" });
  assert.equal(out.counts.blocks + out.counts.slugNotSqlSafe + out.counts.timestampsNoSource, entries.length);
  assert.equal(out.counts.timestampsNoSource, 2);
});

test("C13: golden one-slug file snapshot", () => {
  const out = generateTimestampsFix([E("hello-world")], { tenantSlug: "gtp", runId: "golden" });
  const golden = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "golden-timestamps-fix.sql"), "utf8");
  assert.equal(out.sql, golden);
});

test("C13: unsafe tenant slug or run id refused", () => {
  assert.throws(() => generateTimestampsFix([], { tenantSlug: "gtp'", runId: "r" }), TimestampsError);
  assert.throws(() => generateTimestampsFix([], { tenantSlug: "gtp", runId: "r*/x" }), TimestampsError);
});

test("C13 (E15): no module under scripts/migrate/*.ts or lib/*.ts reads timestamps-fix.sql back; the only executor is rehearse-assert.ts behind assertLocalDb", () => {
  const dir = path.join(repoRoot(), "scripts/migrate");
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f)),
    ...readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(dir, "lib", f)),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("timestamps-fix.sql")) continue;
    assert.doesNotMatch(src, /(readFileSync|createReadStream)\([^)]*timestamps-fix|\.query\([^)]*timestamps/, f);
  }
  const harness = path.join(dir, "fixtures/gtp-legacy/rehearse-assert.ts");
  if (existsSync(harness)) {
    const src = readFileSync(harness, "utf8");
    assert.match(src, /assertLocalDb\(/);
  }
});
