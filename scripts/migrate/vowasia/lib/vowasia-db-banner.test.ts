import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_MESSAGES, DbBannerError, legacyBanner, legacySsl } from "./vowasia-db-banner";

const SECRET = "s3cr3t-Pa55";

test("AC-A6: banner is host:port/db only, never user or password", () => {
  const b = legacyBanner(`postgres://vowasia_migrator:${SECRET}@db.example.invalid:6543/legacy?sslmode=require`);
  assert.equal(b.banner, "db.example.invalid:6543/legacy");
  assert.ok(!b.banner.includes(SECRET) && !b.banner.includes("vowasia_migrator"));
  assert.equal(b.local, false);
  assert.equal(legacyBanner("postgres://u:p@127.0.0.1/x").banner, "127.0.0.1:5432/x");
  assert.equal(legacyBanner("postgres://u:p@localhost:54336/x").local, true);
});

test("AC-A6: refusals use fixed messages naming the vowasia env var and never echo the URL", () => {
  for (const [url, msg] of [
    [undefined, BANNER_MESSAGES.missing],
    ["  ", BANNER_MESSAGES.missing],
    [`postgres://u:${SECRET}@/db?host=/var/run/postgresql`, BANNER_MESSAGES.badHost],
    [`postgres://u:${SECRET}@h1,h2/db`, BANNER_MESSAGES.badHost],
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
