import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral, type FakeCentral } from "../fixtures/vowasia-legacy/fake-central";
import { writeSnapshotFixture, type SnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { repoRoot } from "./out-dir";
import { runImport, type ImportDeps } from "./import-vowasia-main";
import { runRollback } from "./rollback-vowasia-main";
import { LOCK_NAME, RunDir } from "./vowasia-run";

const LOCAL = "postgres://postgres:password@127.0.0.1:54399/vowasia_unit";

interface Ctx {
  base: string;
  snap: SnapshotFixture;
  runs: string;
  central: FakeCentral;
  tenantId: number | string;
  otherTenantId: number | string;
  logs: string[];
  deps: ImportDeps;
}
function setup(): Ctx {
  const base = mkdtempSync(path.join(os.tmpdir(), "vowasia-rollback-test-"));
  const snap = writeSnapshotFixture(path.join(base, "snap"));
  const runs = path.join(base, "runs");
  mkdirSync(runs, { mode: 0o700 });
  const s = seededCentral();
  const logs: string[] = [];
  return { base, snap, runs, central: s.central, tenantId: s.tenantId, otherTenantId: s.otherTenantId, logs, deps: { env: { DATABASE_URL: LOCAL }, log: (l) => logs.push(l), isTty: true, openPort: async () => s.central, now: () => new Date(s.central.now()) } };
}
const done = (c: Ctx) => rmSync(c.base, { recursive: true, force: true });
const imp = (c: Ctx, runId: string, extra: string[] = []) => runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, "--apply", "--run-id", runId, ...extra], c.deps);
const rb = (c: Ctx, runId: string, extra: string[] = []) => runRollback(["--run-id", runId, "--runs-dir", c.runs, ...extra], c.deps);
const marker = (c: Ctx) => c.central.rows("articles").filter((a) => a.engineSourceName === "legacy:vowasia");
function dirDigest(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    h.update(f);
    h.update(statSync(p).isFile() ? readFileSync(p) : "dir");
  }
  return h.digest("hex");
}

test("rollback --apply deletes only that run's journaled marker rows (+ its unreferenced Media); other runs untouched", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "6"]);
    await imp(c, "B");
    const aIds = new RunDir(path.join(c.runs, "A")).articleIds();
    const bIds = new RunDir(path.join(c.runs, "B")).articleIds();
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    const left = new Set(marker(c).map((a) => String(a.id)));
    for (const id of aIds) assert.equal(left.has(id), false);
    for (const id of bIds) assert.equal(left.has(id), true);
    const mediaIds = new Set(c.central.rows("media").map((m) => String(m.id)));
    for (const a of marker(c)) if (a.heroImage) assert.ok(mediaIds.has(String(a.heroImage)), "B's hero media kept");
    assert.ok(existsSync(path.join(c.runs, "A", "rollback-report.json")));
    assert.equal(await rb(c, "B", ["--apply"]), 0);
    assert.equal(marker(c).length, 0);
    assert.equal(c.central.rows("media").filter((m) => String(m.tenant) === String(c.tenantId)).length, 0);
  } finally {
    done(c);
  }
});

test("should keep a Media row referenced only from another article body", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "3"]);
    const a = new RunDir(path.join(c.runs, "A"));
    const created = a.media().filter((m) => m.origin === "created");
    const keep = created[0]?.mediaId;
    assert.ok(keep !== undefined);
    c.central.seed("articles", { tenant: c.tenantId, slug: "editor-post", origin: "manual", workflowStatus: "draft", body: { root: { type: "root", children: [{ type: "upload", relationTo: "media", value: keep }] } } });
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.ok(c.central.rows("media").some((m) => String(m.id) === String(keep)), "body-only reference keeps the Media");
    assert.equal(c.central.rows("media").filter((m) => String(m.tenant) === String(c.tenantId)).length, 1);
  } finally {
    done(c);
  }
});

test("should leave the run dir byte-identical on rollback dry-run (report on stdout only)", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "4"]);
    writeFileSync(path.join(c.runs, "A", "intent.ndjson"), readFileSync(path.join(c.runs, "A", "intent.ndjson"), "utf8") + JSON.stringify({ legacyId: "x", slug: "ghost", runId: "A", at: "2026-10-20T00:00:00Z" }) + "\n");
    const before = dirDigest(path.join(c.runs, "A"));
    const writesBefore = c.central.writes.length;
    assert.equal(await rb(c, "A"), 0);
    assert.equal(dirDigest(path.join(c.runs, "A")), before);
    assert.equal(c.central.writes.length, writesBefore);
    assert.match(c.logs.join("\n"), /DRY RUN run A: entries 4; would delete 4/);
    assert.equal(existsSync(path.join(c.runs, LOCK_NAME)), false);
  } finally {
    done(c);
  }
});

