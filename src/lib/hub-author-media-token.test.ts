/**
 * Unit tests for ./hub-author-media-token (APCGHub P5.3, T8 — branch B candidate,
 * written at step 1.6 BEFORE the syntax decision; not yet wired into conversion).
 * Node's built-in runner; no DB. The converters here are FAKES that model the one
 * property the module relies on (a root paragraph holding exactly one text node).
 *
 *   npm run test:hub-media
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_TOKEN_RE,
  extractMediaIds,
  findMediaTokenLines,
  mediaPlaceholder,
  mediaTokenConverters,
  mediaTokenFor,
  placeholdersToTokens,
  placeholdersToUploadNodes,
  tokensToPlaceholders,
  uploadIdsInTree,
  uploadNodesToPlaceholders,
  uploadValueId,
  withoutMediaTokenLines,
} from "./hub-author-media-token";

type Node = Record<string, unknown>;
const text = (t: string): Node => ({ type: "text", text: t, format: 0, version: 1 });
const para = (...c: Node[]): Node => ({ type: "paragraph", children: c, version: 1 });
const upload = (value: unknown, relationTo = "media"): Node => ({ type: "upload", version: 3, format: "", id: "abc123", fields: null, relationTo, value });
const root = (...c: Node[]) => ({ root: { type: "root", children: c, version: 1 } });

/** A fake Markdown↔Lexical pair: blank-line separated blocks ⇄ root paragraphs with one text node. */
const fake = {
  toLexical: (md: string) => root(...md.split(/\n\n/).filter((b) => b !== "").map((b) => para(text(b)))),
  toMarkdown: (lex: unknown) =>
    ((lex as { root: { children: Node[] } }).root.children)
      .map((p) => {
        if (p.type !== "paragraph") throw new Error(`fake exporter cannot print ${String(p.type)}`);
        return (p.children as Node[]).map((t) => t.text).join("");
      })
      .join("\n\n"),
};

const ids = (md: string) => extractMediaIds(md);
const isImage = (md: string) => withoutMediaTokenLines(md).includes("![");

// ── plan failing-stub names ──────────────────────────────────────────────────

test("media token export depends only on relationTo and id (number or populated value)", () => {
  assert.equal(mediaTokenFor({ relationTo: "media", value: 5 }), "![](cms-media:5)");
  assert.equal(mediaTokenFor({ relationTo: "media", value: { id: 5, url: "/api/media/file/x.png", alt: "ignored alt" } }), "![](cms-media:5)");
  assert.throws(() => mediaTokenFor({ relationTo: "videoMedia", value: 5 }));
  assert.throws(() => mediaTokenFor({ relationTo: "media", value: null }));
  assert.throws(() => mediaTokenFor({ relationTo: "media", value: 0 }));
});

test("media token is only valid as the sole content of a root paragraph; lex upload ids must equal checked ids", () => {
  assert.deepEqual(ids("![](cms-media:5)"), ["5"]);
  assert.deepEqual(ids("Intro.\n\n![x](cms-media:5)\n\nOutro."), ["5"]);
  assert.deepEqual(ids("Intro.\n![](cms-media:5)\n\nOutro."), [], "previous line not blank");
  assert.deepEqual(ids("Intro.\n\n![](cms-media:5)\nOutro."), [], "next line not blank");
  assert.deepEqual(ids("See ![](cms-media:5) here"), [], "mid-sentence");
  const lex = root(para(text("a")), upload(5), upload({ id: 7, url: "/x" }));
  assert.deepEqual(uploadIdsInTree(lex), ["5", "7"]);
  assert.deepEqual(uploadIdsInTree(root(para(text("a")))), []);
});

test("indented or CRLF media token placed between other paragraphs is rejected as image", () => {
  for (const md of [
    "A.\n\n ![](cms-media:5)\n\nB.",
    "A.\n\n   ![](cms-media:5)\n\nB.",
    "A.\n\n    ![](cms-media:5)\n\nB.",
    "A.\n\n![](cms-media:5)\r\n\r\nB.",
    "A.\r\n\r\n![](cms-media:5)\r\n\r\nB.",
    "A.\n\n![](cms-media:5) \n\nB.",
  ]) {
    assert.deepEqual(ids(md), [], JSON.stringify(md));
    assert.equal(isImage(md), true, JSON.stringify(md));
  }
});

// ── shape ────────────────────────────────────────────────────────────────────

