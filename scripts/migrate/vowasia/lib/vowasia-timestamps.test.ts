import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { generateVowasiaTimestampsFix } from "./vowasia-timestamps";

const HERE = path.dirname(new URL(import.meta.url).pathname);

test("should generate timestamps-fix.sql matching the golden file", () => {
  const r = generateVowasiaTimestampsFix(
    [
      { slug: "hello-world", articleId: 41, legacyCreatedAt: "2025-08-01T01:02:03.000Z", legacyUpdatedAt: "2025-08-02T04:05:06.000Z" },
      { slug: "no-times", articleId: 42, legacyCreatedAt: null, legacyUpdatedAt: null },
      { slug: "Bad'Slug", articleId: 43, legacyCreatedAt: "2025-08-01T00:00:00.000Z", legacyUpdatedAt: null },
    ],
    { runId: "golden" },
  );
  assert.equal(r.sql, readFileSync(path.join(HERE, "golden-vowasia-timestamps-fix.sql"), "utf8"));
  assert.deepEqual(r.baseline, { "hello-world": "2025-08-02T04:05:06.000Z" });
  assert.deepEqual(r.counts, { entries: 3, blocks: 1, skipped: 2 });
});

test("every block is scoped to marker + tenant vowasia + the journaled id of THIS run; header is OWNER-RUN with ON_ERROR_STOP", () => {
  const r = generateVowasiaTimestampsFix([{ slug: "a-b", articleId: 7, legacyCreatedAt: "2025-01-01T00:00:00Z", legacyUpdatedAt: "2025-01-02T00:00:00Z" }], { runId: "run-A" });
  assert.match(r.sql, /^-- timestamps-fix\.sql: OWNER-RUN ONLY/);
  assert.match(r.sql, /psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix\.sql/);
  assert.match(r.sql, /a\.id = 7 AND/);
  assert.match(r.sql, /a\.engine_source_name = 'legacy:vowasia'/);
  assert.match(r.sql, /slug = 'vowasia'/);
  assert.doesNotMatch(r.sql, /globaltravelpost|'gtp'/);
  assert.throws(() => generateVowasiaTimestampsFix([{ slug: "x", articleId: "7; DROP", legacyCreatedAt: null, legacyUpdatedAt: "2025-01-01T00:00:00Z" }], { runId: "r" }), /article id/);
  assert.throws(() => generateVowasiaTimestampsFix([], { runId: "bad id" }), /run id/);
});
