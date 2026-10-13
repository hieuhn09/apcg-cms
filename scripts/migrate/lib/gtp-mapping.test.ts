import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { KEY_TABLE, MAPPING_MESSAGES, OVERLAY_KEYS, loadMapping, readJson, schemaKeys, validateMapping, formatProvisional } from "./gtp-mapping";
import { SQL_MESSAGES } from "./legacy-sql";
import { repoRoot } from "./out-dir";

const ROOT = repoRoot();
const STRUCT = path.join(ROOT, "scripts/migrate/legacy-mapping.gtp-network.json");
const OVERLAY = path.join(ROOT, "scripts/migrate/fixtures/gtp-legacy/overlay.fixture.json");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

test("C2/G41: the committed structural mapping passes --structural-only and carries no site id or host", () => {
  const raw = readJson(STRUCT) as Record<string, unknown>;
  const r = validateMapping(raw, undefined, { structuralOnly: true });
  assert.ok(r.provisional.length > 0);
  assert.equal(r.mapping.source.siteFilter, undefined);
  assert.equal(r.mapping.media.hostAllowlist, undefined);
  const text = JSON.stringify(raw);
  assert.doesNotMatch(text, /00000000-0000-0000-0000-000000000001/);
  assert.doesNotMatch(text, /supabase\.co/);
  assert.throws(() => validateMapping(raw, undefined), { message: MAPPING_MESSAGES.overlayRequired });
});

test("C2/G41: merged fixture mapping deep-equals the structural one except the three overlay-owned keys", () => {
  const merged = loadMapping(STRUCT, OVERLAY).mapping as unknown as Record<string, Record<string, unknown>>;
  const structural = validateMapping(readJson(STRUCT), undefined, { structuralOnly: true }).mapping as unknown as Record<string, Record<string, unknown>>;
  assert.equal(merged.source?.siteFilter, "00000000-0000-0000-0000-00000000f001");
  assert.deepEqual(merged.media?.hostAllowlist, ["images.fixture.invalid"]);
  const strip = (m: Record<string, Record<string, unknown>>) => {
    const c = clone(m);
    for (const k of OVERLAY_KEYS) {
      const [a, b] = k.split(".") as [string, string];
      delete (c[a] as Record<string, unknown>)[b];
    }
    return c;
  };
  assert.deepEqual(strip(merged), strip(structural));
});

test("C2/G46: provisional passes with a printed list; --require-final exits with markers and passes without", () => {
  const raw = readJson(STRUCT);
  const ov = readJson(OVERLAY);
  const r = validateMapping(raw, ov);
  assert.match(formatProvisional(r.provisional), /urls\.articlePathTemplate .*OD-24/);
  assert.throws(() => validateMapping(raw, ov, { requireFinal: true }), { message: MAPPING_MESSAGES.requireFinal });
  const fin = clone(raw) as Record<string, unknown>;
  fin._provisional = [];
  assert.equal(validateMapping(fin, ov, { requireFinal: true }).provisional.length, 0);
  delete fin._provisional;
  validateMapping(fin, ov, { requireFinal: true });
});

test("C2/G46: literal TODO fails; a foreign _provisional key fails; unknown keys fail", () => {
  const raw = readJson(STRUCT) as Record<string, Record<string, unknown>>;
  const ov = readJson(OVERLAY);
  const t = clone(raw);
  (t.urls as Record<string, unknown>).oldOrigin = "TODO";
  assert.throws(() => validateMapping(t, ov), { message: MAPPING_MESSAGES.todo });
  const p = clone(raw) as Record<string, unknown>;
  p._provisional = ["source.schema"];
  assert.throws(() => validateMapping(p, ov), { message: MAPPING_MESSAGES.provisionalForeign });
  const u = clone(raw) as Record<string, unknown>;
  u.subscribers = { enabled: true };
  assert.throws(() => validateMapping(u, ov), /schema error/);
  const u2 = clone(raw);
  (u2.body as Record<string, unknown>).joins = [];
  assert.throws(() => validateMapping(u2, ov), /schema error/);
});

test("C2: pillar outside the 6, press-room sub-section, author outside staff, createMissing all rejected", () => {
  const raw = readJson(STRUCT) as Record<string, Record<string, unknown>>;
  const ov = readJson(OVERLAY);
  const a = clone(raw);
  (a.categories as { map: Record<string, unknown> }).map["x/y"] = { pillar: "lifestyle" };
  assert.throws(() => validateMapping(a, ov), { message: MAPPING_MESSAGES.pillar("lifestyle") });
  const b = clone(raw);
  (b.categories as { map: Record<string, unknown> }).map["x/y"] = { pillar: "press-room", subSection: "x" };
  assert.throws(() => validateMapping(b, ov), { message: MAPPING_MESSAGES.pressRoomSub });
  const c = clone(raw);
  (c.authors as { map: Record<string, string> }).map["Simon Ng"] = "Simon Ng";
  assert.throws(() => validateMapping(c, ov), { message: MAPPING_MESSAGES.author("Simon Ng") });
  const d = clone(raw);
  (d.authors as Record<string, unknown>).createMissing = true;
  assert.throws(() => validateMapping(d, ov), { message: MAPPING_MESSAGES.createMissing });
});

test("C2/G47: zod schema keys equal the A12-N11 key table; overlay only three keys; non-local rewrite refused", () => {
  assert.deepEqual([...schemaKeys()].sort(), [...KEY_TABLE].sort());
  const raw = readJson(STRUCT);
  assert.throws(() => validateMapping(raw, { source: { siteFilter: "00000000-0000-0000-0000-00000000f001", schema: "x" }, media: { hostAllowlist: ["a"] } }), { message: MAPPING_MESSAGES.overlayForeign });
  assert.throws(() => validateMapping(raw, { source: { siteFilter: "00000000-0000-0000-0000-00000000f001" }, media: { hostAllowlist: ["a"], hostRewrite: { a: "evil.example.com:80" } } }), { message: MAPPING_MESSAGES.rewriteNotLocal });
  const s = clone(raw) as Record<string, Record<string, unknown>>;
  (s.source as Record<string, unknown>).siteFilter = "00000000-0000-0000-0000-00000000f001";
  assert.throws(() => validateMapping(s, undefined, { structuralOnly: true }), { message: MAPPING_MESSAGES.structuralHasOverlayKey });
});

test("C1/G45 (A13-R08): a foreign table in source.tableAllowList is a mapping validation error", () => {
  const raw = readJson(STRUCT) as Record<string, Record<string, unknown>>;
  const x = clone(raw);
  (x.source as Record<string, unknown>).tableAllowList = ["articles", "secret_table_a"];
  assert.throws(() => validateMapping(x, readJson(OVERLAY)), { message: SQL_MESSAGES.allowListForeign });
  (x.source as Record<string, unknown>).tableAllowList = [];
  assert.throws(() => validateMapping(x, readJson(OVERLAY)), { message: SQL_MESSAGES.allowListEmpty });
});
