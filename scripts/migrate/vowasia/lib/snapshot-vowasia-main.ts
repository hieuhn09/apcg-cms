/**
 * VowAsia legacy SNAPSHOT (Amendment 3, B-0; owner-run, two steps of ONE sitting).
 *
 * Step 1, read (needs the temporary read-only role and LEGACY_VOWASIA_DB_URL):
 *   npm run migrate:vowasia:snapshot -- --mapping-overlay <overlay> --out <dir outside the repo>
 *   - loads the catalog of the configured views, REFUSES before reading any
 *     row when a required column role is unmapped or its column is missing
 *     (the reader silently drops unknown columns, so this check is ours, E-B2);
 *   - verifies the site filter points at exactly the vowasia site row;
 *   - reads the 15 article columns (key, site column, 13 roles) through the
 *     closed SELECT builders, in keyset order, and the site row (id/slug/name);
 *   - writes `snapshot.ndjson` (one JSON line per row: {"t":"site"|"article","row":{...}}),
 *     `snapshot-meta.json` (sha256 of snapshot.ndjson, counts, role -> column)
 *     and `query-log.json` (builder id + SQL text, never params); prints the
 *     snapshot digest. Then the owner removes the role (sql/03e).
 *
 * Step 2, images (NO database):
 *   npm run migrate:vowasia:snapshot -- --download-images --snapshot <dir> --mapping-overlay <overlay> [--rehearsal]
 *   - re-checks the snapshot digest; collects every URL on an allow-listed host
 *     found in ANY string of ANY captured column (also inside JSON strings and
 *     HTML; U2); counts image-like URLs on other hosts (never fetched);
 *   - fetches with the hardened GTP fetch (https only, allow-list re-checked on
 *     every redirect hop, 20 MB cap, magic bytes, SVG refused);
 *   - stores each image as `images/<sha256 of content>` (never a path built
 *     from a URL; U16b) and writes `manifest.json` (url -> sha256, bytes, mime;
 *     failures; the sha256 of snapshot.ndjson, U23); prints the manifest
 *     digest (the value for the importer's `--expect-sha256`).
 *   - `media.hostRewrite` (local fixture host) is refused unless `--rehearsal`
 *     is passed AND every target is local (U16c, E-B4). Never read from env.
 *
 * Everything is written OUTSIDE the repo (`assertOutsideRepo`, dirs 700,
 * files 600). Stdout carries counts and digests only: never a site id, URL,
 * host, title or body.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fetchImageWithRetry, sniffMime, type FetchLike } from "../../lib/media-fetch";
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { URL_IN_TEXT, nonAbsoluteRefs } from "./image-refs";
import { writeFileSafe, writeJsonSafe } from "./out-dir";
import { DEFAULT_SOURCE, resolvePath } from "./vowasia-cli";
import { loadSourceConfig, type ColumnRole, type SourceConfig } from "./vowasia-config";
import { LEGACY_URL_ENV } from "./vowasia-constants";
import { legacyBanner, legacySsl, sslLabel } from "./vowasia-db-banner";
import { parseVowasiaMapping, isAllowedMediaUrl } from "./vowasia-mapping";
import { LiveVowasiaReader, assertVowasiaSite } from "./vowasia-reader";
import { countRows, createSqlRegistry, type SqlRegistry } from "./vowasia-sql";

export const SNAPSHOT_FLAGS: FlagSpec = {
  "mapping-overlay": "value",
  out: "value",
  "download-images": "bool",
  snapshot: "value",
  rehearsal: "bool",
};

export const SNAPSHOT_MESSAGES = {
  needOverlay: "snapshot: --mapping-overlay <file outside the repo> is required; refusing.",
  needOut: "snapshot: --out <directory outside the repo> is required for the read step; refusing.",
  needSnapshot: "snapshot: --download-images needs --snapshot <directory written by the read step>; refusing.",
  snapshotOnlyDownload: "snapshot: --snapshot is only used with --download-images; refusing.",
  outOnlyRead: "snapshot: --out is only used by the read step (images go to <snapshot>/images); refusing.",
  rehearsalOnlyDownload: "snapshot: --rehearsal only applies to --download-images; refusing.",
  noSiteFilter: "snapshot: no site filter (set source.siteFilter in the overlay outside the repo); refusing.",
  missingColumn: "snapshot: a required column role is not mapped or its column is not in the view catalog; fix the overlay (or the view) and run again; refusing before reading any row.",
  exists: "snapshot: this directory already holds a snapshot; use a new --out directory (a snapshot is never overwritten); refusing.",
  noSnapshot: "snapshot: snapshot.ndjson or snapshot-meta.json is missing in --snapshot; refusing.",
  badMeta: "snapshot: snapshot-meta.json is not a valid VowAsia snapshot meta; refusing.",
  snapshotDigest: "snapshot: sha256 of snapshot.ndjson does not match snapshot-meta.json (file changed after the read step); refusing.",
  noManifest: "snapshot: manifest.json is missing (run --download-images first); refusing.",
  badManifest: "snapshot: manifest.json is not a valid VowAsia image manifest; refusing.",
  manifestExists: "snapshot: manifest.json already exists in this snapshot; images are downloaded once (remove manifest.json and images/ yourself to retry); refusing.",
  manifestSnapshotMismatch: "snapshot: snapshot.ndjson sha256 differs from the value recorded in manifest.json; refusing.",
  manifestDigest: "snapshot: sha256 of manifest.json does not match --expect-sha256; refusing.",
  imageDigest: "snapshot: an image file in the store is missing, changed, too large or not an image (sha256/magic bytes); refusing.",
  countChanged: "snapshot: the number of article rows changed during the read (count before, rows read and count after differ); nothing was written; run the snapshot again when the old site is quiet; refusing.",
  storeCorrupt: "snapshot: a file already in images/ does not match the sha256 in its name (a corrupt or truncated earlier download); remove that file yourself and run --download-images again; refusing.",
  storeForeign: "snapshot: images/ holds a file that is neither a stored image (<sha256>) nor a leftover temp file of a crashed run; images/ is for this tool only, move that file away; refusing.",
  noAllowlist: "snapshot: media.hostAllowlist is empty in the overlay; nothing may be downloaded; refusing.",
  badAllowlist: "snapshot: media.hostAllowlist must hold host names only; refusing.",
  rewriteNeedsRehearsal: "snapshot: media.hostRewrite is set but --rehearsal was not passed; a rewrite would fetch from another host than the one recorded; refusing.",
  rewriteNotLocal: "snapshot: media.hostRewrite targets must be localhost, 127.0.0.1 or ::1 (rehearsal fixture only); refusing.",
} as const;

export class SnapshotError extends CliError {
  override name = "SnapshotError";
}

/** Column roles every snapshot must capture (Amendment 3, B-0 U1; with id + site column = 15 columns). */
export const SNAPSHOT_REQUIRED_ROLES: readonly ColumnRole[] = Object.freeze([
  "createdAt", "publishedAt", "status", "section", "subsection", "slug", "title", "excerpt", "body", "image", "imageCredit", "tags", "updatedAt",
] as const);

