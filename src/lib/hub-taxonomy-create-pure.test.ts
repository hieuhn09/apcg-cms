/**
 * Unit tests for ./hub-taxonomy-create-pure (APCGHub P5.6, chặng 2 — T01–T10).
 * Pure: no Payload, no DB, no network. Invisible / line-break code points are built
 * with `cp(…)` so this file carries no raw invisible characters.
 *
 *   npm run test:hub-p56
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HUB_FIELD_CODES, HUB_SLUG_SHAPE } from "./hub-author-limits";
import {
  AUTHOR_ROLES,
  DEFAULT_AUTHOR_ROLE,
  authorCreateData,
  normaliseTaxonomyText,
  parseAuthorBody,
  parseTagBody,
  tagPreFold,
  tagSlugFrom,
} from "./hub-taxonomy-create-pure";

const cp = (...n: number[]) => String.fromCodePoint(...n);
const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
type Sample = { input: string; out?: string; code?: string; title?: string; slug?: string };
const S = JSON.parse(readFileSync(path.resolve("src/lib/hub-taxonomy-create-samples.json"), "utf8")) as {
  roles: string[];
  defaultRole: string;
  authors: { accept: Sample[]; reject: Sample[] };
  tags: { accept: Sample[]; reject: Sample[] };
};
const CODES = HUB_FIELD_CODES as readonly string[];
const norm = (s: string, k: "author" | "tag" = "author") => normaliseTaxonomyText(s, k);
const code = (s: string, k: "author" | "tag" = "author") => {
  const r = norm(s, k);
  return r.ok ? `ok:${r.value}` : r.code;
};

test("T01 normalisation order (D12)", async (t) => {
  await t.test("NFD and NFC give the same value", () => {
    const nfd = "Nguye" + cp(0x302, 0x303) + "n";
    assert.deepEqual(norm(nfd), { ok: true, value: "Nguyễn" });
  });
  await t.test("line breaks / BOM / tab are REFUSED, never folded into a space", () => {
    assert.equal(code("A" + cp(0x2028) + "B"), "newline");
    assert.equal(code("A" + cp(0x2029) + "B"), "newline");
    assert.equal(code("A\tB"), "newline");
    assert.equal(code("A\nB"), "newline");
    assert.equal(code("Ab" + cp(0xfeff) + "Cd"), "invalid");
  });
  await t.test("every space-separator run (NBSP, U+3000, tabs excluded) becomes one space", () => {
    assert.deepEqual(norm("Jo" + cp(0xa0, 0x3000, 0x20) + "Ann"), { ok: true, value: "Jo Ann" });
  });
  await t.test("both ends are trimmed", () => {
    assert.deepEqual(norm("   Ann Lee  "), { ok: true, value: "Ann Lee" });
  });
});

test("T02 accept samples round-trip and the sample table is not empty", () => {
  for (const s of S.authors.accept) assert.deepEqual(norm(s.input), { ok: true, value: s.out }, JSON.stringify(s));
  const total = S.authors.accept.length + S.authors.reject.length + S.tags.accept.length + S.tags.reject.length;
  assert.ok(total >= 40, `samples ${total}`);
  assert.ok(S.authors.accept.length >= 15);
  assert.ok(S.authors.reject.length >= 20);
  assert.ok(new Set(S.authors.reject.map((s) => s.code)).size >= 8);
  assert.ok(S.tags.accept.length + S.tags.reject.length >= 10);
  assert.equal(S.roles.length, 9);
});

test("T03 reject samples carry the right closed code", async (t) => {
  await t.test("every reject sample", () => {
    for (const s of S.authors.reject) {
      assert.equal(code(s.input), s.code, JSON.stringify(s));
      assert.ok(CODES.includes(s.code!), s.code);
    }
  });
  await t.test("invisible fillers, joiners and selectors are refused", () => {
    for (const v of [
      cp(0x3164, 0x3164),
      cp(0xffa0, 0xffa0),
      "A" + cp(0x34f) + "B",
      "Ab" + cp(0xfe0f),
      "Ab" + cp(0x17b4) + "c",
      "Ab" + cp(0x180b) + "c",
      "Ab" + cp(0xfeff) + "c",
      "A" + cp(0x16fe4) + "B",
      "Ab" + cp(0x200b) + "c",
      "Ab" + cp(0x200d) + "c",
      "<b>Ann</b>",
      "Ann\\Lee",
      "Ann " + cp(0x1f3b8),
    ]) {
      assert.equal(code(v), "invalid", JSON.stringify(v));
    }
    assert.equal(code("Ab" + cp(0x202e) + "c"), "bidi");
    assert.equal(code("Ab" + cp(0x1) + "c"), "c0");
    assert.equal(code("Ab" + cp(0x85) + "c"), "c0");
    assert.equal(code(cp(0x301) + "Ann"), "format");
    assert.equal(code("x" + cp(0x301, 0x302, 0x303, 0x304) + "yz"), "format");
    assert.equal(code("x".repeat(121)), "too_long");
  });
});

test("T04 a pen name needs at least two letters", () => {
  for (const v of ["..", "-- --", "12", "A1"]) assert.equal(code(v), "format", v);
});

test("T05 roles: closed list of 9, default Staff writer, anything else invalid", async (t) => {
  const body = (role?: unknown) => ({ tenant: "gcv", name: "Ann Lee", actor: ACTOR, ...(role === undefined ? {} : { role }) });
  await t.test("the 9 roles are accepted (and equal the sample list)", () => {
    assert.deepEqual([...AUTHOR_ROLES], S.roles);
    for (const r of AUTHOR_ROLES) {
      const p = parseAuthorBody(body(r));
      assert.ok(p.ok && p.value.role === r, r);
    }
  });
  await t.test("absent ⇒ Staff writer", () => {
    const p = parseAuthorBody(body());
    assert.equal(DEFAULT_AUTHOR_ROLE, S.defaultRole);
    assert.ok(p.ok && p.value.role === "Staff writer");
  });
  await t.test("another string ⇒ invalid (a closed code)", () => {
    for (const r of ["Staff Writer", "Editor-in-chief", ""]) {
      const p = parseAuthorBody(body(r));
      assert.ok(!p.ok && p.status === 422);
      assert.deepEqual((p.body as { fields: unknown }).fields, { role: "invalid" });
    }
  });
});

test("T06 parseAuthorBody", async (t) => {
  await t.test("exact keys ⇒ ok, name normalised", () => {
    const p = parseAuthorBody({ tenant: " gcv ", name: "  Ann  Lee ", role: "Analyst", actor: ACTOR });
    assert.deepEqual(p, { ok: true, value: { tenant: "gcv", name: "Ann Lee", role: "Analyst", actor: { email: ACTOR.email, role: "editor" } } });
  });
  await t.test("unknown key (root or actor) ⇒ 400", () => {
    const a = parseAuthorBody({ tenant: "gcv", name: "Ann Lee", actor: ACTOR, slug: "x" });
    const b = parseAuthorBody({ tenant: "gcv", name: "Ann Lee", actor: { ...ACTOR, x: 1 } });
    assert.ok(!a.ok && a.status === 400 && !b.ok && b.status === 400);
  });
  await t.test("wrong type ⇒ 422 type", () => {
    const p = parseAuthorBody({ tenant: "gcv", name: 42, actor: ACTOR });
    assert.ok(!p.ok && p.status === 422);
    assert.deepEqual((p.body as { fields: unknown }).fields, { name: "type" });
  });
  await t.test("missing name ⇒ required; missing actor ⇒ actor required", () => {
    const p = parseAuthorBody({ tenant: "gcv", actor: ACTOR });
    assert.ok(!p.ok && p.status === 422);
    assert.deepEqual((p.body as { fields: unknown }).fields, { name: "required" });
    const q = parseAuthorBody({ tenant: "gcv", name: "Ann Lee" });
    assert.ok(!q.ok && q.status === 422);
    assert.deepEqual((q.body as { fields: unknown }).fields, { actor: "required" });
  });
  await t.test("role null ⇒ type", () => {
    const p = parseAuthorBody({ tenant: "gcv", name: "Ann Lee", role: null, actor: ACTOR });
    assert.ok(!p.ok);
    assert.deepEqual((p.body as { fields: unknown }).fields, { role: "type" });
  });
});

test("T07 tag titles and slugs (D14)", async (t) => {
  await t.test("accept samples: title + slug", () => {
    for (const s of S.tags.accept) {
      const r = norm(s.input, "tag");
      assert.deepEqual(r, { ok: true, value: s.title }, JSON.stringify(s));
      assert.equal(tagSlugFrom(s.title!), s.slug);
      assert.ok(HUB_SLUG_SHAPE.test(s.slug!));
    }
  });
  await t.test("reject samples", () => {
    for (const s of S.tags.reject) assert.equal(code(s.input, "tag"), s.code, JSON.stringify(s));
  });
  await t.test("letter-or-digit rule: 5G F1 G7 2024 accepted; .. -- C++ refused", () => {
    for (const [v, slug] of [["5G", "5g"], ["F1", "f1"], ["G7", "g7"], ["2024", "2024"]] as const) {
      assert.equal(code(v, "tag"), `ok:${v}`);
      assert.equal(tagSlugFrom(v), slug);
    }
    for (const v of ["..", "--", "C++"]) assert.equal(code(v, "tag"), "invalid", v);
  });
  await t.test("CJK only ⇒ no slug ⇒ invalid; R&D ⇒ r-d", () => {
    assert.equal(code("日本", "tag"), "invalid");
    assert.equal(tagSlugFrom("R&D"), "r-d");
  });
  await t.test("tagPreFold letters", () => {
    const want: [string, string][] = [
      ["Đồng", "dong"], ["Đà Nẵng", "da-nang"], ["Łódź", "lodz"], ["Søren", "soren"], ["Straße", "strasse"],
      ["Ðorđe", "dorde"], ["Þór", "thor"], ["Ħamrun", "hamrun"], ["Işık", "isik"],
    ];
    for (const [v, slug] of want) assert.equal(tagSlugFrom(v), slug, v);
    assert.equal(tagPreFold("ĐđŁłØøßÆæŒœÐðÞþĦħı"), "DdLlOossAEaeOEoeDdThthHhi");
  });
  await t.test("title length 2–60", () => {
    assert.equal(code("A", "tag"), "format");
    assert.equal(code("x".repeat(61), "tag"), "too_long");
    assert.equal(code("x".repeat(60), "tag"), `ok:${"x".repeat(60)}`);
  });
});

test("T08 parseTagBody", async (t) => {
  await t.test("exact keys ⇒ ok with derived slug", () => {
    assert.deepEqual(parseTagBody({ tenant: "gcv", title: " Đà  Nẵng ", actor: ACTOR }), {
      ok: true,
      value: { tenant: "gcv", title: "Đà Nẵng", slug: "da-nang", actor: { email: ACTOR.email, role: "editor" } },
    });
  });
  await t.test("unknown key ⇒ 400 (a slug from the body is refused)", () => {
    const p = parseTagBody({ tenant: "gcv", title: "Climate", slug: "x", actor: ACTOR });
    assert.ok(!p.ok && p.status === 400);
  });
  await t.test("missing title ⇒ required", () => {
    const p = parseTagBody({ tenant: "gcv", actor: ACTOR });
    assert.ok(!p.ok && p.status === 422);
    assert.deepEqual((p.body as { fields: unknown }).fields, { title: "required" });
  });
  await t.test("wrong type ⇒ type; no tenant ⇒ 400", () => {
    const p = parseTagBody({ tenant: "gcv", title: ["x"], actor: ACTOR });
    assert.ok(!p.ok);
    assert.deepEqual((p.body as { fields: unknown }).fields, { title: "type" });
    const q = parseTagBody({ title: "Climate", actor: ACTOR });
    assert.ok(!q.ok && q.status === 400);
  });
});

test("T09 the author create data is exactly {name, role}", () => {
  assert.deepEqual(Object.keys(authorCreateData("Ann Lee", "Analyst")).sort(), ["name", "role"]);
});

test("T10 accent / case folding gives the same tag slug", async (t) => {
  await t.test("Châu Á ≡ chau a", () => assert.equal(tagSlugFrom("Châu Á"), tagSlugFrom("chau a")));
  await t.test("Đồng ≡ Dong (dong)", () => {
    assert.equal(tagSlugFrom("Đồng"), "dong");
    assert.equal(tagSlugFrom("Dong"), "dong");
  });
});
