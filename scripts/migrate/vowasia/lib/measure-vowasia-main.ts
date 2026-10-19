/**
 * VowAsia snapshot MEASURE (Amendment 3, B-0b; owner-run, OFFLINE).
 *
 *   npm run migrate:vowasia:measure -- --snapshot <dir> [--mapping-overlay <overlay>] [--out <dir>]
 *
 * Reads ONLY the snapshot directory (sha256 re-checked against its meta and,
 * when present, the image manifest). It never opens a database connection and
 * imports no database code. It reports, as counts and shapes only:
 *   - Q2: the shape of the jsonb `title` / `excerpt` values (keys, never text);
 *   - Q3: where URLs sit inside `body_sections` (normalised JSON path, split
 *     into allow-listed host vs other; never a host name or URL);
 *   - KB-2: the (section, subsection) cross table with the C8 verdict;
 *   - the legacy `tags` column (shape + distinct values; recorded only, Q10
 *     does not use it), statuses, missing dates, missing cover images.
 * Writes `measure-report.json` + `measure-report.md` into --out (default: the
 * snapshot directory), outside the repo, files 600.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { writeFileSafe, writeJsonSafe } from "./out-dir";
import { DEFAULT_SOURCE, resolvePath } from "./vowasia-cli";
import { loadSourceConfig } from "./vowasia-config";
import { mapTaxonomy, parseVowasiaMapping } from "./vowasia-mapping";
import { URL_IN_TEXT, nonAbsoluteRefs, refKind } from "./image-refs";
import { verifySnapshotInput } from "./snapshot-vowasia-main";

export const MEASURE_FLAGS: FlagSpec = { snapshot: "value", "mapping-overlay": "value", out: "value" };

export const MEASURE_MESSAGES = {
  needSnapshot: "measure: --snapshot <directory written by migrate:vowasia:snapshot> is required; refusing.",
} as const;

export interface MeasureDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

/** Caps on what the report prints (G22 M5): value length and number of values per block. */
export const MEASURE_LIMITS = Object.freeze({ valueChars: 60, topN: 50 });

type Counts = Record<string, number>;
/** Prototype-free map: legacy values such as `__proto__` / `constructor` are plain keys (G22 M4). */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const inc = (c: Counts, k: string, n = 1) => {
  c[k] = (Object.prototype.hasOwnProperty.call(c, k) ? (c[k] as number) : 0) + n;
};

/** Shape of a value: types and object keys only, never content. Depth-limited. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    const t = v.trim();
    if (depth < 3 && (t.startsWith("{") || t.startsWith("["))) {
      try {
        return `string(json:${shapeOf(JSON.parse(t), depth + 1)})`;
      } catch {
        /* plain string */
      }
    }
    return "string";
  }
  if (typeof v !== "object") return typeof v;
  if (depth >= 3) return Array.isArray(v) ? "array<...>" : "object{...}";
  if (Array.isArray(v)) {
    const kinds: string[] = [];
    for (const x of v) {
      const s = shapeOf(x, depth + 1);
      if (!kinds.includes(s)) kinds.push(s);
      if (kinds.length >= 6) break;
    }
    return `array<${kinds.join("|")}>`;
  }
  return `object{${Object.keys(v).sort().join(",")}}`;
}

/** Visit every string leaf with its normalised path (`[]` for indices, `(json)` when inside a JSON string). */
function walk(v: unknown, p: string, visit: (path: string, s: string) => void, depth = 0): void {
  if (depth > 40 || v === null || v === undefined) return;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && depth < 10) {
      try {
        walk(JSON.parse(t), `${p}(json)`, visit, depth + 1);
        return;
      } catch {
        /* text */
      }
    }
    visit(p, v);
    return;
  }
  if (Array.isArray(v)) for (const x of v) walk(x, `${p}[]`, visit, depth + 1);
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p === "" ? k : `${p}.${k}`, visit, depth + 1);
}

export interface MeasureReport {
  articles: number;
  status: Counts;
  title: Counts;
  excerpt: Counts;
  body: { container: Counts; elementShapes: Counts; urlPaths: Record<string, { allowlisted: number; other: number }>; articlesWithAllowlistedImage: number; relativeRefs: number; protocolRelativeRefs: number };
  pairs: Record<string, { n: number; verdict: string }>;
  tags: { shape: Counts; values: Counts };
  dates: { withoutCreatedAt: number; withoutPublishedAt: number };
  images: { featured: { missing: number; allowlisted: number; other: number; relative: number; protocolRelative: number } };
}

