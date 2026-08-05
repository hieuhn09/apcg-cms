/**
 * Publish a frontend's view counts into Central so editors see a number in the
 * admin sidebar. Read-only against the frontend; SETs `articles.views` in Central.
 *
 *   READER_DATABASE_URL=postgres://…            (the frontend's own DB)
 *   VIEWS_TENANT=brief-asia
 *   VIEWS_ID_MAP=migration-data/brief-asia/article-id-map.json   (optional)
 *   npm run migrate:sync-views -- [--dry-run]
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is NOT the ranking source. brief-asia's "Most Read" rail is a rolling 24-hour
 * window computed from its own event table (`article_views`, one timestamped row
 * per view) and it stays that way — Central stores a single all-time integer with
 * no time dimension, so it cannot answer "most read today" and must never be
 * pointed at that rail. This script exists only so the cumulative number is
 * VISIBLE to editors in Central's admin.
 *
 * SET, not increment. Re-running converges on the same value instead of doubling
 * it, so this is safe on a cron, safe to re-run after a failure, and safe to run
 * twice by accident. That is the opposite of POST /api/public/views, which is a
 * +1 and is not idempotent.
 *
 * Raw SQL on purpose. Writing `views` through the Payload API would bump
 * `updatedAt` and create a version row for every article on every sync — churning
 * the editorial audit trail with analytics noise. Central's own view endpoint uses
 * raw SQL for exactly this reason.
 *
 * ID SPACES — the part that silently goes wrong
 *
 * `article_views.article_id` holds whatever id the page was rendered with, so its
 * meaning changes at cutover:
 *   - rows written AFTER the CMS_SOURCE flip carry CENTRAL ids → used directly;
 *   - rows written BEFORE carry SOURCE ids → only usable via the import id map.
 * Because the two id spaces are dense overlapping serials, feeding pre-flip ids
 * straight in does not fail — it credits the wrong articles. So historical rows are
 * counted ONLY from the `article_views_pre_central` snapshot and ONLY when
 * VIEWS_ID_MAP is supplied. Without the map, this reports post-flip totals and says
 * so, rather than quietly guessing.
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

const TENANT_SLUG = process.env.VIEWS_TENANT || "brief-asia";
const ID_MAP_PATH = process.env.VIEWS_ID_MAP;
const SNAPSHOT_TABLE = process.env.VIEWS_SNAPSHOT_TABLE || "article_views_pre_central";

type Counts = Map<string, number>;

function add(counts: Counts, id: string, n: number): void {
  counts.set(id, (counts.get(id) ?? 0) + n);
}

async function collect(): Promise<{ counts: Counts; historical: number; live: number }> {
  const sql = postgres(requireEnv("READER_DATABASE_URL"), { max: 1 });
  const counts: Counts = new Map();
  let historical = 0;
  let live = 0;

  try {
    const liveRows = await sql<{ article_id: string; n: number }[]>`
      SELECT article_id, count(*)::int AS n FROM article_views GROUP BY article_id`;
    for (const r of liveRows) {
      add(counts, String(r.article_id), r.n);
      live += r.n;
    }

    if (ID_MAP_PATH) {
      if (!existsSync(ID_MAP_PATH)) throw new Error(`VIEWS_ID_MAP not found: ${ID_MAP_PATH}`);
      const raw = JSON.parse(readFileSync(ID_MAP_PATH, "utf8")) as Record<string, number | string>;
      const map = new Map(Object.entries(raw).map(([src, dst]) => [String(src), String(dst)]));

      const snapExists = await sql<{ exists: boolean }[]>`
        SELECT to_regclass(${SNAPSHOT_TABLE}) IS NOT NULL AS exists`;
      if (!snapExists[0]?.exists) {
        console.warn(`[sync-views] ${SNAPSHOT_TABLE} not found — skipping historical rows`);
      } else {
        const snapRows = await sql<{ article_id: string; n: number }[]>`
          SELECT article_id, count(*)::int AS n FROM ${sql(SNAPSHOT_TABLE)} GROUP BY article_id`;
        let unmapped = 0;
        for (const r of snapRows) {
          const central = map.get(String(r.article_id));
          // An unmapped source id has no correct home in Central. Dropping it
          // undercounts; guessing would credit a different real article.
          if (!central) {
            unmapped += r.n;
            continue;
          }
          add(counts, central, r.n);
          historical += r.n;
        }
        if (unmapped) console.warn(`[sync-views] ${unmapped} historical view(s) had no id-map entry — not counted`);
      }
    } else {
      console.warn("[sync-views] VIEWS_ID_MAP not set — counting post-flip rows only (pre-cutover history excluded)");
    }
  } finally {
    await sql.end();
  }

  return { counts, historical, live };
}

async function main(): Promise<void> {
  const { counts, historical, live } = await collect();
  console.log(
    `[sync-views] ${counts.size} article(s) with views — ${live} live event row(s)${historical ? `, ${historical} historical` : ""}`,
  );
  if (counts.size === 0) {
    console.log("[sync-views] nothing to write.");
    return;
  }

  const central = postgres(requireEnv("DATABASE_URL"), { max: 1 });
  try {
    const t = await central<{ id: number | string }[]>`SELECT id FROM tenants WHERE slug = ${TENANT_SLUG} LIMIT 1`;
    const tenantId = t[0]?.id;
    if (tenantId == null) throw new Error(`Tenant not found in Central: ${TENANT_SLUG}`);

    const pairs = [...counts].map(([article_id, n]) => ({ article_id, n }));

    if (DRY_RUN) {
      const top = pairs.sort((a, b) => b.n - a.n).slice(0, 10);
      console.log(`[sync-views] would set views on ${pairs.length} article(s) for tenant ${TENANT_SLUG}. Top 10:`);
      for (const p of top) console.log(`  article ${p.article_id} → ${p.n}`);
      // Surface ids that do not exist in this tenant — the loud signal that the
      // id space is wrong (e.g. syncing pre-flip ids without a map).
      const known = await central<{ id: number | string }[]>`
        SELECT id FROM articles WHERE tenant_id = ${tenantId}`;
      const knownSet = new Set(known.map((r) => String(r.id)));
      const strangers = pairs.filter((p) => !knownSet.has(p.article_id));
      console.log(
        strangers.length
          ? `[sync-views] WARNING: ${strangers.length}/${pairs.length} ids do not exist in tenant ${TENANT_SLUG} — wrong id space? e.g. ${strangers.slice(0, 5).map((s) => s.article_id).join(", ")}`
          : `[sync-views] all ${pairs.length} ids resolve inside tenant ${TENANT_SLUG}.`,
      );
      return;
    }

    await central.begin(async (tx) => {
      await tx`CREATE TEMP TABLE _view_counts (article_id text PRIMARY KEY, n integer NOT NULL) ON COMMIT DROP`;
      await tx`INSERT INTO _view_counts ${tx(pairs, "article_id", "n")}`;
      const res = await tx`
        UPDATE articles a SET views = v.n
        FROM _view_counts v
        WHERE a.id::text = v.article_id AND a.tenant_id = ${tenantId}`;
      console.log(`[sync-views] ${res.count} article(s) updated in tenant ${TENANT_SLUG}.`);
    });
  } finally {
    await central.end();
  }
}

main().catch((err) => {
  console.error("[sync-views] failed", err);
  process.exit(1);
});
