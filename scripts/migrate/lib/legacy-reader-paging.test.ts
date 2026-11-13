/**
 * Amendment 5: keyset paging must equal ONE unpaged ORDER BY query (no duplicate,
 * no skipped row) for any page size, also when rows share a millisecond or even
 * the exact microsecond. A fake pg client emulates Postgres: microsecond ordering
 * on the server, timestamptz handed to JS as a millisecond Date (the real
 * node-postgres behaviour that caused 73 duplicate reads on the real legacy DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_TS, LegacyReadOnlyDb, cursorOf, keysetPage, type MinimalPgClient } from "./legacy-sql";
import { LiveLegacyReader, READER_MESSAGES } from "./legacy-reader";

const SITE = "00000000-0000-0000-0000-00000000f001";

/** Microseconds since epoch from a Postgres text timestamptz or an ISO string. */
function micros(s: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(s);
  if (!m) throw new Error(`fake pg: bad timestamptz ${s}`);
  const tz = m[4] === "Z" ? "+00:00" : (m[4] as string).length === 3 ? `${m[4]}:00` : (m[4] as string).replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const base = BigInt(Date.parse(`${m[1]}T${m[2]}${tz}`)) * 1000n;
  return base + BigInt(((m[3] ?? "") + "000000").slice(0, 6));
}
/** Postgres text output of a timestamptz (UTC session), microseconds kept. */
function pgText(us: bigint): string {
  const ms = Number(us / 1000n);
  const frac = (us % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}${frac ? `.${frac}` : ""}+00`;
}

interface FakeRow { id: string; us: bigint }

function fakeClient(rows: FakeRow[]): MinimalPgClient {
  const sorted = [...rows].sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    connect: async () => {},
    end: async () => {},
    query: async (text: string, params: unknown[] = []) => {
      if (!text.startsWith("SELECT")) return { rows: [] };
      const withCursor = text.includes(") > (");
      const limit = Number(params[params.length - 1]);
      let list = sorted;
      if (withCursor) {
        const cu = micros(String(params[2]));
        const ci = String(params[3]);
        list = sorted.filter((r) => r.us > cu || (r.us === cu && r.id > ci));
      }
      return {
        rows: list.slice(0, limit).map((r) => ({
          id: r.id,
          created_at: new Date(Number(r.us / 1000n)), // node-postgres: millisecond Date
          ...(text.includes(`"${CURSOR_TS}"`) ? { [CURSOR_TS]: pgText(r.us) } : {}),
        })),
      };
    },
  };
}

function reader(rows: FakeRow[]): LiveLegacyReader {
  const db = new LegacyReadOnlyDb(() => fakeClient(rows));
  // private constructor: the test bypasses open() (no real pg) and seeds the catalog directly.
  const r = new (LiveLegacyReader as unknown as new (...a: unknown[]) => LiveLegacyReader)(db, "public", SITE, ["articles"]);
  (r as unknown as { catalog: Map<string, Set<string>> }).catalog.set("articles", new Set(["id", "created_at"]));
  return r;
}

/** Microsecond fixture: distinct micros, groups sharing a millisecond, a few sharing the exact microsecond. */
function fixture(): FakeRow[] {
  const out: FakeRow[] = [];
  const t0 = 1_760_000_000_000_000n; // 2025-10-09, whole second
  let n = 0;
  const id = () => `aaaaaaaa-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
  for (let i = 0; i < 40; i++) out.push({ id: id(), us: t0 + BigInt(i) * 1000n + BigInt((i * 137) % 1000) });
  for (let g = 0; g < 6; g++) for (let k = 0; k < 5; k++) out.push({ id: id(), us: t0 + 100_000n + BigInt(g) * 1000n + BigInt(k * 199 + 1) });
  for (let k = 0; k < 4; k++) out.push({ id: id(), us: t0 + 200_000n + 654n }); // same microsecond
  out.push({ id: id(), us: t0 + 300_000n }); // whole millisecond
  return out.reverse(); // insertion order must not matter
}

const unpaged = (rows: FakeRow[]) => [...rows].sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : a.id < b.id ? -1 : 1)).map((r) => r.id);

for (const size of [1, 2, 7, 25, 500]) {
  test(`A5: paged read equals the unpaged ORDER BY (page size ${size}; no duplicate, no skip)`, async () => {
    const rows = fixture();
    const got: string[] = [];
    for await (const page of reader(rows).pages("articles", ["id"], size)) {
      for (const r of page) {
        assert.ok(!(CURSOR_TS in r), "the cursor column never reaches callers");
        got.push(String(r.id));
      }
      if (got.length > rows.length * 2) break; // a non-advancing reader must fail, not hang the suite
    }
    assert.deepEqual(got, unpaged(rows));
  });
}

test("A5: keysetPage on a created_at table selects the exact ordering value as text; others do not", () => {
  const a = keysetPage("public", "articles", ["id"], SITE, null, 10);
  assert.ok(a.text.includes(`coalesce("created_at", $2::timestamptz)::text AS "${CURSOR_TS}"`), a.text);
  assert.ok(!keysetPage("public", "events", ["id"], SITE, null, 10).text.includes(CURSOR_TS));
});

test("A5: cursorOf prefers the exact text value over the millisecond Date", () => {
  const exact = "2025-10-09 08:53:20.000137+00";
  assert.deepEqual(cursorOf("articles", { id: "u1", created_at: new Date("2025-10-09T08:53:20.000Z"), [CURSOR_TS]: exact }), [exact, "u1"]);
});

test("A5: a full page whose cursor does not advance throws instead of looping", async () => {
  const stuck: MinimalPgClient = {
    connect: async () => {},
    end: async () => {},
    query: async (text: string) => (text.startsWith("SELECT") ? { rows: [{ id: "x", created_at: new Date(0), [CURSOR_TS]: "1970-01-01 00:00:00+00" }] } : { rows: [] }),
  };
  const r = reader([]);
  (r as unknown as { db: LegacyReadOnlyDb }).db = new LegacyReadOnlyDb(() => stuck);
  await assert.rejects(async () => {
    let n = 0;
    for await (const page of r.pages("articles", ["id"], 1)) if ((n += page.length) > 5) return; // no guard: resolves, so the test fails
  }, new RegExp(READER_MESSAGES.noProgress.replace(/[()]/g, "\\$&")));
});
