/**
 * Live reader of the VowAsia legacy source (phase A, read-only). Wraps the
 * closed builders of ./vowasia-sql over short `BEGIN READ ONLY` batches.
 *
 * Keyset hardening (vs the GTP reader):
 *   - rows are de-duplicated by key (a key already seen is skipped and counted);
 *   - the cursor is the DB-rendered created-at text (microseconds kept);
 *   - a FULL page that brings no new key, or a cursor equal to the previous
 *     one, throws `legacy: keyset cursor did not advance; refusing.` (no "less than"
 *     comparison on timestamptz text: ordering is the database's ORDER BY);
 *   - the helper column `__cursor_ts` is stripped from every row returned.
 */
import pg from "pg";
import { LEGACY_SITE_SLUG } from "./vowasia-constants";
import {
  CURSOR_COLUMN, VowasiaReadOnlyDb, catalogColumns, catalogTables, cursorOf, keysetPage, setCatalog, siteRow, slugPlanRows,
  type MinimalPgClient, type SqlRegistry, type TableSpec,
} from "./vowasia-sql";

type Row = Record<string, unknown>;

export const READER_MESSAGES = {
  siteMissing: "legacy: the site row for the site filter was not found; refusing.",
  siteAmbiguous: "legacy: the site filter matches more than one site row; refusing.",
  siteNotVowasia: "legacy: the site filter does not point at the site with the expected vowasia slug; refusing (another site must never be read).",
  cursorStuck: "legacy: keyset cursor did not advance; refusing.",
} as const;

export class VowasiaReaderError extends Error {
  override name = "VowasiaReaderError";
}

function keyOf(t: TableSpec, r: Row): string {
  return JSON.stringify(t.keyColumns.map((k) => (r[k] === null || r[k] === undefined ? null : String(r[k]))));
}

function sameCursor(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => String(v) === String(b[i]));
}

export class LiveVowasiaReader {
  /** Rows skipped because their key was already returned. */
  duplicatesSkipped = 0;
  private catalog = new Map<string, Set<string>>();
  private tableTypes = new Map<string, string>();

  constructor(
    readonly db: VowasiaReadOnlyDb,
    private readonly siteId: string,
  ) {}

  get registry(): SqlRegistry {
    return this.db.registry;
  }

  /** Open a live reader (the URL comes from the environment only, never argv). */
  static open(url: string, ssl: false | { rejectUnauthorized: boolean; ca?: string }, reg: SqlRegistry, siteId: string): LiveVowasiaReader {
    const db = new VowasiaReadOnlyDb(reg, () => new pg.Client({ connectionString: url, ssl, application_name: "vowasia-legacy-migrate" }) as unknown as MinimalPgClient);
    return new LiveVowasiaReader(db, siteId);
  }

  /** Read the catalog of the configured tables only and register it with the SQL registry. */
  async loadCatalog(): Promise<{ tables: Map<string, string>; columns: Map<string, Map<string, { type: string; nullable: string }>> }> {
    const [tables, cols] = await this.db.batch([catalogTables(this.registry), catalogColumns(this.registry)]);
    const detail = new Map<string, Map<string, { type: string; nullable: string }>>();
    for (const r of tables ?? []) this.tableTypes.set(String(r.table_name), String(r.table_type));
    for (const c of cols ?? []) {
      const t = String(c.table_name);
      if (!this.catalog.has(t)) this.catalog.set(t, new Set());
      this.catalog.get(t)?.add(String(c.column_name));
      if (!detail.has(t)) detail.set(t, new Map());
      detail.get(t)?.set(String(c.column_name), { type: String(c.data_type), nullable: String(c.is_nullable) });
    }
    setCatalog(this.registry, this.catalog);
    return { tables: this.tableTypes, columns: detail };
  }

  /** Known columns of a logical table (empty before loadCatalog or when the table is absent). */
  columns(logical: string): string[] {
    const t = this.registry.tables[logical];
    return t ? [...(this.catalog.get(t.name) ?? [])] : [];
  }

  async siteRows(): Promise<Row[]> {
    return this.db.query(siteRow(this.registry, this.siteId));
  }

  async slugPlanRows(columns: string[]): Promise<Row[]> {
    return this.db.query(slugPlanRows(this.registry, columns, this.siteId));
  }

  /** Pages of a table in keyset order; de-duplicated; refuses a cursor that does not advance. */
  async *pages(logical: string, columns: string[], pageSize: number): AsyncGenerator<Row[]> {
    const t = this.registry.tables[logical];
    if (!t) return;
    const known = this.catalog.get(t.name);
    let cols = known ? columns.filter((c) => known.has(c)) : [...columns];
    for (const k of t.keyColumns) if (!cols.includes(k)) cols = [...cols, k];
    const seen = new Set<string>();
    let cursor: unknown[] | null = null;
    for (;;) {
      const rows = await this.db.query(keysetPage(this.registry, logical, cols, this.siteId, cursor, pageSize));
      if (!rows.length) return;
      const fresh: Row[] = [];
      for (const r of rows) {
        const k = keyOf(t, r);
        if (seen.has(k)) {
          this.duplicatesSkipped++;
          continue;
        }
        seen.add(k);
        const { [CURSOR_COLUMN]: _drop, ...rest } = r;
        void _drop;
        fresh.push(rest);
      }
      if (!fresh.length) {
        // A short page is the source's own "end of data"; only a FULL page with no new key could loop forever.
        if (rows.length < pageSize) return;
        throw new VowasiaReaderError(READER_MESSAGES.cursorStuck);
      }
      const next = cursorOf(this.registry, logical, rows[rows.length - 1] as Row);
      if (cursor !== null && sameCursor(next, cursor)) throw new VowasiaReaderError(READER_MESSAGES.cursorStuck);
      yield fresh;
      if (rows.length < pageSize) return;
      cursor = next;
    }
  }

  close(): void {
    setCatalog(this.registry, undefined);
  }
}

/** The site filter must resolve to exactly one site row whose slug is the expected vowasia slug. */
export async function assertVowasiaSite(reader: Pick<LiveVowasiaReader, "siteRows" | "registry">, expectedSlug: string = LEGACY_SITE_SLUG): Promise<Row> {
  const rows = await reader.siteRows();
  if (rows.length === 0) throw new VowasiaReaderError(READER_MESSAGES.siteMissing);
  if (rows.length > 1) throw new VowasiaReaderError(READER_MESSAGES.siteAmbiguous);
  const slugCol = reader.registry.tables.sites?.slugColumn ?? "slug";
  const row = rows[0] as Row;
  if (String(row[slugCol]) !== expectedSlug) throw new VowasiaReaderError(READER_MESSAGES.siteNotVowasia);
  return row;
}
