/**
 * Hub Pressroom authoring (05-11-26): single-home pillars are hub-writable as primary,
 * GCV `exclusive` too (HUB_WRITABLE_BLOCKED_PILLARS, 10-11-26); every other
 * engine-blocked pillar stays refused, the engine gate is unchanged.
 * FAKE Payload only; no database.   npm run test:hub-pressroom
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "payload";

process.env.DATABASE_URL ??= "postgres://pressroom-unit@127.0.0.1:1/no_db";
process.env.PAYLOAD_SECRET ??= "pressroom-unit-placeholder";

import { ENGINE_BLOCKED_PILLARS, HUB_WRITABLE_BLOCKED_PILLARS, SINGLE_HOME_PILLARS, isEngineBlockedPillar, isHubBlockedPillar } from "./constants";

type Doc = Record<string, unknown>;
let pub: typeof import("./hub-author-publish-core");
let handlers: typeof import("./hub-author-handlers");
let refs: typeof import("./hub-author-refs");
before(async () => {
  pub = await import("./hub-author-publish-core");
  handlers = await import("./hub-author-handlers");
  refs = await import("./hub-author-refs");
});

function fakePayload(data: Record<string, Doc[]>): Payload {
  return {
    find: async (a: { collection: string; where?: unknown }) => {
      const w = JSON.stringify(a.where ?? {});
      const docs = (data[a.collection] ?? []).filter((d) => {
        const ids = /"id":\{"in":\[([^\]]*)\]/.exec(w);
        if (ids) return ids[1]!.split(",").map((x) => x.replace(/"/g, "")).includes(String(d.id));
        const slug = /"slug":\{"equals":"([^"]*)"/.exec(w);
        if (slug) return d.slug === slug[1];
        const pil = /"pillar":\{"equals":([^}]*)\}/.exec(w);
        if (pil) return String(d.pillar) === pil[1]!.replace(/"/g, "");
        return true;
      });
      return { docs, totalDocs: docs.length };
    },
  } as unknown as Payload;
}

const TAX = {
  pillars: [{ id: 1, slug: "pressroom" }, { id: 2, slug: "exclusive" }, { id: 3, slug: "travel" }],
  subsections: [{ id: 30, slug: "city", pillar: 3 }],
};
const base: Doc = { title: "T", body: { root: { children: [{ type: "paragraph", children: [{ type: "text", text: "x" }] }] } }, slug: "t", readMin: 2 };

describe("isHubBlockedPillar", () => {
  it("single-home + hub-writable pillars are hub-writable; every other engine-blocked pillar stays blocked", () => {
    for (const [t, list] of Object.entries(ENGINE_BLOCKED_PILLARS)) {
      const open = [...(SINGLE_HOME_PILLARS[t] ?? []), ...(HUB_WRITABLE_BLOCKED_PILLARS[t] ?? [])];
      for (const s of list) assert.equal(isHubBlockedPillar(t, s), !open.includes(s), `${t}/${s}`);
    }
    // GCV Exclusive (owner decision 10-11-26): hub-writable as primary, engine still blocked.
    assert.equal(isHubBlockedPillar("gcv", "exclusive"), false);
    assert.equal(isHubBlockedPillar("gcv", " Exclusive "), false);
    assert.equal(isEngineBlockedPillar("gcv", "exclusive"), true);
    // every hub-writable entry is engine-blocked (else the list is meaningless) and not single-home
    for (const [t, list] of Object.entries(HUB_WRITABLE_BLOCKED_PILLARS)) {
      for (const s of list) {
        assert.equal(isEngineBlockedPillar(t, s), true, `${t}/${s}`);
        assert.equal((SINGLE_HOME_PILLARS[t] ?? []).includes(s), false, `${t}/${s}`);
      }
    }
    assert.equal(isHubBlockedPillar("agr", "course-reviews"), true);
    assert.equal(isHubBlockedPillar("vowasia", "real-weddings"), true);
    assert.equal(isHubBlockedPillar("gtp", "events-awards"), true);
    assert.equal(isHubBlockedPillar("gcv", " Pressroom "), false);
    assert.equal(isHubBlockedPillar("gcv", "travel"), false);
  });
  it("engine gate unchanged: pressroom still engine-blocked; intake still uses isEngineBlockedPillar", () => {
    assert.equal(isEngineBlockedPillar("gcv", "pressroom"), true);
    assert.equal(isEngineBlockedPillar("brief-asia", "pressroom"), true);
    const src = readFileSync(path.join(process.cwd(), "src/app/api/engine/intake/route.ts"), "utf8");
    assert.match(src, /isEngineBlockedPillar\(tenant\.slug/);
    assert.doesNotMatch(src, /isHubBlockedPillar/);
  });
});

describe("resolvePillar", () => {
  const p = () => fakePayload(TAX);
  it("primary pressroom ok, primary exclusive ok (10-11-26)", async () => {
    assert.deepEqual(await refs.resolvePillar(p(), { id: 1, slug: "gcv" }, "pressroom"), { ok: true, id: 1 });
    assert.deepEqual(await refs.resolvePillar(p(), { id: 1, slug: "gcv" }, "exclusive"), { ok: true, id: 2 });
  });
  it("secondary exclusive still blocked", async () => {
    assert.deepEqual(await refs.resolvePillar(p(), { id: 1, slug: "gcv" }, "exclusive", "secondary"), { ok: false, code: "blocked_pillar" });
  });
  it("secondary pressroom still blocked", async () => {
    assert.deepEqual(await refs.resolvePillar(p(), { id: 1, slug: "gcv" }, "pressroom", "secondary"), { ok: false, code: "blocked_pillar" });
  });
  it("draft refs: pressroom + sub-section / secondary ⇒ single_home", async () => {
    const r = await refs.resolveDraftRefs({ payload: p(), tenant: { id: 1, slug: "gcv" } as never, input: { pillarSlug: "pressroom", subSectionSlug: "city", secondary: [{ pillarSlug: "travel", subSectionSlug: null }] } as never });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.fields.subSectionSlug, "single_home");
      assert.equal(r.fields.secondary, "single_home");
    }
  });
});

describe("checkPublishable", () => {
  const run = (latest: Doc, slug = "gcv") => pub.checkPublishable({ payload: fakePayload(TAX), tenant: { id: 1, slug }, latest: { ...base, ...latest } });
  it("pressroom without author publishes clean", async () => {
    assert.deepEqual(await run({ pillar: 1, author: null }), {});
  });
  it("ordinary pillar still needs an author", async () => {
    assert.equal((await run({ pillar: 3, subSection: 30, author: null })).authorId, "required");
  });
  it("exclusive as primary publishes clean with an author (hub-writable, 10-11-26)", async () => {
    assert.deepEqual(await run({ pillar: 2, author: 5 }), {});
  });
  it("exclusive is not single-home: author still required", async () => {
    assert.equal((await run({ pillar: 2, author: null })).authorId, "required");
  });
  it("exclusive as a secondary row still blocked_pillar", async () => {
    assert.equal((await run({ pillar: 3, subSection: 30, author: 5, secondarySections: [{ pillar: 2 }] })).secondary, "blocked_pillar");
  });
  it("pressroom with sub-section / secondary / exclusive ⇒ single_home codes", async () => {
    const f = await run({ pillar: 1, subSection: 30, secondarySections: [{ pillar: 3 }], exclusive: true });
    assert.deepEqual([f.subSectionSlug, f.secondary, f["flags.exclusive"], f.authorId], ["single_home", "single_home", "single_home", undefined]);
  });
});

describe("mapWriteError single-home ValidationError", () => {
  it("maps hook paths to hub field names with single_home", () => {
    const err = Object.assign(new Error("x"), { name: "ValidationError", data: { errors: [
      { path: "subSection", message: 'pillar rule: "pressroom" is a single-home pillar: no sub-section' },
      { path: "secondarySections.0.pillar", message: 'pillar rule: "pressroom" is a single-home pillar: x' },
      { path: "title", message: "required" },
    ] } });
    const m = handlers.mapWriteError(err);
    assert.equal(m.status, 422);
    assert.deepEqual((m as { fields: Doc }).fields, { subSectionSlug: "single_home", secondary: "single_home", title: "invalid" });
  });
});
