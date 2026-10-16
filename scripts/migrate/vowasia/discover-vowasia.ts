/**
 * READ-ONLY discovery of the legacy VowAsia source (phase A). Owner-run.
 *
 *   read -s LEGACY_VOWASIA_DB_URL; export LEGACY_VOWASIA_DB_URL
 *   npm run migrate:vowasia:discover -- --mapping-overlay <overlay outside the repo>
 *     [--site-id <id>] [--out <dir>] [--sample N] [--schema S]
 *
 * Reads ONLY the tables named by the source config (hypothesis + overlay),
 * always through the closed builders of ./lib/vowasia-sql, always site-filtered:
 *   - checks the hypothesis against the real catalog and lists every mismatch
 *     (missing table, missing column) instead of guessing;
 *   - site-scoped counts; distributions of status / category / section /
 *     subsection (configured column roles) and of the created-at year;
 *   - slug analysis (duplicates, case collisions, odd characters);
 *   - body shape on a stratified sample (HTML / Markdown / JSON / text and
 *     script / iframe / on*= / javascript: signals), counts only;
 *   - image hosts (host name only) and rows without an image; missing dates.
 * Writes `legacy-schema-report.md`, `legacy-mapping.template.json` (TODO
 * markers on purpose) and `query-log.json` (builder id + SQL text, never
 * params) into the out dir (git-ignored or outside the repo; 700/600).
 * Never prints a body, a site id, a title or any table outside the config.
 */
import path from "node:path";
import { intFlag } from "./lib/args";
import { CliError, DEFAULT_OUT, DEFAULT_SOURCE, parseDiscover, resolvePath, runMain } from "./lib/vowasia-cli";
import { loadSourceConfig, withSiteFilter, type ColumnRole } from "./lib/vowasia-config";
import { legacyBanner, legacySsl } from "./lib/vowasia-db-banner";
import { LEGACY_URL_ENV } from "./lib/vowasia-constants";
import { assertOutDirSafe, writeFileSafe, writeJsonSafe } from "./lib/out-dir";
import { LiveVowasiaReader, assertVowasiaSite } from "./lib/vowasia-reader";
import { IDENT_RE } from "./lib/vowasia-config";
import { countRows, createSqlRegistry, distribution, sampleRows, type TableSpec } from "./lib/vowasia-sql";

export const DISCOVER_MESSAGES = {
  hypothesisMismatch: "discover: the source config does not match the real catalog (missing table or required column); see legacy-schema-report.md, fill the overlay and run again.",
  badSchema: "discover: --schema is not a lower snake_case identifier; refusing.",
} as const;

