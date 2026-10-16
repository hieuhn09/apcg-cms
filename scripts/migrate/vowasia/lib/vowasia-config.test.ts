import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_MESSAGES, ConfigError, isValidSiteId, loadSourceConfig, mergeOverlay, parseSourceConfig, withSiteFilter } from "./vowasia-config";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = path.resolve(HERE, "..", "legacy-source.vowasia.json");
const OVERLAY = path.resolve(HERE, "..", "fixtures", "overlay.fixture.json");
const base = (): Record<string, unknown> => JSON.parse(readFileSync(BASE, "utf8"));
const SITE = "00000000-0000-0000-0000-00000000f002";

function withSource(patch: Record<string, unknown>, filter = true): unknown {
  return mergeOverlay(base(), { source: { ...(filter ? { siteFilter: SITE } : {}), ...patch } });
}

test("T6c: the committed hypothesis passes zod, has no TODO, no site filter, exactly 2 tables", () => {
  const raw = readFileSync(BASE, "utf8");
  assert.ok(!/todo/i.test(raw));
  const cfg = parseSourceConfig(JSON.parse(raw));
  assert.equal(cfg.source.siteFilter, undefined);
  assert.deepEqual(Object.keys(cfg.source.tables).sort(), ["articles", "sites"]);
  assert.equal(cfg.source.expectedSiteSlug, "vowasia");
  assert.equal(cfg._hypothesis, true);
});

test("T6c: the fixture overlay merged on the hypothesis passes zod and renames columns", () => {
  const cfg = loadSourceConfig(BASE, OVERLAY, { requireSiteFilter: true });
  assert.equal(cfg.source.schema, "vowasia_ro");
  assert.equal(cfg.source.columnRoles.createdAt, "inserted_at");
  assert.equal(cfg.source.tables.articles?.createdAtColumn, "inserted_at");
  assert.equal(cfg.source.tables.articles?.siteColumn, "site_id");
});

test("unknown keys are refused (top level, source, table, roles)", () => {
  assert.throws(() => parseSourceConfig({ ...base(), extra: 1 }), ConfigError);
  assert.throws(() => parseSourceConfig(withSource({ extra: 1 })), ConfigError);
  assert.throws(() => parseSourceConfig(withSource({ tables: { articles: { foo: "x" } } })), ConfigError);
  assert.throws(() => parseSourceConfig(withSource({ columnRoles: { author: "x" } })), ConfigError);
});

test("any TODO (value or key, any case) is refused with the fixed message", () => {
  assert.throws(() => parseSourceConfig(withSource({ schema: "todo_schema" })), { message: CONFIG_MESSAGES.todo });
  assert.throws(() => parseSourceConfig(mergeOverlay(base(), { _note: "TODO fill" })), { message: CONFIG_MESSAGES.todo });
});

test("bad identifiers (uppercase, camelCase, space, quote) are refused with the fixed amendment message", () => {
  for (const bad of ["Articles", "createdAt", "my table", 'a"b', "1abc", "a-b"]) {
    assert.throws(() => parseSourceConfig(withSource({ tables: { articles: { name: bad } } })), { message: CONFIG_MESSAGES.ident }, bad);
    assert.throws(() => parseSourceConfig(withSource({ columnRoles: { title: bad } })), { message: CONFIG_MESSAGES.ident }, bad);
  }
  assert.throws(() => parseSourceConfig(withSource({ schema: "Public" })), { message: CONFIG_MESSAGES.ident });
});

test("more than 6 tables is refused; 6 is accepted", () => {
  const t = { name: "x", siteColumn: "site_id", keyColumns: ["id"], createdAtColumn: null };
  const four = { t1: t, t2: t, t3: t, t4: t };
  parseSourceConfig(withSource({ tables: four }));
  assert.throws(() => parseSourceConfig(withSource({ tables: { ...four, t5: t } })), ConfigError);
});

test("articles and sites are both required", () => {
  const raw = base() as { source: { tables: Record<string, unknown> } };
  delete raw.source.tables.sites;
  assert.throws(() => parseSourceConfig(raw), ConfigError);
});

test("siteIdKind must be uuid, integer or text-safe", () => {
  assert.throws(() => parseSourceConfig(withSource({ siteIdKind: "bigint" })), ConfigError);
  for (const kind of ["uuid", "integer", "text-safe"]) parseSourceConfig(withSource({ siteIdKind: kind }, false));
});

test("site filter is validated against its kind; missing filter refused when required", () => {
  assert.throws(() => parseSourceConfig(withSource({ siteIdKind: "integer" })), { message: CONFIG_MESSAGES.badSiteId });
  parseSourceConfig(withSource({ siteIdKind: "integer", siteFilter: "42" }, false));
  assert.throws(() => parseSourceConfig(withSource({ siteIdKind: "text-safe", siteFilter: "a'b" }, false)), { message: CONFIG_MESSAGES.badSiteId });
  assert.throws(() => parseSourceConfig(withSource({}, false), { requireSiteFilter: true }), { message: CONFIG_MESSAGES.noSiteFilter });
  const cfg = parseSourceConfig(withSource({}, false));
  assert.equal(withSiteFilter(cfg, SITE).source.siteFilter, SITE);
  assert.throws(() => withSiteFilter(cfg, "1; DROP"), { message: CONFIG_MESSAGES.badSiteId });
});

test("isValidSiteId per kind", () => {
  assert.ok(isValidSiteId("uuid", SITE));
  assert.ok(!isValidSiteId("uuid", "42"));
  assert.ok(isValidSiteId("integer", "9007199254740993"));
  assert.ok(!isValidSiteId("integer", "-1"));
  assert.ok(!isValidSiteId("integer", "1234567890123456789"));
  assert.ok(isValidSiteId("text-safe", "vow_asia-1"));
  assert.ok(!isValidSiteId("text-safe", "vow asia"));
  assert.ok(!isValidSiteId("text-safe", 42));
});

test("optional media block: shape validated, accepted in phase A", () => {
  parseSourceConfig(mergeOverlay(base(), { media: { hostAllowlist: ["img.example.invalid"], hostRewrite: { "a.example.invalid": "b.example.invalid" } } }));
  assert.throws(() => parseSourceConfig(mergeOverlay(base(), { media: { hostAllowlist: "x" } })), ConfigError);
  assert.throws(() => parseSourceConfig(mergeOverlay(base(), { media: { other: 1 } })), ConfigError);
});

test("an unreadable config file gives the fixed message", () => {
  assert.throws(() => loadSourceConfig(path.join(HERE, "does-not-exist.json"), undefined), { message: CONFIG_MESSAGES.unreadable });
});

test("m6: expectedSiteSlug is locked to the vowasia slug (an overlay cannot point discover at another site)", () => {
  for (const slug of ["gtp", "vowasia-2", "other"]) {
    assert.throws(() => parseSourceConfig(withSource({ expectedSiteSlug: slug })), { message: CONFIG_MESSAGES.badSlug });
  }
  assert.equal(parseSourceConfig(withSource({ expectedSiteSlug: "vowasia" })).source.expectedSiteSlug, "vowasia");
});
