/** Unit tests for ./booth-halls and the Booths `hall` validate (per-tenant halls). npm run test:booths */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ABB_BOOTH_HALLS, AMB_BOOTH_HALLS, BOOTH_HALLS, BOOTH_HALLS_BY_TENANT, boothHallDecision } from "./booth-halls";
import { makeBoothHallValidate } from "../hooks/booth-hall";
import { ABB_EXHIBITION_HALLS } from "../../scripts/lib/abb-taxonomy";
import { AMB_EXHIBITION_HALLS } from "../../scripts/lib/amb-taxonomy";

const VALUES = BOOTH_HALLS.map((h) => h.value);

describe("booth halls", () => {
  it("the six 20261022 values keep their order; four amb values follow; no duplicate", () => {
    assert.deepEqual(VALUES.slice(0, 6), ["manufacturers", "ingredients-fragrance", "packaging-machinery", "brands-for-distribution", "distributors-retail", "services"]);
    assert.deepEqual(VALUES.slice(6), ["brands", "design-studios", "distributors-showrooms", "country-pavilions"]);
    assert.equal(new Set(VALUES).size, VALUES.length);
  });
  it("amb website order: Hall 01..06; abb unchanged; both subsets of the enum and of their taxonomy", () => {
    assert.deepEqual([...AMB_BOOTH_HALLS], ["manufacturers", "brands", "design-studios", "distributors-showrooms", "services", "country-pavilions"]);
    assert.deepEqual([...ABB_BOOTH_HALLS], VALUES.slice(0, 6));
    for (const h of [...ABB_BOOTH_HALLS, ...AMB_BOOTH_HALLS]) assert.ok(VALUES.includes(h), h);
    assert.deepEqual(AMB_EXHIBITION_HALLS.map((h) => h.slug), [...AMB_BOOTH_HALLS]);
    assert.deepEqual(ABB_EXHIBITION_HALLS.map((h) => h.slug), [...ABB_BOOTH_HALLS]);
    assert.deepEqual(Object.keys(BOOTH_HALLS_BY_TENANT).sort(), ["abb", "amb"]);
  });
  it("decision: allowed hall passes, another title's hall is refused, empty hall and unmapped tenant pass", () => {
    assert.equal(boothHallDecision("amb", "design-studios"), true);
    assert.equal(boothHallDecision("amb", "manufacturers"), true);
    assert.match(String(boothHallDecision("amb", "ingredients-fragrance")), /not a hall of this title \(amb\)/);
    assert.match(String(boothHallDecision("abb", "country-pavilions")), /not a hall of this title \(abb\)/);
    assert.equal(boothHallDecision("abb", "services"), true);
    for (const empty of [null, undefined, ""]) assert.equal(boothHallDecision("amb", empty), true);
    assert.equal(boothHallDecision("gcv", "brands"), true);
    assert.equal(boothHallDecision(null, "brands"), true);
    assert.equal(boothHallDecision("__proto__", "brands"), true);
  });
});

describe("Booths hall validate", () => {
  const okBase = (() => true) as never;
  const reqWith = (tenants: Record<string, string | Error>) => ({
    payload: {
      findByID: async ({ id }: { id: number | string }) => {
        const v = tenants[String(id)];
        if (v instanceof Error) throw v;
        return v === undefined ? null : { id, slug: v };
      },
    },
  });
  const run = (value: unknown, tenant: unknown, req: unknown, base = okBase) =>
    makeBoothHallValidate(base)(value as never, { data: { tenant }, siblingData: {}, req } as never);

  it("resolves the tenant id and applies the allowlist", async () => {
    const req = reqWith({ "5": "amb", "6": "abb" });
    assert.equal(await run("brands", 5, req), true);
    assert.match(String(await run("packaging-machinery", 5, req)), /not a hall of this title \(amb\)/);
    assert.match(String(await run("brands", 6, req)), /not a hall of this title \(abb\)/);
    assert.equal(await run("brands", { id: 6, slug: "amb" }, reqWith({})), true);
  });
  it("base select error wins; empty hall and missing tenant pass; lookup failure fails closed", async () => {
    assert.equal(await run("brands", 5, reqWith({ "5": "amb" }), (() => "bad option") as never), "bad option");
    assert.equal(await run(null, 5, reqWith({})), true);
    assert.equal(await run("brands", undefined, reqWith({})), true);
    assert.match(String(await run("brands", 9, reqWith({ "9": new Error("db down") }))), /could not be resolved/);
    assert.match(String(await run("brands", 10, reqWith({}))), /could not be resolved/);
  });
});