describe("token shape (T8 a)", () => {
  it("one regex, no m flag; id [1-9][0-9]*", () => {
    assert.equal(MEDIA_TOKEN_RE.flags.includes("m"), false);
    assert.equal(MEDIA_TOKEN_RE.test("![](cms-media:12)"), true);
    assert.equal(MEDIA_TOKEN_RE.test("![](cms-media:0)"), false);
    assert.equal(MEDIA_TOKEN_RE.test("![](cms-media:01)"), false);
    assert.equal(MEDIA_TOKEN_RE.test("![](cms-media:-1)"), false);
    assert.equal(MEDIA_TOKEN_RE.test("![](cms-media:5 \"t\")"), false);
    assert.equal(MEDIA_TOKEN_RE.test("![a]b](cms-media:5)"), false);
  });
  it("ids above int4 keep their shape and are RETURNED (refs reports out_of_range, never dropped)", () => {
    const d11 = "1".repeat(11);
    const d20 = "9".repeat(20);
    const d400 = "7".repeat(400);
    assert.deepEqual(ids(`![](cms-media:${d11})\n\n![](cms-media:${d20})\n\n![](cms-media:${d400})`), [d11, d20, d400]);
    assert.equal(isImage(`![](cms-media:${d400})`), false);
  });
  it("U+2028 / U+2029 right after the token ⇒ not a token", () => {
    assert.deepEqual(ids("![](cms-media:5) "), []);
    assert.deepEqual(ids("A.\n\n![](cms-media:5) \n\nB."), []);
  });
  it("a neighbouring line with only spaces or tabs counts as blank (same rule as the hub)", () => {
    assert.deepEqual(ids("A.\n  \n![](cms-media:5)\n\t\nB."), ["5"]);
  });
});

// ── positions that are NOT tokens (⇒ image) ──────────────────────────────────

describe("non-token image forms stay `image` (T8 a vectors)", () => {
  const vectors: Record<string, string> = {
    "mid-sentence": "Text ![](cms-media:5) text",
    "in a list": "- ![](cms-media:5)",
    "list then indented 2 spaces": "- item\n\n  ![](cms-media:5)",
    "in a quote": "> ![](cms-media:5)",
    "in a heading": "## ![](cms-media:5)",
    "inside a link label": "[![](cms-media:5)](https://x.test)",
    "two tokens one line": "![](cms-media:5)![](cms-media:6)",
    reference: "![a][r]\n\n[r]: cms-media:1",
    title: '![](cms-media:5 "t")',
    "escaped bang": "!\\[](cms-media:5)",
    "code span": "`![](cms-media:5)`",
    "id 0": "![](cms-media:0)",
    "id 01": "![](cms-media:01)",
    "fence with a blank line inside": "```\n\n![](cms-media:5)\n\n```",
    "tilde fence": "~~~\n![](cms-media:5)\n~~~",
    "plain url image": "![a](https://x.test/i.png)",
    "alt with ]": "![a]b](cms-media:5)",
  };
  for (const [name, md] of Object.entries(vectors)) {
    it(name, () => {
      assert.deepEqual(ids(md), [], name);
      assert.equal(isImage(md) || name === "escaped bang", true, name);
    });
  }
  it("text after a fence closes is scanned again", () => {
    assert.deepEqual(ids("```\nx\n```\n\n![](cms-media:9)"), ["9"]);
  });
  it("findMediaTokenLines reports line index + id", () => {
    assert.deepEqual(findMediaTokenLines("A.\n\n![](cms-media:3)"), [{ line: 2, id: "3" }]);
  });
});

// ── conversion wrappers (with fake converters) ───────────────────────────────

