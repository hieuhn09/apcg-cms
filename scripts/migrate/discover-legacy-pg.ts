/**
 * READ-ONLY discovery of the legacy GTP source (gtp-launch P4, 7.1 as cut by
 * A11-S07/S-11 and A12-N03). Introspects ONLY the 9 allow-listed tables
 * through the closed SQL builders, always site-filtered:
 *   columns (type, nullability), site-scoped exact counts, value distributions,
 *   slug analysis and body-format sniffing (computed in JS from the slug-plan
 *   rows and stratified samples), image host distribution, redacted samples.
 * Other tables of the shared DB exist and are deliberately NOT inspected.
 *
 *   LEGACY_GTP_DB_URL=... npm run migrate:gtp:discover -- (--site-id <uuid> | --mapping-overlay <path>)
 *     [--out dir] [--sample 5] [--max-body-sniff 200] [--schema public] [--snapshot-dir dir] [--mapping path]
 *
 * Writes `legacy-schema-report.md`, `legacy-mapping.template.json` (TODO markers
 * on purpose: validate-mapping fails until a human fills them) and
 * `query-log.json` into the out dir (git-ignored, mode 700/600).
 */
import path from "node:path";
import { CliError, intFlag } from "./lib/args";
import { parseCommand, resolveMappingPath, resolveSiteFilter } from "./lib/cli-spec";
import { loadEffectiveMapping, openLegacy, outDir, resolvePath, runMain } from "./lib/cli-common";
import { redactRow } from "./lib/gtp-exports";
import { enText, sniffBodyFormat } from "./lib/gtp-transform";
import { LiveLegacyReader, writeSnapshot } from "./lib/legacy-reader";
import { ALLOWED_TABLES, catalogColumns, countRows, distribution, effectiveAllowList, sampleRows, type AllowedTable } from "./lib/legacy-sql";
import { mappingFingerprint } from "./lib/gtp-mapping";
import { assertOutDirSafe, writeFileSafe, writeJsonSafe } from "./lib/out-dir";

type Row = Record<string, unknown>;

function trunc(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length > 80) return `<text len=${s.length}> ${s.slice(0, 40).replace(/\|/g, "/")}`;
  return s.replace(/\|/g, "/").replace(/\n/g, " ");
}

