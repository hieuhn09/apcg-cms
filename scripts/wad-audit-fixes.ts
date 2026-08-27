/**
 * WAD audit 26/08 — one-shot data fixes for tenant `wad` (audit items 1, 4,
 * 16, 20, 21):
 *
 *  1. Image credits: move the trailing "Credit: …" body line into the hero
 *     media's `credit` field, scrub publication names ("ArchDaily",
 *     "Wallpaper*", "WAD"…) out of every credit, and move inline
 *     "Photo Credit: …" paragraphs into their image's media doc.
 *  4. Bylines: create the six-person editorial team + the Newsdesk house
 *     byline and re-assign every article by topic with uneven, capped
 *     distribution (roundups → Newsdesk).
 * 16. lastmod: final SQL pass sets articles.updated_at = published_at so the
 *     sitemap reflects real dates instead of the bulk-migration stamp.
 * 20. Body template: headings → h2, whole-line bold stripped, credit
 *     paragraphs removed once captured.
 * 21. Junk deks ("c", brand spillover) cleared to empty.
 *
 * Usage:
 *   npx tsx scripts/wad-audit-fixes.ts --analyze          # report only
 *   npx tsx scripts/wad-audit-fixes.ts --apply --limit 5  # trial batch
 *   npx tsx scripts/wad-audit-fixes.ts --apply            # full run
 *   npx tsx scripts/wad-audit-fixes.ts --videos           # podcasts fixes only
 */
import "./lib/env";
import { getPayload, type Payload } from "payload";
import { sql } from "drizzle-orm";
import config from "../payload.config";

const APPLY = process.argv.includes("--apply");
const VIDEOS_ONLY = process.argv.includes("--videos");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const ctx = { disableRevalidate: true };

/* ── Editorial team (audit item 4) ─────────────────────────────────────── */

const TEAM = [
  { name: "Rachel Teo", role: "Editor" },
  { name: "Duncan Reilly", role: "Awards and Competitions Editor" },
  { name: "Lena Brandt", role: "Senior Writer" },
  { name: "Meera Chandran", role: "Interiors Editor" },
  { name: "Tom Halloran", role: "Contributing Editor" },
  { name: "Rina Sakai", role: "Staff Writer" },
  { name: "World Archi Design Newsdesk", role: "Newsdesk" },
] as const;

type TeamName = (typeof TEAM)[number]["name"];

/** Per-desk weighted byline pools — deliberately uneven (audit: "đừng chia đều"). */
const POOLS: Record<string, ReadonlyArray<readonly [TeamName, number]>> = {
  // Every desk pool stays under the one-third ceiling (audit item 4).
  competition: [
    ["Duncan Reilly", 32],
    ["Rina Sakai", 26],
    ["Lena Brandt", 24],
    ["Tom Halloran", 18],
  ],
  "home-inspiration": [
    ["Meera Chandran", 32],
    ["Rina Sakai", 26],
    ["Tom Halloran", 21],
    ["Lena Brandt", 21],
  ],
  opinions: [
    ["Tom Halloran", 32],
    ["Lena Brandt", 30],
    ["Rachel Teo", 22],
    ["Rina Sakai", 16],
  ],
  journal: [
    ["Lena Brandt", 35],
    ["Rachel Teo", 25],
    ["Tom Halloran", 20],
    ["Rina Sakai", 20],
  ],
  default: [
    ["Lena Brandt", 28],
    ["Rina Sakai", 28],
    ["Meera Chandran", 16],
    ["Tom Halloran", 16],
    ["Duncan Reilly", 12],
  ],
};

/** Roundups/listicles/shorts run under the house byline. */
function isNewsdeskPiece(title: string): boolean {
  return /^top\s?picks\b/i.test(title) || /^\d+\s+(best|top|of)\b/i.test(title);
}

/** Deterministic per-article PRNG so re-runs assign identical bylines. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Running per-desk tallies so the one-third ceiling holds even on small desks. */
const deskTally = new Map<string, Map<TeamName, number>>();

