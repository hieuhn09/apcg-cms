/**
 * The ONLY SQL surface of the VowAsia legacy migration tools (own copy of the
 * GTP `legacy-sql.ts` design; no GTP file is imported or edited). The legacy
 * database is SHARED with other sites and also holds unrelated sensitive
 * tables, so SQL is safe by construction, not by denylist:
 *
 *  1. Closed builders. Every statement comes from one of the eight builders
 *     below and is returned as an opaque, frozen `SafeQuery`. Tables, columns,
 *     keys and the site column come from a frozen `SqlRegistry` built ONCE from
 *     the validated source config (hypothesis + owner overlay); no builder
 *     holds a table or column name literal. Identifiers must be lower
 *     snake_case; anything else is refused with a fixed "amendment required"
 *     message (never loosened automatically). Every data read goes through a
 *     derived table that already carries the site predicate `"<siteColumn>" = $1`.
 *  2. `assertSafeQuery(sq, registry)` is a second line: it re-renders the
 *     template from `sq.id` + `sq.args` and requires the exact same text; a
 *     small lexer refuses comments, `;`, string literals, dollar quoting,
 *     backslashes, non-ASCII, write/DDL keywords, relations outside the
 *     registry, comma joins, JOIN/LATERAL and any function outside FUNCTION_ALLOW;
 *     `$1` must match the configured site id kind (uuid | integer | text-safe).
 *  3. `VowasiaReadOnlyDb` accepts only SafeQueries issued by a builder for the
 *     same registry; each batch is a short `BEGIN READ ONLY ... COMMIT` on a
 *     fresh connection. The owner-created role (views only) is the real fence.
 *
 * Keyset fix (vs the GTP copy): pages also select
 * `coalesce("<createdAt>", $2::timestamptz)::text AS "__cursor_ts"` (the same
 * expression as ORDER BY), and the cursor is that DB-rendered text (microsecond
 * precision, with offset), compared back as `$n::timestamptz`. The cursor never
 * goes through a JS Date (which would cut it to milliseconds).
 *
 * Sensitive table names of the shared DB never appear in this repo; tests use
 * neutral decoys `secret_table_a..d`.
 */
import type { SiteIdKind, SourceConfig } from "./vowasia-config";
import { IDENT_RE, SITE_ID_PATTERNS } from "./vowasia-config";

export const SQL_MESSAGES = {
  refused: "legacy-sql guard: statement refused (not a site-scoped read built by a closed builder on an allow-listed table).",
  notAllowedTable: "legacy-sql guard: table is not in the configured allow-list; refusing.",
  ident: "legacy: identifier not supported by closed builder; amendment required.",
  unknownColumn: "legacy-sql guard: column is not in the catalog of this table; refusing.",
  noCreatedAt: "legacy-sql guard: this table has no created-at column; keyset ordering by created-at refused.",
  notBranded: "legacy-sql guard: only SafeQuery objects issued by a builder for this registry may reach the driver.",
  badCursor: "legacy-sql guard: keyset cursor has the wrong shape; refusing.",
  badLimit: "legacy-sql guard: page size out of range; refusing.",
  badRegistry: "legacy-sql guard: unknown SQL registry; refusing.",
} as const;

export class VowasiaSqlError extends Error {
  override name = "VowasiaSqlError";
}

/** Column alias carrying the DB-rendered keyset timestamp; stripped from rows by the reader. */
export const CURSOR_COLUMN = "__cursor_ts";
export const EPOCH = "1970-01-01T00:00:00.000Z";

export interface TableSpec {
  readonly logical: string;
  readonly name: string;
  readonly siteColumn: string;
  readonly keyColumns: readonly string[];
  readonly createdAtColumn: string | null;
  readonly slugColumn?: string;
  readonly nameColumn?: string;
}

export interface SqlRegistry {
  readonly schema: string;
  readonly siteIdKind: SiteIdKind;
  readonly tables: Readonly<Record<string, TableSpec>>;
  readonly realNames: readonly string[];
}

const registries = new WeakSet<object>();
const catalogs = new WeakMap<SqlRegistry, Map<string, Set<string>>>();

