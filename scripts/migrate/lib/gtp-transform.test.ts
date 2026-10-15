import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadMapping } from "./gtp-mapping";
import { repoRoot } from "./out-dir";
import {
  enText, formatTag, legacyTags, mapStatus, provenanceRow, publishedAtFor, readMinFor, resolveAuthor, resolveCountries, resolveTaxonomy,
  sanitizeLegacyHtml, sectionsToHtml, sniffBodyFormat, statusWrite, stripPhotoLabel, takeawaysText, tagSlugify, stableFilename, storedFilenameMatches,
  canonicalSourceUrl, oldArticleUrl, plainTextForParity, jaccard, rewriteInternalLinks,
} from "./gtp-transform";
import { buildSlugPlan, planEventSlugs } from "./slug-plan";
import { eventBriefs, planEvents, toLegacyEvent, similarity } from "./gtp-events";
import { isRedacted, legacySourceUrls, redactRow, subscribersCsv } from "./gtp-exports";

const ROOT = repoRoot();
const M = loadMapping(path.join(ROOT, "scripts/migrate/legacy-mapping.gtp-network.json"), path.join(ROOT, "scripts/migrate/fixtures/gtp-legacy/overlay.fixture.json")).mapping;

test("G37 (S-19): status map and write flags table", () => {
  assert.deepEqual(mapStatus("Published ", M), { kind: "import", status: "published" });
  assert.deepEqual(mapStatus("ARCHIVED", M), { kind: "import", status: "archived" });
  assert.deepEqual(mapStatus("draft", M), { kind: "import", status: "draft" });
  assert.equal(mapStatus("rejected", M).kind, "skip");
  assert.equal(mapStatus("deleted", M).kind, "reject");
  assert.deepEqual(statusWrite("published"), { draft: false, workflowStatus: "published", _status: "published" });
  assert.deepEqual(statusWrite("draft"), { draft: true, workflowStatus: "draft", _status: "draft" });
  assert.deepEqual(statusWrite("archived"), { draft: false, workflowStatus: "archived" });
});

test("G37: taxonomy 1:1, empty sub, three re-homes keep the ORIGINAL old section/sub", () => {
  assert.deepEqual(resolveTaxonomy("news", "aviation", M), { ok: true, t: { pillar: "news", subSection: "aviation", rehomed: false, oldSection: "news", oldSub: "aviation" } });
  assert.deepEqual(resolveTaxonomy("destinations", "", M), { ok: true, t: { pillar: "destinations", rehomed: false, oldSection: "destinations", oldSub: "" } });
  const r1 = resolveTaxonomy("news", "destination-marketing", M);
  assert.ok(r1.ok && r1.t.pillar === "business-of-travel" && r1.t.subSection === "destination-marketing" && r1.t.rehomed && r1.t.oldSection === "news");
  const r2 = resolveTaxonomy("news", "aviation-business", M);
  assert.ok(r2.ok && r2.t.pillar === "business-of-travel" && r2.t.rehomed);
  const r3 = resolveTaxonomy("business-of-travel", "travel-tech", M);
  assert.ok(r3.ok && r3.t.pillar === "news" && r3.t.subSection === "travel-tech" && r3.t.oldSub === "travel-tech" && r3.t.oldSection === "business-of-travel");
  assert.equal(resolveTaxonomy("", "", M).ok, false);
});

test("G37 (N-10): format tags only for the 4 included values with title-case titles; news/none skipped", () => {
  assert.deepEqual(formatTag("guide", M), { slug: "format-guide", title: "Guide" });
  assert.deepEqual(formatTag("Interview", M), { slug: "format-interview", title: "Interview" });
  assert.equal(formatTag("news", M), null);
  assert.equal(formatTag("none", M), null);
  assert.equal(formatTag("guide", { formatTags: { enabled: false, include: ["guide"] } }), null);
  assert.deepEqual(legacyTags(["Hong Kong", "hong-kong", " visa ", ""], M), [{ slug: "hong-kong", title: "Hong Kong" }, { slug: "visa", title: "Visa" }]);
  assert.deepEqual(legacyTags("{a,b}", M).map((t) => t.slug), ["a", "b"]);
  assert.equal(tagSlugify("Café Ölé"), "cafe-ole");
});

