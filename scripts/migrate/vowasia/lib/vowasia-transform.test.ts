import { test } from "node:test";
import assert from "node:assert/strict";
import { TAG_BY_SUBSECTION, dateFallbackCounts, readEn, rowFromSnapshot, statusDecision, tagFor, transformRow, type LegacyArticle } from "./vowasia-transform";

const ROLES = {
  createdAt: "created_at", publishedAt: "published_at", status: "status", section: "section", subsection: "subsection", slug: "slug",
  title: "title", excerpt: "excerpt", body: "body_sections", image: "featured_image", imageCredit: "featured_image_credit", tags: "tags", updatedAt: "updated_at",
};

function legacy(extra: Partial<LegacyArticle> = {}): LegacyArticle {
  return {
    legacyId: "a1", slug: "a-wedding", status: "published", section: "style", subsection: "beauty",
    title: { en: "A wedding" }, excerpt: { en: "An excerpt" }, body: [], image: "https://img.example.invalid/c.jpg", imageCredit: "Fixture",
    tags: ["x"], createdAt: "2026-01-01T10:00:00.000Z", publishedAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-01-03T10:00:00.000Z",
    ...extra,
  };
}

test("should read title.en and reject any other title shape with titleShape", () => {
  assert.deepEqual(readEn({ en: "Hello" }), { ok: true, text: "Hello" });
  assert.deepEqual(readEn({ en: "" }), { ok: true, text: "" });
  for (const bad of [null, "Hello", { vi: "x" }, { en: 3 }, ["x"], 5]) assert.equal(readEn(bad).ok, false, JSON.stringify(bad));
  const r = transformRow(legacy({ title: "plain string" }));
  assert.equal(r.kind, "reject");
  assert.equal(r.kind === "reject" && r.reason, "titleShape");
  const ex = transformRow(legacy({ excerpt: { de: "x" } }));
  assert.equal(ex.kind === "reject" && ex.reason, "excerptShape");
  const ok = transformRow(legacy());
  assert.equal(ok.kind, "import");
  assert.equal(ok.kind === "import" && ok.title, "A wedding");
  assert.equal(ok.kind === "import" && ok.excerpt, "An excerpt");
});

test("should count date fallbacks over all rows and over imported rows", () => {
  const rows = [
    legacy({ legacyId: "1", publishedAt: null }),
    legacy({ legacyId: "2", publishedAt: null, status: "rejected" }),
    legacy({ legacyId: "3" }),
    legacy({ legacyId: "4", publishedAt: "" }),
  ];
  const c = dateFallbackCounts(rows);
  assert.deepEqual(c, { all: 3, imported: 2 });
  const t = transformRow(rows[0] as LegacyArticle);
  assert.equal(t.kind === "import" && t.publishedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(t.kind === "import" && t.publishedAtFellBack, true);
});

test("status table: published/archived kept, draft/scheduled -> draft, rejected -> skip, other -> reject", () => {
  assert.deepEqual(statusDecision("published"), { kind: "import", from: "published", status: "published" });
  assert.deepEqual(statusDecision("archived"), { kind: "import", from: "archived", status: "archived" });
  assert.deepEqual(statusDecision("draft"), { kind: "import", from: "draft", status: "draft" });
  assert.deepEqual(statusDecision("scheduled"), { kind: "import", from: "scheduled", status: "draft" });
  assert.deepEqual(statusDecision("rejected"), { kind: "skip", reason: "rejected" });
  assert.equal(statusDecision("weird").kind, "reject");
  assert.equal(transformRow(legacy({ status: "rejected" })).kind, "skip");
});

test("no cover -> draft with reason noCover, original status kept for the report", () => {
  for (const image of [null, "", "   "]) {
    const t = transformRow(legacy({ image }));
    assert.equal(t.kind, "import");
    if (t.kind !== "import") continue;
    assert.equal(t.status, "draft");
    assert.equal(t.oldStatus, "published");
    assert.deepEqual(t.draftReasons, ["noCover"]);
    assert.equal(t.coverUrl, null);
  }
  const arch = transformRow(legacy({ image: null, status: "archived" }));
  assert.equal(arch.kind === "import" && arch.status, "draft");
});

test("published_at null -> created_at", () => {
  const t = transformRow(legacy({ publishedAt: null }));
  assert.equal(t.kind === "import" && t.publishedAt, "2026-01-01T10:00:00.000Z");
  const k = transformRow(legacy());
  assert.equal(k.kind === "import" && k.publishedAt, "2026-01-02T10:00:00.000Z");
  assert.equal(k.kind === "import" && k.publishedAtFellBack, false);
});

test("tag table Q10: only the five mapped sub-sections carry a tag; legacy tags column ignored", () => {
  assert.equal(tagFor("honeymoons"), "honeymoons");
  assert.equal(tagFor("hotels-resorts"), "wedding-venues");
  assert.equal(tagFor("gowns-attire"), "bridal-fashion");
  assert.equal(tagFor("rings-jewellery"), "bridal-fashion");
  assert.equal(tagFor("industry-news"), "wedding-industry");
  for (const s of ["beauty", "flowers-decor", "trend-reports", "people-planners", "by-destination", "destination-guides"]) assert.equal(tagFor(s), null, s);
  assert.equal(tagFor(null), null);
  assert.deepEqual(Object.values(TAG_BY_SUBSECTION).sort(), ["bridal-fashion", "bridal-fashion", "honeymoons", "wedding-industry", "wedding-venues"]);
  const t = transformRow(legacy({ section: "style", subsection: "rings-jewelry", tags: ["indian-weddings", "elopements"] }));
  assert.equal(t.kind === "import" && t.subSection, "rings-jewellery");
  assert.equal(t.kind === "import" && t.tag, "bridal-fashion");
  const v = transformRow(legacy({ section: "venues", subsection: null }));
  assert.equal(v.kind === "import" && v.subSection, null);
  assert.equal(v.kind === "import" && v.tag, null);
});

test("unknown C8 pair -> reject with reason; old SEO fields are never read", () => {
  const r = transformRow(legacy({ section: "venues", subsection: "honeymoons" }));
  assert.equal(r.kind, "reject");
  assert.match(r.kind === "reject" ? r.reason : "", /^C8/);
  const row = { id: "z", slug: "s", status: "published", section: "style", subsection: "beauty", title: { en: "T" }, excerpt: { en: "E" }, body_sections: [], featured_image: null, featured_image_credit: null, tags: [], created_at: "2026-01-01T00:00:00Z", published_at: null, updated_at: null, seo: { title: "OLD SEO" }, meta_description: "OLD" };
  const a = rowFromSnapshot(row, ROLES, "id");
  assert.equal(a.legacyId, "z");
  assert.equal(JSON.stringify(transformRow(a)).includes("OLD"), false);
});