export const SNAPSHOT_FORMAT = "vowasia-snapshot/1";
export const MANIFEST_FORMAT = "vowasia-image-manifest/1";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|svg|bmp|tiff?|heic)(\?|#|$)/i;
/** Temp file of an interrupted download (`<sha256>.tmp-<pid>-<index>`): the only kind of file a new run deletes. */
const TMP_LEFTOVER = /^[0-9a-f]{64}\.tmp-\d+-\d+$/;
const LOCAL_TARGET = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d{1,5})?$/i;

export interface SnapshotMeta {
  format: typeof SNAPSHOT_FORMAT;
  takenAt: string;
  snapshotSha256: string;
  counts: { articles: number; sites: number };
  /** count(*) of the site's article rows right before and right after the paged read (equal, and equal to counts.articles). */
  rowCounts: { before: number; after: number };
  columnRoles: Record<string, string>;
  articleColumns: string[];
}

export interface ManifestEntry {
  url: string;
  sha256: string;
  bytes: number;
  mime: string;
}

export interface ImageManifest {
  format: typeof MANIFEST_FORMAT;
  createdAt: string;
  snapshotSha256: string;
  entries: ManifestEntry[];
  failures: { url: string; reason: string }[];
  offAllowlistImageUrls: number;
  /** Distinct root-relative image references (`/x.jpg`): counted, never fetched. */
  relativeImageRefs: number;
  /** Distinct protocol-relative references (`//host/x.jpg`): counted, never fetched. */
  protocolRelativeImageRefs: number;
}