test("G37: countries lowercase/trim, code or name, unmatched reported", () => {
  const all = [{ id: 1, code: "SG", name: "Singapore" }, { id: 2, code: "JP", name: "Japan" }];
  assert.deepEqual(resolveCountries([" sg", "Japan", "XX", "jp"], all, "either"), { ids: [1, 2], unmatched: ["XX"] });
  assert.deepEqual(resolveCountries(["Japan"], all, "code"), { ids: [], unmatched: ["Japan"] });
});

test("G37: takeaways, readMin 230 wpm min 1, publishedAt fallback, author map + GTP Newsroom, Photo: strip, provenance", () => {
  assert.equal(takeawaysText(["One", " Two "]), "One\nTwo");
  assert.equal(takeawaysText([]), undefined);
  assert.equal(takeawaysText("[]"), undefined);
  assert.deepEqual(readMinFor(4, 1000, 230), { readMin: 4, computed: false });
  assert.deepEqual(readMinFor(null, 1000, 230), { readMin: 5, computed: true });
  assert.deepEqual(readMinFor(0, 3, 230), { readMin: 1, computed: true });
  assert.deepEqual(publishedAtFor(null, "2026-08-01T00:00:00Z"), { iso: "2026-08-01T00:00:00.000Z", fellBack: true });
  assert.deepEqual(resolveAuthor("Daniel Cheong", M), { name: "Daniel Cheong", fallback: false });
  assert.deepEqual(resolveAuthor("Clara Widjaja", M), { name: "Natalie Ong", fallback: false });
  for (const b of ["Simon Ng", "Ryan Ng", "Valerie Nguyen", "BriefAsia", "", null]) assert.deepEqual(resolveAuthor(b, M), { name: "GTP Newsroom", fallback: true });
  assert.equal(stripPhotoLabel("Photo: Jimmy Liao / Pexels"), "Jimmy Liao / Pexels");
  assert.equal(stripPhotoLabel("PHOTO:Ana / Pexels"), "Ana / Pexels");
  assert.deepEqual(provenanceRow({ id: "x", migrate_source: "scrape_rss", ai_model: "m", ai_score: 80, title: "t" }), { legacyId: "x", migrate_source: "scrape_rss", ai_model: "m", ai_score: 80 });
  assert.equal(enText({ en: " Hi " }), "Hi");
});

test("C4/S-20: body sections -> escaped h2/p; tag-like text stays text; empty sections dropped; Asian closing kept", () => {
  const r = sectionsToHtml([
    { heading: { en: "Intro" }, body: { en: "First line\nsame para.\n\nSecond <script>alert(1)</script> & <img onerror=x> para." } },
    { heading: { en: "" }, body: { en: "No heading." } },
    { heading: { en: "" }, body: { en: "  " } },
    { heading: { en: "Asian perspective" }, body: { en: "Closing." } },
  ]);
  assert.equal(r.html, "<h2>Intro</h2><p>First line same para.</p><p>Second &lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img onerror=x&gt; para.</p><p>No heading.</p><h2>Asian perspective</h2><p>Closing.</p>");
  assert.equal(r.droppedSections, 1);
  assert.equal(r.tagLikeText, true);
  assert.deepEqual(r.paragraphs[1], "Second <script>alert(1)</script> & <img onerror=x> para.");
  assert.equal(sniffBodyFormat('[{"heading":{"en":"a"},"body":{"en":"b"}}]'), "sections");
  assert.equal(sniffBodyFormat("<p>x</p>"), "html");
  assert.equal(sniffBodyFormat("# t\n- a"), "markdown");
  assert.equal(sniffBodyFormat(""), "empty");
});

test("C4: generic sanitizer removes script/iframe/on* and javascript: URLs, strips utm", () => {
  const out = sanitizeLegacyHtml('<p onclick="x">a<script>bad()</script><a href="javascript:alert(1)">j</a><a href="https://x.com/?utm_source=1&q=2">l</a></p><iframe src="https://www.youtube.com/embed/1"></iframe><style>*{}</style>', { allowedTags: ["p", "a"] });
  assert.doesNotMatch(out.html, /script|onclick|javascript|utm_|iframe|style/);
  assert.match(out.html, /q=2/);
  assert.equal(out.embedsFlattened, 1);
});