const KEY = (v: unknown) => (v === null || v === undefined ? "(null)" : typeof v === "string" ? v : `(${typeof v})`);

/** Pure: rows + role -> column map + allow-list predicate -> report (counts and shapes only). */
export function measureRows(rows: readonly Record<string, unknown>[], roles: Record<string, string>, isAllowed: (url: string) => boolean): MeasureReport {
  const col = (r: Record<string, unknown>, role: string) => (roles[role] ? r[roles[role] as string] : undefined);
  const rep: MeasureReport = {
    articles: rows.length,
    status: dict(),
    title: dict(),
    excerpt: dict(),
    body: { container: dict(), elementShapes: dict(), urlPaths: dict(), articlesWithAllowlistedImage: 0, relativeRefs: 0, protocolRelativeRefs: 0 },
    pairs: dict(),
    tags: { shape: dict(), values: dict() },
    dates: { withoutCreatedAt: 0, withoutPublishedAt: 0 },
    images: { featured: { missing: 0, allowlisted: 0, other: 0, relative: 0, protocolRelative: 0 } },
  };
  for (const r of rows) {
    inc(rep.status, KEY(col(r, "status")));
    inc(rep.title, shapeOf(col(r, "title")));
    inc(rep.excerpt, shapeOf(col(r, "excerpt")));
    const body = col(r, "body");
    inc(rep.body.container, shapeOf(body));
    let parsed: unknown = body;
    if (typeof body === "string") {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
    }
    if (Array.isArray(parsed)) for (const el of parsed) inc(rep.body.elementShapes, shapeOf(el, 1));
    let hasImage = false;
    walk(body, "", (p, s) => {
      for (const m of s.matchAll(URL_IN_TEXT)) {
        const slot = (rep.body.urlPaths[p || "(root)"] ??= { allowlisted: 0, other: 0 });
        if (isAllowed(m[0])) {
          slot.allowlisted++;
          hasImage = true;
        } else slot.other++;
      }
      const na = nonAbsoluteRefs(s);
      rep.body.relativeRefs += na.relative.length;
      rep.body.protocolRelativeRefs += na.protocolRelative.length;
    });
    if (hasImage) rep.body.articlesWithAllowlistedImage++;
    const sec = col(r, "section");
    const sub = col(r, "subsection");
    const pk = `${KEY(sec)}|${sub === "" ? "" : KEY(sub)}`;
    const t = mapTaxonomy(sec, sub);
    const slot = (rep.pairs[pk] ??= { n: 0, verdict: t.ok ? (t.subSection ? `${t.pillar}/${t.subSection}` : t.pillar) : `REJECT (${t.reason})` });
    slot.n++;
    const tags = col(r, "tags");
    inc(rep.tags.shape, shapeOf(tags));
    let tv: unknown = tags;
    if (typeof tags === "string") {
      try {
        tv = JSON.parse(tags);
      } catch {
        tv = tags.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }
    if (Array.isArray(tv)) for (const x of tv) inc(rep.tags.values, KEY(x));
    const c = col(r, "createdAt");
    if (c === null || c === undefined || c === "") rep.dates.withoutCreatedAt++;
    const p = col(r, "publishedAt");
    if (p === null || p === undefined || p === "") rep.dates.withoutPublishedAt++;
    const img = col(r, "image");
    if (typeof img !== "string" || img.trim() === "") rep.images.featured.missing++;
    else {
      const k = refKind(img);
      if (k === "relative") rep.images.featured.relative++;
      else if (k === "protocolRelative") rep.images.featured.protocolRelative++;
      else if (k === "absolute" && isAllowed(img.trim())) rep.images.featured.allowlisted++;
      else rep.images.featured.other++;
    }
  }
  return rep;
}

function sortedEntries(c: Counts): [string, number][] {
  return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The report as written / printed: capped values, hashed unmapped pairs, tags values only when safe (G22 M5). */
export interface PublishableReport extends Omit<MeasureReport, "tags"> {
  tags: { shape: Counts; values: Counts; valuesWithheld: boolean };
  /** Blocks whose values were shortened or cut to the top N. */
  truncated: string[];
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

function capKey(k: string): string {
  return k.length > MEASURE_LIMITS.valueChars ? `${k.slice(0, MEASURE_LIMITS.valueChars)}…` : k;
}

function capCounts(name: string, c: Counts, truncated: string[]): Counts {
  const merged = dict<number>();
  let cut = false;
  for (const [k, n] of Object.entries(c)) {
    const ck = capKey(k);
    if (ck !== k) cut = true;
    inc(merged, ck, n);
  }
  const all = sortedEntries(merged);
  if (all.length > MEASURE_LIMITS.topN) cut = true;
  if (cut) truncated.push(name);
  const out = dict<number>();
  for (const [k, n] of all.slice(0, MEASURE_LIMITS.topN)) out[k] = n;
  return out;
}

function capRecord<T>(name: string, r: Record<string, T>, weight: (v: T) => number, truncated: string[]): Record<string, T> {
  let cut = false;
  const merged = dict<T>();
  for (const [k, v] of Object.entries(r)) {
    const ck = capKey(k);
    if (ck !== k || Object.prototype.hasOwnProperty.call(merged, ck)) cut = true;
    if (!Object.prototype.hasOwnProperty.call(merged, ck)) merged[ck] = v;
  }
  const all = Object.entries(merged).sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]));
  if (all.length > MEASURE_LIMITS.topN) cut = true;
  if (cut) truncated.push(name);
  const out = dict<T>();
  for (const [k, v] of all.slice(0, MEASURE_LIMITS.topN)) out[k] = v;
  return out;
}

