import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLexical, classifyLink, extractLinks, oldHostsLeft, pendingUploadCount, planBody, type BodySection } from "./vowasia-body";

const IMG = "https://img.example.invalid/media/a.jpg";
const IMG2 = "https://img.example.invalid/media/b.jpg";
const HOSTS = ["img.example.invalid"];

function types(state: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; children?: unknown[] }) => {
    if (n.type) out.push(n.type);
    for (const c of n.children ?? []) walk(c as { type?: string; children?: unknown[] });
  };
  walk((state as { root: { type?: string; children?: unknown[] } }).root);
  return out;
}

test("real shapes {heading, body} and {heading, body, image} are planned in array order", () => {
  const p = planBody(
    [
      { heading: "First", body: { en: "One.\n\nTwo." } },
      { heading: { en: "Second" }, body: { en: "Three." }, image: { url: IMG, alt: "Alt text", credit: "Cred" } },
    ],
    "Title",
    HOSTS,
  );
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.sections.length, 2);
  assert.deepEqual(p.sections[0], { heading: "First", image: null, paragraphs: ["One.", "Two."] });
  assert.deepEqual(p.sections[1]?.image, { url: IMG, alt: "Alt text", credit: "Cred" });
  assert.deepEqual(p.imageUrls, [IMG]);
});