function pickByline(pillarSlug: string, title: string, articleId: number): TeamName {
  if (isNewsdeskPiece(title)) return "World Archi Design Newsdesk";
  const pool = POOLS[pillarSlug] ?? POOLS.default!;
  if (!deskTally.has(pillarSlug)) deskTally.set(pillarSlug, new Map());
  const tally = deskTally.get(pillarSlug)!;
  const deskTotal = [...tally.values()].reduce((s, n) => s + n, 0);

  const underCap = (name: TeamName) =>
    deskTotal < 6 || (tally.get(name) ?? 0) + 1 <= Math.ceil((deskTotal + 1) * 0.34);

  const eligible = pool.filter(([name]) => underCap(name));
  const usable = eligible.length > 0 ? eligible : pool;
  const total = usable.reduce((s, [, w]) => s + w, 0);
  let roll = mulberry32(articleId)() * total;
  let picked: TeamName = usable[0]![0];
  for (const [name, w] of usable) {
    roll -= w;
    if (roll <= 0) {
      picked = name;
      break;
    }
  }
  tally.set(picked, (tally.get(picked) ?? 0) + 1);
  return picked;
}

/* ── Credits (audit item 1) ────────────────────────────────────────────── */

/** Publication names that must never sit in a photo-credit field. */
const PUBLICATION_RE =
  /^(archdaily|wallpaper(\s*\*|\s+architecture)?|dezeen|designboom|domus|architectural digest|archello|divisare|wad|world archi design)$/i;

function isBadCredit(credit: string | null | undefined): boolean {
  const c = (credit ?? "").trim().replace(/^photo(graph)?\s*(?::|by\b)\s*/i, "");
  return c.length > 0 && PUBLICATION_RE.test(c);
}

function cleanCreditValue(raw: string): string {
  return raw
    .replace(/^(photo\s*)?credit\s*:\s*/i, "")
    .replace(/^photo(graph)?\s*(?::|by\b)\s*/i, "")
    .trim();
}

/* ── Lexical helpers (audit item 20) ───────────────────────────────────── */

type LexNode = {
  type?: string;
  tag?: string;
  format?: number | string;
  text?: string;
  value?: unknown;
  children?: LexNode[];
  [k: string]: unknown;
};

const BOLD_BIT = 1;

function nodeText(n: LexNode): string {
  if (typeof n.text === "string") return n.text;
  return (n.children ?? []).map(nodeText).join("");
}

function stripBold(n: LexNode): LexNode {
  return {
    ...n,
    ...(n.type === "text" && typeof n.format === "number" ? { format: n.format & ~BOLD_BIT } : {}),
    ...(n.children ? { children: n.children.map(stripBold) } : {}),
  };
}

function uploadMediaId(n: LexNode): number | null {
  if (n.type !== "upload") return null;
  const v = n.value as { id?: number } | number | null | undefined;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.id === "number") return v.id;
  return null;
}

interface BodyResult {
  changed: boolean;
  body: { root: LexNode } | null;
  /** Credit text from the trailing "Credit: …" paragraph, if one was removed. */
  trailingCredit: string | null;
  /** media id → credit text captured from "Photo Credit: …" paragraphs. */
  inlineCredits: Map<number, string>;
  headingsFixed: number;
}