const SAFE_TAG_SHAPES = new Set(["array<string>", "array<>", "null"]);

export function publishableReport(rep: MeasureReport): PublishableReport {
  const truncated: string[] = [];
  const pairs = dict<{ n: number; verdict: string }>();
  for (const [k, v] of Object.entries(rep.pairs)) {
    const key = v.verdict.startsWith("REJECT") ? `unmapped:${shortHash(k)}` : k;
    const prev = pairs[key];
    pairs[key] = prev ? { n: prev.n + v.n, verdict: prev.verdict } : { n: v.n, verdict: v.verdict };
  }
  const valuesWithheld =
    !Object.keys(rep.tags.shape).every((s) => SAFE_TAG_SHAPES.has(s)) || !Object.keys(rep.tags.values).every((v) => v.length <= MEASURE_LIMITS.valueChars);
  return {
    articles: rep.articles,
    status: capCounts("status", rep.status, truncated),
    title: capCounts("title", rep.title, truncated),
    excerpt: capCounts("excerpt", rep.excerpt, truncated),
    body: {
      container: capCounts("body.container", rep.body.container, truncated),
      elementShapes: capCounts("body.elementShapes", rep.body.elementShapes, truncated),
      urlPaths: capRecord("body.urlPaths", rep.body.urlPaths, (v) => v.allowlisted + v.other, truncated),
      articlesWithAllowlistedImage: rep.body.articlesWithAllowlistedImage,
      relativeRefs: rep.body.relativeRefs,
      protocolRelativeRefs: rep.body.protocolRelativeRefs,
    },
    pairs: capRecord("pairs", pairs, (v) => v.n, truncated),
    tags: {
      shape: capCounts("tags.shape", rep.tags.shape, truncated),
      values: valuesWithheld ? dict<number>() : capCounts("tags.values", rep.tags.values, truncated),
      valuesWithheld,
    },
    dates: { ...rep.dates },
    images: { featured: { ...rep.images.featured } },
    truncated,
  };
}