export interface SnapshotDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Reader factory (tests inject a fake client). Default: LiveVowasiaReader.open. */
  openReader?: (url: string, ssl: false | { rejectUnauthorized: boolean; ca?: string }, reg: SqlRegistry, siteId: string) => LiveVowasiaReader;
  fetchImpl?: FetchLike;
  retries?: number;
  concurrency?: number;
}

export function sha256Hex(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/** The 15 article columns (key columns, site column, the 13 required roles) in a fixed order; throws when a role is unmapped. */
export function snapshotColumns(cfg: SourceConfig): { columns: string[]; roles: Record<string, string> } {
  const t = cfg.source.tables.articles;
  const roles: Record<string, string> = {};
  for (const r of SNAPSHOT_REQUIRED_ROLES) {
    const c = cfg.source.columnRoles[r];
    if (c === undefined) throw new SnapshotError(SNAPSHOT_MESSAGES.missingColumn);
    roles[r] = c;
  }
  const columns = [...new Set([...t.keyColumns, t.siteColumn, ...Object.values(roles)])];
  return { columns, roles };
}

/* ── Image URL collection (U2) ─────────────────────────────────────────── */

function walkStrings(v: unknown, visit: (s: string) => void, depth = 0): void {
  if (depth > 40) return;
  if (typeof v === "string") {
    visit(v);
    const t = v.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length < 5_000_000) {
      try {
        walkStrings(JSON.parse(t), visit, depth + 1);
      } catch {
        /* not JSON: already scanned as text */
      }
    }
    return;
  }
  if (Array.isArray(v)) for (const x of v) walkStrings(x, visit, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walkStrings(x, visit, depth + 1);
}

/**
 * Every distinct URL on an allow-listed host found anywhere in the rows (first-seen order), the count of
 * image-like URLs elsewhere, and the distinct relative / protocol-relative references (counted, never fetched).
 */
export function collectImageUrls(
  rows: readonly Record<string, unknown>[],
  isAllowedHost: (url: string) => boolean,
): { urls: string[]; offAllowlistImageUrls: number; relativeImageRefs: number; protocolRelativeImageRefs: number } {
  const urls: string[] = [];
  const seen = new Set<string>();
  const off = new Set<string>();
  const rel = new Set<string>();
  const proto = new Set<string>();
  for (const row of rows) {
    walkStrings(row, (s) => {
      const na = nonAbsoluteRefs(s);
      for (const r of na.relative) rel.add(r);
      for (const r of na.protocolRelative) proto.add(r);
      for (const m of s.matchAll(URL_IN_TEXT)) {
        const raw = m[0].replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&");
        if (!URL.canParse(raw)) continue;
        if (isAllowedHost(raw)) {
          if (!seen.has(raw)) {
            seen.add(raw);
            urls.push(raw);
          }
        } else if (IMAGE_EXT.test(raw)) off.add(raw);
      }
    });
  }
  return { urls, offAllowlistImageUrls: off.size, relativeImageRefs: rel.size, protocolRelativeImageRefs: proto.size };
}

/* ── Snapshot input verification (used by measure and, in B-β, import) ── */

function readJsonFile(file: string, msg: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new SnapshotError(msg);
  }
}

