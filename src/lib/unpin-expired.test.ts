/**
 * Unit tests for ./unpin-expired (review L3 of the hub-pin-exclusive-flags change): the cron's
 * compare-and-set unpin. Node's built-in runner, FAKE Payload, injected lock + row lock: no
 * database is ever reached. The module imports the live core (which imports `@payload-config`),
 * so a NON-ROUTABLE placeholder DATABASE_URL is set when absent.
 *
 *   npm run test:hub-flags
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://unpin-unit@127.0.0.1:1/unpin_unit_no_db";
process.env.PAYLOAD_SECRET ??= "unpin-unit-placeholder";

type Doc = Record<string, unknown>;
let mod: typeof import("./unpin-expired");

before(async () => {
  mod = await import("./unpin-expired");
});

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const LOCK_REQ = { transactionID: "tx9" } as const;

function world(latest: Doc | null) {
  const log = { events: [] as string[], updates: [] as Doc[] };
  const payload = {
    async findByID(a: Doc) {
      log.events.push(`read:${a.draft ? "latest" : "main"}${a.req ? ":tx" : ""}`);
      return latest ? { ...latest } : null;
    },
    async update(a: Doc) {
      log.events.push("update");
      log.updates.push(a);
      return {};
    },
  } as unknown as Payload;
  const deps = {
    lock: (async (args: Doc, fn: (c: { req: unknown; lockSlug: () => Promise<void> }) => Promise<{ ok: boolean; value: Response }>) => {
      log.events.push(`lock:${String(args.tenantId)}:${String(args.articleId)}`);
      const r = await fn({ req: LOCK_REQ, lockSlug: async () => {} });
      log.events.push(r.ok ? "commit" : "kill");
      return r.value;
    }) as never,
    lockRow: async () => {
      log.events.push("rowlock");
    },
  };
  return { payload, deps, log };
}

describe("isStillExpired", () => {
  it("ticked + expiry at or before now only", () => {
    assert.equal(mod.isStillExpired({ pinnedToLatest: true, pinnedUntil: "2026-10-28T10:00:00.000Z" }, NOW), true);
    assert.equal(mod.isStillExpired({ pinnedToLatest: true, pinnedUntil: "2026-10-28T09:00:00.000Z" }, NOW), true);
    assert.equal(mod.isStillExpired({ pinnedToLatest: true, pinnedUntil: "2026-10-28T10:00:00.001Z" }, NOW), false);
    assert.equal(mod.isStillExpired({ pinnedToLatest: true, pinnedUntil: null }, NOW), false);
    assert.equal(mod.isStillExpired({ pinnedToLatest: false, pinnedUntil: "2026-10-28T09:00:00.000Z" }, NOW), false);
    assert.equal(mod.isStillExpired({ pinnedToLatest: true, pinnedUntil: "garbage" }, NOW), false);
    assert.equal(mod.isStillExpired(null, NOW), false);
  });
});

describe("unpinIfStillExpired (compare-and-set under the hub article lock + row lock)", () => {
  const raw = { id: 7, tenant: 3 };

  it("still expired ⇒ ONE write on the transaction, same context as before, draft surface when the latest is a draft", async () => {
    const w = world({ id: 7, pinnedToLatest: true, pinnedUntil: "2026-10-28T09:00:00.000Z", _status: "draft" });
    const out = await mod.unpinIfStillExpired(w.payload, raw, NOW, w.deps);
    assert.deepEqual(out, { kind: "unpinned", draft: true, pinnedUntil: "2026-10-28T09:00:00.000Z" });
    assert.deepEqual(w.log.events, ["lock:3:7", "rowlock", "read:latest:tx", "update", "commit"]);
    const u = w.log.updates[0]!;
    assert.deepEqual([u.req, u.draft, u.data, u.context, u.overrideAccess], [LOCK_REQ, true, { pinnedToLatest: false, pinnedUntil: null }, { systemWrite: true, skipTranslationEnqueue: true, disableRevalidate: true }, true]);
    const w2 = world({ id: 7, pinnedToLatest: true, pinnedUntil: "2026-10-28T09:00:00.000Z", _status: "published" });
    assert.deepEqual(await mod.unpinIfStillExpired(w2.payload, raw, NOW, w2.deps), { kind: "unpinned", draft: false, pinnedUntil: "2026-10-28T09:00:00.000Z" });
  });

  it("re-pinned since the search (future expiry, no expiry, unticked) ⇒ skipped, NOTHING written", async () => {
    for (const latest of [
      { id: 7, pinnedToLatest: true, pinnedUntil: "2026-10-28T12:00:00.000Z", _status: "draft" },
      { id: 7, pinnedToLatest: true, pinnedUntil: null, _status: "published" },
      { id: 7, pinnedToLatest: false, pinnedUntil: null, _status: "published" },
    ]) {
      const w = world(latest);
      assert.deepEqual(await mod.unpinIfStillExpired(w.payload, raw, NOW, w.deps), { kind: "skipped", reason: "not_expired" });
      assert.equal(w.log.updates.length, 0);
      assert.equal(w.log.events.at(-1), "kill");
    }
  });

  it("gone ⇒ skipped missing; lock busy ⇒ skipped busy (retried next run); a write error propagates", async () => {
    const w = world(null);
    assert.deepEqual(await mod.unpinIfStillExpired(w.payload, raw, NOW, w.deps), { kind: "skipped", reason: "missing" });
    const busy = world({ id: 7, pinnedToLatest: true, pinnedUntil: "2026-10-28T09:00:00.000Z" });
    const out = await mod.unpinIfStillExpired(busy.payload, raw, NOW, { ...busy.deps, lock: (async () => new Response("{}", { status: 503 })) as never });
    assert.deepEqual(out, { kind: "skipped", reason: "busy" });
    const bad = world({ id: 7, pinnedToLatest: true, pinnedUntil: "2026-10-28T09:00:00.000Z" });
    (bad.payload as unknown as { update: () => Promise<never> }).update = async () => {
      throw new Error("write failed");
    };
    await assert.rejects(() => mod.unpinIfStillExpired(bad.payload, raw, NOW, bad.deps), /write failed/);
  });

  it("the cron route delegates every write to it (no unconditional update left)", () => {
    const src = readFileSync(path.resolve(process.cwd(), "src/app/api/cron/unpin-expired/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/payload\.update\(/.test(src), false);
    assert.match(src, /await unpinIfStillExpired\(payload, raw, nowMs\)/);
    // F4: a budget for a sweep that can wait up to 3 s per busy article, and the busy ids are logged.
    assert.match(src, /export const maxDuration = 60;/);
    assert.match(src, /skipped busy \(retried next run\): \$\{busy\.join\(","\)\}/);
    // N-c: the cron's graph never imports the live-edit core.
    const lib = readFileSync(path.resolve(process.cwd(), "src/lib/unpin-expired.ts"), "utf8");
    assert.equal(/hub-author-live-core/.test(lib.replace(/\/\*[\s\S]*?\*\//g, "")), false);
  });
});
