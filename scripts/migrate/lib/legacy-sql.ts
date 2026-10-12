/**
 * The ONLY SQL surface of the GTP legacy migration tools (gtp-launch P4,
 * A11-S07, A12-N03, A13-R08). The legacy database is a SHARED multi-site
 * network DB that also holds unrelated sensitive tables, so SQL is safe by
 * construction, not by denylist:
 *
 *  1. Closed builders. Every statement is produced by one of the builder
 *     functions below and returned as an opaque, branded `SafeQuery`. A table
 *     must be a key of `ALLOWED_TABLES` (9 tables); a column must match
 *     `^[a-z_][a-z0-9_]*$` and, when a catalog is supplied, exist in it. Every
 *     data read goes through `scoped(table)`, a derived table that already
 *     carries the site predicate `"<siteColumn>" = $1`.
 *  2. `assertSafeQuery(q)` is a second line: it re-renders the registered
 *     template from `q.id` + `q.args` and requires the exact same text, and a
 *     small lexer refuses comments, `;`, string literals, dollar quoting,
 *     backslashes, non-ASCII, write/DDL keywords, non-allow-listed relations,
 *     comma joins, JOIN/LATERAL and any function outside FUNCTION_ALLOW.
 *  3. `LegacyReadOnlyDb.query()` accepts only branded SafeQuery objects that
 *     pass `assertSafeQuery`; each batch is a short `BEGIN READ ONLY ... COMMIT`
 *     on a fresh connection (A11-S08).
 *
 * The real sensitive table names never appear in this repo (A11-S16); the
 * tests use neutral decoys `secret_table_a..d`.
 */

/* ── Per-table spec (A12-N03; facts from the program digest section 12.1) ── */

export interface TableSpec {
  /** Column that carries the site id; for `sites` it is the primary key `id`. */
  siteColumn: string;
  /** Stable ordering key (after `created_at` when `hasCreatedAt`). */
  keyColumns: readonly string[];
  hasCreatedAt: boolean;
  /** Personal-data columns (A13-R07), redacted in snapshots unless explicitly lifted. */
  personalColumns: readonly string[];
}

export const ALLOWED_TABLES = {
  articles: { siteColumn: "site_id", keyColumns: ["id"], hasCreatedAt: true, personalColumns: [] },
  sites: { siteColumn: "id", keyColumns: ["id"], hasCreatedAt: false, personalColumns: [] },
  site_authors: { siteColumn: "site_id", keyColumns: ["slug"], hasCreatedAt: false, personalColumns: [] },
  media_assets: { siteColumn: "site_id", keyColumns: ["storage_path"], hasCreatedAt: false, personalColumns: [] },
  scraping_sources: { siteColumn: "site_id", keyColumns: ["feed_url"], hasCreatedAt: false, personalColumns: [] },
  gtp_subscribers: { siteColumn: "site_id", keyColumns: ["email"], hasCreatedAt: true, personalColumns: ["email"] },
  visa_rules: { siteColumn: "site_id", keyColumns: ["country_code"], hasCreatedAt: true, personalColumns: [] },
  events: { siteColumn: "site_id", keyColumns: ["id"], hasCreatedAt: false, personalColumns: [] },
  press_submissions: {
    siteColumn: "site_id",
    keyColumns: ["contact_email", "title"],
    hasCreatedAt: true,
    personalColumns: ["contact_name", "contact_email"],
  },
} as const satisfies Record<string, TableSpec>;

export type AllowedTable = keyof typeof ALLOWED_TABLES;
export const ALLOWED_TABLE_NAMES = Object.keys(ALLOWED_TABLES) as AllowedTable[];

