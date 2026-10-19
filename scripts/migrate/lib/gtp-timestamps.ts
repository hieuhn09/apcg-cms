/**
 * Generator for the OWNER-RUN `timestamps-fix.sql` (gtp-launch P4, A13-R01,
 * E13, E14). Pure: it returns text; NO module under scripts/migrate/ passes
 * the output to a driver (the single permitted executor is the LOCAL rehearsal
 * harness `fixtures/gtp-legacy/rehearse-assert.ts` behind assertLocalDb).
 *
 * Shape: one `BEGIN;` ... `COMMIT;`; per slug one DO block that updates
 * `articles` (joined through `articles_locales` en slug, tenant subselect,
 * origin = 'import', engine_source_name = 'legacy:globaltravelpost') and the
 * latest `_articles_v` row, each guarded by "exactly one row or RAISE".
 * Slugs must match ^[a-z0-9][a-z0-9-]*$; timestamps come from Date objects.
 */
export const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const MARKER_SOURCE_NAME = "legacy:globaltravelpost";

export interface TimestampEntry {
  slug: string;
  kind?: string;
  legacyCreatedAt?: string | null;
  legacyUpdatedAt?: string | null;
}

export interface TimestampsOutput {
  sql: string;
  baseline: Record<string, string>;
  skipped: { slug: string; reason: "slugNotSqlSafe" | "timestampsNoSource" }[];
  counts: { entries: number; blocks: number; slugNotSqlSafe: number; timestampsNoSource: number };
}

function lit(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return `TIMESTAMPTZ '${d.toISOString()}'`;
}

export class TimestampsError extends Error {
  override name = "TimestampsError";
}

export function generateTimestampsFix(entries: readonly TimestampEntry[], opts: { tenantSlug: string; runId: string; markerSourceName?: string }): TimestampsOutput {
  const markerName = opts.markerSourceName ?? MARKER_SOURCE_NAME;
  if (!/^legacy:[a-z0-9.-]+$/.test(markerName)) throw new TimestampsError("timestamps: marker is not SQL-safe; refusing.");
  if (!SAFE_SLUG.test(opts.tenantSlug)) throw new TimestampsError("timestamps: tenant slug is not SQL-safe; refusing.");
  if (!/^[A-Za-z0-9_-]+$/.test(opts.runId)) throw new TimestampsError("timestamps: run id is not SQL-comment-safe; refusing.");
  const blocks: string[] = [];
  const baseline: Record<string, string> = {};
  const skipped: TimestampsOutput["skipped"] = [];
  const tenant = `(SELECT id FROM tenants WHERE slug = '${opts.tenantSlug}')`;
  const marker = `a.origin = 'import' AND a.engine_source_name = '${markerName}'`;
  for (const e of entries) {
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
    blocks.push(
      `DO $$ DECLARE n int; BEGIN ` +
        `UPDATE articles a SET ${setA} FROM articles_locales l WHERE l._parent_id = a.id AND l._locale = 'en' AND l.slug = '${s}' AND a.tenant_id = ${tenant} AND ${marker}; ` +
        `GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug ${s} expected 1 article row, got %', n; END IF; ` +
        `UPDATE _articles_v v SET ${setV} WHERE v.latest = true AND v.parent_id = (SELECT a.id FROM articles a JOIN articles_locales l ON l._parent_id = a.id AND l._locale = 'en' AND l.slug = '${s}' WHERE a.tenant_id = ${tenant} AND ${marker}); ` +
        `GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'timestamps-fix: slug ${s} expected 1 latest version row, got %', n; END IF; ` +
        `END $$;`,
    );
  }
  const counts = {
    entries: entries.length,
    blocks: blocks.length,
    slugNotSqlSafe: skipped.filter((x) => x.reason === "slugNotSqlSafe").length,
    timestampsNoSource: skipped.filter((x) => x.reason === "timestampsNoSource").length,
  };
  const header = [
    "-- timestamps-fix.sql: OWNER-RUN ONLY, never executed by tools.",
    `-- run id: ${opts.runId}; tenant: ${opts.tenantSlug}; blocks (articles expected to change): ${counts.blocks};`,
    `-- slug-map entries: ${counts.entries}; skipped slugNotSqlSafe: ${counts.slugNotSqlSafe}; skipped timestampsNoSource: ${counts.timestampsNoSource}.`,
    "-- Run it on ONE session against the DIRECT (non-pooled) URL, never through a transaction-mode pooler or a GUI client that splits statements:",
    '--   psql "<DIRECT, non-pooled URL>" -v ON_ERROR_STOP=1 -f timestamps-fix.sql',
    "-- Do NOT add -1 (the file has its own BEGIN/COMMIT). Read the counts above first.",
    "-- Any RAISE aborts the whole transaction: nothing is changed.",
  ];
  return { sql: [...header, "BEGIN;", ...blocks, "COMMIT;", ""].join("\n"), baseline, skipped, counts };
}