test("misc pure helpers", () => {
  assert.match(stableFilename("https://h/media/featured/My Slug.JPG"), /^gtp-[0-9a-f]{8}-my-slug\.jpg$/);
  const f = stableFilename("https://h/featured/aaaaaaaa-0000-4000-8000-000000000001.jpg");
  assert.match(f, /-img\.jpg$/); // never ends in -<digits> (Payload's renamer would increment it)
  assert.equal(storedFilenameMatches(f, f), true);
  assert.equal(storedFilenameMatches(f.replace(/\.jpg$/, "-3.jpg"), f), true);
  assert.equal(storedFilenameMatches(`x${f}`, f), false);
  assert.equal(storedFilenameMatches(f.replace(/\.jpg$/, "-a.jpg"), f), false);
  assert.equal(canonicalSourceUrl("https://Example.com/a?utm_x=1&b=2#f"), "https://example.com/a?b=2");
  assert.equal(oldArticleUrl("/{section}/{slug}", { section: "news", sub: "", slug: "s", id: "1" }), "/news/s");
  assert.equal(plainTextForParity("<p>Hello&nbsp;World</p>"), "hello&nbsp;world");
  assert.equal(jaccard("a b c", "a b c"), 1);
  assert.deepEqual(rewriteInternalLinks('<a href="https://www.globaltravelpost.com/news/x">x</a>', "https://www.globaltravelpost.com", (p) => (p === "/news/x" ? "/article/x" : undefined)), { html: '<a href="/article/x">x</a>', rewritten: 1 });
});

test("C5/G34 unit: slug plan order (created_at,id), suffixes, rejected rows excluded, never truncated, reserved", () => {
  const long = "a".repeat(150);
  const rows = [
    { id: "b", created_at: "2026-08-02T00:00:00Z", status: "published", slug: "same", title: { en: "x" } },
    { id: "a", created_at: "2026-08-02T00:00:00Z", status: "draft", slug: "same", title: { en: "x" } },
    { id: "r", created_at: "2026-07-01T00:00:00Z", status: "rejected", slug: "same", title: { en: "x" } },
    { id: "c", created_at: null, status: "archived", slug: "same", title: { en: "x" } },
    { id: "d", created_at: "2026-09-01T00:00:00Z", status: "published", slug: long, title: { en: "x" } },
    { id: "e", created_at: "2026-09-02T00:00:00Z", status: "published", slug: "", title: { en: "Derived Title!" } },
    { id: "f", created_at: "2026-09-03T00:00:00Z", status: "published", slug: "news", title: { en: "x" } },
    { id: "g", created_at: "2026-09-04T00:00:00Z", status: "published", slug: "Under_Score", title: { en: "x" } },
  ];
  const plan = buildSlugPlan(rows, M);
  const by = Object.fromEntries(plan.map((p) => [p.legacyId, p]));
  assert.equal(by.r, undefined);
  assert.equal(by.c?.slug, "same");
  assert.equal(by.a?.slug, "same-2");
  assert.equal(by.b?.slug, "same-3");
  assert.equal(by.a?.duplicateOf, "c");
  assert.equal(by.d?.slug, long);
  assert.equal(by.e?.slug, "derived-title");
  assert.equal(by.f?.slug, "news-2");
  assert.equal(by.f?.slugChanged?.reason, "reserved");
  assert.equal(by.g?.slug, "under-score");
  assert.equal(by.g?.slugChanged?.reason, "not-url-safe");
  // Input order does not matter
  assert.deepEqual(buildSlugPlan([...rows].reverse(), M), plan);
  const ev = planEventSlugs([{ id: "e1", title: "Same", dateStart: "2026-10-01" }, { id: "e2", title: "Same", dateStart: "2026-10-01" }, { id: "e3", title: "Same", dateStart: null }], ["same"]);
  assert.deepEqual(ev.map((e) => e.slug), ["same-2026", "same-2026-2", "same-2"]);
  assert.equal(ev[0]?.legacyId, "event:e1");
});

