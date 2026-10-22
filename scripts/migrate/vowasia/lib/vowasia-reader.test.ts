import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSourceConfig } from "./vowasia-config";
import { LiveVowasiaReader, READER_MESSAGES, assertVowasiaSite } from "./vowasia-reader";
import { CURSOR_COLUMN, VowasiaReadOnlyDb, createSqlRegistry, type MinimalPgClient } from "./vowasia-sql";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REG = createSqlRegistry(parseSourceConfig(JSON.parse(readFileSync(path.resolve(HERE, "..", "legacy-source.vowasia.json"), "utf8"))));
const SITE = "00000000-0000-0000-0000-00000000f002";

/** Fake legacy rows: `ts` is the DB text of coalesce(created_at, epoch) (fixed width, so text order = time order). */
interface FakeRow {
  id: string;
  ts: string;
}
type Mode = "honest" | "overlap" | "repeat" | "reorder-seen";

/**
 * Fake client with the keyset semantics of the real SQL:
 * WHERE (ts, id) > ($3, $4) ORDER BY ts, id LIMIT n, comparing the cursor TEXT
 * (microseconds included). Other modes simulate a misbehaving source.
 */
class FakeLegacy implements MinimalPgClient {
  calls = 0;
  constructor(private readonly rows: FakeRow[], private readonly mode: Mode = "honest", private readonly sites: Record<string, unknown>[] = [{ id: SITE, slug: "vowasia", name: "VowAsia" }]) {}
  async connect() {}
  async end() {}
  async query(text: string, params: unknown[] = []) {
    if (!text.startsWith("SELECT")) return { rows: [] };
    if (text.includes('"sites"')) return { rows: this.sites };
    this.calls++;
    const sorted = [...this.rows].sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts < b.ts ? -1 : 1));
    const withCursor = text.includes(") > (");
    const limit = Number(params[params.length - 1]);
    let pool = sorted;
    if (withCursor && this.mode !== "repeat") {
      const [cts, cid] = [String(params[2]), String(params[3])];
      pool = sorted.filter((r) => (this.mode === "overlap" ? r.ts > cts || (r.ts === cts && r.id >= cid) : r.ts > cts || (r.ts === cts && r.id > cid)));
    }
    let page = pool.slice(0, limit);
    if (this.mode === "reorder-seen" && withCursor) page = sorted.slice(0, limit).reverse();
    return { rows: page.map((r) => ({ id: r.id, title: `t-${r.id}`, [CURSOR_COLUMN]: r.ts })) };
  }
}

function reader(rows: FakeRow[], mode: Mode = "honest", sites?: Record<string, unknown>[]): { r: LiveVowasiaReader; fake: FakeLegacy } {
  const fake = new FakeLegacy(rows, mode, sites);
  return { r: new LiveVowasiaReader(new VowasiaReadOnlyDb(REG, () => fake), SITE), fake };
}

async function readAll(r: LiveVowasiaReader, pageSize: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const page of r.pages("articles", ["id", "title"], pageSize)) out.push(...page);
  return out;
}

// Two rows in the same millisecond, different microseconds, plus ties and the epoch (NULL created_at).
const ROWS: FakeRow[] = [
  { id: "a", ts: "1970-01-01 00:00:00+00" },
  { id: "b", ts: "1970-01-01 00:00:00+00" },
  { id: "c", ts: "2026-03-01 10:00:00.123400+00" },
  { id: "d", ts: "2026-03-01 10:00:00.123900+00" },
  { id: "e", ts: "2026-03-01 10:00:00.123900+00" },
  { id: "f", ts: "2026-03-02 00:00:00+00" },
];

test("AC-A5: same-millisecond rows with different microseconds across a page boundary: none lost, none duplicated", async () => {
  for (const size of [1, 2, 3, 6, 7]) {
    const { r } = reader(ROWS);
    const got = await readAll(r, size);
    assert.deepEqual(got.map((x) => x.id), ["a", "b", "c", "d", "e", "f"], `pageSize ${size}`);
    assert.equal(r.duplicatesSkipped, 0);
    assert.ok(got.every((x) => !(CURSOR_COLUMN in x)), "cursor column stripped");
  }
});

test("a page exactly equal to pageSize and then the end: stops on the empty page", async () => {
  const { r, fake } = reader(ROWS.slice(0, 4));
  assert.equal((await readAll(r, 2)).length, 4);
  assert.equal(fake.calls, 3);
});

test("AC-A5: should dedup by key and throw when the keyset cursor does not advance (overlapping pages are de-duplicated)", async () => {
  const { r } = reader(ROWS, "overlap");
  const got = await readAll(r, 2);
  assert.deepEqual(got.map((x) => x.id), ["a", "b", "c", "d", "e", "f"]);
  assert.ok(r.duplicatesSkipped > 0);
});

test("AC-A5: a source that returns the same page again throws cursorStuck", async () => {
  const { r } = reader(ROWS, "repeat");
  await assert.rejects(readAll(r, 2), { message: READER_MESSAGES.cursorStuck });
});

test("AC-A5: a page made only of keys already seen throws cursorStuck even if its last row differs", async () => {
  const { r } = reader(ROWS, "reorder-seen");
  await assert.rejects(readAll(r, 2), { message: READER_MESSAGES.cursorStuck });
});

test("site check: exactly one row with slug vowasia, else refused", async () => {
  assert.equal((await assertVowasiaSite(reader(ROWS).r)).slug, "vowasia");
  await assert.rejects(assertVowasiaSite(reader(ROWS, "honest", [{ id: SITE, slug: "gtp", name: "x" }]).r), { message: READER_MESSAGES.siteNotVowasia });
  await assert.rejects(assertVowasiaSite(reader(ROWS, "honest", []).r), { message: READER_MESSAGES.siteMissing });
  await assert.rejects(
    assertVowasiaSite(reader(ROWS, "honest", [{ id: SITE, slug: "vowasia" }, { id: SITE, slug: "vowasia" }]).r),
    { message: READER_MESSAGES.siteAmbiguous },
  );
  await assert.rejects(assertVowasiaSite(reader(ROWS, "honest", [{ id: SITE, slug: "VowAsia" }]).r), { message: READER_MESSAGES.siteNotVowasia });
});
