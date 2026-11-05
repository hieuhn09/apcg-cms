/** Unit tests for ./amb-legacy-booths (legacy amb booths -> Central `booths`). npm run test:booths */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AMB_BOOTH_HALLS, boothHallDecision } from "../../src/lib/booth-halls";
import {
  AMB_LEGACY_BOOTHS,
  AMB_LEGACY_HALL_MAP,
  deriveTypeLine,
  hallsNeeded,
  lexicalParagraphs,
  mapAmbLegacyBooth,
  planAmbBooths,
  validateAmbLegacyBooths,
  type AmbLegacyBooth,
} from "./amb-legacy-booths";

const bySlug = (slug: string) => {
  const r = AMB_LEGACY_BOOTHS.find((b) => b.slug === slug);
  assert.ok(r, slug);
  return r;
};

describe("amb legacy booths: embedded data", () => {
  it("six rows, unique kebab-case slugs, the expected set", () => {
    const slugs = AMB_LEGACY_BOOTHS.map((b) => b.slug);
    assert.equal(slugs.length, 6);
    assert.equal(new Set(slugs).size, 6);
    for (const s of slugs) assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.deepEqual([...slugs].sort(), [
      "boho",
      "naffaro-dawood-indofurni",
      "neri-and-hu",
      "richards-prestige-lighting",
      "takenaka-asia",
      "tran-duc-furnishings",
    ]);
  });
  it("validates clean; no personal-contact fields are embedded", () => {
    assert.deepEqual(validateAmbLegacyBooths(), []);
    for (const b of AMB_LEGACY_BOOTHS) {
      for (const k of Object.keys(b)) assert.doesNotMatch(k, /email|phone|password|token|secret|contact/i, k);
    }
  });
  it("validate catches a duplicate slug, a bad slug and an unknown hall", () => {
    const base = AMB_LEGACY_BOOTHS[0] as AmbLegacyBooth;
    const bad = [base, { ...base }, { ...base, slug: "Bad Slug" }, { ...base, slug: "x", hall: "pavilions" as never }];
    const p = validateAmbLegacyBooths(bad);
    assert.ok(p.some((m) => /duplicate slug/.test(m)));
    assert.ok(p.some((m) => /not kebab-case/.test(m)));
    assert.ok(p.some((m) => /unknown legacy hall/.test(m)));
  });
});

describe("amb legacy booths: hall mapping", () => {
  it("studios -> design-studios; services/brands/manufacturers unchanged", () => {
    assert.deepEqual({ ...AMB_LEGACY_HALL_MAP }, { studios: "design-studios", services: "services", brands: "brands", manufacturers: "manufacturers" });
    assert.equal(mapAmbLegacyBooth(bySlug("neri-and-hu")).hall, "design-studios");
    assert.equal(mapAmbLegacyBooth(bySlug("takenaka-asia")).hall, "services");
    assert.equal(mapAmbLegacyBooth(bySlug("richards-prestige-lighting")).hall, "brands");
    assert.equal(mapAmbLegacyBooth(bySlug("boho")).hall, "manufacturers");
  });
  it("every mapped hall is allowed for tenant amb (the Booths hall validate)", () => {
    for (const b of AMB_LEGACY_BOOTHS) {
      const hall = mapAmbLegacyBooth(b).hall;
      assert.ok(AMB_BOOTH_HALLS.includes(hall), hall);
      assert.equal(boothHallDecision("amb", hall), true);
    }
    assert.deepEqual(hallsNeeded().sort(), ["brands", "design-studios", "manufacturers", "services"]);
  });
  it("an unknown legacy hall throws", () => {
    assert.throws(() => mapAmbLegacyBooth({ ...(AMB_LEGACY_BOOTHS[0] as AmbLegacyBooth), hall: "x" as never }), /unknown legacy hall/);
  });
});