test("should emit H2, then the upload node, then paragraphs inside one section", () => {
  const p = planBody([{ heading: "H", body: { en: "P1\n\nP2" }, image: { url: IMG } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const b = buildLexical(p.sections, { mediaIdByUrl: new Map([[IMG, 42]]), failedUrls: new Set(), nodeSeed: "a1" });
  const top = b.state?.root.children.map((c) => (c as { type: string }).type);
  assert.deepEqual(top, ["heading", "upload", "paragraph", "paragraph"]);
  const up = b.state?.root.children[1] as Record<string, unknown>;
  assert.equal(up.value, 42);
  assert.equal(up.relationTo, "media");
  assert.equal(up.version, 3);
  assert.equal((b.state?.root.children[0] as Record<string, unknown>).tag, "h2");
});

test("should escape < > & in body.en and never create HTML nodes", () => {
  const p = planBody([{ heading: "a <b> & c", body: { en: "<script>alert(1)</script> & <img src=x>" } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.htmlLike, true);
  const b = buildLexical(p.sections, { mediaIdByUrl: new Map(), failedUrls: new Set(), nodeSeed: "x" });
  const t = types(b.state);
  assert.deepEqual([...new Set(t)].sort(), ["heading", "paragraph", "root", "text"]);
  const json = JSON.stringify(b.state);
  assert.ok(json.includes("<script>alert(1)</script> & <img src=x>"), "the text is kept literally in a text node");
});

test("blank-line split gives one paragraph per block; single newlines become spaces", () => {
  const p = planBody([{ heading: "", body: { en: "a\nb\r\n\r\nc\n\n\n  d  " } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.deepEqual(p.sections[0]?.paragraphs, ["a b", "c", "d"]);
  assert.equal(p.sections[0]?.heading, null);
});

test("body-image alt fallback chain and credit", () => {
  const plan = (image: unknown) => {
    const p = planBody([{ heading: "h", body: { en: "x" }, image }], "Article Title", HOSTS);
    assert.equal(p.ok, true);
    return p.ok ? p.sections[0]?.image : undefined;
  };
  assert.deepEqual(plan({ url: IMG, alt: "A", caption: "C", credit: "K" }), { url: IMG, alt: "A", credit: "K" });
  assert.deepEqual(plan({ url: IMG, alt: " ", caption: "C" }), { url: IMG, alt: "C", credit: "" });
  assert.deepEqual(plan({ url: IMG }), { url: IMG, alt: "Article Title", credit: "" });
  const bad = planBody([{ heading: "h", body: { en: "x" }, image: { alt: "no url" } }], "T", HOSTS);
  assert.equal(bad.ok, false);
});

test("should leave zero pending upload nodes and zero old image hosts", () => {
  const p = planBody([{ heading: "h", body: { en: "x" }, image: { url: IMG } }, { heading: "h2", body: { en: "y" }, image: { url: IMG2 } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const b = buildLexical(p.sections, { mediaIdByUrl: new Map([[IMG, 1], [IMG2, 2]]), failedUrls: new Set(), nodeSeed: "s" });
  assert.equal(pendingUploadCount(b.state), 0);
  assert.deepEqual(oldHostsLeft(b.state, HOSTS), []);
  // a mutant: an upload node without a value is pending, an old URL in a text node is found
  const mutant = JSON.parse(JSON.stringify(b.state));
  delete mutant.root.children[1].value;
  mutant.root.children[0].children[0].text = `see ${IMG}`;
  assert.equal(pendingUploadCount(mutant), 1);
  assert.deepEqual(oldHostsLeft(mutant, HOSTS), ["img.example.invalid"]);
  assert.throws(() => buildLexical(p.sections, { mediaIdByUrl: new Map([[IMG, 1]]), failedUrls: new Set(), nodeSeed: "s" }), /no Media id/);
});

test("store-level failed image -> the whole section is dropped and the article is flagged draft", () => {
  const p = planBody([{ heading: "keep", body: { en: "k" } }, { heading: "drop", body: { en: "d" }, image: { url: IMG } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const b = buildLexical(p.sections, { mediaIdByUrl: new Map(), failedUrls: new Set([IMG]), nodeSeed: "s" });
  assert.equal(b.draft, true);
  assert.equal(b.droppedImageSections, 1);
  assert.equal(JSON.stringify(b.state).includes("drop"), false);
  assert.equal(JSON.stringify(b.state).includes(IMG), false);
});

test("off-allow-list URL in text -> kept verbatim and returned with its class", () => {
  const body = "Read https://vowasia.com/article/old-post. Also https://www.VowAsia.com/article/other-one and https://example.invalid/page?x=1, plus https://vowasia.com/about.";
  const p = planBody([{ heading: "h", body: { en: body } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.deepEqual(
    p.links.map((l) => [l.url, l.cls, l.legacySlug ?? null]),
    [
      ["https://vowasia.com/article/old-post", "old-site-article", "old-post"],
      ["https://www.VowAsia.com/article/other-one", "old-site-article", "other-one"],
      ["https://example.invalid/page?x=1", "external", null],
      ["https://vowasia.com/about", "external", null],
    ],
  );
  const b = buildLexical(p.sections, { mediaIdByUrl: new Map(), failedUrls: new Set(), nodeSeed: "s" });
  assert.ok(JSON.stringify(b.state).includes(body), "text unchanged");
  assert.deepEqual(extractLinks("x https://vowasia.com/article/a-b), y").map((l) => l.url), ["https://vowasia.com/article/a-b"]);
  assert.equal(classifyLink("http://vowasia.com/article/a").cls, "old-site-article");
  assert.equal(classifyLink("https://vowasia.com.evil.invalid/article/a").cls, "external");
});

test("an old image host URL inside the body text is reported by the plan (row rejected by the importer)", () => {
  const p = planBody([{ heading: "h", body: { en: `inline ${IMG}` } }], "T", HOSTS);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.deepEqual(p.oldHostInText, true);
  assert.equal(p.links.length, 0, "image-host URLs are not links");
});

test("JSON-string body and empty body; invalid shapes rejected", () => {
  const s = planBody(JSON.stringify([{ heading: "h", body: "plain" }]), "T", HOSTS);
  assert.equal(s.ok && (s.sections[0] as BodySection).paragraphs[0], "plain");
  const e = planBody(null, "T", HOSTS);
  assert.equal(e.ok && e.sections.length, 0);
  assert.equal(planBody({ not: "array" }, "T", HOSTS).ok, false);
  assert.equal(planBody([{ heading: 5, body: "x" }], "T", HOSTS).ok, false);
  const empty = buildLexical([], { mediaIdByUrl: new Map(), failedUrls: new Set(), nodeSeed: "s" });
  assert.equal(empty.state, undefined);
});
