import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral, type FakeCentral } from "../fixtures/vowasia-legacy/fake-central";
import { fixImage, fixtureRows } from "../fixtures/vowasia-legacy/fixture-rows";
import { writeSnapshotFixture, type SnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { repoRoot } from "./out-dir";
import { runImport, type ImportDeps } from "./import-vowasia-main";
import { LOCK_NAME, RunDir } from "./vowasia-run";

const LOCAL = "postgres://postgres:password@127.0.0.1:54399/vowasia_unit";
const REMOTE = "postgres://owner:pw@central.example.invalid:5432/neondb";

interface Ctx {
  base: string;
  snap: SnapshotFixture;
  runs: string;
  central: FakeCentral;
  logs: string[];
  deps: ImportDeps;
  exits: number[];
}

function setup(o: { central?: ReturnType<typeof seededCentral>; snap?: Parameters<typeof writeSnapshotFixture>[1]; env?: Record<string, string | undefined>; isTty?: boolean } = {}): Ctx {
  const base = mkdtempSync(path.join(os.tmpdir(), "vowasia-import-test-"));
  const snap = writeSnapshotFixture(path.join(base, "snap"), o.snap);
  const runs = path.join(base, "runs");
  mkdirSync(runs, { mode: 0o700 });
  const { central } = o.central ?? seededCentral();
  const logs: string[] = [];
  const exits: number[] = [];
  const deps: ImportDeps = {
    env: { DATABASE_URL: LOCAL, ...o.env },
    log: (l) => logs.push(l),
    isTty: o.isTty ?? true,
    openPort: async () => central,
  };
  return { base, snap, runs, central, logs, deps, exits };
}
const done = (c: Ctx) => rmSync(c.base, { recursive: true, force: true });
const dry = (c: Ctx, extra: string[] = []) => ["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, ...extra];
const apply = (c: Ctx, runId: string, extra: string[] = []) => [...dry(c), "--apply", "--run-id", runId, ...extra];
const articleWrites = (c: Ctx) => c.central.writes.filter((w) => w.collection === "articles" && w.op === "create");
const taxonomyWrites = (c: Ctx) => c.central.writes.filter((w) => ["pillars", "subsections", "tags", "authors", "tenants"].includes(w.collection));
const marker = (c: Ctx) => c.central.rows("articles").filter((a) => a.engineSourceName === "legacy:vowasia");

test("should stop with the full missing list and create no taxonomy when a pillar, sub-section, tag or author is missing", async () => {
  const cases: [Parameters<typeof seededCentral>[0], RegExp][] = [
    [{ omit: { pillar: "planning" } }, /pillar planning/],
    [{ omit: { subSection: "rings-jewellery" } }, /sub-section style\/rings-jewellery/],
    [{ omit: { subUnderWrongPillar: "honeymoons" } }, /sub-section destination-weddings\/honeymoons/],
    [{ omit: { tag: "wedding-venues" } }, /tag wedding-venues/],
    [{ omit: { author: "Hanna Pang" } }, /author Hanna Pang/],
  ];
  for (const [omit, re] of cases) {
    for (const mode of ["dry", "apply"]) {
      const c = setup({ central: seededCentral(omit) });
      try {
        await assert.rejects(() => runImport(mode === "dry" ? dry(c) : apply(c, "A"), c.deps), (e: unknown) => re.test((e as Error).message) && (e as Error).name === "TaxonomyStop");
        assert.equal(c.central.writes.length, 0, "zero writes");
        assert.equal(taxonomyWrites(c).length, 0);
        assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false, "lock released");
      } finally {
        done(c);
      }
    }
  }
});

test("an author with the right name but another slug is missing (lookup by name AND slug)", async () => {
  const s = seededCentral();
  const a = s.central.rows("authors").find((x) => x.name === "Ishaan Bhatt" && String(x.tenant) === String(s.tenantId));
  if (a) a.slug = "someone-else";
  const c = setup({ central: s });
  try {
    await assert.rejects(() => runImport(dry(c), c.deps), /author Ishaan Bhatt/);
  } finally {
    done(c);
  }
});

test("should refuse a dry-run whose --runs-dir is inside the repo, even when git-ignored", async () => {
  const c = setup();
  try {
    for (const inside of [path.join(repoRoot(), "scripts", "migrate", "out", "vowasia-unit-runs"), path.join(repoRoot(), "tmp-vowasia-unit-runs")]) {
      await assert.rejects(() => runImport(["--snapshot", c.snap.dir, "--runs-dir", inside], c.deps), /inside the repository/);
      assert.equal(existsSync(inside), false, "never created");
    }
    await assert.rejects(() => runImport(["--snapshot", c.snap.dir], c.deps), /--runs-dir/);
    assert.equal(c.central.writes.length, 0);
  } finally {
    done(c);
  }
});

test("flag gates: run-id rules, no --resume, dry-run with --run-id, expect-sha256 on apply", async () => {
  const c = setup();
  try {
    await assert.rejects(() => runImport([...dry(c), "--apply"], c.deps), /--run-id/);
    await assert.rejects(() => runImport([...dry(c), "--run-id", "A"], c.deps), /dry run never takes --run-id/);
    await assert.rejects(() => runImport([...apply(c, "A"), "--resume"], c.deps), /--resume/);
    await assert.rejects(() => runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--apply", "--run-id", "A"], c.deps), /--expect-sha256/);
    await assert.rejects(() => runImport(apply(c, "dry-x"), c.deps), /--run-id/);
    mkdirSync(path.join(c.runs, "B"));
    await assert.rejects(() => runImport(apply(c, "B"), c.deps), /already exists/);
    assert.equal(c.central.writes.length, 0);
  } finally {
    done(c);
  }
});

test("Central guards: no TTY, missing/wrong --confirm-host, database name not /neondb (dry-run too, name printed first)", async () => {
  const noTty = setup({ env: { DATABASE_URL: REMOTE }, isTty: false });
  try {
    await assert.rejects(() => runImport([...apply(noTty, "A"), "--confirm-host", "central.example.invalid"], noTty.deps), /TTY/);
    await assert.rejects(() => runImport(dry(noTty), noTty.deps), /--confirm-host/);
    await assert.rejects(() => runImport([...dry(noTty), "--confirm-host", "other.example.invalid"], noTty.deps), /does not match/);
  } finally {
    done(noTty);
  }
  const wrongDb = setup({ env: { DATABASE_URL: "postgres://owner:pw@central.example.invalid:5432/gcv_payload_disabled" } });
  try {
    await assert.rejects(() => runImport([...dry(wrongDb), "--confirm-host", "central.example.invalid"], wrongDb.deps), /not "\/neondb"/);
    assert.match(wrongDb.logs[0] ?? "", /database name .*"\/gcv_payload_disabled"/);
    assert.equal(wrongDb.logs.some((l) => l.includes("pw")), false);
  } finally {
    done(wrongDb);
  }
});

test("missing R2 env on a non-local Central refuses --apply; names only are printed", async () => {
  const c = setup({ env: { DATABASE_URL: REMOTE, R2_BUCKET: "b", R2_ENDPOINT: "", R2_ACCESS_KEY_ID: "k" } });
  try {
    await assert.rejects(() => runImport([...apply(c, "A"), "--confirm-host", "central.example.invalid"], c.deps), /R2_ENDPOINT, R2_SECRET_ACCESS_KEY missing or empty/);
    assert.equal(c.central.writes.length, 0);
    assert.equal(existsSync(path.join(c.runs, "A")), false);
  } finally {
    done(c);
  }
});

test("wrong --expect-sha256 and a broken sha chain are refused", async () => {
  const c = setup();
  try {
    await assert.rejects(() => runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", "0".repeat(64)], c.deps), /--expect-sha256/);
    writeFileSync(path.join(c.snap.dir, "snapshot.ndjson"), readFileSync(path.join(c.snap.dir, "snapshot.ndjson"), "utf8") + "\n");
    await assert.rejects(() => runImport(dry(c), c.deps), /sha256/);
  } finally {
    done(c);
  }
});

test("should refuse a second --apply while .import.lock exists and print the holder; dry-runs never touch the lock", async () => {
  const c = setup();
  try {
    writeFileSync(path.join(c.runs, LOCK_NAME), JSON.stringify({ pid: 4242, runId: "Z", mode: "import", startedAt: "2026-10-20T00:00:00Z" }));
    await assert.rejects(() => runImport(apply(c, "A"), c.deps), /held by pid 4242, run Z, import/);
    assert.equal(existsSync(path.join(c.runs, "A")), false);
    assert.equal(await runImport(dry(c), c.deps), 0, "dry-run is not blocked by the lock");
    assert.ok(existsSync(path.join(c.runs, LOCK_NAME)), "dry-run did not remove it");
    rmSync(path.join(c.runs, LOCK_NAME));
    assert.equal(await runImport(dry(c), c.deps), 0);
    assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false, "dry-run never creates it");
  } finally {
    done(c);
  }
});

test("dry-run writes only <runs-dir>/dry-<timestamp>, writes nothing to Central, prints the expected-count block", async () => {
  const c = setup();
  try {
    assert.equal(await runImport(dry(c), c.deps), 0);
    assert.equal(c.central.writes.length, 0);
    const dirs = readdirSync(c.runs);
    assert.equal(dirs.length, 1);
    assert.match(dirs[0] as string, /^dry-/);
    const out = c.logs.join("\n");
    const rows = c.snap.rows;
    const rejected = rows.filter((r) => r.status === "rejected").length;
    const noCover = rows.filter((r) => !r.featured_image);
    assert.match(out, new RegExp(`rows in snapshot: ${rows.length}`));
    assert.match(out, new RegExp(`dropped \\(rejected, C2\\): ${rejected}`));
    assert.match(out, new RegExp(`to import: ${rows.length - rejected}\\b`));
    assert.match(out, new RegExp(`no-cover rows: ${noCover.length} \\(published 1, archived 1, draft 1`));
    assert.match(out, /date fallbacks \(no published_at\): all rows 3, imported rows 2/);
    assert.match(out, /old-site-article .*https:\/\/vowasia\.com\/article\/body-images-post/);
    assert.match(out, /external .*https:\/\/partner\.example\.invalid\/report\?id=7/);
    assert.match(out, /expected redirect map: \d+ entries = \d+ x 410 \+ \d+ x 308/);
    assert.match(out, /C8 rejects: 0/);
    assert.equal(/postgres:\/\/|password/.test(out), false, "no URL or secret printed");
  } finally {
    done(c);
  }
});

test("apply: run A --limit 5, run B (new id) the rest, run C creates nothing; create-only, never adopts; every write carries the context", async () => {
  const c = setup();
  try {
    assert.equal(await runImport(apply(c, "A", ["--limit", "5"]), c.deps), 0);
    assert.equal(marker(c).length, 5);
    assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false);
    assert.equal(await runImport(apply(c, "B"), c.deps), 0);
    const importable = c.snap.rows.filter((r) => r.status !== "rejected").length;
    assert.equal(marker(c).length, importable);
    const before = c.central.writes.length;
    assert.equal(await runImport(apply(c, "C"), c.deps), 0);
    assert.equal(c.central.writes.length, before, "run C writes nothing");
    assert.equal(new RunDir(path.join(c.runs, "C")).slugMap().length, 0);
    const a = new RunDir(path.join(c.runs, "A"));
    const b = new RunDir(path.join(c.runs, "B"));
    assert.equal(a.slugMap().length, 5);
    assert.equal(b.slugMap().length, importable - 5);
    for (const id of a.articleIds()) assert.equal(b.articleIds().has(id), false, "no adoption across runs");
    for (const w of c.central.writes) assert.deepEqual({ disableRevalidate: w.options?.context?.disableRevalidate, skipTranslationEnqueue: w.options?.context?.skipTranslationEnqueue }, { disableRevalidate: true, skipTranslationEnqueue: true });
    assert.equal(c.central.writes.filter((w) => w.op !== "create").length, 0, "create-only");
    assert.equal(taxonomyWrites(c).length, 0);
    // statuses and markers
    const bySlug = new Map(c.central.rows("articles").map((x) => [x.slug, x]));
    assert.equal(bySlug.get("no-cover-published")?.workflowStatus, "draft");
    assert.equal(bySlug.get("archived-target")?.workflowStatus, "archived");
    assert.equal(bySlug.get("scheduled-one")?.workflowStatus, "draft");
    assert.equal(bySlug.has("rejected-one"), false);
    const imgPost = bySlug.get("body-images-post") as Record<string, unknown>;
    assert.equal(imgPost.origin, "import");
    const ups = JSON.stringify(imgPost.body).match(/"type":"upload"/g) ?? [];
    assert.equal(ups.length, 2);
    assert.ok(existsSync(path.join(c.runs, "A", "timestamps-fix.sql")));
    assert.match(readFileSync(path.join(c.runs, "A", "timestamps-fix.sql"), "utf8"), /OWNER-RUN/);
    // shared cover -> one Media row reused
    const shared = c.central.rows("media").filter((m) => /shared/.test(String(m.filename)));
    assert.equal(shared.length, 1);
    assert.ok(c.central.rows("media").every((m) => m.prefix === "vowasia"));
  } finally {
    done(c);
  }
});

test("store-level image failure: the article becomes draft, its body section is dropped, the run continues", async () => {
  const c = setup({ snap: { rows: fixtureRows({ bulk: 60 }), failUrls: [fixImage("body-1a.jpg")] } });
  try {
    assert.equal(await runImport(apply(c, "A"), c.deps), 0);
    const a = c.central.rows("articles").find((x) => x.slug === "body-images-post") as Record<string, unknown>;
    assert.equal(a.workflowStatus, "draft");
    const body = JSON.stringify(a.body);
    assert.equal(body.includes("The venue"), false, "section with the failed image dropped");
    assert.ok(body.includes("Details"));
    assert.ok(marker(c).length > 10, "run continued");
  } finally {
    done(c);
  }
});

test("more than 2% store-level image failures stop the run before any write", async () => {
  const urls = Array.from({ length: 8 }, (_, i) => fixImage(`cover-${100 + i}.jpg`));
  const c = setup({ snap: { failUrls: urls } });
  try {
    await assert.rejects(() => runImport(apply(c, "A"), c.deps), /2%/);
    assert.equal(c.central.writes.length, 0);
    assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false);
  } finally {
    done(c);
  }
});

