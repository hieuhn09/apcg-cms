import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_MESSAGES, DbBannerError, legacyBanner, legacySsl, sslLabel } from "./vowasia-db-banner";

const SECRET = "s3cr3t-Pa55";

test("AC-A6: banner is host:port/db only, never user or password", () => {
  const b = legacyBanner(`postgres://vowasia_migrator:${SECRET}@db.example.invalid:6543/legacy`);
  assert.equal(b.banner, "db.example.invalid:6543/legacy");
  assert.ok(!b.banner.includes(SECRET) && !b.banner.includes("vowasia_migrator"));
  assert.equal(b.local, false);
  assert.equal(legacyBanner("postgres://vowasia_migrator:p@127.0.0.1/x").banner, "127.0.0.1:5432/x");
  assert.equal(legacyBanner("postgres://vowasia_migrator:p@localhost:54336/x").local, true);
});

test("AC-A6: refusals use fixed messages naming the vowasia env var and never echo the URL", () => {
  for (const [url, msg] of [
    [undefined, BANNER_MESSAGES.missing],
    ["  ", BANNER_MESSAGES.missing],
    [`postgres://vowasia_migrator:${SECRET}@/db?host=/var/run/postgresql`, BANNER_MESSAGES.badHost],
    [`postgres://vowasia_migrator:${SECRET}@h1,h2/db`, BANNER_MESSAGES.badHost],
  ] as const) {
    assert.throws(() => legacyBanner(url), (e: unknown) => e instanceof DbBannerError && e.message === msg && !e.message.includes(SECRET));
  }
  assert.ok(BANNER_MESSAGES.missing.includes("LEGACY_VOWASIA_DB_URL"));
  assert.ok(!Object.values(BANNER_MESSAGES).some((m) => m.includes("GTP")));
});

test("SSL from LEGACY_VOWASIA_DB_SSL / _CA (GTP variables are ignored)", () => {
  assert.equal(legacySsl({}, true), false);
  assert.deepEqual(legacySsl({}, false), { rejectUnauthorized: false });
  assert.deepEqual(legacySsl({ LEGACY_VOWASIA_DB_SSL: "verify-full", LEGACY_VOWASIA_DB_CA: "CA" }, false), { rejectUnauthorized: true, ca: "CA" });
  assert.equal(legacySsl({ LEGACY_VOWASIA_DB_SSL: "disable" }, false), false);
  assert.deepEqual(legacySsl({ LEGACY_GTP_DB_SSL: "disable" }, false), { rejectUnauthorized: false });
  assert.throws(() => legacySsl({ LEGACY_VOWASIA_DB_SSL: "prefer" }, false), { message: BANNER_MESSAGES.badSsl });
});

test("m6: only the vowasia_migrator credential is accepted (fixed message, no echo)", () => {
  for (const u of ["postgres", "gtp_migrator", "owner", ""]) {
    const url = `postgres://${u}${u ? `:${SECRET}` : ""}@db.example.invalid/legacy`;
    assert.throws(() => legacyBanner(url), (e: unknown) => e instanceof DbBannerError && e.message === BANNER_MESSAGES.badUser && !e.message.includes(SECRET));
  }
});

test("m7: SSL settings inside the URL are refused (they would silently override LEGACY_VOWASIA_DB_SSL)", () => {
  for (const q of ["sslmode=disable", "sslmode=require", "ssl=false", "sslrootcert=x", "SSLMODE=disable"]) {
    assert.throws(() => legacyBanner(`postgres://vowasia_migrator:${SECRET}@db.example.invalid/legacy?${q}`), { message: BANNER_MESSAGES.sslInUrl });
  }
  assert.equal(legacyBanner("postgres://vowasia_migrator:p@db.example.invalid/legacy?application_name=x").banner, "db.example.invalid:5432/legacy");
});

test("m7: the effective SSL mode is printable for the banner", () => {
  assert.equal(sslLabel(false), "ssl off");
  assert.equal(sslLabel({ rejectUnauthorized: false }), "ssl require (certificate not verified)");
  assert.equal(sslLabel({ rejectUnauthorized: true }), "ssl verify-full");
  assert.equal(sslLabel({ rejectUnauthorized: true, ca: "x" }), "ssl verify-full (custom CA)");
});

test("Amendment 1: Supabase session-pooler login vowasia_migrator.<20 x [a-z0-9]> is accepted; project ref never printed", () => {
  const REF = "abcdefghijklmnopqrst";
  const b = legacyBanner(`postgres://vowasia_migrator.${REF}:${SECRET}@aws-0-xx.pooler.example.invalid:5432/postgres`);
  assert.equal(b.banner, "aws-0-xx.pooler.example.invalid:5432/postgres");
  assert.ok(!b.banner.includes(REF) && !b.banner.includes("vowasia_migrator") && !b.banner.includes(SECRET));
  assert.ok(!JSON.stringify(b).includes(REF), "no field of the result carries the project ref");
  for (const u of [
    "vowasia_migrator.short",
    "postgres.abcdefghijklmnopqrst",
    "vowasia_migrator.ABCDEFGHIJKLMNOPQRST",
    "vowasia_migrator.abcdefghijklmnopqrst.x",
    "vowasia_migrator.abcdefghijklmnopqrstu",
    "vowasia_migrator.",
    "xvowasia_migrator.abcdefghijklmnopqrst",
    "",
  ]) {
    const url = `postgres://${u}${u ? `:${SECRET}` : ""}@pooler.example.invalid:5432/postgres`;
    assert.throws(
      () => legacyBanner(url),
      (e: unknown) => e instanceof DbBannerError && e.message === BANNER_MESSAGES.badUser && !e.message.includes(SECRET) && !e.message.includes("abcdefghijklmnopqrst"),
      u,
    );
  }
});
