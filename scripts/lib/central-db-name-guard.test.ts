/**
 * Unit tests for ./central-db-name-guard (Node's built-in runner; pure, no DB).
 *
 *   npm run test:single-home
 *
 * The database-NAME check that owner-run production scripts run on top of the
 * host-only local-db guard (incident 13-10-26: right Neon server, wrong
 * database `gcv_payload_disabled`). Cases go through the real
 * `assertLocalOrConfirmed` first, exactly as the vowasia owner script does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertLocalOrConfirmed } from "./local-db-guard";
import {
  CENTRAL_DB_PATHNAME,
  CentralDbNameError,
  DB_NAME_MESSAGES,
  assertCentralDbName,
  databaseNameBanner,
  databasePathname,
} from "./central-db-name-guard";

const PW = "S3cretPw";
const HOST = "ep-quiet-sky-a1b2c3.ap-southeast-1.aws.neon.tech";

/** Host guard (confirmed, dry run, no TTY needed) then the name guard. */
function guard(url: string) {
  const target = assertLocalOrConfirmed(url, HOST, false, false);
  return assertCentralDbName(url, target);
}

describe("assertCentralDbName: non-local targets", () => {
  it("accepts exactly /neondb (with or without port / query string)", () => {
    assert.equal(CENTRAL_DB_PATHNAME, "/neondb");
    assert.equal(guard(`postgres://u:${PW}@${HOST}/neondb`), "/neondb");
    assert.equal(guard(`postgresql://u:${PW}@${HOST}:5432/neondb?sslmode=verify-full`), "/neondb");
  });

  const REFUSED: Array<[string, string]> = [
    ["the empty legacy database (incident 13-10-26)", `postgres://u:${PW}@${HOST}/gcv_payload_disabled`],
    ["upper case", `postgres://u:${PW}@${HOST}/NEONDB`],
    ["percent-encoded lookalike", `postgres://u:${PW}@${HOST}/neon%64b`],
    ["prefix lookalike", `postgres://u:${PW}@${HOST}/neondb_old`],
    ["trailing slash", `postgres://u:${PW}@${HOST}/neondb/`],
    ["default postgres database", `postgres://u:${PW}@${HOST}/postgres`],
    ["no database at all", `postgres://u:${PW}@${HOST}`],
    ["bare slash", `postgres://u:${PW}@${HOST}/`],
  ];
  for (const [label, url] of REFUSED) {
    it(`refuses ${label}, without leaking the password or host`, () => {
      assert.throws(
        () => guard(url),
        (err: unknown) => {
          assert.ok(err instanceof CentralDbNameError, String(err));
          assert.ok(!err.message.includes(PW), "message leaks the password");
          assert.ok(!err.message.includes(HOST), "message leaks the host");
          assert.ok(err.message.includes("refusing"));
          return true;
        },
      );
    });
  }

  it("names the wrong database in the refusal so the owner sees what to fix", () => {
    assert.throws(() => guard(`postgres://u:${PW}@${HOST}/gcv_payload_disabled`), {
      message: DB_NAME_MESSAGES.wrongName("/gcv_payload_disabled"),
    });
  });

  it("refuses when the driver's database differs from the URL path (defence in depth)", () => {
    assert.throws(() => assertCentralDbName(`postgres://u:${PW}@${HOST}/neondb`, { local: false, db: "other" }), {
      message: DB_NAME_MESSAGES.driverMismatch,
    });
  });

  it("refuses an unset or unparseable DATABASE_URL for a non-local target", () => {
    assert.throws(() => assertCentralDbName(undefined, { local: false, db: "neondb" }), { message: DB_NAME_MESSAGES.unparseable });
    assert.throws(() => assertCentralDbName("not a url", { local: false, db: "neondb" }), { message: DB_NAME_MESSAGES.unparseable });
  });
});

describe("assertCentralDbName: local targets stay allowed (disposable test databases)", () => {
  for (const url of [
    `postgres://u:${PW}@localhost:5432/central_test`,
    `postgres://u:${PW}@127.0.0.1/gcv_payload_disabled`,
    `postgres://u:${PW}@[::1]:5432/neondb`,
    `postgres://u:${PW}@host.docker.internal:5432/payload`,
  ]) {
    it(`allows ${url.replace(PW, "***")}`, () => {
      const target = assertLocalOrConfirmed(url, undefined, false, true);
      assert.equal(target.local, true);
      assert.doesNotThrow(() => assertCentralDbName(url, target));
    });
  }
});

describe("databasePathname / databaseNameBanner", () => {
  it("returns the pathname, or null when unset / unparseable (never throws)", () => {
    assert.equal(databasePathname(`postgres://u:${PW}@${HOST}/neondb?sslmode=require`), "/neondb");
    assert.equal(databasePathname(undefined), null);
    assert.equal(databasePathname("   "), null);
    assert.equal(databasePathname("::::"), null);
  });
  it("banner shows only the database name: no password, no host, no query string", () => {
    const b = databaseNameBanner(`postgres://u:${PW}@${HOST}/gcv_payload_disabled?sslmode=require`);
    assert.equal(b, 'database name (new URL(DATABASE_URL).pathname): "/gcv_payload_disabled"');
    assert.ok(!b.includes(PW) && !b.includes(HOST) && !b.includes("sslmode"));
    assert.equal(databaseNameBanner(undefined), "database name (new URL(DATABASE_URL).pathname): (unreadable)");
  });
});
