/**
 * Synthetic legacy VowAsia rows for the phase-B tests and the rehearsal
 * (Amendment 4, B-11). Fake hosts only (`*.invalid`, the old-site host appears
 * only inside body TEXT as a link, as in the real data), no real content, no
 * real project ref. Every real shape of §4.1 has a case:
 *   object{en} title/excerpt, 2-key and 3-key (image) sections, null subsection,
 *   missing cover (published, archived AND old draft), missing published_at,
 *   off-allow-list links in text of both classes, `<` / `&` in body text,
 *   rejected rows, one scheduled row (none in the real data), every C8 rename.
 */
export const FIX_SITE_ID = "00000000-0000-0000-0000-00000000f002";
export const FIX_OTHER_SITE_ID = "00000000-0000-0000-0000-00000000f001";
export const FIX_IMAGE_HOST = "img.vowasia-fixture.invalid";
export const FIX_EXTERNAL_HOST = "partner.example.invalid";
export const FIX_ROLES = Object.freeze({
  createdAt: "created_at", publishedAt: "published_at", status: "status", section: "section", subsection: "subsection", slug: "slug",
  title: "title", excerpt: "excerpt", body: "body_sections", image: "featured_image", imageCredit: "featured_image_credit", tags: "tags", updatedAt: "updated_at",
});
export const FIX_COLUMNS = ["id", "site_id", ...Object.values(FIX_ROLES)];

export const fixImage = (name: string): string => `https://${FIX_IMAGE_HOST}/storage/v1/object/public/media/${name}`;

/** C8 pairs used by the generated bulk rows (legacy section, legacy subsection). */
const PAIRS: [string, string | null][] = [
  ["wedding-business", "industry-news"], ["venues", "hotels-resorts"], ["destination-weddings", "honeymoons"], ["style", "rings-jewelry"],
  ["wedding-business", "people"], ["style", "flowers-decor"], ["destination-weddings", "guides"], ["style", "trends"], ["style", "beauty"],
  ["style", "gowns-attire"], ["wedding-business", "data-insights"], ["venues", "by-destination"], ["planning", "budgets-costs"],
  ["planning", "expert-advice"], ["destination-weddings", "pre-wedding-shoots"], ["planning", "checklists"], ["planning", "etiquette-traditions"], ["venues", null],
];

const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const day = (n: number, h = 10) => new Date(Date.UTC(2025, 0, 1 + n, h, 0, 0)).toISOString();

export interface FixtureSpec {
  /** Bulk rows on top of the special cases (default 120). */
  bulk?: number;
}

/** Article rows of the vowasia site (column names as in the snapshot). */
export function fixtureRows(o: FixtureSpec = {}): Record<string, unknown>[] {
  const bulk = o.bulk ?? 120;
  const rows: Record<string, unknown>[] = [];
  const add = (n: number, extra: Record<string, unknown>) =>
    rows.push({
      id: uuid(n),
      site_id: FIX_SITE_ID,
      slug: `fixture-post-${n}`,
      status: "published",
      section: "style",
      subsection: "beauty",
      title: { en: `Fixture post ${n}` },
      excerpt: { en: `Excerpt of fixture post ${n}` },
      body_sections: [{ heading: `Heading ${n}`, body: { en: `First paragraph of post ${n}.\n\nSecond paragraph.` } }],
      featured_image: fixImage(`cover-${n}.jpg`),
      featured_image_credit: `Fixture Studio ${n % 3}`,
      tags: ["legacy-tag"],
      created_at: day(n),
      published_at: day(n, 11),
      updated_at: day(n, 12),
      ...extra,
    });
  // special cases (ids 1-19)
  add(1, { slug: "body-images-post", section: "venues", subsection: "hotels-resorts", body_sections: [
    { heading: "Intro", body: { en: "Opening text." } },
    { heading: "The venue", body: { en: "Pictured above.\n\nMore words." }, image: { url: fixImage("body-1a.jpg"), alt: "The ballroom", credit: "Body Credit" } },
    { heading: { en: "Details" }, body: { en: "Closing." }, image: { url: fixImage("body-1b.png"), caption: "Garden caption" } },
  ] });
  add(2, { slug: "links-post", section: "wedding-business", subsection: "industry-news", body_sections: [
    { heading: "Links", body: { en: `See https://vowasia.com/article/body-images-post for the venue, https://www.vowasia.com/article/archived-target and https://${FIX_EXTERNAL_HOST}/report?id=7.` } },
    { heading: "More", body: { en: "Also https://vowasia.com/article/no-cover-published, https://vowasia.com/article/rejected-one and https://vowasia.com/about." } },
  ] });
  add(3, { slug: "escape-post", body_sections: [{ heading: "a <b> & c", body: { en: "Text with <tags> & ampersands; 5 < 6 > 4." } }] });
  add(4, { slug: "no-cover-published", featured_image: null });
  add(5, { slug: "no-cover-archived", status: "archived", featured_image: "" });
  add(6, { slug: "no-cover-old-draft", status: "draft", featured_image: null });
  add(7, { slug: "archived-target", status: "archived" });
  add(8, { slug: "old-draft", status: "draft" });
  add(9, { slug: "scheduled-one", status: "scheduled" });
  add(10, { slug: "rejected-one", status: "rejected" });
  add(11, { slug: "rejected-two", status: "rejected", published_at: null });
  add(12, { slug: "no-date", published_at: null, body_sections: [{ heading: "h", body: { en: "x" }, image: { url: fixImage("body-12.jpg") } }] });
  add(13, { slug: "venue-only", section: "venues", subsection: null });
  add(14, { slug: "honeymoon-post", section: "destination-weddings", subsection: "honeymoons" });
  add(15, { slug: "ring-post", section: "style", subsection: "rings-jewelry" });
  add(16, { slug: "people-post", section: "wedding-business", subsection: "people" });
  add(17, { slug: "shared-cover-a", featured_image: fixImage("shared.jpg") });
  add(18, { slug: "shared-cover-b", featured_image: fixImage("shared.jpg") });
  add(19, { slug: "external-only", body_sections: [{ heading: "h", body: { en: `Partner https://${FIX_EXTERNAL_HOST}/x.` } }] });
  for (let i = 0; i < bulk; i++) {
    const n = 100 + i;
    const [section, subsection] = PAIRS[i % PAIRS.length] as [string, string | null];
    const status = i % 11 === 10 ? "archived" : i % 23 === 22 ? "draft" : "published";
    add(n, { section, subsection, status, published_at: i % 13 === 12 ? null : day(n, 11) });
  }
  return rows;
}

/** Rows of ANOTHER site in the same legacy tables (must never be read). */
export function otherSiteRows(): Record<string, unknown>[] {
  return [1, 2, 3].map((n) => ({
    id: `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, site_id: FIX_OTHER_SITE_ID, slug: `other-site-${n}`, status: "published",
    section: "style", subsection: "beauty", title: { en: `OTHER SITE ${n}` }, excerpt: { en: "x" }, body_sections: [], featured_image: fixImage(`other-${n}.jpg`),
    featured_image_credit: null, tags: [], created_at: day(n), published_at: day(n), updated_at: day(n),
  }));
}

/** Every image URL the rows reference (covers + body images), first-seen order. */
export function fixtureImageUrls(rows: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  const add = (u: unknown) => {
    if (typeof u === "string" && u && !out.includes(u)) out.push(u);
  };
  for (const r of rows) {
    add(r.featured_image);
    for (const s of (r.body_sections as { image?: { url?: string } }[]) ?? []) add(s.image?.url);
  }
  return out;
}
