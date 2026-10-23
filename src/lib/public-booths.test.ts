/** Unit tests for ./public-booths (allowlist shaping). npm run test:booths */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boothDetail, boothSummary, mediaIdsOf, refId } from "./public-booths";

const media = new Map([
  ["7", { url: "https://img/logo.png", alt: "Logo", filename: "logo.png" }],
  ["8", { url: "https://img/cat.png", alt: "Cat", filename: "cat.png" }],
]);
const stored = {
  id: 1, tenant: 3, published: true, articles: [11, 12], createdAt: "x", updatedAt: "y", secretNote: "nope",
  slug: "acme", name: "Acme", hall: "manufacturers", typeLine: "OEM/ODM Manufacturer", city: "Seoul", country: "Korea",
  verified: true, tier: "premium", summary: "S", about: { root: { children: [] } }, logo: 7, catalog: 8,
  capabilities: [{ id: "a", category: "Skin", formats: "Cream", moq: "1000", leadTime: "6w" }],
  atAGlance: { id: "g", founded: "1999", employees: "200", certifications: "ISO 22716", marketsServed: "Asia", languages: "EN" },
  website: "https://acme.example", inquiryEmail: "sales@acme.example",
};

describe("public booths shaping", () => {
  it("summary carries exactly the allowlisted keys", () => {
    const s = boothSummary(stored, media);
    assert.deepEqual(Object.keys(s).sort(), ["atAGlance", "city", "country", "hall", "logo", "name", "slug", "summary", "tier", "typeLine", "verified"]);
    assert.deepEqual(s.logo, { url: "https://img/logo.png", alt: "Logo" });
    assert.deepEqual(s.atAGlance, { certifications: "ISO 22716" });
  });
  it("detail adds the full fields and never leaks internal ones", () => {
    const d = boothDetail(stored, media);
    for (const k of ["tenant", "published", "articles", "id", "createdAt", "updatedAt", "secretNote"]) assert.equal(k in d, false, k);
    assert.deepEqual(d.catalog, { url: "https://img/cat.png", filename: "cat.png" });
    assert.deepEqual(d.capabilities, [{ category: "Skin", formats: "Cream", moq: "1000", leadTime: "6w" }]);
    assert.equal("id" in d.atAGlance, false);
    assert.equal(d.inquiryEmail, "sales@acme.example");
    assert.deepEqual(d.about, { root: { children: [] } });
  });
  it("missing media/catalog -> null; defaults", () => {
    const d = boothDetail({ slug: "b", name: "B" }, new Map());
    assert.equal(d.logo, null);
    assert.equal(d.catalog, null);
    assert.equal(d.tier, "basic");
    assert.equal(d.verified, false);
    assert.deepEqual(d.capabilities, []);
  });
  it("refId / mediaIdsOf", () => {
    assert.equal(refId({ id: 5 }), "5");
    assert.equal(refId(null), null);
    assert.deepEqual(mediaIdsOf([{ logo: 1, catalog: { id: 2 } }, { logo: 1 }], ["logo", "catalog"]), ["1", "2"]);
  });
});