function ident(name: unknown): string {
  if (typeof name !== "string" || !IDENT_RE.test(name)) throw new VowasiaSqlError(SQL_MESSAGES.ident);
  return name;
}

/** Build the frozen registry ONCE from a validated config (optionally another schema). */
export function createSqlRegistry(cfg: SourceConfig, schemaOverride?: string): SqlRegistry {
  const schema = ident(schemaOverride ?? cfg.source.schema);
  const tables: Record<string, TableSpec> = {};
  for (const [logical, t] of Object.entries(cfg.source.tables)) {
    const x = t as SourceConfig["source"]["tables"]["sites"] | SourceConfig["source"]["tables"]["articles"];
    tables[ident(logical)] = Object.freeze({
      logical,
      name: ident(x.name),
      siteColumn: ident(x.siteColumn),
      keyColumns: Object.freeze(x.keyColumns.map(ident)),
      createdAtColumn: x.createdAtColumn === null ? null : ident(x.createdAtColumn),
      ...("slugColumn" in x ? { slugColumn: ident(x.slugColumn), nameColumn: ident(x.nameColumn) } : {}),
    });
  }
  const realNames = Object.freeze([...new Set(Object.values(tables).map((t) => t.name))]);
  const reg: SqlRegistry = Object.freeze({ schema, siteIdKind: cfg.source.siteIdKind, tables: Object.freeze(tables), realNames });
  registries.add(reg);
  return reg;
}

function assertRegistry(reg: SqlRegistry): void {
  if (!registries.has(reg)) throw new VowasiaSqlError(SQL_MESSAGES.badRegistry);
}

/** Catalog (real table -> known columns) used to validate column identifiers. */
export function setCatalog(reg: SqlRegistry, c: Map<string, Set<string>> | undefined): void {
  assertRegistry(reg);
  if (c === undefined) catalogs.delete(reg);
  else catalogs.set(reg, c);
}

/* ── SafeQuery ──────────────────────────────────────────────────────────── */

export type BuilderId = "catalogTables" | "catalogColumns" | "countRows" | "distribution" | "keysetPage" | "sampleRows" | "slugPlanRows" | "siteRow";

export interface BuilderArgs {
  table?: string;
  columns?: string[];
  column?: string;
  withCursor?: boolean;
}

export interface SafeQuery {
  readonly id: BuilderId;
  readonly text: string;
  readonly params: readonly unknown[];
  readonly args: Readonly<BuilderArgs>;
}

const issuedBy = new WeakMap<object, SqlRegistry>();

function q(name: string): string {
  return `"${ident(name)}"`;
}

function spec(reg: SqlRegistry, table: unknown): TableSpec {
  if (typeof table !== "string" || !Object.prototype.hasOwnProperty.call(reg.tables, table)) throw new VowasiaSqlError(SQL_MESSAGES.notAllowedTable);
  return reg.tables[table] as TableSpec;
}

function col(reg: SqlRegistry, t: TableSpec, name: unknown): string {
  const n = ident(name);
  if (n.startsWith("__")) throw new VowasiaSqlError(SQL_MESSAGES.ident);
  const known = catalogs.get(reg)?.get(t.name);
  if (known && !known.has(n)) throw new VowasiaSqlError(SQL_MESSAGES.unknownColumn);
  return q(n);
}

function scoped(reg: SqlRegistry, t: TableSpec): string {
  return `(SELECT * FROM ${q(reg.schema)}.${q(t.name)} WHERE ${q(t.siteColumn)} = $1) AS t`;
}

function orderExprs(t: TableSpec, epochParam: string): string[] {
  const keys = t.keyColumns.map((k) => q(k));
  return t.createdAtColumn ? [`coalesce(${q(t.createdAtColumn)}, ${epochParam}::timestamptz)`, ...keys] : keys;
}

function articles(reg: SqlRegistry): TableSpec {
  return spec(reg, "articles");
}