test("C11/G38 unit: events briefs, de-dupe, near match, inactive; author GTP Newsroom handled by the importer", () => {
  const e = toLegacyEvent({ id: "1", title: "ITB Asia", date_start: "2026-10-22", date_end: "2026-10-24", location: "Singapore", url: "https://www.itb-asia.com/x", note: "n", active: true, category: "Trade show" });
  assert.deepEqual(eventBriefs(e), [
    { label: "Event date", value: "2026-10-22", source: "www.itb-asia.com" },
    { label: "Event end", value: "2026-10-24", source: "www.itb-asia.com" },
    { label: "Location", value: "Singapore", source: "www.itb-asia.com" },
    { label: "Link", value: "https://www.itb-asia.com/x", source: "www.itb-asia.com" },
  ]);
  const noUrl = toLegacyEvent({ id: "2", title: "X", date_start: "2026-10-22", date_end: "2026-10-22", location: "", url: "", active: false });
  assert.deepEqual(eventBriefs(noUrl), [{ label: "Event date", value: "2026-10-22", source: "Industry calendar" }]);
  const cal = [{ title: "ITB Asia!", date: "2026-10-22", legacyId: "a1" }, { title: "World Travel Market London", date: "2026-11-03", legacyId: "a2" }];
  const near = toLegacyEvent({ id: "3", title: "World Travel Market, London", date_start: "2026-11-04", active: true });
  const d = planEvents([e, near, noUrl], cal, 0.9);
  assert.equal(d.duplicates.length, 1);
  assert.equal(d.near.length, 1);
  assert.deepEqual(d.imports.map((x) => x.id), ["2"]);
  assert.ok(similarity("World Travel Market London", "World Travel Market, London") >= 0.9);
});

test("C11/G39 unit (S-22, R-07): anchored redaction; contact lifted only by --include-contact; token never lifted", () => {
  const P = M.redact;
  for (const c of ["email", "ip", "client_ip", "contact_name", "contact_email", "userAgent", "user_agent", "api_token"]) assert.equal(isRedacted(c, P), true, c);
  for (const c of ["description", "recipient", "zip", "title", "company"]) assert.equal(isRedacted(c, P), false, c);
  const personal = ["contact_name", "contact_email"];
  assert.equal(isRedacted("contact_name", P, { personalColumns: personal, includeContact: true }), false);
  assert.equal(isRedacted("contact_email", P, { personalColumns: personal, includeContact: true }), false);
  assert.equal(isRedacted("access_token", P, { personalColumns: [...personal, "access_token"], includeContact: true }), true);
  assert.deepEqual(redactRow({ company: "c", contact_name: "n" }, P), { company: "c", contact_name: "<redacted>" });
});

test("C11/G39 unit: legacy-source-urls one line per unique URL, collisions listed, CSV formula guard", () => {
  const rows = [
    { id: "2", created_at: "2026-08-02", source_url: "https://a.com/x", title: { en: "B" }, published_at: null },
    { id: "1", created_at: "2026-08-01", source_url: "https://a.com/x", title: { en: "A" }, published_at: "2026-08-01T00:00:00Z" },
    { id: "3", created_at: "2026-08-03", source_url: "https://a.com/x?utm_source=z", title: { en: "C" }, published_at: null },
    { id: "4", created_at: "2026-08-04", source_url: null, title: { en: "D" } },
  ];
  const r = legacySourceUrls(rows);
  assert.deepEqual(r.lines.map((l) => [l.source_url, l.title]), [["https://a.com/x", "A"], ["https://a.com/x?utm_source=z", "C"]]);
  assert.deepEqual(r.collisions, [{ source_url: "https://a.com/x", legacyIds: ["1", "2", "3"] }]);
  assert.equal(subscribersCsv([{ email: "=cmd", newsletter: "a,b", source: "s", created_at: "t" }]), "email,newsletter,source,created_at\n'=cmd,\"a,b\",s,t\n");
});