function parseMeta(raw: unknown): SnapshotMeta {
  const m = raw as Partial<SnapshotMeta>;
  if (!m || m.format !== SNAPSHOT_FORMAT || typeof m.snapshotSha256 !== "string" || !HEX64.test(m.snapshotSha256) || typeof m.columnRoles !== "object" || m.columnRoles === null) {
    throw new SnapshotError(SNAPSHOT_MESSAGES.badMeta);
  }
  return m as SnapshotMeta;
}

function parseManifest(raw: unknown): ImageManifest {
  const m = raw as Partial<ImageManifest>;
  const okEntry = (e: unknown) => {
    const x = e as ManifestEntry;
    return !!x && typeof x.url === "string" && typeof x.sha256 === "string" && HEX64.test(x.sha256) && Number.isInteger(x.bytes) && x.bytes > 0 && typeof x.mime === "string";
  };
  if (!m || m.format !== MANIFEST_FORMAT || typeof m.snapshotSha256 !== "string" || !Array.isArray(m.entries) || !m.entries.every(okEntry) || !Array.isArray(m.failures)) {
    throw new SnapshotError(SNAPSHOT_MESSAGES.badManifest);
  }
  return m as ImageManifest;
}

export interface SnapshotInput {
  snapshotSha256: string;
  meta: SnapshotMeta;
  sites: Record<string, unknown>[];
  articles: Record<string, unknown>[];
  manifest?: ImageManifest;
  manifestSha256?: string;
}

/**
 * Verify a snapshot directory and load it. Always: sha256(snapshot.ndjson) == meta.
 * When a manifest exists (or is required): manifest.snapshotSha256 == that digest (U23);
 * `expectManifestSha256` must equal sha256(manifest.json); `checkImages` re-hashes and
 * re-sniffs every store file (size cap, magic bytes).
 */
export function verifySnapshotInput(dir: string, o: { expectManifestSha256?: string; requireManifest?: boolean; checkImages?: boolean } = {}): SnapshotInput {
  const snapFile = path.join(dir, "snapshot.ndjson");
  const metaFile = path.join(dir, "snapshot-meta.json");
  if (!existsSync(snapFile) || !existsSync(metaFile)) throw new SnapshotError(SNAPSHOT_MESSAGES.noSnapshot);
  const bytes = readFileSync(snapFile);
  const digest = sha256Hex(bytes);
  const meta = parseMeta(readJsonFile(metaFile, SNAPSHOT_MESSAGES.badMeta));
  if (meta.snapshotSha256 !== digest) throw new SnapshotError(SNAPSHOT_MESSAGES.snapshotDigest);
  const manifestFile = path.join(dir, "manifest.json");
  const needManifest = o.requireManifest || o.expectManifestSha256 !== undefined || o.checkImages;
  let manifest: ImageManifest | undefined;
  let manifestSha256: string | undefined;
  if (existsSync(manifestFile)) {
    const raw = readFileSync(manifestFile);
    manifestSha256 = sha256Hex(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new SnapshotError(SNAPSHOT_MESSAGES.badManifest);
    }
    manifest = parseManifest(parsed);
    if (manifest.snapshotSha256 !== digest) throw new SnapshotError(SNAPSHOT_MESSAGES.manifestSnapshotMismatch);
  } else if (needManifest) throw new SnapshotError(SNAPSHOT_MESSAGES.noManifest);
  if (o.expectManifestSha256 !== undefined && o.expectManifestSha256.toLowerCase() !== manifestSha256) throw new SnapshotError(SNAPSHOT_MESSAGES.manifestDigest);
  if (o.checkImages && manifest) {
    for (const e of manifest.entries) {
      const f = path.join(dir, "images", e.sha256);
      if (!existsSync(f)) throw new SnapshotError(SNAPSHOT_MESSAGES.imageDigest);
      const b = readFileSync(f);
      if (b.length > MAX_IMAGE_BYTES || b.length !== e.bytes || sha256Hex(b) !== e.sha256 || sniffMime(b) !== e.mime) throw new SnapshotError(SNAPSHOT_MESSAGES.imageDigest);
    }
  }
  const sites: Record<string, unknown>[] = [];
  const articles: Record<string, unknown>[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: { t?: unknown; row?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      throw new SnapshotError(SNAPSHOT_MESSAGES.badMeta);
    }
    if (!rec.row || typeof rec.row !== "object") throw new SnapshotError(SNAPSHOT_MESSAGES.badMeta);
    if (rec.t === "site") sites.push(rec.row as Record<string, unknown>);
    else if (rec.t === "article") articles.push(rec.row as Record<string, unknown>);
    else throw new SnapshotError(SNAPSHOT_MESSAGES.badMeta);
  }
  if (articles.length !== meta.counts?.articles || sites.length !== meta.counts?.sites) throw new SnapshotError(SNAPSHOT_MESSAGES.badMeta);
  return { snapshotSha256: digest, meta, sites, articles, ...(manifest ? { manifest, manifestSha256 } : {}) };
}