/** Pure template renderer: (registry, id, args) -> text. Throws on anything invalid. */
function render(reg: SqlRegistry, id: BuilderId, a: BuilderArgs): string {
  switch (id) {
    case "catalogTables":
      return "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name";
    case "catalogColumns":
      return "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position";
    case "countRows":
      return `SELECT count(*) AS n FROM ${scoped(reg, spec(reg, a.table))}`;
    case "distribution": {
      const t = spec(reg, a.table);
      const c = col(reg, t, a.column);
      return `SELECT ${c} AS v, count(*) AS n FROM ${scoped(reg, t)} GROUP BY ${c} ORDER BY count(*) DESC, ${c} LIMIT 25`;
    }
    case "keysetPage": {
      const t = spec(reg, a.table);
      const cols = (a.columns ?? []).map((c) => col(reg, t, c));
      if (!cols.length) throw new VowasiaSqlError(SQL_MESSAGES.ident);
      // $1 site, [$2 epoch when createdAt], then cursor values, last = limit
      const has = t.createdAtColumn !== null;
      const first = has ? 3 : 2;
      const ord = orderExprs(t, "$2");
      const n = ord.length;
      const select = has ? [...cols, `${ord[0] as string}::text AS ${q(CURSOR_COLUMN)}`] : cols;
      const cursor = a.withCursor
        ? ` WHERE (${ord.join(", ")}) > (${ord.map((_, i) => (has && i === 0 ? `$${first + i}::timestamptz` : `$${first + i}`)).join(", ")})`
        : "";
      const limitParam = a.withCursor ? `$${first + n}` : `$${first}`;
      return `SELECT ${select.join(", ")} FROM ${scoped(reg, t)}${cursor} ORDER BY ${ord.join(", ")} LIMIT ${limitParam}`;
    }
    case "sampleRows": {
      const t = spec(reg, a.table);
      const cols = (a.columns ?? []).map((c) => col(reg, t, c));
      if (!cols.length) throw new VowasiaSqlError(SQL_MESSAGES.ident);
      const k = q(t.keyColumns[0] as string);
      return `SELECT ${cols.join(", ")} FROM ${scoped(reg, t)} WHERE ${k}::text = ANY($2::text[]) ORDER BY ${k}`;
    }
    case "slugPlanRows": {
      const t = articles(reg);
      const cols = (a.columns ?? []).map((c) => col(reg, t, c));
      if (!cols.length) throw new VowasiaSqlError(SQL_MESSAGES.ident);
      return `SELECT ${cols.join(", ")} FROM ${scoped(reg, t)} ORDER BY ${orderExprs(t, "$2").join(", ")}`;
    }
    case "siteRow": {
      const t = spec(reg, "sites");
      if (!t.slugColumn || !t.nameColumn) throw new VowasiaSqlError(SQL_MESSAGES.ident);
      return `SELECT ${[t.siteColumn, t.slugColumn, t.nameColumn].map((c) => col(reg, t, c)).join(", ")} FROM ${scoped(reg, t)}`;
    }
    default:
      throw new VowasiaSqlError(SQL_MESSAGES.refused);
  }
}

function issue(reg: SqlRegistry, id: BuilderId, args: BuilderArgs, params: unknown[]): SafeQuery {
  assertRegistry(reg);
  const frozenArgs = Object.freeze({ ...args, ...(args.columns ? { columns: Object.freeze([...args.columns]) as string[] } : {}) });
  const sq: SafeQuery = Object.freeze({ id, text: render(reg, id, frozenArgs), params: Object.freeze([...params]), args: frozenArgs });
  issuedBy.set(sq, reg);
  assertSafeQuery(sq, reg);
  return sq;
}

/* ── Builders (the only exports that produce SQL) ──────────────────────── */