test("should stop before the article create when the Media upload throws (Q12): outcome failed/uploadError, lock removed, non-zero exit", async () => {
  const c = setup();
  try {
    let mediaCreates = 0;
    c.central.hooks.failCreate = (col) => (col === "media" && ++mediaCreates === 3 ? new Error("R2 PutObject failed") : undefined);
    const code = await runImport(apply(c, "A"), c.deps);
    assert.notEqual(code, 0);
    const run = new RunDir(path.join(c.runs, "A"));
    const failed = run.outcomes().filter((o) => o.result === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.reason, "uploadError");
    const failedSlug = failed[0]?.slug;
    assert.equal(c.central.rows("articles").some((x) => x.slug === failedSlug), false, "no article for the failed upload");
    const createsAfter = articleWrites(c).length;
    assert.equal(createsAfter, run.slugMap().length, "every created article is journaled; nothing after the stop");
    assert.equal(c.central.rows("articles").filter((x) => x.workflowStatus === "draft" && !x.heroImage && x.slug === failedSlug).length, 0);
    assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false);
    assert.equal(run.dangling().length, 0);
  } finally {
    done(c);
  }
});

test("preflight: a dangling intent in any run, or a marker article absent from every journal, refuses --apply", async () => {
  const c = setup();
  try {
    assert.equal(await runImport(apply(c, "A", ["--limit", "2"]), c.deps), 0);
    writeFileSync(path.join(c.runs, "A", "intent.ndjson"), readFileSync(path.join(c.runs, "A", "intent.ndjson"), "utf8") + JSON.stringify({ legacyId: "x", slug: "ghost", runId: "A", at: "2026-10-20T00:00:00Z" }) + "\n");
    await assert.rejects(() => runImport(apply(c, "B"), c.deps), /dangling intent.*A: ghost/);
    rmSync(path.join(c.runs, "A"), { recursive: true });
    await assert.rejects(() => runImport(apply(c, "B"), c.deps), (e: unknown) => {
      const m = (e as Error).message;
      // F-1: rollback cannot reach a row no journal lists; the advice must give a path that works
      return /not in any run journal/.test(m) && !/use the rollback of their run/.test(m) && /--runs-dir/.test(m) && /\/admin/.test(m);
    });
    assert.equal(existsSync(path.join(c.runs, "B")), false);
  } finally {
    done(c);
  }
});

