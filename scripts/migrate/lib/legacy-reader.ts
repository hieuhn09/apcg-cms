/**
 * Legacy source readers (gtp-launch P4, 6.1, A12-N08). One interface, two
 * implementations, same row shape:
 *   - LiveLegacyReader: the closed builders of ./legacy-sql over a read-only
 *     connection (short BEGIN READ ONLY batches);
 *   - SnapshotLegacyReader: the tool-written snapshot (`<table>.ndjson` +
 *     `manifest.json`) produced by `writeSnapshot()` from the SAME builders.
 * Rows are normalised (Date -> ISO) so both paths give identical results.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ALLOWED_TABLES, CURSOR_TS, EPOCH, LegacyReadOnlyDb, catalogColumns, cursorOf, keysetPage, setCatalog, siteAuthorsRows, siteRow, slugPlanRows, type AllowedTable, type TableSpec } from "./legacy-sql";
import { redactRow } from "./gtp-exports";
import { writeFileSafe, writeJsonSafe } from "./out-dir";
import { readNdjson } from "./run-dir";
import { sortKey } from "./slug-plan";

type Row = Record<string, unknown>;

export interface LegacyReader {
  readonly kind: "live" | "snapshot";
  siteRow(): Promise<Row | undefined>;
  slugPlanRows(): Promise<Row[]>;
  /** Pages of a table in keyset order. */
  pages(table: AllowedTable, columns: string[] | "all", pageSize: number): AsyncGenerator<Row[]>;
  siteAuthors(): Promise<Row[]>;
  columns(table: AllowedTable): string[];
  queryLog(): { id: string; text: string }[];
  close(): Promise<void>;
}

export const READER_MESSAGES = {
  siteMissing: "legacy: the site row for the site filter was not found; refusing.",
  siteNotGtp: "legacy: the site filter does not point at the site with slug gtp; refusing (another site must never be read).",
  snapshotMissing: "legacy: --from-snapshot directory has no manifest.json; refusing.",
  snapshotSite: "legacy: the snapshot was taken for a different site filter; refusing.",
  noProgress: "legacy: keyset paging did not advance (same cursor twice); refusing to loop or re-read rows.",
} as const;

export class LiveLegacyReader implements LegacyReader {
  readonly kind = "live" as const;
  private catalog = new Map<string, Set<string>>();
  private constructor(private readonly db: LegacyReadOnlyDb, private readonly schema: string, private readonly siteId: string, private readonly allow: AllowedTable[]) {}

  static async open(url: string, ssl: false | { rejectUnauthorized: boolean; ca?: string }, schema: string, siteId: string, allow: AllowedTable[]): Promise<LiveLegacyReader> {
    const db = new LegacyReadOnlyDb(() => new pg.Client({ connectionString: url, ssl: ssl === false ? false : ssl, application_name: "gtp-legacy-migrate" }) as never);
    const r = new LiveLegacyReader(db, schema, siteId, allow);
    const rows = await db.query(catalogColumns(schema, allow));
    for (const c of rows) {
      const t = String(c.table_name);
      if (!r.catalog.has(t)) r.catalog.set(t, new Set());
      r.catalog.get(t)?.add(String(c.column_name));
    }
    setCatalog(r.catalog);
    return r;
  }
  catalogRows(): Map<string, Set<string>> {
    return this.catalog;
  }
  columns(table: AllowedTable): string[] {
    return [...(this.catalog.get(table) ?? [])];
  }
  queryLog() {
    return this.db.log;
  }
  dbHandle(): LegacyReadOnlyDb {
    return this.db;
  }
  async siteRow(): Promise<Row | undefined> {
    return (await this.db.query(siteRow(this.schema, this.siteId, this.allow)))[0];
  }
  async slugPlanRows(): Promise<Row[]> {
    return this.db.query(slugPlanRows(this.schema, this.siteId, this.allow));
  }
  async siteAuthors(): Promise<Row[]> {
    return this.db.query(siteAuthorsRows(this.schema, this.siteId, this.allow));
  }
  async *pages(table: AllowedTable, columns: string[] | "all", pageSize: number): AsyncGenerator<Row[]> {
    const spec: TableSpec = ALLOWED_TABLES[table];
    const known = this.columns(table);
    let cols = columns === "all" ? known : columns.filter((c) => known.includes(c));
    for (const k of [...spec.keyColumns, ...(spec.hasCreatedAt ? ["created_at"] : [])]) if (!cols.includes(k) && known.includes(k)) cols = [...cols, k];
    if (!known.length) return;
    let cursor: unknown[] | null = null;
    for (;;) {
      const rows = await this.db.query(keysetPage(this.schema, table, cols, this.siteId, cursor, pageSize, this.allow));
      if (!rows.length) return;
      const next = cursorOf(table, rows[rows.length - 1] as Row);
      // Amendment 5 guard: a full page whose cursor does not advance would loop or re-read forever.
      if (cursor !== null && JSON.stringify(next) === JSON.stringify(cursor)) throw new Error(READER_MESSAGES.noProgress);
      for (const r of rows) delete r[CURSOR_TS];
      yield rows;
      if (rows.length < pageSize) return;
      cursor = next;
    }
  }
  async close(): Promise<void> {
    setCatalog(undefined);
  }
}