export function catalogTables(reg: SqlRegistry): SafeQuery {
  return issue(reg, "catalogTables", {}, [reg.schema, [...reg.realNames]]);
}
export function catalogColumns(reg: SqlRegistry): SafeQuery {
  return issue(reg, "catalogColumns", {}, [reg.schema, [...reg.realNames]]);
}
export function countRows(reg: SqlRegistry, table: string, siteId: string): SafeQuery {
  return issue(reg, "countRows", { table }, [siteId]);
}
export function distribution(reg: SqlRegistry, table: string, column: string, siteId: string): SafeQuery {
  return issue(reg, "distribution", { table, column }, [siteId]);
}
/** Keyset page; `cursor` = [created-at text from `__cursor_ts` (when present), ...key values] of the last row. */
export function keysetPage(reg: SqlRegistry, table: string, columns: string[], siteId: string, cursor: readonly unknown[] | null, limit: number): SafeQuery {
  const t = spec(reg, table);
  const n = t.keyColumns.length + (t.createdAtColumn ? 1 : 0);
  if (cursor && (cursor.length !== n || (t.createdAtColumn !== null && (typeof cursor[0] !== "string" || cursor[0] === "")))) throw new VowasiaSqlError(SQL_MESSAGES.badCursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new VowasiaSqlError(SQL_MESSAGES.badLimit);
  const params: unknown[] = [siteId, ...(t.createdAtColumn ? [EPOCH] : []), ...(cursor ?? []), limit];
  return issue(reg, "keysetPage", { table, columns, withCursor: cursor !== null }, params);
}
/** Keyset ordering BY created-at on a table without one is refused. */
export function assertCreatedAtOrdering(reg: SqlRegistry, table: string): void {
  if (spec(reg, table).createdAtColumn === null) throw new VowasiaSqlError(SQL_MESSAGES.noCreatedAt);
}
export function sampleRows(reg: SqlRegistry, table: string, columns: string[], siteId: string, ids: string[]): SafeQuery {
  return issue(reg, "sampleRows", { table, columns }, [siteId, ids.map(String)]);
}
/** All articles rows (selected columns), in keyset order. */
export function slugPlanRows(reg: SqlRegistry, columns: string[], siteId: string): SafeQuery {
  const t = articles(reg);
  return issue(reg, "slugPlanRows", { columns }, [siteId, ...(t.createdAtColumn ? [EPOCH] : [])]);
}
export function siteRow(reg: SqlRegistry, siteId: string): SafeQuery {
  return issue(reg, "siteRow", {}, [siteId]);
}

/** Cursor values for the last row of a keyset page: DB text of created-at (never a Date) + keys. */
export function cursorOf(reg: SqlRegistry, table: string, row: Record<string, unknown>): unknown[] {
  const t = spec(reg, table);
  const vals = t.keyColumns.map((k) => row[k]);
  if (t.createdAtColumn === null) return vals;
  const c = row[CURSOR_COLUMN];
  if (typeof c !== "string" || c === "") throw new VowasiaSqlError(SQL_MESSAGES.badCursor);
  return [c, ...vals];
}

/* ── Second line: lexer + template check ───────────────────────────────── */

type Tok = { k: "id" | "qid" | "num" | "param" | "op"; v: string };

const KEYWORD_DENY = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "grant", "revoke", "truncate", "copy", "do", "with",
  "into", "table", "values", "lateral", "join", "union", "intersect", "except", "call", "execute", "set", "reset",
  "listen", "notify", "vacuum", "analyze", "lock", "cursor", "fetch", "prepare", "deallocate", "begin", "commit",
  "rollback", "savepoint", "or", "returning", "merge", "comment", "security", "load", "import", "show", "explain",
]);
export const FUNCTION_ALLOW = new Set(["count", "min", "max", "coalesce", "lower", "btrim", "length", "left"]);
const KEYWORD_PAREN_OK = new Set(["any", "from", "in", "where", "and", "by", "select", "as"]);

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const refuse = (): never => {
    throw new VowasiaSqlError(SQL_MESSAGES.refused);
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
      if (!IDENT_RE.test(inner)) refuse();
      toks.push({ k: "qid", v: inner });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i)) as RegExpExecArray;
      const word = m[0];
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

function relationAllowed(reg: SqlRegistry, schema: string | null, name: string): boolean {
  if (schema === "information_schema") return name === "columns" || name === "tables";
  if (schema !== null && schema !== reg.schema) return false;
  return reg.realNames.includes(name);
}

