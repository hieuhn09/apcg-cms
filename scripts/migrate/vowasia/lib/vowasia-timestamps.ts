/**
 * Generator for the OWNER-RUN `timestamps-fix.sql` of ONE VowAsia import run
 * (Amendment 4, B-10; Q11). A COPY of the GTP generator with the VowAsia marker
 * and tenant, plus the run scope: every block also requires `a.id = <id>` of an
 * article journaled by THIS run, so the file can never touch a row of another
 * run, another tenant, or a non-imported article. Pure: it returns text; no
 * tool executes it (the local rehearsal is the only executor, on a local DB).
 */
import { MARKER_ORIGIN, MARKER_SOURCE_NAME, TENANT_SLUG } from "./vowasia-constants";

export const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface VowasiaTimestampEntry {
  slug: string;
  articleId: number | string;
  legacyCreatedAt: string | null;
  legacyUpdatedAt: string | null;
}

export class VowasiaTimestampsError extends Error {
  override name = "VowasiaTimestampsError";
}

function lit(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? `TIMESTAMPTZ '${d.toISOString()}'` : null;
}

export function generateVowasiaTimestampsFix(entries: readonly VowasiaTimestampEntry[], opts: { runId: string }): {
  sql: string;
  baseline: Record<string, string>;
  skipped: { slug: string; reason: "slugNotSqlSafe" | "timestampsNoSource" }[];
  counts: { entries: number; blocks: number; skipped: number };
} {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(opts.runId)) throw new VowasiaTimestampsError("timestamps: run id is not SQL-comment-safe; refusing.");
  const tenant = `(SELECT id FROM tenants WHERE slug = '${TENANT_SLUG}')`;
  const marker = `a.origin = '${MARKER_ORIGIN}' AND a.engine_source_name = '${MARKER_SOURCE_NAME}'`;
  const blocks: string[] = [];
  const baseline: Record<string, string> = {};
  const skipped: { slug: string; reason: "slugNotSqlSafe" | "timestampsNoSource" }[] = [];
  for (const e of entries) {
    const id = String(e.articleId);
    if (!/^[0-9]{1,18}$/.test(id)) throw new VowasiaTimestampsError("timestamps: article id is not an integer; refusing.");
    if (!SAFE_SLUG.test(e.slug)) {
      skipped.push({ slug: e.slug, reason: "slugNotSqlSafe" });
      continue;
    }
    const c = lit(e.legacyCreatedAt);
    const u = lit(e.legacyUpdatedAt);
    if (!c && !u) {
      skipped.push({ slug: e.slug, reason: "timestampsNoSource" });
      continue;
    }
    const setA = [c ? `created_at = ${c}` : null, u ? `updated_at = ${u}` : null].filter(Boolean).join(", ");
    const setV = [c ? `version_created_at = ${c}` : null, u ? `version_updated_at = ${u}` : null, u ? `updated_at = ${u}` : null].filter(Boolean).join(", ");
    if (u) baseline[e.slug] = new Date(e.legacyUpdatedAt as string).toISOString();
    const s = e.slug;
    const where = `a.id = ${id} AND l._parent_id = a.id AND l._locale = 'en' AND l.slug = '${s}' AND a.tenant_id = ${tenant} AND ${marker}`;
    blocks.push(
      `DO $$ DECLARE n int; BEGIN ` +
        `UPDATE articles a SET ${setA} FROM articles_locales l WHERE ${where}; ` +
        `GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug ${s} (id ${id}) expected 1 article row, got %', n; END IF; ` +
        `UPDATE _articles_v v SET ${setV} WHERE v.latest = true AND v.parent_id = (SELECT a.id FROM articles a JOIN articles_locales l ON ${where}); ` +
        `GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug ${s} (id ${id}) expected 1 latest version row, got %', n; END IF; ` +
        `END $$;`,
    );
  }
  const counts = { entries: entries.length, blocks: blocks.length, skipped: skipped.length };
  const header = [
    "-- timestamps-fix.sql: OWNER-RUN ONLY, never executed by tools.",
    `-- run id: ${opts.runId}; tenant: ${TENANT_SLUG}; marker: ${MARKER_SOURCE_NAME}; blocks (articles expected to change): ${counts.blocks};`,
    `-- journaled articles of this run: ${counts.entries}; skipped (unsafe slug or no legacy timestamps): ${counts.skipped}.`,
    "-- Every block is limited to ONE article id created by THIS run (Q11).",
    "-- Run it on ONE session against the DIRECT (non-pooled) URL:",
    '--   psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix.sql',
    "-- Do NOT add -1 (the file has its own BEGIN/COMMIT). Any RAISE aborts the whole transaction: nothing is changed.",
  ];
  return { sql: [...header, "BEGIN;", ...blocks, "COMMIT;", ""].join("\n"), baseline, skipped, counts };
}