test("should report and not archive when an article delete throws", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "3"]);
    const victim = new RunDir(path.join(c.runs, "A")).slugMap()[0]?.articleId;
    c.central.hooks.failDelete = (col, id) => (col === "articles" && String(id) === String(victim) ? new Error("violates foreign key constraint translation_jobs") : undefined);
    assert.equal(await rb(c, "A", ["--apply"]), 2);
    const v = c.central.rows("articles").find((x) => String(x.id) === String(victim));
    assert.ok(v, "article still there");
    assert.notEqual(v?.workflowStatus, "archived");
    assert.equal(c.central.writes.filter((w) => w.op === "update").length, 0, "no archive fallback");
    const rep = JSON.parse(readFileSync(path.join(c.runs, "A", "rollback-report.json"), "utf8"));
    assert.equal(rep.errors.length, 1);
    assert.match(rep.errors[0], /run A, slug .*, id .*foreign key/);
  } finally {
    done(c);
  }
});

test("--runs-dir inside the repo (git-ignored too) is refused; edited rows kept unless --include-edited; GTP marker never touched", async () => {
  const c = setup();
  try {
    await assert.rejects(() => runRollback(["--run-id", "A", "--runs-dir", path.join(repoRoot(), "scripts", "migrate", "out", "x")], c.deps), /inside the repository/);
    await imp(c, "A", ["--limit", "3"]);
    const ids = [...new RunDir(path.join(c.runs, "A")).articleIds()];
    const edited = c.central.rows("articles").find((x) => String(x.id) === ids[0]);
    if (edited) {
      edited.version = 2;
      edited.updatedAt = "2027-01-01T00:00:00.000Z";
    }
    const gtpRow = c.central.seed("articles", { tenant: c.otherTenantId, slug: "gtp-x", origin: "import", engineSourceName: "legacy:globaltravelpost" });
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.ok(c.central.rows("articles").some((x) => String(x.id) === ids[0]), "edited kept");
    assert.equal(marker(c).length, 1);
    assert.equal(await rb(c, "A", ["--apply", "--include-edited"]), 0);
    assert.equal(marker(c).length, 0);
    assert.ok(c.central.rows("articles").some((x) => x.id === gtpRow.id));
  } finally {
    done(c);
  }
});

test("a lock left by a killed process makes rollback --apply refuse; after deleting it rollback proceeds", async () => {
  const c = setup();
  try {
    const kill = { ...c.deps, env: { ...c.deps.env, VOWASIA_TEST_KILL_BEFORE_JOURNAL: "2" }, exit: (() => { throw new Error("killed (simulated kill -9)"); }) as (code: number) => never };
    await assert.rejects(() => runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, "--apply", "--run-id", "A"], kill), /killed/);
    // a real kill -9 leaves the lock behind (the in-process test exit ran the finally block, so put it back)
    writeFileSync(path.join(c.runs, LOCK_NAME), JSON.stringify({ pid: 999999, runId: "A", mode: "import", startedAt: "2026-10-20T00:00:00Z" }));
    await assert.rejects(() => rb(c, "A", ["--apply"]), /held by pid 999999, run A, import/);
    assert.equal(await rb(c, "A"), 0, "dry-run is not blocked");
    rmSync(path.join(c.runs, LOCK_NAME));
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.equal(marker(c).length, 0, "crash after create, before journal: rollback A deletes it");
    const run = new RunDir(path.join(c.runs, "A"));
    assert.equal(run.dangling().length, 0, "the dangling intent is resolved");
    assert.equal(run.outcomes().filter((o) => o.result === "resolved" && o.deleted).length, 1);
  } finally {
    done(c);
  }
});