/** Throws unless `sq` is template-exact for `reg`, lexically clean and site-scoped with a well-typed site id. */
export function assertSafeQuery(sq: SafeQuery, reg: SqlRegistry): void {
  const refuse = (): never => {
    throw new VowasiaSqlError(SQL_MESSAGES.refused);
  };
  assertRegistry(reg);
  if (typeof sq !== "object" || sq === null || typeof sq.text !== "string" || typeof sq.id !== "string" || !Array.isArray(sq.params)) refuse();
  let expected: string;
  try {
    expected = render(reg, sq.id, (sq.args ?? {}) as BuilderArgs);
  } catch {
    return refuse();
  }
  if (expected !== sq.text) refuse();
  assertLexicallySafe(sq.text, reg);
  if (sq.id === "catalogTables" || sq.id === "catalogColumns") {
    if (sq.params.length !== 2 || sq.params[0] !== reg.schema) refuse();
    const list = sq.params[1];
    if (!Array.isArray(list) || list.length === 0 || list.some((x) => typeof x !== "string" || !reg.realNames.includes(x))) refuse();
    return;
  }
  const site = sq.params[0];
  if (typeof site !== "string" || !SITE_ID_PATTERNS[reg.siteIdKind].test(site)) refuse();
  if (!/ WHERE "[a-z_][a-z0-9_]*" = \$1\) AS t/.test(sq.text)) refuse();
}

/** Lexical second line, usable on any text (tests run the adversarial corpus through it too). */
export function assertLexicallySafe(text: string, reg: SqlRegistry): void {
  const refuse = (): never => {
    throw new VowasiaSqlError(SQL_MESSAGES.refused);
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
      if (!r) return refuse();
      if (r.k === "op" && r.v === "(") continue; // derived table; its body is scanned too
      if (r.k !== "id" && r.k !== "qid") refuse();
      let schema: string | null = null;
      let name = r.v;
      let j = i + 2;
      if (toks[j]?.v === ".") {
        schema = name;
        const n2 = toks[j + 1];
        if (!n2 || (n2.k !== "id" && n2.k !== "qid")) return refuse();
        name = n2.v;
        j += 2;
      }
      if (!relationAllowed(reg, schema, name)) refuse();
      if (schema === "information_schema" && !/table_name = ANY\(\$2::text\[\]\)/.test(text)) refuse();
      if (toks[j]?.v === "as") j += 2;
      else if (toks[j]?.k === "id" && !["where", "order", "group", "limit"].includes((toks[j] as Tok).v)) j += 1;
      if (toks[j]?.v === ",") refuse();
    }
  }
}

/* ── Read-only driver wrapper ──────────────────────────────────────────── */

export interface MinimalPgClient {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
}

const RECONNECT_CODES = new Set(["57P01", "08003", "08006", "25P03", "57P05"]);

/** Query log entry: builder id + text only (never params, so never the site id). */
export interface QueryLogEntry {
  id: string;
  text: string;
}

/** Normalise driver values (Date -> ISO) for report/JSON output. The cursor column is already text. */
export function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

export class VowasiaReadOnlyDb {
  readonly log: QueryLogEntry[] = [];
  /** Event order for tests: "BEGIN" | "COMMIT" | "QUERY". */
  readonly events: string[] = [];
  constructor(
    readonly registry: SqlRegistry,
    private readonly makeClient: () => MinimalPgClient,
    private readonly opts: { retries?: number; backoffMs?: number } = {},
  ) {
    assertRegistry(registry);
  }

  /** Run a group of SafeQueries in ONE short read-only transaction on a fresh connection. */
  async batch(queries: SafeQuery[]): Promise<Record<string, unknown>[][]> {
    for (const sq of queries) {
      if (issuedBy.get(sq) !== this.registry) throw new VowasiaSqlError(SQL_MESSAGES.notBranded);
      assertSafeQuery(sq, this.registry);
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
        this.events.push("BEGIN");
        await client.query("BEGIN READ ONLY");
        try {
          await client.query("SET LOCAL statement_timeout = '30s'");
        } catch {
          /* pooler may refuse; BEGIN READ ONLY is the fallback */
        }
        const out: Record<string, unknown>[][] = [];
        for (const sq of queries) {
          this.events.push("QUERY");
          this.log.push({ id: sq.id, text: sq.text });
          const res = await client.query(sq.text, [...sq.params]);
          out.push(res.rows.map(normaliseRow));
        }
        await client.query("COMMIT");
        this.events.push("COMMIT");
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

/** Test helper: was this object issued by a builder for `reg`? */
export function isIssuedFor(x: object, reg: SqlRegistry): boolean {
  return issuedBy.get(x) === reg;
}