describe("placeholders + converters (T8 d)", () => {
  it("the internal placeholder holds a forbidden C0 (U+0001), never \\t \\n \\r", () => {
    const p = mediaPlaceholder("5");
    assert.ok(p.includes("\u0001"));
    assert.ok(!/[\t\n\r]/.test(p));
  });
  it("tokensToPlaceholders / placeholdersToTokens are inverse on token lines, others untouched", () => {
    const md = "A.\n\n![alt is dropped](cms-media:5)\n\nB ![](cms-media:6) x";
    const pre = tokensToPlaceholders(md);
    assert.ok(pre.includes(mediaPlaceholder("5")));
    assert.ok(pre.includes("B ![](cms-media:6) x"));
    assert.equal(placeholdersToTokens(pre), "A.\n\n![](cms-media:5)\n\nB ![](cms-media:6) x");
  });
  it("placeholder paragraphs become upload nodes; only DIRECT children of root", () => {
    const lex = root(para(text("A.")), para(text(mediaPlaceholder("5"))), { type: "quote", children: [para(text(mediaPlaceholder("6")))] });
    const out = placeholdersToUploadNodes(lex) as { root: { children: Node[] } };
    const kids = out.root.children;
    assert.equal(kids[1]!.type, "upload");
    assert.equal(kids[1]!.relationTo, "media");
    assert.equal(kids[1]!.value, 5);
    assert.equal(kids[2]!.type, "quote");
  });
  it("upload nodes (value number or populated object) become placeholders; other relationTo / null value throw", () => {
    const a = uploadNodesToPlaceholders(root(upload(5), upload({ id: 8, url: "/x" }))) as { root: { children: Node[] } };
    assert.deepEqual(a.root.children.map((n) => (n.children as Node[])[0]!.text), [mediaPlaceholder("5"), mediaPlaceholder("8")]);
    assert.throws(() => uploadNodesToPlaceholders(root(upload(5, "videoMedia"))));
    assert.throws(() => uploadNodesToPlaceholders(root(upload(null))));
  });
  it("(i)–(iii) with fakes: md → lex has upload{media,5}; export is the canonical token; md1 → lex → md1 is stable", () => {
    const conv = mediaTokenConverters(fake);
    const lex = conv.toLexical("Intro.\n\n![any alt](cms-media:5)\n\nOutro.") as { root: { children: Node[] } };
    assert.deepEqual(lex.root.children.map((n) => n.type), ["paragraph", "upload", "paragraph"]);
    assert.equal(lex.root.children[1]!.value, 5);
    const md1 = conv.toMarkdown(lex);
    assert.equal(md1, "Intro.\n\n![](cms-media:5)\n\nOutro.");
    assert.equal(conv.toMarkdown(conv.toLexical(md1)), md1);
    const populated = root(para(text("Intro.")), upload({ id: 5, url: "/api/media/file/a.png", alt: "x" }), para(text("Outro.")));
    assert.equal(conv.toMarkdown(populated), md1);
  });
  it("uploadValueId", () => {
    assert.equal(uploadValueId(5), 5);
    assert.equal(uploadValueId({ id: 9 }), 9);
    assert.equal(uploadValueId("5"), null);
    assert.equal(uploadValueId(null), null);
    assert.equal(uploadValueId({ id: -1 }), null);
  });
});

// ── step 2.2: fences (review-1 M1) + placeholder discipline (review-2 note a) ──

describe("CommonMark fences (review-1 M1)", () => {
  it("a token inside a 4-backtick fence that contains a 3-backtick line is NOT a token", () => {
    const md = "````\n```\n\n![](cms-media:5)\n\n```\n````";
    assert.deepEqual(ids(md), []);
    assert.equal(isImage(md), true);
  });
  it("a longer closer closes; a shorter one or one with text after it does not", () => {
    assert.deepEqual(ids("```\nx\n`````\n\n![](cms-media:5)"), ["5"]);
    assert.deepEqual(ids("~~~~\nx\n~~~\n\n![](cms-media:5)"), []);
    assert.deepEqual(ids("```\nx\n``` y\n\n![](cms-media:5)"), []);
  });
  it("a backtick line with a backtick in its info string is not an opener; an unclosed fence runs to the end", () => {
    assert.deepEqual(ids("``` a`b\n\n![](cms-media:5)"), ["5"]);
    assert.deepEqual(ids("```\n\n![](cms-media:5)"), []);
  });
});

describe("placeholder discipline (no U+0001 except where the wrapper put it)", () => {
  it("import: Markdown already holding U+0001 throws", () => {
    assert.throws(() => mediaTokenConverters(fake).toLexical(`A.\n\n${mediaPlaceholder("5")}`));
    assert.throws(() => mediaTokenConverters(fake).toLexical("a\u0001b"), "a stray U+0001 that is not a placeholder line");
  });
  it("import: a token whose placeholder does not come back as a root paragraph throws", () => {
    const merging = { ...fake, toLexical: (md: string) => root(para(text(md.replace(/\n/g, " ")))) };
    assert.throws(() => mediaTokenConverters(merging).toLexical("A.\n\n![](cms-media:5)\n\nB."));
  });
  it("export: a stored text holding U+0001 (e.g. a line equal to a placeholder) throws, never becomes a token", () => {
    assert.throws(() => mediaTokenConverters(fake).toMarkdown(root(para(text(mediaPlaceholder("99"))))));
    assert.throws(() => mediaTokenConverters(fake).toMarkdown(root(para(text("a\u0001b")))));
  });
  it("export: an exporter that glues the image to its neighbour throws", () => {
    const glue = { ...fake, toMarkdown: (lex: unknown) => fake.toMarkdown(lex).replace(/\n\n/g, "\n") };
    assert.throws(() => mediaTokenConverters(glue).toMarkdown(root(para(text("A.")), upload(5), para(text("B.")))));
  });
  it("round trip with two images and text stays exact", () => {
    const conv = mediaTokenConverters(fake);
    const md = "A.\n\n![](cms-media:5)\n\n![](cms-media:6)\n\nB.";
    assert.equal(conv.toMarkdown(conv.toLexical(md)), md);
  });
});
