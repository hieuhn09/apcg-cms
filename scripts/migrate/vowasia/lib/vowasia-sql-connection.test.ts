// Incident 12-11-26 (network legacy DB overloaded by per-batch connection churn):
// VowasiaReadOnlyDb must reuse ONE connection per run, ported from apcg-cms#74.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeOverlay, parseSourceConfig } from "./vowasia-config";
import { VowasiaReadOnlyDb, countRows, createSqlRegistry, type MinimalPgClient } from "./vowasia-sql";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = JSON.parse(readFileSync(path.resolve(HERE, "..", "legacy-source.vowasia.json"), "utf8"));
const SITE = "00000000-0000-0000-0000-00000000f002";
const REG = createSqlRegistry(parseSourceConfig(mergeOverlay(BASE, { source: { siteIdKind: "uuid", siteFilter: SITE } }), { requireSiteFilter: true }));
const Q = () => countRows(REG, "articles", SITE);

function countingClient(opts: { failOn?: (n: number) => string | null } = {}) {
  const stats = { made: 0, connects: 0, ends: 0, open: 0, maxOpen: 0, selects: 0 };
  const make = (): MinimalPgClient => {
    stats.made++;
    let alive = false;
    return {
      connect: async () => {
        stats.connects++;
        alive = true;
        stats.open++;
        stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      },
      query: async (t: string) => {
        if (t.startsWith("SELECT")) {
          stats.selects++;
          const code = opts.failOn?.(stats.selects);
          if (code) throw Object.assign(new Error("boom"), { code });
        }
        return { rows: [{ n: 1 }] };
      },
      end: async () => {
        stats.ends++;
        if (alive) stats.open--;
        alive = false;
      },
    };
  };
  return { stats, make };
}

test("incident 12-11-26: N batches use exactly one connect(); never more than one open connection", async () => {
  const { stats, make } = countingClient();
  const db = new VowasiaReadOnlyDb(REG, make, { backoffMs: 1 });
  for (let i = 0; i < 25; i++) await db.batch([Q(), Q()]);
  await db.query(Q());
  assert.equal(stats.connects, 1);
  assert.equal(stats.maxOpen, 1);
  assert.equal(stats.ends, 0);
  assert.equal(db.events.filter((e) => e === "BEGIN").length, 26);
  assert.equal(db.events.filter((e) => e === "COMMIT").length, 26);
  await db.close();
  assert.equal(stats.open, 0);
});

test("a reconnect-class error drops the connection, reconnects exactly once, then succeeds", async () => {
  const { stats, make } = countingClient({ failOn: (n) => (n === 3 ? "57P01" : null) });
  const db = new VowasiaReadOnlyDb(REG, make, { backoffMs: 1 });
  for (let i = 0; i < 5; i++) await db.query(Q());
  assert.equal(stats.connects, 2);
  assert.equal(stats.ends, 1);
  assert.equal(stats.maxOpen, 1);
  await db.close();
  assert.equal(stats.open, 0);
});

test("reconnect retries are capped at 2 by default, then the error is rethrown with the connection closed", async () => {
  const { stats, make } = countingClient({ failOn: () => "08006" });
  const db = new VowasiaReadOnlyDb(REG, make, { backoffMs: 1 });
  await assert.rejects(db.query(Q()), { code: "08006" });
  assert.equal(stats.connects, 3);
  assert.equal(stats.open, 0);
});

test("a non-reconnect error closes the connection and rethrows without retry", async () => {
  const { stats, make } = countingClient({ failOn: (n) => (n === 1 ? "42P01" : null) });
  const db = new VowasiaReadOnlyDb(REG, make, { backoffMs: 1 });
  await assert.rejects(db.query(Q()), { code: "42P01" });
  assert.equal(stats.connects, 1);
  assert.equal(stats.open, 0);
  await db.query(Q());
  assert.equal(stats.connects, 2);
  await db.close();
});

test("close() ends the connection and is idempotent; close before any batch is a no-op", async () => {
  const { stats, make } = countingClient();
  const db = new VowasiaReadOnlyDb(REG, make);
  await db.close();
  assert.equal(stats.made, 0);
  await db.query(Q());
  await db.close();
  await db.close();
  assert.equal(stats.ends, 1);
  assert.equal(stats.open, 0);
});
