/**
 * Exports of the side datasets (gtp-launch P4, A3, A11-S22, A13-R07). Pure
 * builders; the CLI `export-gtp-legacy.ts` writes them (mode 600, git-ignored
 * out dir). Nothing here is imported into Central.
 */
import { canonicalSourceUrl, enText, str } from "./gtp-transform";
import { sortKey } from "./slug-plan";

/** Anchored whole-token redaction: column split by `_` and camelCase; pattern tokens must appear contiguously. */
export function columnTokens(col: string): string[] {
  return col
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\W]+/)
    .filter(Boolean);
}

export const NEVER_LIFT = ["password", "passwd", "token", "secret"];

export function matchesRedact(col: string, patterns: readonly string[]): boolean {
  const toks = columnTokens(col);
  return patterns.some((p) => {
    const pt = columnTokens(p);
    for (let i = 0; i + pt.length <= toks.length; i++) if (pt.every((t, j) => toks[i + j] === t)) return true;
    return false;
  });
}

export function isRedacted(col: string, patterns: readonly string[], opts: { personalColumns?: readonly string[]; includeContact?: boolean } = {}): boolean {
  if (!matchesRedact(col, patterns) && !(opts.personalColumns ?? []).includes(col)) return false;
  if (matchesRedact(col, NEVER_LIFT)) return true;
  if (opts.includeContact && (opts.personalColumns ?? []).includes(col)) return false;
  return true;
}

export function redactRow(row: Record<string, unknown>, patterns: readonly string[], opts: { personalColumns?: readonly string[]; includeContact?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = isRedacted(k, patterns, opts) ? "<redacted>" : v;
  return out;
}

export interface SourceUrlLine {
  source_url: string;
  title: string;
  published_at: string | null;
}

/** One line per unique (exact) source_url, all statuses, first by (created_at, id). */
export function legacySourceUrls(rows: readonly Record<string, unknown>[]): { lines: SourceUrlLine[]; collisions: { source_url: string; legacyIds: string[] }[] } {
  const ordered = [...rows].sort((a, b) => (sortKey(a.created_at, a.id) < sortKey(b.created_at, b.id) ? -1 : 1));
  const seen = new Map<string, SourceUrlLine>();
  const byCanon = new Map<string, string[]>();
  for (const r of ordered) {
    const u = str(r.source_url);
    if (!u) continue;
    const canon = canonicalSourceUrl(u);
    byCanon.set(canon, [...(byCanon.get(canon) ?? []), String(r.id)]);
    if (seen.has(u)) continue;
    seen.set(u, { source_url: u, title: enText(r.title), published_at: r.published_at ? new Date(String(r.published_at)).toISOString() : null });
  }
  const collisions = [...byCanon.entries()].filter(([, ids]) => ids.length > 1).map(([source_url, legacyIds]) => ({ source_url, legacyIds }));
  return { lines: [...seen.values()], collisions };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function subscribersCsv(rows: readonly Record<string, unknown>[]): string {
  const cols = ["email", "newsletter", "source", "created_at"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