/* ── Step 1: read ──────────────────────────────────────────────────────── */

async function readStep(cfg: SourceConfig, outArg: string, deps: SnapshotDeps): Promise<number> {
  if (cfg.source.siteFilter === undefined) throw new SnapshotError(SNAPSHOT_MESSAGES.noSiteFilter);
  const { columns, roles } = snapshotColumns(cfg);
  // check only: --out is created after the read succeeded (G22 N3)
  const out = assertOutsideRepo(resolvePath(outArg), undefined, { create: false });
  if (existsSync(path.join(out, "snapshot.ndjson")) || existsSync(path.join(out, "snapshot-meta.json"))) throw new SnapshotError(SNAPSHOT_MESSAGES.exists);
  const url = deps.env[LEGACY_URL_ENV];
  const b = legacyBanner(url);
  const ssl = legacySsl(deps.env, b.local);
  deps.log(`[snapshot] legacy source: ${b.banner} (${sslLabel(ssl)}; read-only, site-filtered)`);
  const reg = createSqlRegistry(cfg);
  const open = deps.openReader ?? ((u, s, r, site) => LiveVowasiaReader.open(u, s, r, site));
  const reader = open(url as string, ssl, reg, cfg.source.siteFilter);
  try {
    await reader.loadCatalog();
    const have = new Set(reader.columns("articles"));
    if (!columns.every((c) => have.has(c))) throw new SnapshotError(SNAPSHOT_MESSAGES.missingColumn);
    const sitesSpec = reg.tables.sites;
    const siteHave = new Set(reader.columns("sites"));
    if (!sitesSpec || ![sitesSpec.siteColumn, sitesSpec.slugColumn, sitesSpec.nameColumn].every((c) => c !== undefined && siteHave.has(c))) {
      throw new SnapshotError(SNAPSHOT_MESSAGES.missingColumn);
    }
    const site = await assertVowasiaSite(reader, cfg.source.expectedSiteSlug);
    const countNow = async (): Promise<number> => {
      const rows = await reader.db.query(countRows(reg, "articles", cfg.source.siteFilter as string));
      const v = Number(rows[0]?.n);
      if (!Number.isSafeInteger(v) || v < 0) throw new SnapshotError(SNAPSHOT_MESSAGES.countChanged);
      return v;
    };
    const before = await countNow();
    const lines: string[] = [JSON.stringify({ t: "site", row: site })];
    let n = 0;
    for await (const page of reader.pages("articles", columns, 500)) {
      for (const row of page) {
        const ordered = Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
        lines.push(JSON.stringify({ t: "article", row: ordered }));
        n++;
      }
    }
    const after = await countNow();
    // a row inserted / deleted while paging would make the snapshot silently incomplete (G22 M8)
    if (before !== after || n !== before) throw new SnapshotError(SNAPSHOT_MESSAGES.countChanged);
    const body = lines.join("\n") + "\n";
    const digest = sha256Hex(body);
    assertOutsideRepo(out);
    if (existsSync(path.join(out, "snapshot.ndjson")) || existsSync(path.join(out, "snapshot-meta.json"))) throw new SnapshotError(SNAPSHOT_MESSAGES.exists);
    writeFileSafe(path.join(out, "snapshot.ndjson"), body);
    const meta: SnapshotMeta = {
      format: SNAPSHOT_FORMAT,
      takenAt: new Date().toISOString(),
      snapshotSha256: digest,
      counts: { articles: n, sites: 1 },
      rowCounts: { before, after },
      columnRoles: roles,
      articleColumns: columns,
    };
    writeJsonSafe(path.join(out, "snapshot-meta.json"), meta);
    writeJsonSafe(path.join(out, "query-log.json"), reader.db.log);
    deps.log(`[snapshot] articles=${n}${reader.duplicatesSkipped ? ` (duplicate keys skipped: ${reader.duplicatesSkipped})` : ""}; files: snapshot.ndjson, snapshot-meta.json, query-log.json`);
    deps.log(`[snapshot] snapshot.ndjson sha256: ${digest}`);
    deps.log("[snapshot] next: remove the role now (sql/03e), then run the image step with --download-images --snapshot <this dir> (no database needed).");
    return 0;
  } finally {
    reader.close();
  }
}

