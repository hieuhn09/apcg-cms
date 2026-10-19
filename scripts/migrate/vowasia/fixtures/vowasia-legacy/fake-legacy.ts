/**
 * Minimal FAKE legacy source for the snapshot/measure unit tests (chặng B-α).
 * Synthetic data only: fake site ids, `*.example.invalid` hosts, no real
 * content, no real project ref, no URL of any real database (repo is PUBLIC).
 *
 * `FakeLegacyClient` implements `MinimalPgClient` well enough for the closed
 * builders of ../../lib/vowasia-sql: catalog queries, the site row and ONE
 * keyset page (pages are larger than the fixture). It PROJECTS each SELECT to
 * the quoted columns of the statement, like a real database would, so a test
 * can see exactly which columns reached the snapshot.
 */
import type { MinimalPgClient } from "../../lib/vowasia-sql";

export const FAKE_SITE_ID = "00000000-0000-0000-0000-00000000f002";
export const OTHER_SITE_ID = "00000000-0000-0000-0000-00000000f001";
export const TITLE_MARK = "FIXTURE-TITLE-MARK";
export const BODY_MARK = "FIXTURE-BODY-MARK";
export const ALLOWED_HOST = "img.example.invalid";
export const OTHER_HOST = "other.example.invalid";

/** The 15 snapshot columns (Amendment 3, B-0 U1) plus a column that must never be read. */
export const ARTICLE_COLUMNS = [
  "id", "site_id", "slug", "status", "section", "subsection", "title", "excerpt", "body_sections",
  "featured_image", "featured_image_credit", "tags", "created_at", "published_at", "updated_at", "author_email",
] as const;

const img = (p: string) => `https://${ALLOWED_HOST}/storage/v1/object/public/media/${p}`;

export function fakeArticles(): Record<string, unknown>[] {
  const base = (i: number, extra: Record<string, unknown>) => ({
    id: `00000000-0000-0000-0000-0000000000a${i}`,
    site_id: FAKE_SITE_ID,
    slug: `fixture-article-${i}`,
    status: "published",
    section: "style",
    subsection: "beauty",
    title: { en: `${TITLE_MARK} ${i}` },
    excerpt: { en: `excerpt ${i}` },
    body_sections: [{ heading: "h", body: `<p>${BODY_MARK} ${i}</p>` }],
    featured_image: img(`cover-${i}.jpg`),
    featured_image_credit: "Photo: Fixture",
    tags: ["fixture-tag"],
    created_at: `2026-01-0${i}T10:00:00.000Z`,
    published_at: `2026-01-0${i}T11:00:00.000Z`,
    updated_at: `2026-01-0${i}T12:00:00.000Z`,
    author_email: "author1@example.invalid",
    ...extra,
  });
  return [
    base(1, { featured_image: img("ok.jpg") }),
    base(2, {
      featured_image: img("dup.jpg"),
      section: "venues",
      subsection: "",
      // an image under an UNKNOWN key, nested (U2), plus an off-allow-list image and a page link
      body_sections: [
        { heading: "a", body: `<p>${BODY_MARK}</p><img src="${img("ok2.png")}">` },
        { kind: "gallery", pic: { src: img("nested/deep.png") } },
        { body: `see https://${OTHER_HOST}/x/photo.jpg and https://vowasia.example.invalid/article/x` },
      ],
      published_at: null,
    }),
    base(3, { featured_image: img("svg.svg"), status: "draft", tags: [], excerpt: "plain text excerpt" }),
    base(4, { featured_image: img("bad.jpg"), status: "archived", body_sections: JSON.stringify([{ image: img("big.jpg") }]) }),
    base(5, { featured_image: `http://${ALLOWED_HOST}/storage/v1/object/public/media/http.jpg`, status: "rejected", section: "wedding-business", subsection: "people" }),
    base(6, { featured_image: img("redir-off.jpg"), section: "venues", subsection: "honeymoons" }),
    base(7, { featured_image: img("missing.jpg"), featured_image_credit: null, section: "planning", subsection: "checklists" }),
    base(8, { featured_image: null, section: "style", subsection: "rings-jewelry" }),
  ];
}

export interface FakeOptions {
  /** Columns the view exposes for `articles` (default: all of ARTICLE_COLUMNS). */
  articleColumns?: readonly string[];
  articles?: Record<string, unknown>[];
  sites?: Record<string, unknown>[];
}

export class FakeLegacyClient implements MinimalPgClient {
  readonly statements: string[] = [];
  keysetCalls = 0;
  constructor(private readonly o: FakeOptions = {}) {}
  async connect(): Promise<void> {}
  async end(): Promise<void> {}
  async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(text);
    if (!text.startsWith("SELECT")) return { rows: [] };
    if (text.includes("information_schema.tables")) return { rows: [{ table_name: "articles", table_type: "VIEW" }, { table_name: "sites", table_type: "VIEW" }] };
    if (text.includes("information_schema.columns")) {
      const cols = this.o.articleColumns ?? ARTICLE_COLUMNS;
      return {
        rows: [
          ...cols.map((c) => ({ table_name: "articles", column_name: c, data_type: "text", is_nullable: "YES" })),
          ...["id", "slug", "name"].map((c) => ({ table_name: "sites", column_name: c, data_type: "text", is_nullable: "NO" })),
        ],
      };
    }
    const selected = [...text.slice(7, text.indexOf(" FROM ")).matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1] as string);
    const project = (r: Record<string, unknown>) => Object.fromEntries(selected.map((c) => [c, c === "__cursor_ts" ? String(r.created_at) : r[c] ?? null]));
    if (text.includes('."sites"')) return { rows: (this.o.sites ?? [{ id: FAKE_SITE_ID, slug: "vowasia", name: "VowAsia" }]).map(project) };
    this.keysetCalls++;
    if (text.includes(") > (")) return { rows: [] };
    return { rows: (this.o.articles ?? fakeArticles()).map(project) };
  }
}