/** Classify a body string without printing it. */
export function sniffBody(raw: string): "empty" | "json" | "html" | "markdown" | "text" {
  const s = raw.trim();
  if (!s) return "empty";
  if ((s.startsWith("{") || s.startsWith("[")) && (() => { try { JSON.parse(s); return true; } catch { return false; } })()) return "json";
  if (/<\/?(p|div|h[1-6]|ul|ol|li|br|img|a|span|figure|section|strong|em)\b/i.test(s)) return "html";
  if (/^#{1,6} |\n#{1,6} |\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|^\s*[-*] /m.test(s)) return "markdown";
  return "text";
}

function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s.length > 60 ? `${s.slice(0, 57)}...` : s).replace(/[|\n\r`]/g, " ");
}

async function main(): Promise<number> {
  const a = parseDiscover(process.argv.slice(2));
  const overlay = a.get("mapping-overlay");
  let cfg = loadSourceConfig(DEFAULT_SOURCE, overlay ? resolvePath(overlay) : undefined);
  cfg = withSiteFilter(cfg, a.get("site-id"));
  if (cfg.source.siteFilter === undefined) throw new CliError("discover: no site filter (set source.siteFilter in the overlay outside the repo); refusing.");
  const siteId = cfg.source.siteFilter;
  const schemaFlag = a.get("schema");
  if (schemaFlag !== undefined && !IDENT_RE.test(schemaFlag)) throw new CliError(DISCOVER_MESSAGES.badSchema);
  const sample = intFlag(a, "sample", 200) as number;
  const out = assertOutDirSafe(resolvePath(a.get("out") ?? DEFAULT_OUT));
  const url = process.env[LEGACY_URL_ENV];
  const b = legacyBanner(url);
  console.log(`[discover] legacy source: ${b.banner} (read-only, site-filtered)`);
  const reg = createSqlRegistry(cfg, schemaFlag);
  const reader = LiveVowasiaReader.open(url as string, legacySsl(process.env, b.local), reg, siteId);
  const lines: string[] = [];
  const P = (s = "") => lines.push(s);
  const report = path.join(out, "legacy-schema-report.md");
  const roles = cfg.source.columnRoles;

  P("# Legacy VowAsia schema report");
  P();
  P("Read-only discovery, site-filtered, configured tables only. Other tables of the shared database exist and were deliberately NOT inspected or named.");
  P();
  P(`- Schema: ${reg.schema}`);
  P(`- Site filter: provided (value not printed); kind: ${reg.siteIdKind}`);
  P(`- Config: hypothesis${overlay ? " + overlay" : " only (no overlay)"}`);

  // 1. Hypothesis vs real catalog.
  const cat = await reader.loadCatalog();
  const missing: string[] = [];
  const blocking: string[] = [];
  P();
  P("## Hypothesis check (config vs real catalog)");
  P();
  for (const [logical, t] of Object.entries(reg.tables) as [string, TableSpec][]) {
    const cols = cat.columns.get(t.name);
    if (!cols) {
      blocking.push(`table ${logical} (${t.name}) not found in schema ${reg.schema}`);
      continue;
    }
    P(`- table ${logical} -> ${t.name}: found (${cat.tables.get(t.name) ?? "?"}, ${cols.size} columns)`);
    const need = [t.siteColumn, ...t.keyColumns, ...(t.createdAtColumn ? [t.createdAtColumn] : []), ...(t.slugColumn ? [t.slugColumn, t.nameColumn as string] : [])];
    for (const c of need) if (!cols.has(c)) blocking.push(`required column ${logical}.${c} not found`);
  }
  const articleCols = cat.columns.get(reg.tables.articles?.name ?? "") ?? new Map();
  const roleCol = (r: ColumnRole): string | undefined => {
    const c = roles[r];
    return c !== undefined && articleCols.has(c) ? c : undefined;
  };
  for (const [r, c] of Object.entries(roles)) if (c !== undefined && articleCols.size && !articleCols.has(c)) missing.push(`role ${r} -> articles.${c} not found`);
  for (const m of blocking) P(`- MISMATCH (blocking): ${m}`);
  for (const m of missing) P(`- MISMATCH (role skipped): ${m}`);
  if (!blocking.length && !missing.length) P("- no mismatch");
  P();
  P("## Columns");
  for (const [logical, t] of Object.entries(reg.tables) as [string, TableSpec][]) {
    const cols = cat.columns.get(t.name);
    if (!cols) continue;
    P();
    P(`### ${logical} (${t.name})`);
    P();
    P("| column | type | nullable |");
    P("|---|---|---|");
    for (const [c, d] of cols) P(`| ${c} | ${d.type} | ${d.nullable} |`);
  }
  if (blocking.length) {
    writeFileSafe(report, lines.join("\n") + "\n");
    writeJsonSafe(path.join(out, "query-log.json"), reader.db.log);
    reader.close();
    console.log(`[discover] report: ${report}`);
    throw new CliError(DISCOVER_MESSAGES.hypothesisMismatch);
  }

  // 2. Site row (HS3: exactly one row, slug vowasia).
  await assertVowasiaSite(reader, cfg.source.expectedSiteSlug);
  P();
  P(`## Site: one row, slug ${cfg.source.expectedSiteSlug} (verified)`);

  // 3. Counts.
  const counts: Record<string, number> = {};
  P();
  P("## Site-scoped row counts");
  P();
  for (const logical of Object.keys(reg.tables)) {
    counts[logical] = Number((await reader.db.query(countRows(reg, logical, siteId)))[0]?.n ?? 0);
    P(`- ${logical}: ${counts[logical]}`);
  }

  // 4. Distributions.
  const dists: Record<string, [unknown, number][]> = {};
  P();
  P("## Distributions (articles, top 25)");
  for (const r of ["status", "category", "section", "subsection"] as ColumnRole[]) {
    const c = roleCol(r);
    if (!c) continue;
    const rows = await reader.db.query(distribution(reg, "articles", c, siteId));
    dists[r] = rows.map((x) => [x.v, Number(x.n)]);
    P();
    P(`### ${r} (${c})`);
    P();
    for (const x of rows) P(`- ${cell(x.v)}: ${String(x.n)}`);
  }

  // 5. Slug plan rows: slugs, years, missing dates (computed in JS, no extra SQL shape).
  const t = reg.tables.articles as TableSpec;
  const planCols = [...new Set([...t.keyColumns, ...(["createdAt", "publishedAt", "status", "slug"] as ColumnRole[]).map(roleCol).filter((x): x is string => !!x)])];
  const plan = await reader.slugPlanRows(planCols);
  const createdCol = roleCol("createdAt");
  const publishedCol = roleCol("publishedAt");
  const slugCol = roleCol("slug");
  const years: Record<string, number> = {};
  let noCreated = 0;
  let noPublished = 0;
  for (const r of plan) {
    const c = createdCol ? r[createdCol] : undefined;
    if (c === null || c === undefined || c === "") noCreated++;
    else {
      const y = String(c).slice(0, 4);
      years[y] = (years[y] ?? 0) + 1;
    }
    if (publishedCol && (r[publishedCol] === null || r[publishedCol] === undefined || r[publishedCol] === "")) noPublished++;
  }
  P();
  P(`### created-at year${createdCol ? ` (${createdCol})` : " (no createdAt role column)"}`);
  P();
  for (const [y, n] of Object.entries(years).sort()) P(`- ${y}: ${n}`);
  P();
  P("## Dates");
  P();
  P(`- rows without created-at: ${createdCol ? noCreated : "n/a (no createdAt column)"}`);
  P(`- rows without published-at: ${publishedCol ? noPublished : "n/a (no publishedAt column)"}`);
  P();
  P("## Slug analysis");
  P();
  if (slugCol) {
    const slugs = plan.map((r) => (typeof r[slugCol] === "string" ? (r[slugCol] as string) : ""));
    const nonEmpty = slugs.filter(Boolean);
    const lower = new Map<string, number>();
    for (const s of nonEmpty) lower.set(s.toLowerCase(), (lower.get(s.toLowerCase()) ?? 0) + 1);
    P(`- rows: ${plan.length}; null/empty slugs: ${slugs.length - nonEmpty.length}`);
    P(`- duplicate slugs (exact): ${nonEmpty.length - new Set(nonEmpty).size}; case-insensitive collisions: ${[...lower.values()].filter((n) => n > 1).length}; with uppercase: ${nonEmpty.filter((s) => s !== s.toLowerCase()).length}`);
    P(`- slugs with characters outside [a-z0-9-]: ${nonEmpty.filter((s) => !/^[a-z0-9][a-z0-9-]*$/.test(s)).length}; non-ASCII: ${nonEmpty.filter((s) => /[^\x00-\x7f]/.test(s)).length}; max length: ${Math.max(0, ...nonEmpty.map((s) => s.length))}`);
  } else P("- n/a (no slug column)");

  // 6. Body shape on a stratified sample (by status and year), counts only.
  const bodyCol = roleCol("body");
  const formats: Record<string, number> = {};
  const signals = { script: 0, iframe: 0, handler: 0, jsUrl: 0, img: 0 };
  const key0 = t.keyColumns[0] as string;
  if (bodyCol) {
    const strata = new Map<string, string[]>();
    const statusCol = roleCol("status");
    for (const r of plan) {
      const k = `${statusCol ? String(r[statusCol]) : ""}|${createdCol ? String(r[createdCol] ?? "").slice(0, 4) : ""}`;
      strata.set(k, [...(strata.get(k) ?? []), String(r[key0])]);
    }
    const ids: string[] = [];
    for (let i = 0; ids.length < Math.min(sample, plan.length); i++) {
      let added = false;
      for (const list of strata.values()) {
        if (list[i] !== undefined && ids.length < sample) {
          ids.push(list[i] as string);
          added = true;
        }
      }
      if (!added) break;
    }
    for (let i = 0; i < ids.length; i += 100) {
      for (const r of await reader.db.query(sampleRows(reg, "articles", [key0, bodyCol], siteId, ids.slice(i, i + 100)))) {
        const raw = typeof r[bodyCol] === "string" ? (r[bodyCol] as string) : JSON.stringify(r[bodyCol] ?? "");
        const f = sniffBody(raw);
        formats[f] = (formats[f] ?? 0) + 1;
        if (/<script/i.test(raw)) signals.script++;
        if (/<iframe/i.test(raw)) signals.iframe++;
        if (/\son\w+\s*=/i.test(raw)) signals.handler++;
        if (/javascript:/i.test(raw)) signals.jsUrl++;
        if (/<img/i.test(raw)) signals.img++;
      }
    }
    P();
    P(`## Body shape (${bodyCol}; stratified sample of ${ids.length}; bodies never printed)`);
    P();
    for (const [k, n] of Object.entries(formats)) P(`- ${k}: ${n}`);
    P(`- signals: script=${signals.script} iframe=${signals.iframe} on*==${signals.handler} javascript:=${signals.jsUrl} img=${signals.img}`);
  } else {
    P();
    P("## Body shape: n/a (no body column)");
  }

  // 7. Image hosts (host only) and rows without an image.
  const imageCol = roleCol("image");
  const hosts: Record<string, number> = {};
  let noImage = 0;
  if (imageCol) {
    for await (const page of reader.pages("articles", [imageCol], 500)) {
      for (const r of page) {
        const u = typeof r[imageCol] === "string" ? (r[imageCol] as string).trim() : "";
        if (!u) {
          noImage++;
          continue;
        }
        let h = "(unparseable or relative)";
        try {
          h = new URL(u).host || h;
        } catch {
          /* keep */
        }
        hosts[h] = (hosts[h] ?? 0) + 1;
      }
    }
    P();
    P(`## Image hosts (${imageCol}; host name only)`);
    P();
    for (const [h, n] of Object.entries(hosts).sort((x, y) => y[1] - x[1])) P(`- ${h}: ${n}`);
    P(`- rows without image: ${noImage}`);
    P("- image size: not estimated in phase A (no size column configured; measured when images are fetched in phase B)");
  } else {
    P();
    P("## Image hosts: n/a (no image column)");
  }
  if (reader.duplicatesSkipped) P(`- keyset: ${reader.duplicatesSkipped} duplicate rows skipped`);

  P();
  P("## Open owner decisions (not derivable from the database)");
  P();
  P("- C3: old URL origin and path pattern; removed sections 410 or 301.");
  P("- C8: map each category/section above to the 8 VowAsia pillars / 27 sub-sections (unmatched rows are rejected, never guessed).");
  P("- C10: cutover date; image host allowlist and R2 bucket (overlay, outside the repo).");
  P("- Before sharing this report: re-read it and remove anything sensitive.");
  writeFileSafe(report, lines.join("\n") + "\n");

  const template = {
    _template: "TODO: legacy mapping for phase B; every TODO must be replaced by an owner decision.",
    source: {
      schema: reg.schema,
      siteIdKind: reg.siteIdKind,
      siteFilter: "TODO: keep in the overlay outside the repo",
      tables: cfg.source.tables,
      columnRoles: cfg.source.columnRoles,
    },
    taxonomy: { rules: [], _todo: "TODO (C8): map legacy category/section values to pillar/sub-section slugs" },
    urls: { oldOrigin: "TODO (C3)", articlePathTemplate: "TODO (C3)", sectionPaths: {}, gonePaths: [], extraLegacyPaths: [], _provisional: ["oldOrigin", "articlePathTemplate"] },
    media: { hostAllowlist: ["TODO: from Image hosts"], hostRewrite: {} },
    _evidence: { counts, distributions: dists, years, formats, imageHosts: hosts, rowsWithoutImage: noImage },
  };
  writeJsonSafe(path.join(out, "legacy-mapping.template.json"), template);
  writeJsonSafe(path.join(out, "query-log.json"), reader.db.log);
  reader.close();
  console.log(`[discover] report: ${report}; articles=${counts.articles ?? 0}; mismatches=${missing.length}`);
  return 0;
}

void runMain("discover", main);
