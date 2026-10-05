/**
 * Unit tests for ./single-home-pillars (Node's built-in runner; no test framework).
 *
 *   npm run test:single-home
 *
 * Covers the pure rule core: V1-V4 + V6 decisions, the fail-closed taxonomy
 * normaliser, change detection, the intake pre-check, the Pillars row-guard
 * predicates, error unwrapping, the filterOptions / validate builders, the
 * batched resolver (with an injected fake `find`) and tenant keying.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { SINGLE_HOME_PILLARS, ENGINE_BLOCKED_PILLARS, isEngineBlockedPillar } from "./constants";
import {
  MSG,
  ruleMessage,
  isSingleHomePillar,
  singleHomeSlugUnion,
  normalizeTaxonomy,
  taxonomyChanged,
  checkSingleHome,
  checkIntakeSingleHome,
  checkPillarRowChange,
  checkPillarDelete,
  isSingleHomeRuleError,
  humanErrorMessage,
  pillarFilterWhere,
  subSectionPillarDecision,
  secondaryRowPillarDecision,
  resolveSingleHome,
  resolveTenantSlugs,
  resetSingleHomeMemo,
  idKey,
  type FindFn,
} from "./single-home-pillars";

const V1 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot also have secondary sections.';
const V2 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot have a sub-section.';
const V3 = 'pillar rule: "pressroom" is a single-home pillar: it cannot be added as a secondary section to another article.';
const V4 = 'pillar rule: "pressroom" is a single-home pillar: it cannot have sub-sections.';
const V6 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot be marked exclusive.';

describe("constants", () => {
  it("SINGLE_HOME_PILLARS = { brief-asia: [pressroom] } beside ENGINE_BLOCKED_PILLARS", () => {
    assert.deepEqual(SINGLE_HOME_PILLARS, { "brief-asia": ["pressroom"] });
    assert.deepEqual(ENGINE_BLOCKED_PILLARS, { gcv: ["exclusive"], "brief-asia": ["pressroom"] });
    assert.deepEqual(singleHomeSlugUnion(), ["pressroom"]);
  });
  it("Amendment 1: brief-asia pressroom is engine-blocked; wad pressroom is not; gcv unchanged", () => {
    assert.ok(ENGINE_BLOCKED_PILLARS["brief-asia"]?.includes("pressroom"));
    assert.equal(ENGINE_BLOCKED_PILLARS["wad"], undefined);
    assert.deepEqual(ENGINE_BLOCKED_PILLARS.gcv, ["exclusive"]);
  });
  it("isEngineBlockedPillar is case/whitespace-insensitive and tenant-keyed (C11g)", () => {
    assert.equal(isEngineBlockedPillar("brief-asia", "pressroom"), true);
    assert.equal(isEngineBlockedPillar("brief-asia", "PRESSROOM"), true);
    assert.equal(isEngineBlockedPillar("brief-asia", " Pressroom "), true);
    assert.equal(isEngineBlockedPillar("gcv", " EXCLUSIVE"), true);
    assert.equal(isEngineBlockedPillar("wad", "pressroom"), false);
    assert.equal(isEngineBlockedPillar("brief-asia", "finance"), false);
    assert.equal(isEngineBlockedPillar("brief-asia", "exclusive"), false);
    assert.equal(isEngineBlockedPillar(undefined, "pressroom"), false);
    assert.equal(isEngineBlockedPillar("brief-asia", ""), false);
  });
});

describe("message strings equal the shared contract", () => {
  it("V1-V4, V6", () => {
    assert.equal(ruleMessage("pressroom", "V1"), V1);
    assert.equal(ruleMessage("pressroom", "V2"), V2);
    assert.equal(ruleMessage("pressroom", "V3"), V3);
    assert.equal(ruleMessage("pressroom", "V4"), V4);
    assert.equal(ruleMessage("pressroom", "V6"), V6);
  });
  it("V5 strings carry no single-home prefix", () => {
    assert.equal(MSG.rename, "pillar rule: this pillar's slug cannot be changed.");
    assert.equal(MSG.delete, "pillar rule: this pillar cannot be deleted while articles or sub-sections use it.");
    assert.equal(MSG.move, "pillar rule: this pillar cannot be moved to another tenant.");
  });
});

describe("tenant keying", () => {
  it("brief-asia pressroom is single-home", () => {
    assert.equal(isSingleHomePillar("brief-asia", "pressroom"), true);
  });
  it("wad and gcv pressroom are NOT flagged (negative control)", () => {
    assert.equal(isSingleHomePillar("wad", "pressroom"), false);
    assert.equal(isSingleHomePillar("gcv", "pressroom"), false);
    assert.equal(isSingleHomePillar(undefined, "pressroom"), false);
    assert.equal(isSingleHomePillar(null, "pressroom"), false);
  });
  it("resolver slug compare is case-sensitive", () => {
    assert.equal(isSingleHomePillar("brief-asia", "Pressroom"), false);
    assert.equal(isSingleHomePillar("brief-asia", " pressroom "), false);
    assert.equal(isSingleHomePillar("brief-asia", "asia"), false);
  });
  it("intake pre-check is a no-op for wad and gcv", () => {
    assert.equal(checkIntakeSingleHome("wad", { pillarSlug: "pressroom", sections: ["asia"], subSectionSlug: "x" }), null);
    assert.equal(checkIntakeSingleHome("gcv", { pillarSlug: "finance", sections: ["pressroom"] }), null);
  });
});

describe("normalizeTaxonomy", () => {
  it("ids vs populated objects reduce to the same keys", () => {
    const a = normalizeTaxonomy({ pillar: 5, subSection: "7", secondarySections: [{ pillar: { id: 9 }, subSection: null }] });
    const b = normalizeTaxonomy({ pillar: { id: 5, slug: "x" }, subSection: { id: 7 }, secondarySections: [{ pillar: 9 }] });
    assert.deepEqual(a, b);
    assert.deepEqual(a, { pillar: "5", subSection: "7", secondary: [{ pillar: "9", subSection: null }] });
  });
  it("null / '' / absent / [] are empty", () => {
    const empty = { pillar: null, subSection: null, secondary: [] };
    assert.deepEqual(normalizeTaxonomy({}), empty);
    assert.deepEqual(normalizeTaxonomy({ pillar: null, subSection: "", secondarySections: [] }), empty);
    assert.deepEqual(normalizeTaxonomy({ pillar: "", secondarySections: null }), empty);
  });
  it("rows whose pillar and subSection are both empty are dropped", () => {
    assert.deepEqual(normalizeTaxonomy({ secondarySections: [{ pillar: null, subSection: "" }] }).secondary, []);
  });
  describe("fail closed on malformed shapes (G80)", () => {
    const bad: Array<[string, unknown]> = [
      ["$push with a row object", { $push: { pillar: 3 } }],
      ["$push with an array", { $push: [{ pillar: 3 }] }],
      ["plain non-array object", { 0: { pillar: 3 } }],
      ["a string", "pressroom"],
      ["a number", 3],
      ["a boolean", true],
    ];
    for (const [name, value] of bad) {
      it(`secondarySections as ${name} throws a pillar rule error`, () => {
        assert.throws(() => normalizeTaxonomy({ secondarySections: value }), /^Error: pillar rule:/);
      });
    }
    it("rows that are not objects throw", () => {
      assert.throws(() => normalizeTaxonomy({ secondarySections: [3] }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ secondarySections: ["pressroom"] }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ secondarySections: [null] }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ secondarySections: [[{ pillar: 1 }]] }), /pillar rule:/);
    });
    it("a $-prefixed key in a row throws", () => {
      assert.throws(() => normalizeTaxonomy({ secondarySections: [{ $set: { pillar: 3 } }] }), /pillar rule:/);
    });
    it("NaN / boolean / array / unsafe-int ids throw", () => {
      assert.throws(() => normalizeTaxonomy({ pillar: Number.NaN }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: true }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: [1] }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ subSection: false }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: Number.MAX_SAFE_INTEGER + 1 }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: 1.5 }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ secondarySections: [{ pillar: Number.NaN }] }), /pillar rule:/);
    });
    it("{id} objects: only a non-empty string or a safe-integer id is accepted (G86)", () => {
      assert.throws(() => normalizeTaxonomy({ pillar: { id: { $push: 9 } } }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: { id: "" } }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: { id: Number.NaN } }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: {} }), /pillar rule:/);
      assert.throws(() => normalizeTaxonomy({ pillar: { $in: [1] } }), /pillar rule:/);
    });
  });
  it("null-prototype objects (GraphQL inputs) are accepted (G86)", () => {
    const row = Object.create(null) as Record<string, unknown>;
    row.pillar = 4;
    const ref = Object.create(null) as Record<string, unknown>;
    ref.id = 6;
    assert.deepEqual(normalizeTaxonomy({ pillar: ref, secondarySections: [row] }), {
      pillar: "6",
      subSection: null,
      secondary: [{ pillar: "4", subSection: null }],
    });
  });
  it("an own __proto__ key neither crashes nor pollutes (G86)", () => {
    const row = JSON.parse('{"__proto__": {"polluted": 1}, "pillar": 3}') as Record<string, unknown>;
    assert.deepEqual(normalizeTaxonomy({ secondarySections: [row] }).secondary, [{ pillar: "3", subSection: null }]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
  it("does not call .hasOwnProperty (a row may shadow it)", () => {
    const row = { pillar: 3, hasOwnProperty: () => { throw new Error("must not be called"); } };
    assert.deepEqual(normalizeTaxonomy({ secondarySections: [row] }).secondary, [{ pillar: "3", subSection: null }]);
  });
});

describe("taxonomyChanged", () => {
  const base = normalizeTaxonomy({ pillar: 1, subSection: 2, secondarySections: [{ pillar: 3 }] });
  it("equal (incl. id vs populated) = unchanged", () => {
    assert.equal(taxonomyChanged(base, normalizeTaxonomy({ pillar: { id: 1 }, subSection: { id: 2 }, secondarySections: [{ pillar: { id: 3 } }] })), false);
  });
  it("changed secondarySections / subSection / pillar = changed", () => {
    assert.equal(taxonomyChanged(base, normalizeTaxonomy({ pillar: 1, subSection: 2, secondarySections: [] })), true);
    assert.equal(taxonomyChanged(base, normalizeTaxonomy({ pillar: 1, subSection: null, secondarySections: [{ pillar: 3 }] })), true);
    assert.equal(taxonomyChanged(base, normalizeTaxonomy({ pillar: 8, subSection: 2, secondarySections: [{ pillar: 3 }] })), true);
  });
});

describe("checkSingleHome (V1/V2/V3/V6)", () => {
  // pillar id 10 = brief-asia pressroom; 11 = asia; 12 = wad pressroom (not single-home)
  const sh = (id: string | null) => (id === "10" ? "pressroom" : null);
  it("V1: primary single-home + any secondary row is blocked", () => {
    const r = checkSingleHome(normalizeTaxonomy({ pillar: 10, secondarySections: [{ pillar: 11 }] }), sh, false);
    assert.deepEqual(r, { message: V1, path: "secondarySections" });
  });
  it("V1: a PERSISTED duplicate-of-primary secondary row is a violation", () => {
    const r = checkSingleHome(normalizeTaxonomy({ pillar: 10, secondarySections: [{ pillar: 10 }] }), sh, false);
    assert.deepEqual(r, { message: V1, path: "secondarySections" });
  });
  it("V2: primary single-home + subSection is blocked", () => {
    const r = checkSingleHome(normalizeTaxonomy({ pillar: 10, subSection: 4 }), sh, false);
    assert.deepEqual(r, { message: V2, path: "subSection" });
  });
  it("V3: secondary row = single-home with other or null primary is blocked", () => {
    assert.deepEqual(checkSingleHome(normalizeTaxonomy({ pillar: 11, secondarySections: [{ pillar: 13 }, { pillar: 10 }] }), sh, false), {
      message: V3,
      path: "secondarySections.1.pillar",
    });
    assert.deepEqual(checkSingleHome(normalizeTaxonomy({ pillar: null, secondarySections: [{ pillar: 10 }] }), sh, false), {
      message: V3,
      path: "secondarySections.0.pillar",
    });
  });
  it("V6: primary single-home + exclusive is blocked", () => {
    assert.deepEqual(checkSingleHome(normalizeTaxonomy({ pillar: 10 }), sh, true), { message: V6, path: "exclusive" });
  });
  it("valid pressroom-only article and ordinary articles pass", () => {
    assert.equal(checkSingleHome(normalizeTaxonomy({ pillar: 10 }), sh, false), null);
    assert.equal(checkSingleHome(normalizeTaxonomy({ pillar: 11, subSection: 4, secondarySections: [{ pillar: 12 }] }), sh, true), null);
  });
});

describe("intake pre-check (checkIntakeSingleHome)", () => {
  const ba = (body: Record<string, unknown>) => checkIntakeSingleHome("brief-asia", body);
  it("pressroom + sections is refused (V1)", () => {
    assert.equal(ba({ pillarSlug: "pressroom", sections: ["asia"] }), V1);
    assert.equal(ba({ pillarSlug: "pressroom", sections: [{ pillar: "finance" }] }), V1);
  });
  it("pressroom + a nonexistent slug in sections is refused (stricter than today)", () => {
    assert.equal(ba({ pillarSlug: "pressroom", sections: ["does-not-exist"] }), V1);
  });
  it("an entry equal to the primary is ignored (string, trimmed, and {pillar, subSection})", () => {
    assert.equal(ba({ pillarSlug: "pressroom", sections: ["pressroom", " pressroom ", { pillar: "pressroom", subSection: "x" }] }), null);
  });
  it("pressroom + subSectionSlug / subSectionSlugs[] is refused (V2)", () => {
    assert.equal(ba({ pillarSlug: "pressroom", subSectionSlug: "interviews" }), V2);
    assert.equal(ba({ pillarSlug: "pressroom", subSectionSlugs: ["", "x"] }), V2);
  });
  it("pressroom + secondarySubSections is refused (V1)", () => {
    assert.equal(ba({ pillarSlug: "pressroom", secondarySubSections: [{ pillarSlug: "asia", subSectionSlug: "x" }] }), V1);
  });
  it("empty optional fields are fine", () => {
    assert.equal(ba({ pillarSlug: "pressroom", sections: [], subSectionSlug: "", subSectionSlugs: [], secondarySubSections: [] }), null);
  });
  it("other article with sections naming pressroom is refused (V3), case/whitespace-insensitive", () => {
    assert.equal(ba({ pillarSlug: "asia", sections: ["pressroom"] }), V3);
    assert.equal(ba({ pillarSlug: "asia", sections: ["PRESSROOM"] }), V3);
    assert.equal(ba({ pillarSlug: "asia", sections: [" pressroom "] }), V3);
    assert.equal(ba({ pillarSlug: "asia", sections: [{ pillar: "Pressroom" }] }), V3);
  });
  it("case/whitespace primary variants are treated as single-home by the pre-check (safe superset)", () => {
    assert.equal(ba({ pillarSlug: "PRESSROOM", sections: ["asia"] }), V1);
    assert.equal(ba({ pillarSlug: " pressroom ", subSectionSlug: "x" }), V2);
    // ...while the resolver itself stays case-sensitive (pinned):
    assert.equal(isSingleHomePillar("brief-asia", "PRESSROOM"), false);
  });
  it("secondaryPillarSlugs is never checked (WTB field, ignored by intake)", () => {
    assert.equal(ba({ pillarSlug: "asia", secondaryPillarSlugs: ["pressroom"] }), null);
    assert.equal(ba({ pillarSlug: "pressroom", secondaryPillarSlugs: ["asia"] }), null);
  });
  // Pre-check level only: since Amendment 1 the route's engine-blocked gate 3b
  // (ENGINE_BLOCKED_PILLARS) refuses a brief-asia pressroom primary FIRST.
  it("valid pressroom-only body and an ordinary body pass", () => {
    assert.equal(ba({ pillarSlug: "pressroom" }), null);
    assert.equal(ba({ pillarSlug: "asia", sections: ["finance"], subSectionSlug: "x" }), null);
  });
  it("refresh bodies go through the same pre-check", () => {
    const refresh = { pillarSlug: "pressroom", engineDraftId: "d-1", sections: ["asia"] };
    assert.equal(ba(refresh), V1);
  });
  it("duplicate secondary entries naming pressroom are still refused", () => {
    assert.equal(ba({ pillarSlug: "asia", sections: ["finance", "pressroom", "pressroom"] }), V3);
  });
});

describe("checkPillarRowChange (V5 rename / tenant move)", () => {
  const T = (slug: string | null) => slug;
  it("create is never checked (handled by the operation gate); unchanged pair passes", () => {
    assert.equal(checkPillarRowChange({ oldTenantId: "1", oldTenantSlug: T("brief-asia"), oldSlug: "pressroom", newTenantId: "1", newTenantSlug: T("brief-asia"), newSlug: "pressroom" }), null);
  });
  it("renaming the single-home slug is blocked, incl. case/whitespace (raw compare)", () => {
    assert.equal(checkPillarRowChange({ oldTenantId: "1", oldTenantSlug: "brief-asia", oldSlug: "pressroom", newTenantId: "1", newTenantSlug: "brief-asia", newSlug: "press" }), "rename");
    assert.equal(checkPillarRowChange({ oldTenantId: "1", oldTenantSlug: "brief-asia", oldSlug: "pressroom", newTenantId: "1", newTenantSlug: "brief-asia", newSlug: "Pressroom " }), "rename");
  });
  it("renaming ANOTHER pillar to pressroom is blocked (new pair single-home)", () => {
    assert.equal(checkPillarRowChange({ oldTenantId: "1", oldTenantSlug: "brief-asia", oldSlug: "asia", newTenantId: "1", newTenantSlug: "brief-asia", newSlug: "pressroom" }), "rename");
  });
  it("tenant move is blocked in both directions", () => {
    assert.equal(checkPillarRowChange({ oldTenantId: "1", oldTenantSlug: "brief-asia", oldSlug: "pressroom", newTenantId: "2", newTenantSlug: "wad", newSlug: "pressroom" }), "move");
    assert.equal(checkPillarRowChange({ oldTenantId: "2", oldTenantSlug: "wad", oldSlug: "pressroom", newTenantId: "1", newTenantSlug: "brief-asia", newSlug: "pressroom" }), "move");
  });
  it("wad pressroom rename / gcv moves are not blocked", () => {
    assert.equal(checkPillarRowChange({ oldTenantId: "2", oldTenantSlug: "wad", oldSlug: "pressroom", newTenantId: "2", newTenantSlug: "wad", newSlug: "press" }), null);
    assert.equal(checkPillarRowChange({ oldTenantId: "2", oldTenantSlug: "wad", oldSlug: "pressroom", newTenantId: "3", newTenantSlug: "gcv", newSlug: "pressroom" }), null);
  });
});

describe("checkPillarDelete (V5 in-use)", () => {
  const zero = { articles: 0, subsections: 0, newsletters: 0, draftVersions: 0 };
  it("0-ref single-home delete is allowed; non-single-home always allowed", () => {
    assert.equal(checkPillarDelete(true, zero), false);
    assert.equal(checkPillarDelete(false, { ...zero, articles: 3 }), false);
  });
  it("any reference blocks (articles, sub-sections, newsletters, draft-only versions)", () => {
    assert.equal(checkPillarDelete(true, { ...zero, articles: 1 }), true);
    assert.equal(checkPillarDelete(true, { ...zero, subsections: 1 }), true);
    assert.equal(checkPillarDelete(true, { ...zero, newsletters: 1 }), true);
    assert.equal(checkPillarDelete(true, { ...zero, draftVersions: 1 }), true);
  });
});

describe("error detection and unwrapping", () => {
  const vErr = (message: string) => Object.assign(new Error("The following field is invalid: secondarySections"), { data: { errors: [{ message, path: "secondarySections" }] } });
  it("isSingleHomeRuleError: ValidationError-shaped with a pillar rule message", () => {
    assert.equal(isSingleHomeRuleError(vErr(V1)), true);
  });
  it("isSingleHomeRuleError: plain Error / APIError with a pillar rule message", () => {
    assert.equal(isSingleHomeRuleError(new Error(MSG.delete)), true);
    assert.equal(isSingleHomeRuleError(Object.assign(new Error(MSG.move), { status: 400 })), true);
  });
  it("isSingleHomeRuleError: a gcv/other ValidationError is NOT a single-home error", () => {
    assert.equal(isSingleHomeRuleError(vErr("Sub-section must belong to this article's Pillar.")), false);
    assert.equal(isSingleHomeRuleError(new Error("invalid date")), false);
    assert.equal(isSingleHomeRuleError("pillar rule: string"), false);
    assert.equal(isSingleHomeRuleError(null), false);
  });
  it("humanErrorMessage unwraps err.data.errors[].message", () => {
    assert.equal(humanErrorMessage(vErr(V2)), V2);
    const two = Object.assign(new Error("x"), { data: { errors: [{ message: "a" }, { message: "b" }] } });
    assert.equal(humanErrorMessage(two), "a; b");
  });
  it("humanErrorMessage: plain Error and non-Error", () => {
    assert.equal(humanErrorMessage(new Error("boom")), "boom");
    assert.equal(humanErrorMessage("text"), "text");
    assert.equal(humanErrorMessage(undefined), "Something went wrong.");
  });
});

describe("filterOptions where-builder and validate decisions", () => {
  it("unconfigured tenant / empty map -> exactly true (fail open)", () => {
    assert.equal(pillarFilterWhere([], false), true);
  });
  it("primary single-home -> false (no secondary pillar may be picked)", () => {
    assert.equal(pillarFilterWhere(["pressroom"], true), false);
  });
  it("other primary -> exclude the single-home slugs", () => {
    assert.deepEqual(pillarFilterWhere(["pressroom"], false), { slug: { not_in: ["pressroom"] } });
  });
  it("SubSections pillar decision: V4 for a single-home pillar", () => {
    assert.equal(subSectionPillarDecision("pressroom"), V4);
    assert.equal(subSectionPillarDecision(null), true);
  });
  it("secondary row decision: V3 for a single-home row pillar", () => {
    assert.equal(secondaryRowPillarDecision("pressroom"), V3);
    assert.equal(secondaryRowPillarDecision(null), true);
  });
});

describe("resolver (injected find, D-C)", () => {
  type Doc = Record<string, unknown>;
  const pillars: Doc[] = [
    { id: 10, slug: "pressroom", tenant: 1 },
    { id: 11, slug: "asia", tenant: 1 },
    { id: 12, slug: "pressroom", tenant: 2 },
  ];
  const tenants: Doc[] = [
    { id: 1, slug: "brief-asia" },
    { id: 2, slug: "wad" },
  ];
  let calls: Array<{ collection: string; args: Record<string, unknown> }>;
  const makeFind = (dropIds: number[] = []): FindFn => async (args) => {
    calls.push({ collection: args.collection, args: args as Record<string, unknown> });
    const ids = ((args.where as { id: { in: unknown[] } }).id.in).map(String);
    const src = args.collection === "pillars" ? pillars : tenants;
    return { docs: src.filter((d) => ids.includes(String(d.id)) && !dropIds.includes(d.id as number)) };
  };
  let ctx: Record<string, unknown>;
  beforeEach(() => {
    calls = [];
    ctx = {};
  });

  it("keys on the referenced pillar docs' own tenant+slug, batched, pagination:false, overrideAccess", async () => {
    const m = await resolveSingleHome({ pillarIds: [10, "11", 12], find: makeFind(), context: ctx });
    assert.equal(m.get("10"), "pressroom");
    assert.equal(m.get("11"), null);
    assert.equal(m.get("12"), null); // wad pressroom: negative control
    assert.equal(calls.length, 2);
    const p = calls[0]!.args;
    assert.equal(calls[0]!.collection, "pillars");
    assert.equal(p.pagination, false);
    assert.equal(p.overrideAccess, true);
    assert.equal(p.depth, 0);
    assert.deepEqual(p.select, { slug: true, tenant: true });
    assert.equal(calls[1]!.collection, "tenants");
    assert.equal(calls[1]!.args.pagination, false);
  });
  it("skips the tenant lookup when no referenced slug is in the single-home union (G79b)", async () => {
    const m = await resolveSingleHome({ pillarIds: [11], find: makeFind(), context: ctx });
    assert.equal(m.get("11"), null);
    assert.equal(calls.length, 1);
  });
  it("no ids -> no lookups", async () => {
    await resolveSingleHome({ pillarIds: [], find: makeFind(), context: ctx });
    assert.equal(calls.length, 0);
  });
  it("fails closed when a requested pillar id is unresolved (G65)", async () => {
    await assert.rejects(resolveSingleHome({ pillarIds: [10, 11], find: makeFind([11]), context: ctx }));
  });
  it("fails closed when a tenant id is unresolved", async () => {
    const find: FindFn = async (args) => {
      calls.push({ collection: args.collection, args: args as Record<string, unknown> });
      return args.collection === "pillars" ? { docs: [pillars[0]!] } : { docs: [] };
    };
    await assert.rejects(resolveSingleHome({ pillarIds: [10], find, context: ctx }));
  });
  it("lookup errors propagate (fail closed)", async () => {
    const find: FindFn = async () => {
      throw new Error("db down");
    };
    await assert.rejects(resolveSingleHome({ pillarIds: [10], find, context: ctx }), /db down/);
  });
  it("memoises per request context; reset helper clears it (G52)", async () => {
    const find = makeFind();
    await resolveSingleHome({ pillarIds: [10], find, context: ctx });
    await resolveSingleHome({ pillarIds: [10], find, context: ctx });
    assert.equal(calls.length, 2);
    resetSingleHomeMemo(ctx);
    await resolveSingleHome({ pillarIds: [10], find, context: ctx });
    assert.equal(calls.length, 4);
    // a fresh request context starts empty
    await resolveSingleHome({ pillarIds: [10], find, context: {} });
    assert.equal(calls.length, 6);
  });
  it("resolveTenantSlugs maps ids to slugs and fails closed on a missing tenant", async () => {
    const m = await resolveTenantSlugs({ tenantIds: [1, "2"], find: makeFind(), context: ctx });
    assert.equal(m.get("1"), "brief-asia");
    assert.equal(m.get("2"), "wad");
    await assert.rejects(resolveTenantSlugs({ tenantIds: [99], find: makeFind(), context: {} }));
  });
  it("idKey normalises numbers, strings and populated docs", () => {
    assert.equal(idKey(5), "5");
    assert.equal(idKey("5"), "5");
    assert.equal(idKey({ id: 5 }), "5");
    assert.equal(idKey(null), null);
    assert.equal(idKey(""), null);
  });
});