test("a non-marker vowasia article with a legacy slug is rejected (slugClash), never touched; another tenant is never read", async () => {
  const s = seededCentral();
  s.central.seed("articles", { tenant: s.tenantId, slug: "escape-post", origin: "manual", workflowStatus: "draft", title: "manual" });
  s.central.seed("articles", { tenant: s.otherTenantId, slug: "ring-post", origin: "import", engineSourceName: "legacy:vowasia", workflowStatus: "published" });
  const c = setup({ central: s });
  try {
    assert.equal(await runImport(apply(c, "A"), c.deps), 0);
    const manual = c.central.rows("articles").filter((x) => x.slug === "escape-post");
    assert.equal(manual.length, 1);
    assert.equal(manual[0]?.origin, "manual");
    assert.ok(c.central.rows("articles").some((x) => x.slug === "ring-post" && String(x.tenant) === String(s.tenantId)), "other-tenant row does not block");
    assert.match(readFileSync(path.join(c.runs, "A", "import-report.md"), "utf8"), /slugClash: 1/);
  } finally {
    done(c);
  }
});

test("bylines: spread within 1 per pillar over two runs", async () => {
  const c = setup({ snap: { rows: fixtureRows({ bulk: 60 }) } });
  try {
    await runImport(apply(c, "A", ["--limit", "17"]), c.deps);
    await runImport(apply(c, "B"), c.deps);
    const authors = new Map(c.central.rows("authors").map((a) => [String(a.id), String(a.name)]));
    const per = new Map<string, Map<string, number>>();
    for (const a of marker(c)) {
      const p = String(a.pillar);
      const m = per.get(p) ?? new Map();
      const n = authors.get(String(a.author)) as string;
      m.set(n, (m.get(n) ?? 0) + 1);
      per.set(p, m);
    }
    for (const [, m] of per) {
      const v = [...m.values()];
      const all = v.length < 6 ? [...v, 0] : v;
      assert.ok(Math.max(...all) - Math.min(...all) <= 1 || v.reduce((x, y) => x + y, 0) < 6);
    }
  } finally {
    done(c);
  }
});