export const SQL_MESSAGES = {
  refused: "legacy-sql guard: statement refused (not a site-scoped read built by a closed builder on an allow-listed table).",
  notAllowedTable: "legacy-sql guard: table is not allow-listed; refusing.",
  badIdentifier: "legacy-sql guard: invalid or unknown identifier; refusing.",
  noCreatedAt: "legacy-sql guard: this table has no created_at; keyset ordering by created_at refused.",
  allowListForeign: "mapping: source.tableAllowList names a table outside the code allow-list.",
  allowListEmpty: "mapping: source.tableAllowList is empty.",
  notBranded: "legacy-sql guard: only SafeQuery objects issued by a builder may reach the driver.",
} as const;

export class LegacySqlError extends Error {
  override name = "LegacySqlError";
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The mapping list may only NARROW the code constant (A13-R08). */
export function effectiveAllowList(mappingList: readonly string[] | undefined): AllowedTable[] {
  if (mappingList === undefined) return [...ALLOWED_TABLE_NAMES];
  if (mappingList.length === 0) throw new LegacySqlError(SQL_MESSAGES.allowListEmpty);
  for (const t of mappingList) if (!(t in ALLOWED_TABLES)) throw new LegacySqlError(SQL_MESSAGES.allowListForeign);
  return ALLOWED_TABLE_NAMES.filter((t) => mappingList.includes(t));
}

/* ── SafeQuery ──────────────────────────────────────────────────────────── */

export type BuilderId =
  | "catalogTables"
  | "catalogColumns"
  | "countRows"
  | "distribution"
  | "keysetPage"
  | "sampleRows"
  | "slugPlanRows"
  | "siteRow"
  | "siteAuthorsRows";

export interface BuilderArgs {
  schema: string;
  table?: string;
  columns?: string[];
  column?: string;
  /** keysetPage: whether a cursor is present (adds the WHERE row comparison). */
  withCursor?: boolean;
  /** Narrowed allow list (must be a subset of ALLOWED_TABLES). */
  allow?: string[];
}

export interface SafeQuery {
  readonly id: BuilderId;
  readonly text: string;
  readonly params: readonly unknown[];
  readonly args: Readonly<BuilderArgs>;
}

const issued = new WeakSet<object>();
/** Optional catalog (table -> known columns) used to validate column identifiers. */
let catalog: Map<string, Set<string>> | undefined;
export function setCatalog(c: Map<string, Set<string>> | undefined): void {
  catalog = c;
}

function q(name: string): string {
  if (!IDENT.test(name)) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
  return `"${name}"`;
}

function checkAllow(table: string | undefined, allow: string[] | undefined): AllowedTable {
  if (typeof table !== "string" || !(table in ALLOWED_TABLES)) throw new LegacySqlError(SQL_MESSAGES.notAllowedTable);
  if (allow !== undefined) {
    for (const a of allow) if (!(a in ALLOWED_TABLES)) throw new LegacySqlError(SQL_MESSAGES.notAllowedTable);
    if (!allow.includes(table)) throw new LegacySqlError(SQL_MESSAGES.notAllowedTable);
  }
  return table as AllowedTable;
}

function col(table: AllowedTable, name: string): string {
  if (!IDENT.test(name)) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
  const known = catalog?.get(table);
  if (known && !known.has(name)) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
  return q(name);
}

function scoped(schema: string, table: AllowedTable): string {
  const spec: TableSpec = ALLOWED_TABLES[table];
  return `(SELECT * FROM ${q(schema)}.${q(table)} WHERE ${q(spec.siteColumn)} = $1) AS t`;
}

function orderExprs(table: AllowedTable, epochParam: string): string[] {
  const spec: TableSpec = ALLOWED_TABLES[table];
  const keys = spec.keyColumns.map((k) => q(k));
  return spec.hasCreatedAt ? [`coalesce(${q("created_at")}, ${epochParam}::timestamptz)`, ...keys] : keys;
}

/** Pure template renderer: (id, args) -> text. Throws on anything invalid. */
function render(id: BuilderId, a: BuilderArgs): string {
  const schema = a.schema;
  if (!IDENT.test(schema)) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
  switch (id) {
    case "catalogTables":
      return "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name";
    case "catalogColumns":
      return "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position";
    case "countRows": {
      const t = checkAllow(a.table, a.allow);
      return `SELECT count(*) AS n FROM ${scoped(schema, t)}`;
    }
    case "distribution": {
      const t = checkAllow(a.table, a.allow);
      const c = col(t, a.column ?? "");
      return `SELECT ${c} AS v, count(*) AS n FROM ${scoped(schema, t)} GROUP BY ${c} ORDER BY count(*) DESC, ${c} LIMIT 25`;
    }
    case "keysetPage": {
      const t = checkAllow(a.table, a.allow);
      const spec: TableSpec = ALLOWED_TABLES[t];
      const cols = (a.columns ?? []).map((c) => col(t, c));
      if (!cols.length) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
      // $1 site, [$2 epoch when hasCreatedAt], then cursor values, last = limit
      const first = spec.hasCreatedAt ? 3 : 2;
      const ord = orderExprs(t, "$2");
      const n = ord.length;
      const cursor = a.withCursor
        ? ` WHERE (${ord.join(", ")}) > (${ord.map((_, i) => (spec.hasCreatedAt && i === 0 ? `$${first + i}::timestamptz` : `$${first + i}`)).join(", ")})`
        : "";
      const limitParam = a.withCursor ? `$${first + n}` : `$${first}`;
      return `SELECT ${cols.join(", ")} FROM ${scoped(schema, t)}${cursor} ORDER BY ${ord.join(", ")} LIMIT ${limitParam}`;
    }
    case "sampleRows": {
      const t = checkAllow(a.table, a.allow);
      const spec: TableSpec = ALLOWED_TABLES[t];
      const cols = (a.columns ?? []).map((c) => col(t, c));
      if (!cols.length) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
      const k = q(spec.keyColumns[0] as string);
      return `SELECT ${cols.join(", ")} FROM ${scoped(schema, t)} WHERE ${k}::text = ANY($2::text[]) ORDER BY ${k}`;
    }
    case "slugPlanRows": {
      const t = checkAllow("articles", a.allow);
      const cols = ["id", "created_at", "status", "slug", "title", "section", "subsection"].map((c) => col(t, c));
      return `SELECT ${cols.join(", ")} FROM ${scoped(schema, t)} ORDER BY ${orderExprs(t, "$2").join(", ")}`;
    }
    case "siteRow": {
      const t = checkAllow("sites", a.allow);
      return `SELECT ${["id", "slug", "name"].map((c) => col(t, c)).join(", ")} FROM ${scoped(schema, t)}`;
    }
    case "siteAuthorsRows": {
      const t = checkAllow("site_authors", a.allow);
      return `SELECT ${["slug", "name", "bio", "beats"].map((c) => col(t, c)).join(", ")} FROM ${scoped(schema, t)} ORDER BY ${q("slug")}`;
    }
    default:
      throw new LegacySqlError(SQL_MESSAGES.refused);
  }
}

function issue(id: BuilderId, args: BuilderArgs, params: unknown[]): SafeQuery {
  const text = render(id, args);
  const sq: SafeQuery = Object.freeze({ id, text, params: Object.freeze([...params]), args: Object.freeze({ ...args }) });
  issued.add(sq);
  assertSafeQuery(sq);
  return sq;
}

/* ── Builders (the only exports that produce SQL) ──────────────────────── */

export const EPOCH = "1970-01-01T00:00:00.000Z";

export function catalogTables(schema: string, allow: readonly string[]): SafeQuery {
  const list = effectiveAllowList(allow);
  return issue("catalogTables", { schema }, [schema, list]);
}
export function catalogColumns(schema: string, allow: readonly string[]): SafeQuery {
  const list = effectiveAllowList(allow);
  return issue("catalogColumns", { schema }, [schema, list]);
}
export function countRows(schema: string, table: string, siteId: string, allow?: string[]): SafeQuery {
  return issue("countRows", { schema, table, allow }, [siteId]);
}
export function distribution(schema: string, table: string, column: string, siteId: string, allow?: string[]): SafeQuery {
  return issue("distribution", { schema, table, column, allow }, [siteId]);
}
/** Keyset page; `cursor` = values of the order expressions of the last row (created_at first when present). */
export function keysetPage(
  schema: string,
  table: string,
  columns: string[],
  siteId: string,
  cursor: readonly unknown[] | null,
  limit: number,
  allow?: string[],
): SafeQuery {
  const t = checkAllow(table, allow);
  const spec: TableSpec = ALLOWED_TABLES[t];
  const n = spec.keyColumns.length + (spec.hasCreatedAt ? 1 : 0);
  if (cursor && cursor.length !== n) throw new LegacySqlError(SQL_MESSAGES.badIdentifier);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new LegacySqlError(SQL_MESSAGES.refused);
  const params: unknown[] = [siteId, ...(spec.hasCreatedAt ? [EPOCH] : []), ...(cursor ?? []), limit];
  return issue("keysetPage", { schema, table, columns, withCursor: cursor !== null, allow }, params);
}
/** Keyset ordering BY created_at on a table without it is refused (A12-N03). */
export function assertCreatedAtOrdering(table: string): void {
  const t = checkAllow(table, undefined);
  if (!(ALLOWED_TABLES[t] as TableSpec).hasCreatedAt) throw new LegacySqlError(SQL_MESSAGES.noCreatedAt);
}
export function sampleRows(schema: string, table: string, columns: string[], siteId: string, ids: string[], allow?: string[]): SafeQuery {
  return issue("sampleRows", { schema, table, columns, allow }, [siteId, ids.map(String)]);
}
export function slugPlanRows(schema: string, siteId: string, allow?: string[]): SafeQuery {
  return issue("slugPlanRows", { schema, allow }, [siteId, EPOCH]);
}
export function siteRow(schema: string, siteId: string, allow?: string[]): SafeQuery {
  return issue("siteRow", { schema, allow }, [siteId]);
}
export function siteAuthorsRows(schema: string, siteId: string, allow?: string[]): SafeQuery {
  return issue("siteAuthorsRows", { schema, allow }, [siteId]);
}

/** Cursor values for the last row of a keyset page. */
export function cursorOf(table: string, row: Record<string, unknown>): unknown[] {
  const t = checkAllow(table, undefined);
  const spec: TableSpec = ALLOWED_TABLES[t];
  const vals = spec.keyColumns.map((k) => row[k]);
  if (!spec.hasCreatedAt) return vals;
  const c = row.created_at;
  const iso = c instanceof Date ? c.toISOString() : typeof c === "string" && c ? c : EPOCH;
  return [iso, ...vals];
}

/* ── Second line: lexer + template check ───────────────────────────────── */

type Tok = { k: "id" | "qid" | "num" | "param" | "op"; v: string };

const KEYWORD_DENY = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "grant", "revoke", "truncate", "copy", "do", "with",
  "into", "table", "values", "lateral", "join", "union", "intersect", "except", "call", "execute", "set", "reset",
  "listen", "notify", "vacuum", "analyze", "lock", "cursor", "fetch", "prepare", "deallocate", "begin", "commit",
  "rollback", "savepoint", "or", "returning", "merge", "comment", "security", "load", "import", "show", "explain",
]);
export const FUNCTION_ALLOW = new Set([
  "count", "min", "max", "coalesce", "lower", "btrim", "length", "left", "jsonb_typeof", "jsonb_array_length",
  "array_length", "cardinality", "unnest",
]);
const KEYWORD_PAREN_OK = new Set(["any", "from", "in", "where", "and", "by", "select", "as"]);

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const refuse = (): never => {
    throw new LegacySqlError(SQL_MESSAGES.refused);
  };
  while (i < text.length) {
    const ch = text[i] as string;
    const code = ch.charCodeAt(0);
    if (code > 0x7e || (code < 0x20 && ch !== "\n" && ch !== "\t" && ch !== "\r")) refuse();
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") refuse();
    if (ch === "/" && text[i + 1] === "*") refuse();
    if (ch === ";" || ch === "'" || ch === "\\" || ch === "`") refuse();
    if (ch === "$") {
      const m = /^\$(\d+)/.exec(text.slice(i));
      if (!m) refuse();
      toks.push({ k: "param", v: (m as RegExpExecArray)[0] });
      i += (m as RegExpExecArray)[0].length;
      continue;
    }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) refuse();
      const inner = text.slice(i + 1, end);
      if (!IDENT.test(inner)) refuse();
      toks.push({ k: "qid", v: inner });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i)) as RegExpExecArray;
      const word = m[0];
      // E'' / U&'' / B'' prefixed strings
      if (text[i + word.length] === "'" || text[i + word.length] === "&") refuse();
      toks.push({ k: "id", v: word.toLowerCase() });
      i += word.length;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+/.exec(text.slice(i)) as RegExpExecArray;
      toks.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === ":" && text[i + 1] === ":") {
      toks.push({ k: "op", v: "::" });
      i += 2;
      continue;
    }
    if ("(),.*=<>[]".includes(ch)) {
      toks.push({ k: "op", v: ch });
      i++;
      continue;
    }
    refuse();
  }
  return toks;
}