test("required scenario: crash before create, then run B creates the same slug, then rollback A -> B's article untouched", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    const a = new RunDir(path.join(c.runs, "A"));
    // the next planned row of A crashed before its create: only an intent line
    const next = "escape-post";
    writeFileSync(a.p("intent.ndjson"), readFileSync(a.p("intent.ndjson"), "utf8") + JSON.stringify({ legacyId: "z", slug: next, runId: "A", at: "2026-10-20T00:00:00Z" }) + "\n");
    // resolve the dangling intent first (preflight would refuse run B): rollback A dry-run lists it, apply resolves it (nothing to delete)
    // then run B creates the slug; a SECOND dangling-style check must still not touch it
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.equal(await imp(c, "B"), 0);
    const bRow = c.central.rows("articles").find((x) => x.slug === next);
    assert.ok(bRow);
    // re-open A with a fresh dangling intent for the same slug (worst case: an old journal copy restored)
    writeFileSync(a.p("intent.ndjson"), readFileSync(a.p("intent.ndjson"), "utf8") + JSON.stringify({ legacyId: "z", slug: next, runId: "A", at: "2026-10-20T00:00:00Z" }) + "\n");
    writeFileSync(a.p("outcome.ndjson"), readFileSync(a.p("outcome.ndjson"), "utf8").split("\n").filter((l) => !l.includes('"resolved"')).join("\n"));
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.ok(c.central.rows("articles").some((x) => x.id === bRow?.id), "B's article untouched (condition c)");
  } finally {
    done(c);
  }
});

test("required scenario: failed create, then run B, then rollback A -> untouched", async () => {
  const c = setup();
  try {
    let n = 0;
    c.central.hooks.failCreate = (col) => (col === "articles" && ++n === 2 ? new Error("db hiccup") : undefined);
    assert.equal(await imp(c, "A", ["--limit", "3"]), 2);
    c.central.hooks.failCreate = undefined;
    const failedSlug = new RunDir(path.join(c.runs, "A")).outcomes().find((o) => o.result === "failed")?.slug;
    assert.ok(failedSlug);
    assert.equal(await imp(c, "B"), 0);
    const bRow = c.central.rows("articles").find((x) => x.slug === failedSlug);
    assert.ok(bRow);
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    assert.ok(c.central.rows("articles").some((x) => x.id === bRow?.id));
  } finally {
    done(c);
  }
});

test("dangling intent: one condition per case must hold before a delete (b, c, d, e)", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "1"]);
    const a = new RunDir(path.join(c.runs, "A"));
    const start = a.state()?.startedAt as string;
    const ghost = (slug: string) => writeFileSync(a.p("intent.ndjson"), readFileSync(a.p("intent.ndjson"), "utf8") + JSON.stringify({ legacyId: slug, slug, runId: "A", at: start }) + "\n");
    const mk = (slug: string, extra: Record<string, unknown>) => c.central.seed("articles", { tenant: c.tenantId, slug, origin: "import", engineSourceName: "legacy:vowasia", version: 1, ...extra });
    // (b) not marker
    c.central.seed("articles", { tenant: c.tenantId, slug: "b-case", origin: "manual", version: 1, createdAt: "2027-01-01T00:00:00Z" });
    ghost("b-case");
    // (c) owned by another run's journal
    const other = mk("c-case", { createdAt: "2027-01-01T00:00:00Z" });
    mkdirSync(path.join(c.runs, "OTHER"));
    writeFileSync(path.join(c.runs, "OTHER", "state.json"), JSON.stringify({ runId: "OTHER", startedAt: start }));
    writeFileSync(path.join(c.runs, "OTHER", "outcome.ndjson"), JSON.stringify({ legacyId: "c", slug: "c-case", result: "created", id: other.id, at: start }) + "\n");
    ghost("c-case");
    // (d) edited
    mk("d-case", { version: 2, createdAt: "2027-01-01T00:00:00Z" });
    ghost("d-case");
    // (e) created before the run started
    mk("e-case", { createdAt: "2000-01-01T00:00:00Z" });
    ghost("e-case");
    // all five hold
    mk("ok-case", { createdAt: "2027-01-01T00:00:00Z" });
    ghost("ok-case");
    assert.equal(await rb(c, "A", ["--apply"]), 0);
    const slugs = new Set(c.central.rows("articles").map((x) => x.slug));
    for (const s of ["b-case", "c-case", "d-case", "e-case"]) assert.ok(slugs.has(s), `${s} kept`);
    assert.equal(slugs.has("ok-case"), false, "all five conditions -> deleted");
    assert.equal(a.dangling().length, 0, "every dangling intent got a resolved line");
  } finally {
    done(c);
  }
});