export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  siteIdSha256: string;
  mappingSha256: string;
  tables: Record<string, { rows: number; columns: string[] }>;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class SnapshotLegacyReader implements LegacyReader {
  readonly kind = "snapshot" as const;
  private constructor(private readonly dir: string, private readonly manifest: SnapshotManifest) {}
  static open(dir: string, siteId: string): SnapshotLegacyReader {
    const mf = path.join(dir, "manifest.json");
    if (!existsSync(mf)) throw new Error(READER_MESSAGES.snapshotMissing);
    const manifest = JSON.parse(readFileSync(mf, "utf8")) as SnapshotManifest;
    if (manifest.siteIdSha256 !== sha256(siteId.toLowerCase())) throw new Error(READER_MESSAGES.snapshotSite);
    return new SnapshotLegacyReader(dir, manifest);
  }
  private rows(table: AllowedTable): Row[] {
    return readNdjson<Row>(path.join(this.dir, `${table}.ndjson`));
  }
  columns(table: AllowedTable): string[] {
    return this.manifest.tables[table]?.columns ?? [];
  }
  queryLog() {
    return [];
  }
  async siteRow(): Promise<Row | undefined> {
    const r = this.rows("sites")[0];
    return r ? { id: r.id, slug: r.slug, name: r.name } : undefined;
  }
  async slugPlanRows(): Promise<Row[]> {
    return this.rows("articles")
      .map((r) => ({ id: r.id, created_at: r.created_at, status: r.status, slug: r.slug, title: r.title, section: r.section, subsection: r.subsection }))
      .sort((a, b) => (sortKey(a.created_at, a.id) < sortKey(b.created_at, b.id) ? -1 : 1));
  }
  async siteAuthors(): Promise<Row[]> {
    return this.rows("site_authors").map((r) => ({ slug: r.slug, name: r.name, bio: r.bio, beats: r.beats }));
  }
  async *pages(table: AllowedTable, columns: string[] | "all", pageSize: number): AsyncGenerator<Row[]> {
    const spec: TableSpec = ALLOWED_TABLES[table];
    const key = (r: Row) => [...(spec.hasCreatedAt ? [String(r.created_at ?? EPOCH)] : []), ...spec.keyColumns.map((k) => String(r[k]))].join("\u0000");
    const all = this.rows(table).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    for (let i = 0; i < all.length; i += pageSize) {
      const page = all.slice(i, i + pageSize);
      yield columns === "all" ? page : page.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => columns.includes(k) || spec.keyColumns.includes(k) || k === "created_at")));
    }
  }
  async close(): Promise<void> {}
}

/** Write the snapshot (allow-listed, site-filtered, redacted) from a LIVE reader. */
export async function writeSnapshot(reader: LiveLegacyReader, dir: string, opts: { tables: AllowedTable[]; redact: readonly string[]; siteId: string; mappingSha256: string }): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = { version: 1, createdAt: new Date().toISOString(), siteIdSha256: sha256(opts.siteId.toLowerCase()), mappingSha256: opts.mappingSha256, tables: {} };
  for (const t of opts.tables) {
    const lines: string[] = [];
    const spec: TableSpec = ALLOWED_TABLES[t];
    for await (const page of reader.pages(t, "all", 500)) {
      for (const row of page) lines.push(JSON.stringify(redactRow(row, opts.redact, { personalColumns: spec.personalColumns })));
    }
    writeFileSafe(path.join(dir, `${t}.ndjson`), lines.join("\n") + (lines.length ? "\n" : ""));
    manifest.tables[t] = { rows: lines.length, columns: reader.columns(t) };
  }
  writeJsonSafe(path.join(dir, "manifest.json"), manifest);
  return manifest;
}

/** Common: verify the site row is the gtp site (E19). */
export async function assertGtpSite(reader: LegacyReader): Promise<Row> {
  const s = await reader.siteRow();
  if (!s) throw new Error(READER_MESSAGES.siteMissing);
  if (String(s.slug) !== "gtp") throw new Error(READER_MESSAGES.siteNotGtp);
  return s;
}