function relationAllowed(schema: string | null, name: string, cfgSchema: string): boolean {
  if (schema === "information_schema") return name === "columns" || name === "tables";
  if (schema !== null && schema !== cfgSchema) return false;
  return name in ALLOWED_TABLES;
}

/** Throws LegacySqlError unless `sq` is an issued, template-exact, lexically clean read. */
export function assertSafeQuery(sq: SafeQuery): void {
  const refuse = (): never => {
    throw new LegacySqlError(SQL_MESSAGES.refused);
  };
  if (typeof sq !== "object" || sq === null || typeof sq.text !== "string" || typeof sq.id !== "string") refuse();
  // (a) template: re-render from id + args and require the exact same text.
  let expected: string;
  try {
    expected = render(sq.id, (sq.args ?? {}) as BuilderArgs);
  } catch {
    return refuse();
  }
  if (expected !== sq.text) refuse();
  // (b) lexer checks.
  assertLexicallySafe(sq.text, (sq.args as BuilderArgs).schema);
  // (c) scoped builders: $1 is the site uuid and the site predicate is in the template.
  if (sq.id !== "catalogTables" && sq.id !== "catalogColumns") {
    if (typeof sq.params[0] !== "string" || !UUID.test(sq.params[0] as string)) refuse();
    if (!/ WHERE "[a-z_][a-z0-9_]*" = \$1\) AS t/.test(sq.text)) refuse();
  } else {
    const list = sq.params[1];
    if (!Array.isArray(list) || list.length === 0 || list.some((x) => typeof x !== "string" || !(x in ALLOWED_TABLES))) refuse();
  }
}

