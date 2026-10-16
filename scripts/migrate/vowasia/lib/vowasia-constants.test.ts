import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CENTRAL_DB_PATHNAME, LEGACY_SITE_SLUG, LEGACY_URL_ENV, MARKER_ORIGIN, MARKER_SOURCE_NAME, TENANT_SLUG } from "./vowasia-constants";

const GTP_MARKER = "legacy:globaltravelpost";

test("AC-A7: should use marker legacy:vowasia that differs from GTP and never contains globaltravelpost", () => {
  assert.equal(MARKER_SOURCE_NAME, "legacy:vowasia");
  assert.notEqual(MARKER_SOURCE_NAME, GTP_MARKER);
  assert.ok(!MARKER_SOURCE_NAME.includes("globaltravelpost"));
  assert.ok(!GTP_MARKER.startsWith(MARKER_SOURCE_NAME) && !MARKER_SOURCE_NAME.startsWith(GTP_MARKER));
  assert.equal(MARKER_ORIGIN, "import");
});

test("AC-A7: the GTP marker in the GTP importer is still the GTP one (no shared constant)", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const gtp = readFileSync(path.resolve(here, "..", "..", "lib", "import-gtp-main.ts"), "utf8");
  assert.ok(gtp.includes(GTP_MARKER));
  assert.ok(!gtp.includes(MARKER_SOURCE_NAME));
});

test("tenant, site slug, Central db name and env name are the vowasia ones", () => {
  assert.equal(TENANT_SLUG, "vowasia");
  assert.equal(LEGACY_SITE_SLUG, "vowasia");
  assert.equal(CENTRAL_DB_PATHNAME, "/neondb");
  assert.equal(LEGACY_URL_ENV, "LEGACY_VOWASIA_DB_URL");
  assert.ok(!LEGACY_URL_ENV.includes("GTP"));
});