function transformBody(body: unknown): BodyResult {
  const root = (body as { root?: LexNode } | null | undefined)?.root;
  const none: BodyResult = {
    changed: false,
    body: null,
    trailingCredit: null,
    inlineCredits: new Map(),
    headingsFixed: 0,
  };
  if (!root?.children) return none;

  let changed = false;
  let headingsFixed = 0;
  let trailingCredit: string | null = null;
  const inlineCredits = new Map<number, string>();

  // 1. Trailing "Credit: …" paragraph (the LAST non-empty node only).
  const children = [...root.children];
  for (let i = children.length - 1; i >= 0; i--) {
    const text = nodeText(children[i]!).trim();
    if (!text) continue;
    if (children[i]!.type === "paragraph" && /^credit\s*:/i.test(text)) {
      trailingCredit = cleanCreditValue(text);
      children.splice(i, 1);
      changed = true;
    }
    break;
  }

  // 2. Inline "Photo Credit: …" paragraphs → nearest PRECEDING upload node.
  let lastUpload: number | null = null;
  const kept: LexNode[] = [];
  for (const node of children) {
    const mid = uploadMediaId(node);
    if (mid != null) lastUpload = mid;
    const text = nodeText(node).trim();
    if (node.type === "paragraph" && /^photo\s*credit\s*:/i.test(text) && lastUpload != null) {
      inlineCredits.set(lastUpload, cleanCreditValue(text));
      changed = true;
      continue; // drop the paragraph — the credit now lives on the media doc
    }
    kept.push(node);
  }

  // 3. Headings → h2, whole-line bold stripped.
  const normalized = kept.map((node) => {
    if (node.type !== "heading") return node;
    const needsTag = node.tag !== "h2";
    const flat = JSON.stringify(node);
    const stripped = stripBold({ ...node, tag: "h2" });
    if (needsTag || JSON.stringify(stripped) !== flat) {
      headingsFixed += 1;
      changed = true;
      return stripped;
    }
    return node;
  });

  return {
    changed,
    body: changed ? { ...(body as object), root: { ...root, children: normalized } } as { root: LexNode } : null,
    trailingCredit,
    inlineCredits,
    headingsFixed,
  };
}

/* ── Main ──────────────────────────────────────────────────────────────── */

