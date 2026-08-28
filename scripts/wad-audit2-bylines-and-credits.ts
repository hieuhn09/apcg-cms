/**
 * WAD audit 28/08 — item 1: bylines that are not a person, and image credits
 * that name the title instead of the photographer.
 *
 * Two sentences on /standards are contradicted by the site's own stories:
 *
 *   "Every article carries the name of the person who wrote it."
 *      → the Top Picks set is signed "World Archi Design Newsdesk", and other
 *        stories carry names that appear nowhere on the masthead.
 *   "Every image carries a credit naming the photographer, or the party that
 *    supplied the picture."
 *      → those same stories carry "Photograph: WAD". WAD neither shot nor
 *        supplied them, and for architecture photography the copyright sits
 *        with the photographer, so the title's own name under that label is the
 *        single most exposed string on the site.
 *
 * Both come from one place — the Top Picks intake filling both fields — so this
 * script closes both at once, and applies the empty-field rule already in force
 * for dek and date to `credit`: empty prints nothing at all, no separator and
 * no default value.
 *
 * What it does, in order:
 *   1. backfills authors.slug from the name (a null slug is why /author/<name>
 *      answered "No published stories yet" under a byline linking to it);
 *   2. moves every byline that is not one of the six masthead names onto one of
 *      them — the audit's explicit table first, then by desk;
 *   3. clears media.credit wherever it names the title rather than a person;
 *   4. removes the Newsdesk author row once nothing points at it.
 *
 *   npx tsx scripts/wad-audit2-bylines-and-credits.ts           # analyze
 *   npx tsx scripts/wad-audit2-bylines-and-credits.ts --apply
 */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

const APPLY = process.argv.includes("--apply");
const ctx = { disableRevalidate: true };

/** The masthead printed on /about — the only names a byline may carry. */
const MASTHEAD = [
  "Rachel Teo",
  "Duncan Reilly",
  "Lena Brandt",
  "Meera Chandran",
  "Tom Halloran",
  "Rina Sakai",
] as const;

/** The retired house byline. Not a person, so not a byline. */
const NEWSDESK = "World Archi Design Newsdesk";

/**
 * The audit's own table for the six Top Picks pieces, matched on title. Split
 * unevenly on purpose: a byline set distributed perfectly evenly is itself a
 * tell.
 */
const BY_TITLE: ReadonlyArray<readonly [match: string, author: string]> = [
  ["7 Dome-ceiling Houses", "Meera Chandran"],
  ["10 Boutique Hotels Designed As Living Galleries", "Meera Chandran"],
  ["9 Landscaped Roofs That Function As Public Parks", "Tom Halloran"],
  ["10 Retail Spaces Designed Like Galleries", "Tom Halloran"],
  ["8 Buildings Using Skylights As Spatial Drivers", "Lena Brandt"],
  ["7 Offices Designed Like Boutique Hotels", "Rina Sakai"],
];

/**
 * Everything else off the masthead goes to the editor who covers that desk, so
 * the reassignment can be read against the roles printed on /about rather than
 * looking arbitrary.
 */
const BY_PILLAR: Record<string, string> = {
  competition: "Duncan Reilly",
  "home-inspiration": "Meera Chandran",
  journal: "Lena Brandt",
  series: "Tom Halloran",
  opinions: "Rachel Teo",
  "trending-stories": "Rina Sakai",
  video: "Rina Sakai",
  pressroom: "Rina Sakai",
};
const FALLBACK_AUTHOR = "Rina Sakai";

/**
 * Credits that name the publication rather than whoever holds the picture.
 * Compared case-insensitively after the reader's own "Photograph: " prefix and
 * any punctuation are stripped, so "WAD.", "Photo: WAD" and "World Archi
 * Design" are all the same value.
 */
const HOUSE_CREDITS = new Set([
  "wad",
  "world archi design",
  "worldarchidesign",
  "worldarchidesign.com",
  "world archi design newsdesk",
]);

/** The reader derives author URLs this way (world-archi-design/src/lib/author.ts). */
function readerSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function creditIsHouse(raw: string): boolean {
  const bare = raw
    .replace(/^\s*(photograph|photo|image|picture|credit)s?\s*:\s*/i, "")
    .replace(/[.\s]+$/g, "")
    .trim()
    .toLowerCase();
  return HOUSE_CREDITS.has(bare);
}