/** Lexical second line, usable on any text (tests run the adversarial corpus through it too). */
export function assertLexicallySafe(text: string, cfgSchema = "public"): void {
  const refuse = (): never => {
    throw new LegacySqlError(SQL_MESSAGES.refused);
  };
  const toks = lex(text);
  if (toks[0]?.v !== "select") refuse();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (t.k === "id" && KEYWORD_DENY.has(t.v)) refuse();
    if ((t.k === "id" || t.k === "qid") && next?.k === "op" && next.v === "(" && prev?.v !== ".") {
      if (t.k === "qid") refuse();
      if (!FUNCTION_ALLOW.has(t.v) && !KEYWORD_PAREN_OK.has(t.v)) refuse();
    }
    if (t.k === "op" && t.v === "*") {
      const countStar = prev?.v === "(" && toks[i - 2]?.v === "count" && next?.v === ")";
      const selectStar = prev?.v === "select" && next?.v === "from";
      if (!countStar && !selectStar) refuse();
    }
    if (t.k === "id" && t.v === "from") {
      const r = toks[i + 1];
      if (!r) refuse();
      if ((r as Tok).k === "op" && (r as Tok).v === "(") continue; // derived table; its body is scanned too
      if ((r as Tok).k !== "id" && (r as Tok).k !== "qid") refuse();
      let schema: string | null = null;
      let name = (r as Tok).v;
      let j = i + 2;
      if (toks[j]?.v === ".") {
        schema = name;
        const n2 = toks[j + 1];
        if (!n2 || (n2.k !== "id" && n2.k !== "qid")) refuse();
        name = (n2 as Tok).v;
        j += 2;
      }
      if (!relationAllowed(schema, name, cfgSchema)) refuse();
      if (schema === "information_schema" && !/table_name = ANY\(\$2::text\[\]\)/.test(text)) refuse();
      if (toks[j]?.v === "as") j += 2;
      else if (toks[j]?.k === "id" && !["where", "order", "group", "limit"].includes((toks[j] as Tok).v)) j += 1;
      if (toks[j]?.v === ",") refuse();
    }
  }
}