/* ── Step 2: images ────────────────────────────────────────────────────── */

export function assertHostRewriteAllowed(rewrite: Readonly<Record<string, string>> | undefined, rehearsal: boolean): Record<string, string> {
  const r = rewrite ?? {};
  if (Object.keys(r).length === 0) return {};
  if (!rehearsal) throw new SnapshotError(SNAPSHOT_MESSAGES.rewriteNeedsRehearsal);
  if (!Object.values(r).every((t) => LOCAL_TARGET.test(t))) throw new SnapshotError(SNAPSHOT_MESSAGES.rewriteNotLocal);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
}

async function downloadStep(cfg: SourceConfig, snapArg: string, rehearsal: boolean, deps: SnapshotDeps): Promise<number> {
  const allowRaw = cfg.media?.hostAllowlist ?? [];
  if (allowRaw.length === 0) throw new SnapshotError(SNAPSHOT_MESSAGES.noAllowlist);
  let mapping;
  try {
    mapping = parseVowasiaMapping({ media: { hostAllowlist: allowRaw } });
  } catch {
    throw new SnapshotError(SNAPSHOT_MESSAGES.badAllowlist);
  }
  const rewrite = assertHostRewriteAllowed(cfg.media?.hostRewrite, rehearsal);
  // check only: a missing --snapshot directory is never created (G22 N3)
  const dir = assertOutsideRepo(resolvePath(snapArg), undefined, { create: false });
  if (existsSync(path.join(dir, "manifest.json"))) throw new SnapshotError(SNAPSHOT_MESSAGES.manifestExists);
  const input = verifySnapshotInput(dir);
  const store = assertOutsideRepo(path.join(dir, "images"));
  // G22 M7: before any download, delete ONLY leftover temp files of a crashed run; anything else unexpected stops the run
  let leftovers = 0;
  for (const f of readdirSync(store)) {
    if (HEX64.test(f)) continue;
    if (!TMP_LEFTOVER.test(f)) throw new SnapshotError(SNAPSHOT_MESSAGES.storeForeign);
    unlinkSync(path.join(store, f));
    leftovers++;
  }
  if (leftovers) deps.log(`[snapshot] removed ${leftovers} leftover temp file(s) of an interrupted earlier run`);
  const { urls, offAllowlistImageUrls, relativeImageRefs, protocolRelativeImageRefs } = collectImageUrls(input.articles, (u) => {
    try {
      return mapping.media.hostAllowlist.includes(new URL(u).host.toLowerCase());
    } catch {
      return false;
    }
  });
  const entries: ManifestEntry[] = [];
  const failures: { url: string; reason: string }[] = [];
  let next = 0;
  let fatal: Error | null = null;
  const worker = async () => {
    for (;;) {
      if (fatal) return;
      const i = next++;
      if (i >= urls.length) return;
      const u = urls[i] as string;
      if (!isAllowedMediaUrl(mapping, u)) {
        failures.push({ url: u, reason: "hostNotAllowed" });
        continue;
      }
      const r = await fetchImageWithRetry(u, {
        allow: mapping.media.hostAllowlist,
        rewrite,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 60_000,
        retries: deps.retries ?? 3,
        baseDelayMs: 500,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (!r.ok) {
        failures.push({ url: u, reason: r.reason });
        continue;
      }
      const h = sha256Hex(r.bytes);
      const file = path.join(store, h);
      if (existsSync(file)) {
        // re-hash before reuse: a stored file must still be exactly the content its name claims (G22 M7)
        if (sha256Hex(readFileSync(file)) !== h) {
          fatal ??= new SnapshotError(SNAPSHOT_MESSAGES.storeCorrupt);
          return;
        }
      } else {
        const tmp = `${file}.tmp-${process.pid}-${i}`;
        writeFileSync(tmp, r.bytes, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      }
      entries.push({ url: u, sha256: h, bytes: r.bytes.length, mime: r.mime });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 4, 8)) }, worker));
  if (fatal) throw fatal;
  // only content-named files may remain in the store
  for (const f of readdirSync(store)) if (!HEX64.test(f)) throw new SnapshotError(SNAPSHOT_MESSAGES.storeForeign);
  const order = new Map(urls.map((u, i) => [u, i]));
  entries.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
  failures.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
  const manifest: ImageManifest = { format: MANIFEST_FORMAT, createdAt: new Date().toISOString(), snapshotSha256: input.snapshotSha256, entries, failures, offAllowlistImageUrls, relativeImageRefs, protocolRelativeImageRefs };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSafe(path.join(dir, "manifest.json"), text);
  const byReason: Record<string, number> = {};
  for (const f of failures) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
  const pct = urls.length ? ((failures.length / urls.length) * 100).toFixed(1) : "0.0";
  deps.log(`[snapshot] images: urls=${urls.length} ok=${entries.length} files=${new Set(entries.map((e) => e.sha256)).size} failed=${failures.length} (${pct}%); off-allow-list image URLs (not fetched): ${offAllowlistImageUrls}; relative refs (not fetched): ${relativeImageRefs}; protocol-relative refs (not fetched): ${protocolRelativeImageRefs}`);
  if (failures.length) deps.log(`[snapshot] failures by reason: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  deps.log(`[snapshot] manifest.json sha256 (record it; the importer's --expect-sha256): ${sha256Hex(text)}`);
  return 0;
}

/** Entry point of `migrate:vowasia:snapshot` (pure of process.*: deps carry env and output). */
export async function runSnapshot(argv: readonly string[], deps: SnapshotDeps): Promise<number> {
  const a = parseArgs(argv, SNAPSHOT_FLAGS);
  const download = a.has("download-images");
  const overlay = a.get("mapping-overlay");
  if (download) {
    if (a.has("out")) throw new SnapshotError(SNAPSHOT_MESSAGES.outOnlyRead);
    if (!a.get("snapshot")) throw new SnapshotError(SNAPSHOT_MESSAGES.needSnapshot);
  } else {
    if (a.has("snapshot")) throw new SnapshotError(SNAPSHOT_MESSAGES.snapshotOnlyDownload);
    if (a.has("rehearsal")) throw new SnapshotError(SNAPSHOT_MESSAGES.rehearsalOnlyDownload);
  }
  if (!overlay) throw new SnapshotError(SNAPSHOT_MESSAGES.needOverlay);
  if (!download && !a.get("out")) throw new SnapshotError(SNAPSHOT_MESSAGES.needOut);
  const cfg = loadSourceConfig(DEFAULT_SOURCE, resolvePath(overlay), { requireSiteFilter: !download });
  return download ? downloadStep(cfg, a.get("snapshot") as string, a.has("rehearsal"), deps) : readStep(cfg, a.get("out") as string, deps);
}