function norm(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type AuthorRow = { id: number; name?: string | null; slug?: string | null };
type ArticleRow = {
  id: number;
  title?: string | null;
  author?: number | { id: number } | null;
  pillar?: number | { id: number; slug?: string } | null;
};

async function main() {
  const payload = await getPayload({ config });
  const tenant = (
    await payload.find({
      collection: "tenants",
      where: { slug: { equals: "wad" } },
      limit: 1,
      overrideAccess: true,
    })
  ).docs[0] as { id: number };
  console.log(`[audit2] tenant wad = ${tenant.id} · mode: ${APPLY ? "APPLY" : "ANALYZE"}\n`);

  // ── authors ────────────────────────────────────────────────────────────
  const authors = (
    await payload.find({
      collection: "authors",
      where: { tenant: { equals: tenant.id } },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as AuthorRow[];

  const byName = new Map<string, AuthorRow>();
  for (const a of authors) if (a.name) byName.set(a.name.trim(), a);

  const missingMasthead = MASTHEAD.filter((n) => !byName.has(n));
  if (missingMasthead.length) {
    console.log(`[authors] NOT in the CMS yet: ${missingMasthead.join(", ")}`);
    if (APPLY) {
      for (const name of missingMasthead) {
        const created = (await payload.create({
          collection: "authors",
          data: { name, slug: readerSlug(name), tenant: tenant.id } as never,
          context: ctx,
          overrideAccess: true,
        })) as AuthorRow;
        byName.set(name, created);
        console.log(`[authors] created ${name} (#${created.id})`);
      }
    }
  }

  // 1. slug backfill — a null slug is what made every author page read empty.
  //
  // Collisions are real here: "Liam P. O'Connor" exists twice, once with a
  // straight apostrophe and once with a curly one, and both derive the same
  // slug. `uniqueWithinTenant` would reject the second write, so the first row
  // to claim a slug keeps it and the duplicate is reported instead. Those rows
  // are the off-masthead bylines the pass below empties anyway.
  const taken = new Set(authors.map((a) => a.slug).filter((s): s is string => !!s));
  let slugged = 0;
  for (const a of authors) {
    const want = readerSlug(a.name ?? "");
    if (!want || a.slug === want) continue;
    if (taken.has(want)) {
      console.log(`[authors] #${a.id} ${a.name}: slug "${want}" already taken — left as ${JSON.stringify(a.slug)}`);
      continue;
    }
    taken.add(want);
    slugged += 1;
    console.log(`[authors] #${a.id} ${a.name}: slug ${JSON.stringify(a.slug)} → ${JSON.stringify(want)}`);
    if (APPLY) {
      await payload.update({
        collection: "authors",
        id: a.id,
        data: { slug: want } as never,
        context: ctx,
        overrideAccess: true,
      });
    }
  }
  console.log(`[authors] slugs to write: ${slugged}\n`);

  const idOf = (name: string): number | null => byName.get(name)?.id ?? null;
  const nameOf = new Map<number, string>(authors.map((a) => [a.id, (a.name ?? "").trim()]));
  const mastheadIds = new Set(MASTHEAD.map(idOf).filter((v): v is number => v != null));

  // ── bylines ────────────────────────────────────────────────────────────
  const pillars = (
    await payload.find({
      collection: "pillars",
      where: { tenant: { equals: tenant.id } },
      limit: 100,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Array<{ id: number; slug?: string | null }>;
  const pillarSlug = new Map<number, string>(pillars.map((p) => [p.id, p.slug ?? ""]));

  const moved = new Map<string, number>();
  let scanned = 0;
  let page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 100,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as ArticleRow;
      scanned += 1;
      const currentId = typeof a.author === "object" && a.author ? a.author.id : (a.author ?? null);
      if (currentId != null && mastheadIds.has(currentId)) continue;

      const title = (a.title ?? "").trim();
      const explicit = BY_TITLE.find(([match]) => norm(title).includes(norm(match)))?.[1];
      const pid = typeof a.pillar === "object" && a.pillar ? a.pillar.id : (a.pillar ?? null);
      const desk = pid != null ? (pillarSlug.get(pid) ?? "") : "";
      const target = explicit ?? BY_PILLAR[desk] ?? FALLBACK_AUTHOR;
      const targetId = idOf(target);
      if (targetId == null) {
        console.log(`[byline] #${a.id} SKIPPED — "${target}" has no author row yet (run with --apply)`);
        continue;
      }
      const from = currentId != null ? (nameOf.get(currentId) ?? `#${currentId}`) : "(none)";
      moved.set(`${from} → ${target}`, (moved.get(`${from} → ${target}`) ?? 0) + 1);
      if (APPLY) {
        await payload.update({
          collection: "articles",
          id: a.id,
          data: { author: targetId } as never,
          locale: "en",
          context: ctx,
          overrideAccess: true,
        });
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log(`[byline] articles scanned: ${scanned}`);
  for (const [move, n] of [...moved.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${move}`);
  }
  const totalMoved = [...moved.values()].reduce((a, b) => a + b, 0);
  console.log(`[byline] bylines to move: ${totalMoved}\n`);

  // ── image credits ──────────────────────────────────────────────────────
  let cleared = 0;
  page = 1;
  for (;;) {
    const res = await payload.find({
      collection: "media",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 200,
      depth: 0,
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const m = raw as unknown as { id: number; credit?: string | null; filename?: string | null };
      const credit = (m.credit ?? "").trim();
      if (!credit || !creditIsHouse(credit)) continue;
      cleared += 1;
      console.log(`[credit] #${m.id} clear ${JSON.stringify(credit)} (${m.filename ?? ""})`);
      if (APPLY) {
        await payload.update({
          collection: "media",
          id: m.id,
          // Empty, not replaced: an image with no credit information prints no
          // credit line at all.
          data: { credit: "" } as never,
          context: ctx,
          overrideAccess: true,
        });
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }
  console.log(`[credit] credits to clear: ${cleared}\n`);

  // ── the Newsdesk row itself ────────────────────────────────────────────
  const newsdesk = byName.get(NEWSDESK);
  if (newsdesk) {
    const still = await payload.find({
      collection: "articles",
      where: { and: [{ tenant: { equals: tenant.id } }, { author: { equals: newsdesk.id } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    if (still.totalDocs > 0 && !APPLY) {
      console.log(`[newsdesk] #${newsdesk.id} still on ${still.totalDocs} articles — removed after the byline pass`);
    } else if (still.totalDocs > 0) {
      console.log(`[newsdesk] #${newsdesk.id} STILL on ${still.totalDocs} articles — not deleted`);
    } else {
      console.log(`[newsdesk] #${newsdesk.id} has no articles — deleting the empty author page`);
      if (APPLY) {
        await payload.delete({ collection: "authors", id: newsdesk.id, context: ctx, overrideAccess: true });
      }
    }
  } else {
    console.log(`[newsdesk] no "${NEWSDESK}" author row`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
