/**
 * Unit tests for ./local-db-guard (Node's built-in runner).
 *
 *   npm run test:single-home
 *
 * 27-URL accept/refuse verdict table for the shared local-DB guard used by
 * `audit:add-pressroom`, the seed Pressroom fixture and `probe:single-home`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertLocalDb, assertLocalOrConfirmed, GUARD_MESSAGES } from "./local-db-guard";

const PW = "S3cretPw";

/** [url, expected verdict, expected host when accepted] */
const TABLE: Array<[string, "accept" | "refuse", string?]> = [
  // ── accepted: exact allow-listed effective host ──
  [`postgres://u:${PW}@localhost/db`, "accept", "localhost"],
  [`postgres://u:${PW}@127.0.0.1:54327/x`, "accept", "127.0.0.1"],
  [`postgres://u:${PW}@[::1]:5432/db`, "accept", "[::1]"],
  [`postgres://u:${PW}@host.docker.internal:5432/db`, "accept", "host.docker.internal"],
  [`postgresql://u:${PW}@localhost:5432/db`, "accept", "localhost"],
  [`postgres://localhost/db`, "accept", "localhost"],
  [`postgres://u:${PW}@127.0.0.1/db?sslmode=disable`, "accept", "127.0.0.1"],
  [`postgres://u:${PW}@localhost/db?host=localhost`, "accept", "localhost"],
  [`postgres://u:${PW}@%6Cocalhost/db`, "accept", "localhost"],
  [`postgres://u:${PW}@localhost:5432/db?port=6543`, "accept", "localhost"],
  // ── refused ──
  [`postgres://u:${PW}@LOCALHOST/db`, "refuse"], // case-sensitive exact match
  [`postgres://u:${PW}@localhost/db?host=prod.example.com`, "refuse"], // ?host= override folded into c.host
  [`postgres://u:${PW}@localhost/db?hostaddr=1.2.3.4`, "refuse"],
  [`postgres://u:${PW}@localhost/db?service=prod`, "refuse"],
  [`postgres://u:${PW}@a,b/db`, "refuse"], // multi-host
  [`postgres://u:${PW}@localhost,prod.example.com/db`, "refuse"],
  [`postgres://u:${PW}@a:1,b:2/db`, "refuse"], // parser throws -> fixed message
  [`postgres://u:${PW}@/db`, "refuse"], // empty host
  [`postgres://u:${PW}@localhost.evil.com/db`, "refuse"], // lookalike suffix
  [`postgres://u:${PW}@127.0.0.1.evil.com/db`, "refuse"],
  [`postgres://u:${PW}@evil.host.docker.internal/db`, "refuse"],
  [`postgres://u:${PW}@db.example.com:5432/postgres`, "refuse"],
  [`postgres://localhost:${PW}@prod.example.com/localhost`, "refuse"], // user/db named localhost
  [`postgres://u:${PW}@prod.example.com/db?application_name=localhost`, "refuse"],
  [``, "refuse"],
  [`/var/run/postgresql`, "refuse"], // socket path ("/"-prefixed host)
  [`postgres://u:${PW}@localhost/db?host=%2Fvar%2Frun%2Fpostgresql`, "refuse"],
];

describe("assertLocalDb: 27-URL verdict table", () => {
  it("has 27 rows", () => assert.equal(TABLE.length, 27));
  for (const [url, verdict, host] of TABLE) {
    it(`${verdict}: ${url || "(empty)"}`, () => {
      if (verdict === "accept") {
        const r = assertLocalDb(url);
        assert.equal(r.host, host);
        assert.ok(!r.banner.includes(PW), "banner leaks the password");
        assert.ok(!r.banner.includes("?"), "banner carries a query string");
      } else {
        assert.throws(
          () => assertLocalDb(url),
          (err: unknown) => {
            const msg = (err as Error).message;
            assert.ok(!msg.includes(PW), `refusal message leaks the password: ${msg}`);
            assert.ok(!msg.includes("postgres://"), `refusal message leaks the DSN: ${msg}`);
            return true;
          },
        );
      }
    });
  }
  it("undefined is refused", () => assert.throws(() => assertLocalDb(undefined)));
  it("a parser throw prints only the fixed message", () => {
    assert.throws(() => assertLocalDb(`postgres://u:${PW}@a:1,b:2/db`), (err: unknown) => (err as Error).message === GUARD_MESSAGES.unparseable);
  });
  it("banner = host:port/db with the default port when absent", () => {
    assert.equal(assertLocalDb(`postgres://u:${PW}@127.0.0.1:54327/x`).banner, "127.0.0.1:54327/x");
    assert.equal(assertLocalDb(`postgres://u:${PW}@localhost/db?sslmode=disable`).banner, "localhost:5432/db");
  });
});

describe("assertLocalOrConfirmed (owner script)", () => {
  const remote = `postgres://u:${PW}@db.example.com:5432/postgres`;
  it("local host needs no confirmation", () => {
    const r = assertLocalOrConfirmed(`postgres://u:${PW}@127.0.0.1:54327/x`, undefined, false, true);
    assert.equal(r.local, true);
  });
  it("non-local without --confirm-host is refused", () => {
    assert.throws(() => assertLocalOrConfirmed(remote, undefined, true, false));
    assert.throws(() => assertLocalOrConfirmed(`postgres://u:${PW}@localhost.evil.com/db`, undefined, true, true));
  });
  it("non-local with a mismatching --confirm-host is refused", () => {
    assert.throws(() => assertLocalOrConfirmed(remote, "db.example.co", true, true));
    assert.throws(() => assertLocalOrConfirmed(remote, "DB.example.com", true, true));
  });
  it("--apply against non-local without a TTY is refused even with the right --confirm-host", () => {
    assert.throws(() => assertLocalOrConfirmed(remote, "db.example.com", false, true));
  });
  it("--apply against non-local with the right --confirm-host and a TTY is allowed", () => {
    const r = assertLocalOrConfirmed(remote, "db.example.com", true, true);
    assert.equal(r.local, false);
    assert.equal(r.banner, "db.example.com:5432/postgres");
  });
  it("dry-run against non-local with the right --confirm-host needs no TTY", () => {
    assert.equal(assertLocalOrConfirmed(remote, "db.example.com", false, false).local, false);
  });
  it("structural refusals hold even when confirmed", () => {
    assert.throws(() => assertLocalOrConfirmed(`postgres://u:${PW}@db.example.com/db?hostaddr=1.2.3.4`, "db.example.com", true, true));
    assert.throws(() => assertLocalOrConfirmed(`postgres://u:${PW}@a,b/db`, "a,b", true, true));
    assert.throws(() => assertLocalOrConfirmed(`postgres://u:${PW}@a:1,b:2/db`, "a", true, true));
  });
});