const cell = (s: string) => s.replace(/[|\n\r`]/g, " ");

export function renderMeasure(rep: PublishableReport, snapshotSha256: string, hasAllowlist: boolean): string {
  const L: string[] = [];
  const P = (s = "") => L.push(s);
  P("# VowAsia snapshot measure (B-0b)");
  P();
  P(`- snapshot.ndjson sha256: ${snapshotSha256}`);
  P(`- articles: ${rep.articles}`);
  P(`- allow-list for URL classification: ${hasAllowlist ? "from overlay" : "none given (every URL counted as other)"}`);
  P("- Counts and shapes only: no title, body, URL, host or site id.");
  P(`- Values are cut to ${MEASURE_LIMITS.valueChars} characters and the top ${MEASURE_LIMITS.topN} per block; unmapped section/subsection pairs are shown as a short hash.`);
  const note = (id: string) => (rep.truncated.includes(id) ? ` (truncated: top ${MEASURE_LIMITS.topN}, values cut to ${MEASURE_LIMITS.valueChars} chars)` : "");
  const block = (title: string, c: Counts, id: string) => {
    P();
    P(`## ${title}${note(id)}`);
    P();
    for (const [k, n] of sortedEntries(c)) P(`- \`${cell(k)}\`: ${n}`);
  };
  block("status", rep.status, "status");
  block("Q2 title shape", rep.title, "title");
  block("Q2 excerpt shape", rep.excerpt, "excerpt");
  block("Q3 body_sections container shape", rep.body.container, "body.container");
  block("Q3 body_sections element shapes", rep.body.elementShapes, "body.elementShapes");
  P();
  P(`## Q3 URL positions inside body_sections (normalised path)${note("body.urlPaths")}`);
  P();
  P("| path | allow-listed | other |");
  P("|---|---|---|");
  for (const [p, v] of Object.entries(rep.body.urlPaths).sort()) P(`| ${cell(p)} | ${v.allowlisted} | ${v.other} |`);
  P();
  P(`- articles with at least one allow-listed URL in the body: ${rep.body.articlesWithAllowlistedImage}`);
  P(`- relative references in the body (counted, never fetched): ${rep.body.relativeRefs}; protocol-relative (//host/...): ${rep.body.protocolRelativeRefs}`);
  P();
  P(`## KB-2 (section | subsection) with the C8 verdict${note("pairs")}`);
  P();
  P("| section/subsection | n | C8 |");
  P("|---|---|---|");
  for (const [k, v] of Object.entries(rep.pairs).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) P(`| ${cell(k)} | ${v.n} | ${cell(v.verdict)} |`);
  block("tags column shape (recorded only; Q10 does not use it)", rep.tags.shape, "tags.shape");
  if (rep.tags.valuesWithheld) {
    P();
    P("## tags column values");
    P();
    P("- withheld: the column is not an array of short strings in every row (see the shape block).");
  } else block("tags column values", rep.tags.values, "tags.values");
  P();
  P("## Dates and cover images");
  P();
  P(`- without created-at: ${rep.dates.withoutCreatedAt}; without published-at: ${rep.dates.withoutPublishedAt}`);
  P(`- cover image: missing ${rep.images.featured.missing}, allow-listed ${rep.images.featured.allowlisted}, other ${rep.images.featured.other}, relative ${rep.images.featured.relative}, protocol-relative ${rep.images.featured.protocolRelative}`);
  return L.join("\n") + "\n";
}

export async function runMeasure(argv: readonly string[], deps: MeasureDeps): Promise<number> {
  const a = parseArgs(argv, MEASURE_FLAGS);
  const snapArg = a.get("snapshot");
  if (!snapArg) throw new CliError(MEASURE_MESSAGES.needSnapshot);
  const snap = resolvePath(snapArg);
  const outPath = resolvePath(a.get("out") ?? snap);
  // validate every input before creating anything (G22 N3)
  assertOutsideRepo(outPath, undefined, { create: false });
  const input = verifySnapshotInput(snap);
  const overlay = a.get("mapping-overlay");
  const allow = overlay ? (loadSourceConfig(DEFAULT_SOURCE, resolvePath(overlay)).media?.hostAllowlist ?? []) : [];
  const mapping = parseVowasiaMapping({ media: { hostAllowlist: allow } });
  const isAllowed = (u: string) => {
    try {
      return mapping.media.hostAllowlist.includes(new URL(u).host.toLowerCase());
    } catch {
      return false;
    }
  };
  const raw = measureRows(input.articles, input.meta.columnRoles, isAllowed);
  const rep = publishableReport(raw);
  const out = assertOutsideRepo(outPath);
  writeJsonSafe(path.join(out, "measure-report.json"), { snapshotSha256: input.snapshotSha256, ...rep });
  writeFileSafe(path.join(out, "measure-report.md"), renderMeasure(rep, input.snapshotSha256, allow.length > 0));
  deps.log(`[measure] articles=${rep.articles}; pairs=${Object.keys(raw.pairs).length} (C8 rejects: ${Object.values(raw.pairs).filter((p) => p.verdict.startsWith("REJECT")).reduce((s, p) => s + p.n, 0)}); report: ${path.join(out, "measure-report.md")}`);
  return 0;
}