test("local test hooks: forced upload error stops the run (Q12); hooks are refused against a non-local Central", async () => {
  const c = setup({ env: { VOWASIA_TEST_FAIL_UPLOAD_AT: "1" } });
  try {
    assert.equal(await runImport(apply(c, "A"), c.deps), 1);
    assert.equal(articleWrites(c).length, 0, "no article created after the forced upload error");
    assert.equal(new RunDir(path.join(c.runs, "A")).outcomes()[0]?.reason, "uploadError");
  } finally {
    done(c);
  }
  const r = setup({ env: { DATABASE_URL: REMOTE, VOWASIA_TEST_KILL_BEFORE_JOURNAL: "1", R2_BUCKET: "b", R2_ENDPOINT: "e", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" } });
  try {
    await assert.rejects(() => runImport([...apply(r, "A"), "--confirm-host", "central.example.invalid"], r.deps), /LOCAL rehearsal Central only/);
    assert.equal(r.central.writes.length, 0);
  } finally {
    done(r);
  }
});

test("F-1: a create that commits but then errors (lost reply) is journaled as created, so rollback can remove it and the next run is not blocked", async () => {
  const c = setup();
  try {
    let n = 0;
    c.central.hooks.failCreateAfterCommit = (col) => (col === "articles" && ++n === 2 ? new Error("Connection terminated unexpectedly") : undefined);
    const code = await runImport(apply(c, "A", ["--limit", "3"]), c.deps);
    c.central.hooks.failCreateAfterCommit = undefined;
    const run = new RunDir(path.join(c.runs, "A"));
    assert.equal(marker(c).length, 3, "3 rows exist in Central");
    assert.equal(run.outcomes().filter((o) => o.result === "created").length, 3, "the lost-reply row is journaled as created");
    assert.equal(run.slugMap().length, 3, "and has a slug-map line");
    assert.equal(code, 0);
    assert.equal(await runImport(apply(c, "B", ["--limit", "1"]), c.deps), 0, "orphan preflight does not block the next run");
  } finally {
    done(c);
  }
});

test("F-3: report.failed reasons and report.stop are redacted (Central DATABASE_URL password, R2 values)", async () => {
  const secretPw = "CentralFakePw123";
  const r2Key = "R2FAKEACCESSKEYID000";
  const r2Secret = "r2FakeSecretValue/abc+def";
  const c = setup({ env: { DATABASE_URL: `postgres://postgres:${secretPw}@127.0.0.1:54399/vowasia_unit`, R2_ACCESS_KEY_ID: r2Key, R2_SECRET_ACCESS_KEY: r2Secret, R2_BUCKET: "fake-bucket-xyz", R2_ENDPOINT: "https://fake.r2.example.invalid" } });
  try {
    let n = 0;
    c.central.hooks.failCreate = (col) => (col === "articles" && ++n === 1 ? new Error(`auth failed pw=${secretPw} key=${r2Key} secret=${r2Secret}`) : undefined);
    await runImport(apply(c, "A", ["--limit", "2"]), c.deps);
    n = 0;
    c.central.hooks.failCreate = (col) => (col === "media" && ++n === 1 ? new Error(`S3 denied ${r2Key} ${r2Secret} bucket fake-bucket-xyz`) : undefined);
    await runImport(apply(c, "B", ["--limit", "2"]), c.deps);
    for (const id of ["A", "B"]) {
      const txt = readFileSync(path.join(c.runs, id, "import-report.json"), "utf8") + readFileSync(path.join(c.runs, id, "import-report.md"), "utf8");
      for (const s of [secretPw, r2Key, r2Secret, "fake-bucket-xyz"]) assert.ok(!txt.includes(s), `${id} report leaks ${s}`);
    }
    assert.ok(!c.logs.join("\n").includes(r2Secret), "log leaks the R2 secret");
  } finally {
    done(c);
  }
});