async function fixVideos(payload: Payload, tenantId: number | string) {
  const REAL_DATES: ReadonlyArray<readonly [match: RegExp, iso: string]> = [
    [/ennea/i, "2025-11-26T04:00:00.000Z"],
    [/casa pura/i, "2026-01-11T04:00:00.000Z"],
    [/binocles/i, "2026-01-01T04:00:00.000Z"],
    [/75\.9/, "2025-10-31T04:00:00.000Z"],
    [/zhongshuge/i, "2025-12-11T04:00:00.000Z"],
  ];
  const { docs } = await payload.find({
    collection: "podcasts",
    where: { tenant: { equals: tenantId } },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  });
  console.log(`[videos] ${docs.length} podcast docs`);
  for (const doc of docs as Array<{ id: number; title?: string; audioUrl?: string | null; publishedAt?: string | null; duration?: string | null }>) {
    const title = doc.title ?? "";
    const date = REAL_DATES.find(([re]) => re.test(title))?.[1] ?? null;
    // Normalise the YouTube URL to the www host (audit item 9).
    let audioUrl = doc.audioUrl ?? null;
    if (audioUrl && /^https?:\/\/youtube\.com\//i.test(audioUrl)) {
      audioUrl = audioUrl.replace(/^https?:\/\/youtube\.com\//i, "https://www.youtube.com/");
    }
    // Duration from the watch page when the field is empty.
    let duration = (doc.duration ?? "").trim() || null;
    if (!duration && audioUrl) {
      try {
        const res = await fetch(audioUrl.replace("/shorts/", "/watch?v="), {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const html = await res.text();
        const secs = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1]);
        if (Number.isFinite(secs) && secs > 0) {
          duration = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
        }
      } catch {
        /* leave duration empty */
      }
    }
    const data: Record<string, unknown> = {};
    if (date && doc.publishedAt !== date) data.publishedAt = date;
    if (audioUrl && audioUrl !== doc.audioUrl) data.audioUrl = audioUrl;
    if (duration && duration !== doc.duration) data.duration = duration;
    console.log(
      `[videos] "${title}" → ${JSON.stringify(data)}${date ? "" : "  (no real date on file)"}`,
    );
    if (APPLY && Object.keys(data).length > 0) {
      await payload.update({ collection: "podcasts", id: doc.id, data, context: ctx, overrideAccess: true });
    }
  }
}

async function main() {
  const payload = await getPayload({ config });

  const tenant = (
    await payload.find({ collection: "tenants", where: { slug: { equals: "wad" } }, limit: 1, overrideAccess: true })
  ).docs[0] as { id: number | string } | undefined;
  if (!tenant) throw new Error("tenant wad not found");
  console.log(`[wad-fixes] tenant wad = ${tenant.id} · mode: ${APPLY ? "APPLY" : "ANALYZE"}`);

  if (VIDEOS_ONLY) {
    await fixVideos(payload, tenant.id);
    process.exit(0);
  }

  // Pillar id → slug map for byline pools.
  const pillars = (
    await payload.find({ collection: "pillars", where: { tenant: { equals: tenant.id } }, limit: 100, depth: 0, overrideAccess: true })
  ).docs as Array<{ id: number; slug: string }>;
  const pillarSlug = new Map<number, string>(pillars.map((p) => [p.id, p.slug]));

  // Ensure the editorial-team authors exist (find-or-create by name).
  const authorId = new Map<TeamName, number>();
  for (const member of TEAM) {
    const existing = (
      await payload.find({
        collection: "authors",
        where: { and: [{ tenant: { equals: tenant.id } }, { name: { equals: member.name } }] },
        limit: 1,
        overrideAccess: true,
      })
    ).docs[0] as { id: number } | undefined;
    if (existing) {
      authorId.set(member.name, existing.id);
    } else if (APPLY) {
      const created = (await payload.create({
        collection: "authors",
        data: { name: member.name, role: member.role, tenant: tenant.id } as never,
        context: ctx,
        overrideAccess: true,
      })) as { id: number };
      authorId.set(member.name, created.id);
      console.log(`[authors] created ${member.name} (#${created.id})`);
    } else {
      console.log(`[authors] would create ${member.name}`);
    }
  }

  // Stats
  const dekBuckets = new Map<string, number>();
  const bylineCount = new Map<string, number>();
  const deskByline = new Map<string, Map<string, number>>();
  let scanned = 0;
  let trailingCredits = 0;
  let inlineCreditParas = 0;
  let headingsFixed = 0;
  let badHeroCredits = 0;
  let deksCleared = 0;
  let updatedArticles = 0;
  let mediaUpdates = 0;

  const mediaCreditCache = new Map<number, string | null>();
  async function getMediaCredit(id: number): Promise<string | null> {
    if (mediaCreditCache.has(id)) return mediaCreditCache.get(id)!;
    try {
      const doc = (await payload.findByID({ collection: "media", id, depth: 0, overrideAccess: true })) as {
        credit?: string | null;
      };
      mediaCreditCache.set(id, doc.credit ?? null);
      return doc.credit ?? null;
    } catch {
      mediaCreditCache.set(id, null);
      return null;
    }
  }
  async function setMediaCredit(id: number, credit: string | null) {
    mediaUpdates += 1;
    mediaCreditCache.set(id, credit);
    if (!APPLY) return;
    await payload.update({
      collection: "media",
      id,
      data: { credit } as never,
      context: ctx,
      overrideAccess: true,
    });
  }

  let page = 1;
  outer: for (;;) {
    const res = await payload.find({
      collection: "articles",
      where: { tenant: { equals: tenant.id } },
      sort: "id",
      page,
      limit: 50,
      depth: 0,
      locale: "en",
      overrideAccess: true,
    });
    for (const raw of res.docs) {
      const a = raw as unknown as {
        id: number;
        title?: string;
        dek?: string | null;
        body?: unknown;
        pillar?: number | { id: number } | null;
        heroImage?: number | { id: number } | null;
        author?: number | { id: number } | null;
      };
      if (scanned >= LIMIT) break outer;
      scanned += 1;

      const title = a.title ?? "";
      const pid = typeof a.pillar === "object" && a.pillar ? a.pillar.id : (a.pillar as number | null);
      const desk = (pid != null && pillarSlug.get(pid)) || "default";
      const heroId =
        typeof a.heroImage === "object" && a.heroImage ? a.heroImage.id : (a.heroImage as number | null);

      const data: Record<string, unknown> = {};

      // Item 21 — junk dek.
      const dek = (a.dek ?? "").trim();
      if (dek && dek.length < 20) {
        dekBuckets.set(dek, (dekBuckets.get(dek) ?? 0) + 1);
        deksCleared += 1;
        data.dek = "";
      }

      // Items 1 + 20 — body transform.
      const t = transformBody(a.body);
      if (t.trailingCredit) trailingCredits += 1;
      inlineCreditParas += t.inlineCredits.size;
      headingsFixed += t.headingsFixed;
      if (t.changed && t.body) data.body = t.body;

      // Item 1 — hero credit.
      if (heroId != null) {
        const current = await getMediaCredit(heroId);
        const bad = isBadCredit(current);
        if (bad) badHeroCredits += 1;
        if (t.trailingCredit && (bad || !current || !current.trim())) {
          await setMediaCredit(heroId, t.trailingCredit);
        } else if (bad) {
          await setMediaCredit(heroId, null);
        }
      }
      // Inline image credits captured from the body.
      for (const [mid, credit] of t.inlineCredits) {
        await setMediaCredit(mid, credit);
      }

      // Item 4 — byline.
      const byline = pickByline(desk, title, a.id);
      bylineCount.set(byline, (bylineCount.get(byline) ?? 0) + 1);
      if (!deskByline.has(desk)) deskByline.set(desk, new Map());
      const dm = deskByline.get(desk)!;
      dm.set(byline, (dm.get(byline) ?? 0) + 1);
      const targetAuthor = authorId.get(byline);
      const currentAuthor = typeof a.author === "object" && a.author ? a.author.id : (a.author as number | null);
      if (targetAuthor != null && currentAuthor !== targetAuthor) data.author = targetAuthor;

      if (Object.keys(data).length > 0) {
        updatedArticles += 1;
        if (APPLY) {
          await payload.update({
            collection: "articles",
            id: a.id,
            data: data as never,
            locale: "en",
            context: ctx,
            overrideAccess: true,
          });
          if (updatedArticles % 50 === 0) console.log(`[articles] updated ${updatedArticles}…`);
        }
      }
    }
    if (!res.hasNextPage) break;
    page += 1;
  }

  console.log(`\n[report] scanned ${scanned} articles`);
  console.log(`  trailing "Credit:" lines captured : ${trailingCredits}`);
  console.log(`  inline "Photo Credit:" paragraphs : ${inlineCreditParas}`);
  console.log(`  headings normalised               : ${headingsFixed}`);
  console.log(`  hero credits that were publication: ${badHeroCredits}`);
  console.log(`  junk deks cleared                 : ${deksCleared}`);
  console.log(`  media credit writes               : ${mediaUpdates}`);
  console.log(`  article updates                   : ${updatedArticles}`);
  console.log(`\n[report] junk dek values:`);
  for (const [v, n] of [...dekBuckets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30)) {
    console.log(`    ${JSON.stringify(v)} × ${n}`);
  }
  const total = [...bylineCount.values()].reduce((s, n) => s + n, 0) || 1;
  console.log(`\n[report] byline distribution (overall):`);
  for (const [name, n] of [...bylineCount.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${name.padEnd(32)} ${n} (${Math.round((n / total) * 100)}%)`);
  }
  console.log(`\n[report] byline distribution per desk:`);
  for (const [desk, m] of deskByline) {
    const deskTotal = [...m.values()].reduce((s, n) => s + n, 0) || 1;
    const parts = [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([name, n]) => `${name} ${Math.round((n / deskTotal) * 100)}%`)
      .join(" · ");
    console.log(`    ${desk.padEnd(18)} ${parts}`);
  }

  // Item 16 — real lastmod. Runs LAST because payload.update stamps
  // updated_at = now on every write above.
  if (APPLY && !Number.isFinite(LIMIT)) {
    const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle;
    await db.execute(
      sql`UPDATE articles SET updated_at = published_at WHERE tenant_id = ${tenant.id} AND published_at IS NOT NULL`,
    );
    console.log(`\n[lastmod] articles.updated_at ← published_at (tenant wad)`);
  } else {
    console.log(`\n[lastmod] skipped (runs only on a FULL --apply)`);
  }

  await fixVideos(payload, tenant.id);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