describe("amb legacy booths: field mapping", () => {
  it("fixed values: published, basic tier, not verified; slug and name kept; no tenant, logo, catalog, inquiryEmail, articles", () => {
    for (const b of AMB_LEGACY_BOOTHS) {
      const d = mapAmbLegacyBooth(b);
      assert.equal(d.published, true);
      assert.equal(d.tier, "basic");
      assert.equal(d.verified, false);
      assert.equal(d.slug, b.slug);
      assert.equal(d.name, b.name);
      for (const k of ["tenant", "logo", "catalog", "inquiryEmail", "articles"]) assert.ok(!(k in d), k);
    }
  });
  it("full row (takenaka-asia): joins, city/country, website, summary, typeLine", () => {
    const d = mapAmbLegacyBooth(bySlug("takenaka-asia"));
    assert.equal(d.city, "Bangkok");
    assert.equal(d.country, "Japan");
    assert.equal(d.website, "https://takenaka.asia/");
    assert.equal(d.summary, "Design-build, project management and interior fit-out across seven Asian markets");
    assert.equal(d.typeLine, "Design-build & interior fit-out");
    assert.deepEqual(d.capabilities, [
      { category: "design-build, interior fit-out, project management, special engineering", formats: "commercial, retail, hospitality, industrial" },
    ]);
    assert.deepEqual(d.atAGlance, { marketsServed: "Singapore, Thailand, Indonesia, India, Myanmar, Malaysia, Vietnam" });
  });
  it("null and empty legacy values leave the field empty (no formats, moq, leadTime, founded keys)", () => {
    const d = mapAmbLegacyBooth(bySlug("boho"));
    assert.deepEqual(d.capabilities, [{ category: "interior fit-out, casegoods, sofas, doors" }]);
    assert.equal(d.atAGlance, undefined);
    const tran = mapAmbLegacyBooth(bySlug("tran-duc-furnishings"));
    assert.deepEqual(tran.atAGlance, { founded: "2001", employees: "2,000+", marketsServed: "United States, Europe, Middle East" });
    const dawood = mapAmbLegacyBooth(bySlug("naffaro-dawood-indofurni"));
    assert.deepEqual(dawood.atAGlance, { founded: "2008", certifications: "SVLK" });
  });
  it("moq / leadTime are carried when present", () => {
    const d = mapAmbLegacyBooth({ ...bySlug("boho"), moq: "50 units", lead_time: " 6 weeks " });
    assert.deepEqual(d.capabilities, [{ category: "interior fit-out, casegoods, sofas, doors", moq: "50 units", leadTime: "6 weeks" }]);
  });
  it("typeLine: first two categories, sentence case; none -> undefined", () => {
    assert.equal(deriveTypeLine(["architecture", "interior design", "branding"]), "Architecture & interior design");
    assert.equal(deriveTypeLine(["chandeliers"]), "Chandeliers");
    assert.equal(deriveTypeLine([]), undefined);
    for (const b of AMB_LEGACY_BOOTHS) assert.ok((mapAmbLegacyBooth(b).typeLine ?? "").length <= 60, b.slug);
  });
});

describe("amb legacy booths: about (Lexical)", () => {
  it("capabilities paragraph, then notable_projects when present", () => {
    const withNotable = mapAmbLegacyBooth(bySlug("takenaka-asia")).about;
    assert.ok(withNotable);
    assert.deepEqual(
      withNotable.root.children.map((p) => p.children[0]?.text),
      [bySlug("takenaka-asia").capabilities, bySlug("takenaka-asia").notable_projects],
    );
    const without = mapAmbLegacyBooth(bySlug("neri-and-hu")).about;
    assert.ok(without);
    assert.equal(without.root.children.length, 1);
    assert.equal(without.root.children[0]?.children[0]?.text, bySlug("neri-and-hu").capabilities);
  });
  it("minimal valid shape: root > paragraph > text with the Lexical version/format keys", () => {
    const doc = lexicalParagraphs(["One.", "  ", "Two."]);
    assert.deepEqual(doc, {
      root: {
        type: "root", version: 1, direction: null, format: "", indent: 0,
        children: ["One.", "Two."].map((text) => ({
          type: "paragraph", version: 1, direction: null, format: "", indent: 0, textFormat: 0,
          children: [{ type: "text", version: 1, text, format: 0, detail: 0, mode: "normal", style: "" }],
        })),
      },
    });
    assert.equal(lexicalParagraphs(["", " "]), undefined);
    assert.equal(mapAmbLegacyBooth({ ...bySlug("boho"), capabilities: null, notable_projects: null }).about, undefined);
  });
});

describe("amb legacy booths: plan", () => {
  it("empty tenant: six create; all present: six exists; partial: only the missing ones create", () => {
    assert.deepEqual(planAmbBooths([]).map((i) => i.action), Array(6).fill("create"));
    const all = AMB_LEGACY_BOOTHS.map((b) => b.slug);
    assert.deepEqual(planAmbBooths(all).map((i) => i.action), Array(6).fill("exists"));
    const partial = planAmbBooths(["boho", "neri-and-hu", "unrelated"]);
    assert.deepEqual(partial.filter((i) => i.action === "exists").map((i) => i.slug).sort(), ["boho", "neri-and-hu"]);
    assert.equal(partial.filter((i) => i.action === "create").length, 4);
  });
});
