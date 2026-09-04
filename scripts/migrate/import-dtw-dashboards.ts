/**
 * One-off (04-09-2026, "remove local Payload from the sites"): copy DailyTechWire's
 * AI Leaderboard out of dtw-web's own Payload database and into Central.
 *
 *   dtw `ai_models` (+ `ai_models_editor_locked`) -> central `aiLeaderboardRows`
 *   dtw `dashboard_methodology` global            -> central `tenants.dashboards`
 *
 * Matching is by `sourceSlugLlmstats` when the source row has one, else by
 * `model` — so re-running is idempotent and never duplicates a row. Rows already
 * in Central for the tenant that the source does NOT have are left alone (the
 * pre-port seed rows); this script only ever creates or updates.
 *
 * Run (from central-cms, with the SOURCE db reachable):
 *   DTW_SOURCE_DATABASE_URL=postgres://…  npx tsx scripts/migrate/import-dtw-dashboards.ts [--tenant dtw] [--dry-run]
 *
 * DTW_SOURCE_DATABASE_URL is dtw-web's own DATABASE_URL (the site's Payload DB,
 * NOT its AUTH_DATABASE_URL). Central's own connection comes from the usual
 * DATABASE_URL in this repo's env, same as every other migrate script.
 */
import "../lib/env";
import postgres from "postgres";
import { getPayload } from "payload";
import config from "../../payload.config";

const DRY = process.argv.includes("--dry-run");
const tenantSlug = (() => {
  const i = process.argv.indexOf("--tenant");
  return i >= 0 ? process.argv[i + 1] : "dtw";
})();

interface SourceRow {
  id: number;
  rank: string | number | null;
  model: string;
  maker: string | null;
  general: string | number | null;
  reasoning: string | number | null;
  coding: string | number | null;
  math: string | number | null;
  search: string | number | null;
  vision: string | number | null;
  input_price: string | number | null;
  output_price: string | number | null;
  released: Date | null;
  source_slug_llmstats: string | null;
  as_of_scores: Date | null;
}

/** Postgres `numeric` arrives as a string through the driver — normalise it. */
function num(v: string | number | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: Date | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

async function main() {
  const sourceUrl = process.env.DTW_SOURCE_DATABASE_URL;
  if (!sourceUrl) throw new Error("DTW_SOURCE_DATABASE_URL is required (dtw-web's own Payload DATABASE_URL)");

  const sql = postgres(sourceUrl, { max: 2, ssl: sourceUrl.includes("localhost") ? false : "require" });
  const payload = await getPayload({ config });

  const tenant = (
    await payload.find({
      collection: "tenants",
      where: { slug: { equals: tenantSlug } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as { id: number; features?: { dashboards?: boolean | null } } | undefined;
  if (!tenant) throw new Error(`tenant ${tenantSlug} not found in Central`);
  if (!tenant.features?.dashboards) {
    console.warn(
      `WARNING: tenant ${tenantSlug} has features.dashboards OFF — the rows will import but the public API will 404 them until it is turned on.`,
    );
  }

  // ── 1. Rows ────────────────────────────────────────────────────────────────
  const rows = (await sql<SourceRow[]>`
    SELECT id, rank, model, maker, general, reasoning, coding, math, search, vision,
           input_price, output_price, released, source_slug_llmstats, as_of_scores
    FROM ai_models ORDER BY rank NULLS LAST, id
  `) as unknown as SourceRow[];
  console.log(`source: ${rows.length} ai_models row(s)`);

  const lockedBySource = new Map<number, string[]>();
  const lockedRows = (await sql<{ _parent_id: number; field: string | null }[]>`
    SELECT "_parent_id", "field" FROM ai_models_editor_locked ORDER BY "_order"
  `) as unknown as { _parent_id: number; field: string | null }[];
  for (const l of lockedRows) {
    if (!l.field) continue;
    const list = lockedBySource.get(l._parent_id) ?? [];
    list.push(l.field);
    lockedBySource.set(l._parent_id, list);
  }

  const existing = await payload.find({
    collection: "aiLeaderboardRows",
    where: { tenant: { equals: tenant.id } },
    limit: 0,
    depth: 0,
    overrideAccess: true,
  });
  const bySlug = new Map<string, { id: number | string }>();
  const byModel = new Map<string, { id: number | string }>();
  for (const d of existing.docs as unknown as { id: number; model?: string; sourceSlugLlmstats?: string | null }[]) {
    if (d.sourceSlugLlmstats) bySlug.set(d.sourceSlugLlmstats, d);
    if (d.model) byModel.set(d.model, d);
  }

  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const data: Record<string, unknown> = {
      rank: num(r.rank),
      model: r.model,
      maker: r.maker,
      general: num(r.general),
      reasoning: num(r.reasoning),
      coding: num(r.coding),
      math: num(r.math),
      search: num(r.search),
      vision: num(r.vision),
      inputPrice: num(r.input_price),
      outputPrice: num(r.output_price),
      released: iso(r.released),
      sourceSlugLlmstats: r.source_slug_llmstats,
      asOfScores: iso(r.as_of_scores),
      editorLocked: (lockedBySource.get(r.id) ?? []).map((field) => ({ field })),
    };

    const match =
      (r.source_slug_llmstats ? bySlug.get(r.source_slug_llmstats) : undefined) ?? byModel.get(r.model);

    if (match) {
      if (DRY) console.log(`[dry-run] update #${match.id} ${r.model}`);
      else
        await payload.update({
          collection: "aiLeaderboardRows",
          id: match.id,
          data: data as never,
          overrideAccess: true,
        });
      updated++;
    } else {
      if (DRY) console.log(`[dry-run] create ${r.model}`);
      else
        await payload.create({
          collection: "aiLeaderboardRows",
          data: { ...data, tenant: tenant.id } as never,
          overrideAccess: true,
        });
      created++;
    }
  }

  // ── 2. Methodology global ──────────────────────────────────────────────────
  // dtw-web stored it as a Payload global, so the table holds exactly one row.
  const meth = (await sql<
    {
      ai_methodology_en: string | null;
      ai_methodology_vi: string | null;
      ai_methodology_ind: string | null;
      disclaimer_en: string | null;
      disclaimer_vi: string | null;
      disclaimer_ind: string | null;
    }[]
  >`
    SELECT ai_methodology_en, ai_methodology_vi, ai_methodology_ind,
           disclaimer_en, disclaimer_vi, disclaimer_ind
    FROM dashboard_methodology LIMIT 1
  `) as unknown as Record<string, string | null>[];

  const m = meth[0];
  if (!m) {
    console.log("source: no dashboard_methodology row — leaving tenant.dashboards untouched");
  } else {
    const dashboards = {
      aiMethodology: {
        en: m.ai_methodology_en,
        vi: m.ai_methodology_vi,
        ind: m.ai_methodology_ind,
      },
      disclaimer: {
        en: m.disclaimer_en,
        vi: m.disclaimer_vi,
        ind: m.disclaimer_ind,
      },
    };
    if (DRY) console.log("[dry-run] would write tenant.dashboards:", JSON.stringify(dashboards, null, 2));
    else
      await payload.update({
        collection: "tenants",
        id: tenant.id,
        data: { dashboards } as never,
        overrideAccess: true,
      });
    console.log("methodology: written to tenant.dashboards");
  }

  console.log(`rows: ${created} created, ${updated} updated${DRY ? " (dry-run — nothing written)" : ""}`);
  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
