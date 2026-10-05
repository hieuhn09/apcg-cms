/**
 * Unit tests for the single-home pillar hooks with a fake `req` (no DB).
 *
 *   npm run test:single-home
 *
 * Articles `beforeChange` (D-A effective state, D-C keying, G80/G81/G85),
 * the secondary-row / SubSections field validators (G54/G59/G77/G94), the
 * secondary-pillar filterOptions (fail open), and the Pillars row guards (V5).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  singleHomePillar,
  makeSecondaryRowPillarValidate,
  makeSubSectionPillarValidate,
  secondaryPillarFilterOptions,
} from "./single-home-pillar";
import { pillarRowGuardBeforeChange, pillarRowGuardBeforeDelete } from "./single-home-pillar-row-guard";
import { isSingleHomeRuleError, humanErrorMessage } from "../lib/single-home-pillars";

const V1 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot also have secondary sections.';
const V2 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot have a sub-section.';
const V3 = 'pillar rule: "pressroom" is a single-home pillar: it cannot be added as a secondary section to another article.';
const V4 = 'pillar rule: "pressroom" is a single-home pillar: it cannot have sub-sections.';
const V6 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot be marked exclusive.';

type Doc = Record<string, unknown>;
// 10 = brief-asia pressroom (single-home), 11 = brief-asia asia, 12 = wad pressroom, 13 = gcv finance
const PILLARS: Doc[] = [
  { id: 10, slug: "pressroom", tenant: 1 },
  { id: 11, slug: "asia", tenant: 1 },
  { id: 12, slug: "pressroom", tenant: 2 },
  { id: 13, slug: "finance", tenant: 3 },
];
const TENANTS: Doc[] = [
  { id: 1, slug: "brief-asia" },
  { id: 2, slug: "wad" },
  { id: 3, slug: "gcv" },
];

interface FakeReq {
  payload: {
    find: (a: Record<string, unknown>) => Promise<{ docs: Doc[] }>;
    findByID: (a: Record<string, unknown>) => Promise<Doc | null>;
    count: (a: Record<string, unknown>) => Promise<{ totalDocs: number }>;
    countVersions: (a: Record<string, unknown>) => Promise<{ totalDocs: number }>;
  };
  context: Record<string, unknown>;
  t?: undefined;
  calls: Array<{ op: string; args: Record<string, unknown> }>;
}

function makeReq(opts: { counts?: Partial<Record<string, number>>; failFind?: boolean; context?: Record<string, unknown> } = {}): FakeReq {
  const calls: FakeReq["calls"] = [];
  const ids = (a: Record<string, unknown>) => ((a.where as { id: { in: unknown[] } }).id.in).map(String);
  return {
    calls,
    context: opts.context ?? {},
    payload: {
      find: async (a) => {
        calls.push({ op: "find", args: a });
        if (opts.failFind) throw new Error("db down");
        const src = a.collection === "pillars" ? PILLARS : a.collection === "tenants" ? TENANTS : [];
        return { docs: src.filter((d) => ids(a).includes(String(d.id))) };
      },
      findByID: async (a) => {
        calls.push({ op: "findByID", args: a });
        return PILLARS.find((p) => String(p.id) === String(a.id)) ?? null;
      },
      count: async (a) => {
        calls.push({ op: "count", args: a });
        return { totalDocs: opts.counts?.[a.collection as string] ?? 0 };
      },
      countVersions: async (a) => {
        calls.push({ op: "countVersions", args: a });
        return { totalDocs: opts.counts?.versions ?? 0 };
      },
    },
  };
}

const collection = { slug: "articles" };

async function run(args: { operation: "create" | "update"; data: Doc; originalDoc?: Doc; req?: FakeReq }) {
  const req = args.req ?? makeReq();
  const out = await (singleHomePillar as unknown as (a: Record<string, unknown>) => Promise<unknown>)({
    data: args.data,
    originalDoc: args.originalDoc ?? {},
    operation: args.operation,
    req,
    collection,
    context: req.context,
  });
  return { out, req };
}

async function rejectsWith(p: Promise<unknown>, message: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.equal(isSingleHomeRuleError(err), true, `not a single-home error: ${String(err)}`);
    assert.equal(humanErrorMessage(err), message);
    return true;
  });
}

describe("Articles beforeChange hook: create (always evaluated)", () => {
  it("plain create uses originalDoc = {} (G81/G92) and is evaluated", async () => {
    await rejectsWith(run({ operation: "create", data: { pillar: 10, secondarySections: [{ pillar: 11 }] }, originalDoc: {} }), V1);
    await rejectsWith(run({ operation: "create", data: { pillar: 10, subSection: 5 } }), V2);
    await rejectsWith(run({ operation: "create", data: { pillar: 11, secondarySections: [{ pillar: 10 }] } }), V3);
    await rejectsWith(run({ operation: "create", data: { pillar: 10, exclusive: true } }), V6);
  });
  it("create with absent keys = empty; valid pressroom-only create passes", async () => {
    const { out } = await run({ operation: "create", data: { pillar: 10, title: "x" } });
    assert.deepEqual(out, { pillar: 10, title: "x" });
  });
  it("explicit [] / null are empty", async () => {
    const { out } = await run({ operation: "create", data: { pillar: 10, subSection: null, secondarySections: [], exclusive: false } });
    assert.ok(out);
  });
  it("DUPLICATE (operation create, originalDoc = source doc) is always evaluated (G81)", async () => {
    const source = { id: 99, pillar: 10, subSection: null, secondarySections: [{ id: "r1", pillar: 10 }] };
    await rejectsWith(run({ operation: "create", data: { ...source }, originalDoc: source }), V1);
  });
  it("draft-partial create (only pillar + secondarySections) is evaluated", async () => {
    await rejectsWith(run({ operation: "create", data: { secondarySections: [{ pillar: 10 }] } }), V3);
  });
  it("client sends a foreign data.tenant: rule still keyed on the pillar docs (D-C)", async () => {
    await rejectsWith(run({ operation: "create", data: { tenant: 2, pillar: 10, subSection: 4 } }), V2);
    const { out } = await run({ operation: "create", data: { tenant: 1, pillar: 12, subSection: 4, secondarySections: [{ pillar: 11 }] } });
    assert.ok(out); // wad pressroom is not single-home even when data.tenant claims brief-asia
  });
});

describe("Articles beforeChange hook: tenant keying negative controls", () => {
  it("wad pressroom (primary or secondary) is NOT blocked", async () => {
    assert.ok((await run({ operation: "create", data: { pillar: 12, subSection: 4, secondarySections: [{ pillar: 13 }], exclusive: true } })).out);
    assert.ok((await run({ operation: "create", data: { pillar: 13, secondarySections: [{ pillar: 12 }] } })).out);
  });
  it("no tenant lookup when no referenced slug is in the single-home union (G79b)", async () => {
    const { req } = await run({ operation: "create", data: { pillar: 13, secondarySections: [{ pillar: 11 }] } });
    assert.deepEqual(req.calls.map((c) => c.args.collection), ["pillars"]);
  });
});

describe("Articles beforeChange hook: update (D-A effective state)", () => {
  const legacy = { id: 1, pillar: 10, subSection: 5, secondarySections: [{ id: "r1", pillar: 11 }], exclusive: true };
  it("unchanged taxonomy (equal) is exempt with ZERO lookups", async () => {
    const req = makeReq({ failFind: true });
    const { out } = await run({ operation: "update", data: { workflowStatus: "hidden", pillar: 10, subSection: 5, secondarySections: [{ id: "r1", pillar: { id: 11 } }], exclusive: true }, originalDoc: legacy, req });
    assert.ok(out);
    assert.equal(req.calls.length, 0);
  });
  it("status-only write with absent keys (effectively equal) is exempt with zero lookups", async () => {
    const req = makeReq({ failFind: true });
    const { out } = await run({ operation: "update", data: { workflowStatus: "published" }, originalDoc: legacy, req });
    assert.ok(out);
    assert.equal(req.calls.length, 0);
  });
  it("populated-object originalDoc vs id data is normalised (no change)", async () => {
    const req = makeReq({ failFind: true });
    const populated = { pillar: { id: 11, slug: "asia" }, subSection: null, secondarySections: [] };
    const { out } = await run({ operation: "update", data: { pillar: 11, secondarySections: [] }, originalDoc: populated, req });
    assert.ok(out);
    assert.equal(req.calls.length, 0);
  });
  it("changed secondarySections is evaluated", async () => {
    await rejectsWith(run({ operation: "update", data: { secondarySections: [{ pillar: 10 }] }, originalDoc: { pillar: 11, secondarySections: [] } }), V3);
  });
  it("changed subSection is evaluated", async () => {
    await rejectsWith(run({ operation: "update", data: { subSection: 6 }, originalDoc: { pillar: 10, subSection: null } }), V2);
  });
  it("primary change to pressroom is evaluated against the EFFECTIVE stored rows", async () => {
    await rejectsWith(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11, secondarySections: [{ id: "r", pillar: 13 }] } }), V1);
  });
  it("draft-partial update {secondarySections} on a pressroom primary is evaluated", async () => {
    await rejectsWith(run({ operation: "update", data: { secondarySections: [{ pillar: 11 }] }, originalDoc: { pillar: 10, secondarySections: [] } }), V1);
  });
  it("PATCH secondarySections: [] on a pressroom primary passes", async () => {
    const { out } = await run({ operation: "update", data: { secondarySections: [] }, originalDoc: { pillar: 10, secondarySections: [] } });
    assert.ok(out);
  });
  it("restoreVersion: data = restored version, originalDoc = current latest; changed => evaluated", async () => {
    const restored = { pillar: 10, subSection: null, secondarySections: [{ id: "x", pillar: 11 }] };
    await rejectsWith(run({ operation: "update", data: restored, originalDoc: { pillar: 11, secondarySections: [] } }), V1);
  });
  it("req.context flags (systemWrite/hubWrite/translationWrite) are NOT honoured", async () => {
    const req = makeReq({ context: { systemWrite: true, hubWrite: true, translationWrite: true } });
    await rejectsWith(run({ operation: "update", data: { subSection: 6 }, originalDoc: { pillar: 10 }, req }), V2);
  });
  it("lookup errors propagate on a taxonomy change (fail closed)", async () => {
    await assert.rejects(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11 }, req: makeReq({ failFind: true }) }), /db down/);
  });
});

describe("Articles beforeChange hook: V6 exclusive (C10)", () => {
  it("existing pressroom article patched with exclusive:true is blocked", async () => {
    await rejectsWith(run({ operation: "update", data: { exclusive: true }, originalDoc: { pillar: 10, exclusive: false } }), V6);
  });
  it("unchanged exclusive:true legacy doc patched only for status is NOT re-blocked", async () => {
    const req = makeReq({ failFind: true });
    const { out } = await run({ operation: "update", data: { workflowStatus: "hidden" }, originalDoc: { pillar: 10, exclusive: true }, req });
    assert.ok(out);
    assert.equal(req.calls.length, 0);
  });
  it("a flip to false never triggers evaluation (G79a)", async () => {
    const req = makeReq({ failFind: true });
    const { out } = await run({ operation: "update", data: { exclusive: false }, originalDoc: { pillar: 10, exclusive: true, secondarySections: [{ pillar: 11 }] }, req });
    assert.ok(out);
    assert.equal(req.calls.length, 0);
  });
  it("G64: exclusive:true article with another primary, PATCH {pillar: pressroom} is blocked", async () => {
    await rejectsWith(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11, exclusive: true } }), V6);
  });
});

describe("Articles beforeChange hook: restore bypass (G85)", () => {
  const ctx = () => ({ isRestoringVersion: true });
  it("isRestoringVersion + data={pillar} with stored subSection -> V2", async () => {
    await rejectsWith(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11, subSection: 5 }, req: makeReq({ context: ctx() }) }), V2);
  });
  it("isRestoringVersion + data={pillar} with stored secondary rows -> V1", async () => {
    await rejectsWith(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11, secondarySections: [{ id: "a", pillar: 13 }] }, req: makeReq({ context: ctx() }) }), V1);
  });
  it("isRestoringVersion + data={pillar} with stored exclusive:true -> V6", async () => {
    await rejectsWith(run({ operation: "update", data: { pillar: 10 }, originalDoc: { pillar: 11, exclusive: true }, req: makeReq({ context: ctx() }) }), V6);
  });
  it("data lacking pillar, stored primary = pressroom, new secondary rows -> evaluated on the effective state", async () => {
    await rejectsWith(run({ operation: "update", data: { secondarySections: [{ pillar: 11 }] }, originalDoc: { pillar: 10 }, req: makeReq({ context: ctx() }) }), V1);
  });
});

describe("Articles beforeChange hook: fail-closed normaliser through the hook (G80/G86)", () => {
  const pushObj = { $push: { pillar: 10 } };
  const pushArr = { $push: [{ pillar: 10 }] };
  for (const [name, value] of [["{$push: obj}", pushObj], ["{$push: [..]}", pushArr]] as const) {
    it(`${name} is rejected on create, update, draft and publish`, async () => {
      for (const operation of ["create", "update"] as const) {
        for (const _status of ["draft", "published"]) {
          await assert.rejects(
            run({ operation, data: { _status, secondarySections: value }, originalDoc: operation === "update" ? { pillar: 11 } : {} }),
            (err: unknown) => isSingleHomeRuleError(err),
          );
        }
      }
    });
  }
  it("null-prototype rows (GraphQL inputs) are evaluated", async () => {
    const row = Object.create(null) as Record<string, unknown>;
    row.pillar = 10;
    await rejectsWith(run({ operation: "create", data: { pillar: 11, secondarySections: [row] } }), V3);
  });
  it("unsafe-integer ids are rejected", async () => {
    await assert.rejects(run({ operation: "create", data: { pillar: Number.MAX_SAFE_INTEGER + 1 } }), (e: unknown) => isSingleHomeRuleError(e));
  });
});

describe("secondary row pillar validate (G54/G59/G77/G94)", () => {
  type V = (value: unknown, options: Record<string, unknown>) => Promise<string | true>;
  let baseCalls: number;
  const base = async () => {
    baseCalls += 1;
    return true as const;
  };
  const validate = makeSecondaryRowPillarValidate(base as never) as unknown as V;
  beforeEach(() => {
    baseCalls = 0;
  });
  const opts = (previousValue: unknown, req = makeReq()) => ({ previousValue, req, filterOptions: () => false, data: {}, siblingData: {} });

  it("unchanged legacy row (id-matched previousValue) passes WITHOUT calling relationship()", async () => {
    assert.equal(await validate(10, opts(10)), true);
    assert.equal(await validate({ id: 10 }, opts(10)), true);
    assert.equal(baseCalls, 0);
  });
  it("changed row is blocked (V3) after the base relationship validator", async () => {
    assert.equal(await validate(10, opts(11)), V3);
    assert.equal(baseCalls, 1);
  });
  it("row without an id (previousValue undefined) is evaluated and blocked", async () => {
    assert.equal(await validate(10, opts(undefined)), V3);
  });
  it("base validator's message wins and filterOptions is stripped", async () => {
    let seen: unknown = "unset";
    const v = makeSecondaryRowPillarValidate((async (_v: unknown, o: { filterOptions?: unknown }) => {
      seen = o.filterOptions;
      return "This relationship field has the following invalid selections";
    }) as never) as unknown as V;
    assert.equal(await v(11, opts(undefined)), "This relationship field has the following invalid selections");
    assert.equal(seen, undefined);
  });
  it("ordinary and wad rows pass", async () => {
    assert.equal(await validate(11, opts(undefined)), true);
    assert.equal(await validate(12, opts(undefined)), true);
    assert.equal(await validate(null, opts(undefined)), true);
  });
});

describe("SubSections pillar validate (V4)", () => {
  type V = (value: unknown, options: Record<string, unknown>) => Promise<string | true>;
  const validate = makeSubSectionPillarValidate((async () => true) as never) as unknown as V;
  it("a sub-section under the single-home pillar is refused", async () => {
    assert.equal(await validate(10, { req: makeReq() }), V4);
  });
  it("other pillars (incl. wad pressroom) are fine", async () => {
    assert.equal(await validate(11, { req: makeReq() }), true);
    assert.equal(await validate(12, { req: makeReq() }), true);
  });
  it("base validator message wins", async () => {
    const v = makeSubSectionPillarValidate((async () => "required") as never) as unknown as V;
    assert.equal(await v(null, { req: makeReq() }), "required");
  });
  it("lookup errors propagate (fail closed)", async () => {
    await assert.rejects(validate(10, { req: makeReq({ failFind: true }) }), /db down/);
  });
});

describe("secondary pillar filterOptions (UX only, fail open)", () => {
  type F = (a: Record<string, unknown>) => Promise<unknown>;
  const fo = secondaryPillarFilterOptions as unknown as F;
  it("brief-asia, primary = other -> exclude pressroom", async () => {
    assert.deepEqual(await fo({ data: { tenant: 1, pillar: 11 }, req: makeReq() }), { slug: { not_in: ["pressroom"] } });
  });
  it("brief-asia, primary = pressroom -> false", async () => {
    assert.equal(await fo({ data: { tenant: 1, pillar: 10 }, req: makeReq() }), false);
  });
  it("unconfigured tenant / missing tenant -> exactly true", async () => {
    assert.equal(await fo({ data: { tenant: 2, pillar: 12 }, req: makeReq() }), true);
    assert.equal(await fo({ data: {}, req: makeReq() }), true);
  });
  it("lookup failure -> exactly true (never throws)", async () => {
    assert.equal(await fo({ data: { tenant: 1, pillar: 10 }, req: makeReq({ failFind: true }) }), true);
  });
});

describe("Pillars row guard: beforeChange (V5 rename / move)", () => {
  type H = (a: Record<string, unknown>) => Promise<unknown>;
  const bc = pillarRowGuardBeforeChange as unknown as H;
  const stored = { id: 10, tenant: 1, slug: "pressroom" };
  it("CREATE of (brief-asia, pressroom) is allowed (originalDoc = {}), and duplicate too", async () => {
    const req = makeReq();
    assert.ok(await bc({ operation: "create", data: { tenant: 1, slug: "pressroom" }, originalDoc: {}, req }));
    assert.ok(await bc({ operation: "create", data: { tenant: 2, slug: "pressroom" }, originalDoc: stored, req }));
    assert.equal(req.calls.length, 0);
  });
  it("update with an unchanged pair (incl. absent keys, populated tenant) is allowed with zero lookups", async () => {
    const req = makeReq({ failFind: true });
    assert.ok(await bc({ operation: "update", data: { title: "Pressroom" }, originalDoc: stored, req }));
    assert.ok(await bc({ operation: "update", data: { tenant: { id: 1 }, slug: "pressroom" }, originalDoc: stored, req }));
    assert.ok(await bc({ operation: "update", data: { tenant: "1" }, originalDoc: stored, req }));
    assert.equal(req.calls.length, 0);
  });
  it("slug rename (incl. case/whitespace) is a ValidationError on path slug", async () => {
    for (const slug of ["press", "Pressroom "]) {
      await assert.rejects(bc({ operation: "update", data: { slug }, originalDoc: stored, req: makeReq() }), (err: unknown) => {
        assert.equal(humanErrorMessage(err), "pillar rule: this pillar's slug cannot be changed.");
        assert.equal((err as { data?: { errors?: { path?: string }[] } }).data?.errors?.[0]?.path, "slug");
        return true;
      });
    }
  });
  it("tenant move out of brief-asia and of WAD's pressroom into brief-asia are APIError 400", async () => {
    for (const [orig, data] of [
      [stored, { tenant: 2 }],
      [{ id: 12, tenant: 2, slug: "pressroom" }, { tenant: { id: 1 } }],
    ] as const) {
      await assert.rejects(bc({ operation: "update", data, originalDoc: orig, req: makeReq() }), (err: unknown) => {
        assert.equal((err as Error).message, "pillar rule: this pillar cannot be moved to another tenant.");
        assert.equal((err as { status?: number }).status, 400);
        assert.equal(isSingleHomeRuleError(err), true);
        return true;
      });
    }
  });
  it("wad pressroom rename and a non-single-home move are allowed", async () => {
    assert.ok(await bc({ operation: "update", data: { slug: "press" }, originalDoc: { id: 12, tenant: 2, slug: "pressroom" }, req: makeReq() }));
    assert.ok(await bc({ operation: "update", data: { tenant: 3 }, originalDoc: { id: 12, tenant: 2, slug: "pressroom" }, req: makeReq() }));
  });
  it("renaming another brief-asia pillar to pressroom is blocked", async () => {
    await assert.rejects(bc({ operation: "update", data: { slug: "pressroom" }, originalDoc: { id: 11, tenant: 1, slug: "asia" }, req: makeReq() }), /slug|invalid/);
  });
});

describe("Pillars row guard: beforeDelete (V5 in-use)", () => {
  type H = (a: Record<string, unknown>) => Promise<unknown>;
  const bd = pillarRowGuardBeforeDelete as unknown as H;
  it("0-ref single-home delete is allowed; reads tenant+slug from the STORED doc", async () => {
    const req = makeReq();
    await bd({ id: 10, req, collection: { slug: "pillars" }, context: req.context });
    assert.equal(req.calls[0]!.op, "findByID");
    assert.equal(req.calls[0]!.args.overrideAccess, true);
  });
  for (const key of ["articles", "subsections", "newsletters", "versions"]) {
    it(`in use by ${key} -> APIError 400`, async () => {
      const req = makeReq({ counts: { [key]: 1 } });
      await assert.rejects(bd({ id: 10, req, collection: { slug: "pillars" }, context: req.context }), (err: unknown) => {
        assert.equal((err as Error).message, "pillar rule: this pillar cannot be deleted while articles or sub-sections use it.");
        assert.equal((err as { status?: number }).status, 400);
        return true;
      });
    });
  }
  it("draft-only reference count uses countVersions with latest=true and version.* paths", async () => {
    const req = makeReq();
    await bd({ id: 10, req, collection: { slug: "pillars" }, context: req.context });
    const cv = req.calls.find((c) => c.op === "countVersions")!;
    assert.deepEqual(cv.args.where, {
      and: [
        { latest: { equals: true } },
        { or: [{ "version.pillar": { equals: 10 } }, { "version.secondarySections.pillar": { equals: 10 } }] },
      ],
    });
  });
  it("wad pressroom (not single-home) delete is allowed even when referenced", async () => {
    const req = makeReq({ counts: { articles: 4 } });
    await bd({ id: 12, req, collection: { slug: "pillars" }, context: req.context });
    assert.equal(req.calls.filter((c) => c.op === "count").length, 0);
  });
});