async function main(): Promise<number> {
  const a = parseCommand("discover", process.argv.slice(2));
  const v = loadEffectiveMapping(a, resolveMappingPath("discover", a));
  const siteId = resolveSiteFilter(a, v.mapping.source.siteFilter);
  const schema = a.get("schema") ?? v.mapping.source.schema;
  if (schema !== v.mapping.source.schema) throw new CliError("discover: --schema must equal the mapping source.schema.");
  const sample = intFlag(a, "sample", 5) as number;
  const maxSniff = intFlag(a, "max-body-sniff", 200) as number;
  const out = outDir(a);
  if (a.get("from-snapshot")) throw new CliError("discover: --from-snapshot is not supported here.");
  const reader = await openLegacy(a, v, siteId);
  if (!(reader instanceof LiveLegacyReader)) throw new CliError("discover: needs a live source.");
  const db = reader.dbHandle();
  const allow = effectiveAllowList(v.mapping.source.tableAllowList);
  const lines: string[] = [];
  const P = (s = "") => lines.push(s);

  P("# Legacy GTP schema report");
  P();
  P("Read-only discovery, site-filtered, allow-listed tables only. Other tables of the shared database exist and were deliberately not inspected.");
  P();
  P(`- Tables inspected: ${allow.length}`);
  P(`- Site filter: provided (value not printed)`);
  P();
  P("## Inventory");
  P();
  P("| table | columns | site-scoped rows | key columns | has created_at |");
  P("|---|---|---|---|---|");
  const catalog = await db.query(catalogColumns(schema, allow));
  const colsBy = new Map<string, Row[]>();
  for (const c of catalog) colsBy.set(String(c.table_name), [...(colsBy.get(String(c.table_name)) ?? []), c]);
  const counts: Record<string, number> = {};
  for (const t of allow) {
    const n = Number((await db.query(countRows(schema, t, siteId, allow)))[0]?.n ?? 0);
    counts[t] = n;
    const spec = ALLOWED_TABLES[t];
    P(`| ${t} | ${(colsBy.get(t) ?? []).length} | ${n} | ${spec.keyColumns.join(", ")} | ${spec.hasCreatedAt} |`);
  }
  P();
  P("## Columns");
  for (const t of allow) {
    P();
    P(`### ${t}`);
    P();
    P("| column | type | nullable |");
    P("|---|---|---|");
    for (const c of colsBy.get(t) ?? []) P(`| ${String(c.column_name)} | ${String(c.data_type)} | ${String(c.is_nullable)} |`);
  }
  P();
  P("## Distributions (articles, top 25)");
  const artCols = new Set((colsBy.get("articles") ?? []).map((c) => String(c.column_name)));
  const dists: Record<string, Row[]> = {};
  for (const c of ["status", "section", "subsection", "format", "label", "byline", "featured", "is_hero", "migrate_source"]) {
    if (!artCols.has(c)) continue;
    const rows = await db.query(distribution(schema, "articles", c, siteId, allow));
    dists[c] = rows;
    P();
    P(`### ${c}`);
    P();
    for (const r of rows) P(`- ${trunc(r.v) || "(empty)"}: ${String(r.n)}`);
  }
  // Slug analysis + stratified sample ids (JS over slugPlanRows; no new SQL).
  const plan = await reader.slugPlanRows();
  const slugs = plan.map((r) => (typeof r.slug === "string" ? r.slug : ""));
  const nonEmpty = slugs.filter(Boolean);
  const lower = new Map<string, number>();
  for (const s of nonEmpty) lower.set(s.toLowerCase(), (lower.get(s.toLowerCase()) ?? 0) + 1);
  P();
  P("## Slug analysis");
  P();
  P(`- rows: ${plan.length}; null/empty slugs: ${slugs.length - nonEmpty.length}`);
  P(`- duplicate slugs (exact): ${nonEmpty.length - new Set(nonEmpty).size}; case-insensitive collisions: ${[...lower.values()].filter((n) => n > 1).length}`);
  P(`- slugs with characters outside [a-z0-9-]: ${nonEmpty.filter((s) => !/^[a-z0-9][a-z0-9-]*$/.test(s)).length}; non-ASCII: ${nonEmpty.filter((s) => /[^\x00-\x7f]/.test(s)).length}; max length: ${Math.max(0, ...nonEmpty.map((s) => s.length))}`);
  const strata = new Map<string, string[]>();
  for (const r of plan) {
    const key = `${String(r.status)}|${String(r.created_at ?? "").slice(0, 4)}`;
    strata.set(key, [...(strata.get(key) ?? []), String(r.id)]);
  }
  const ids: string[] = [];
  for (let i = 0; ids.length < Math.min(maxSniff, plan.length); i++) {
    let added = false;
    for (const list of strata.values()) {
      if (list[i] !== undefined && ids.length < maxSniff) {
        ids.push(list[i] as string);
        added = true;
      }
    }
    if (!added) break;
  }
  const bodyCols = ["id", "body_sections", "featured_image"].filter((c) => artCols.has(c));
  const formats: Record<string, number> = {};
  const signals = { script: 0, iframe: 0, handler: 0, jsUrl: 0, table: 0, blockquote: 0, img: 0 };
  for (let i = 0; i < ids.length; i += 100) {
    for (const r of await db.query(sampleRows(schema, "articles", bodyCols, siteId, ids.slice(i, i + 100), allow))) {
      const raw = typeof r.body_sections === "string" ? r.body_sections : JSON.stringify(r.body_sections ?? "");
      const f = sniffBodyFormat(raw);
      formats[f] = (formats[f] ?? 0) + 1;
      if (/<script/i.test(raw)) signals.script++;
      if (/<iframe/i.test(raw)) signals.iframe++;
      if (/on\w+=/i.test(raw)) signals.handler++;
      if (/javascript:/i.test(raw)) signals.jsUrl++;
      if (/<table/i.test(raw)) signals.table++;
      if (/<blockquote/i.test(raw)) signals.blockquote++;
      if (/<img/i.test(raw)) signals.img++;
    }
  }
  P();
  P(`## Body formats (stratified sample of ${ids.length})`);
  P();
  for (const [k, n] of Object.entries(formats)) P(`- ${k}: ${n}`);
  P(`- tag-like signals (counted, text stays text in the sections path): ${JSON.stringify(signals)}`);
  // Image hosts.
  const hosts: Record<string, number> = {};
  let noImage = 0;
  for await (const page of reader.pages("articles", ["featured_image"], 500)) {
    for (const r of page) {
      const u = typeof r.featured_image === "string" ? r.featured_image : "";
      if (!u) {
        noImage++;
        continue;
      }
      let h = "(unparseable)";
      try {
        const url = new URL(u);
        h = `${url.host}${url.pathname.includes("/object/sign/") ? " (signed: expires)" : url.pathname.includes("/object/public/") ? " (storage public)" : ""}`;
      } catch {
        /* keep */
      }
      hosts[h] = (hosts[h] ?? 0) + 1;
    }
  }
  P();
  P("## Image hosts (featured_image)");
  P();
  for (const [h, n] of Object.entries(hosts)) P(`- ${h}: ${n}`);
  P(`- no image: ${noImage}`);
  // Samples (redacted, truncated; bodies never printed).
  P();
  P(`## Samples (${sample} rows per table, redacted, truncated)`);
  for (const t of allow as AllowedTable[]) {
    const cols = (colsBy.get(t) ?? []).map((c) => String(c.column_name)).filter((c) => c !== "body_sections" && c !== "body" && c !== "site_id");
    if (!cols.length) continue;
    const page = (await reader.pages(t, cols, sample).next()).value as Row[] | undefined;
    P();
    P(`### ${t}`);
    for (const r of page ?? []) P(`- ${Object.entries(redactRow(r, v.mapping.redact, { personalColumns: ALLOWED_TABLES[t].personalColumns })).map(([k, x]) => `${k}=${trunc(x)}`).join("; ")}`);
  }
  P();
  P("## Risks and open questions");
  P();
  P("- Old URL structure (OD-24) is not derivable from the DB; urls.* stay provisional until the owner supplies the sitemap.");
  P("- The SELECT-only grants of the owner-created role are the real fence; `default_transaction_read_only` is advisory.");
  writeFileSafe(path.join(out, "legacy-schema-report.md"), lines.join("\n") + "\n");
  const template = {
    ...JSON.parse(JSON.stringify(v.mapping)),
    source: { schema, tableAllowList: allow, columns: v.mapping.source.columns },
    media: { ...v.mapping.media, hostAllowlist: undefined, hostRewrite: undefined },
    urls: { ...v.mapping.urls, articlePathTemplate: "TODO: old article URL pattern (OD-24)" },
    _evidence: { counts, distributions: Object.fromEntries(Object.entries(dists).map(([k, rows]) => [k, rows.map((r) => [r.v, Number(r.n)])])), formats, imageHosts: hosts },
  };
  writeJsonSafe(path.join(out, "legacy-mapping.template.json"), template);
  writeJsonSafe(path.join(out, "query-log.json"), reader.queryLog());
  const snap = a.get("snapshot-dir");
  if (snap) {
    const dir = assertOutDirSafe(resolvePath(snap));
    const mf = await writeSnapshot(reader, dir, { tables: allow, redact: v.mapping.redact, siteId, mappingSha256: mappingFingerprint(v.mapping) });
    console.log(`[discover] snapshot written: ${Object.entries(mf.tables).map(([t, x]) => `${t}=${x.rows}`).join(", ")}`);
  }
  await reader.close();
  console.log(`[discover] report: ${path.join(out, "legacy-schema-report.md")}; articles=${counts.articles}; plan rows=${plan.length}; title sample "${enText(plan[0]?.title).slice(0, 60)}"`);
  return 0;
}

runMain("discover", main);