/* ── Read-only driver wrapper (A11-S08) ───────────────────────────────── */

export interface MinimalPgClient {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
}

const RECONNECT_CODES = new Set(["57P01", "08003", "08006", "25P03", "57P05"]);

export interface QueryLogEntry {
  id: string;
  text: string;
}

/** Normalise driver values so live rows equal snapshot rows (Date -> ISO). */
export function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

export class LegacyReadOnlyDb {
  readonly log: QueryLogEntry[] = [];
  /** Event order for the S-08 test: "BEGIN" | "COMMIT" | "QUERY". */
  readonly events: string[] = [];
  constructor(
    private readonly makeClient: () => MinimalPgClient,
    private readonly opts: { retries?: number; backoffMs?: number; onEvent?: (e: string) => void } = {},
  ) {}

  private ev(e: string): void {
    this.events.push(e);
    this.opts.onEvent?.(e);
  }

  /** Run a group of SafeQueries in ONE short read-only transaction on a fresh connection. */
  async batch(queries: SafeQuery[]): Promise<Record<string, unknown>[][]> {
    for (const sq of queries) {
      if (!issued.has(sq)) throw new LegacySqlError(SQL_MESSAGES.notBranded);
      assertSafeQuery(sq);
    }
    const retries = this.opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const client = this.makeClient();
      try {
        await client.connect();
        try {
          await client.query("SET default_transaction_read_only = on"); // advisory; SELECT-only grants are the fence
        } catch {
          /* transaction-mode pooler may refuse session SET */
        }
        this.ev("BEGIN");
        await client.query("BEGIN READ ONLY");
        try {
          await client.query("SET LOCAL statement_timeout = '30s'");
        } catch {
          /* pooler may refuse; BEGIN READ ONLY is the fallback */
        }
        const out: Record<string, unknown>[][] = [];
        for (const sq of queries) {
          this.ev("QUERY");
          this.log.push({ id: sq.id, text: sq.text });
          const res = await client.query(sq.text, [...sq.params]);
          out.push(res.rows.map(normaliseRow));
        }
        await client.query("COMMIT");
        this.ev("COMMIT");
        return out;
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (attempt < retries && RECONNECT_CODES.has(code)) {
          await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 500) * 2 ** attempt));
          continue;
        }
        throw err;
      } finally {
        await client.end().catch(() => {});
      }
    }
  }

  async query(sq: SafeQuery): Promise<Record<string, unknown>[]> {
    const [rows] = await this.batch([sq]);
    return rows ?? [];
  }
}

/** Test helper: is this object an issued SafeQuery? */
export function isIssued(x: object): boolean {
  return issued.has(x);
}
