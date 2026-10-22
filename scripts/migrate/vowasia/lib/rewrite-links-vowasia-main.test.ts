import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral, type FakeCentral } from "../fixtures/vowasia-legacy/fake-central";
import { writeSnapshotFixture, type SnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { repoRoot } from "./out-dir";
import { runImport, type ImportDeps } from "./import-vowasia-main";
import { runRewriteLinks } from "./rewrite-links-vowasia-main";
import { runRollback } from "./rollback-vowasia-main";
import { LOCK_NAME } from "./vowasia-run";

const LOCAL = "postgres://postgres:password@127.0.0.1:54399/vowasia_unit";
const L1 = "https://vowasia.com/article/body-images-post";
const L2 = "https://www.vowasia.com/article/archived-target";
const L3 = "https://vowasia.com/article/no-cover-published";
const L4 = "https://vowasia.com/article/rejected-one";
const EXT = "https://partner.example.invalid/report?id=7";
const ALL = (v = "rewrite") => [`links-post ${L1} ${v}`, `links-post ${L2} ${v}`, `links-post ${L3} ${v}`, `links-post ${L4} ${v}`];

interface Ctx {
  base: string;
  snap: SnapshotFixture;
  runs: string;
  central: FakeCentral;
  logs: string[];
  deps: ImportDeps;
}
function setup(): Ctx {
  const base = mkdtempSync(path.join(os.tmpdir(), "vowasia-rewrite-test-"));
  const snap = writeSnapshotFixture(path.join(base, "snap"));
  const runs = path.join(base, "runs");
  mkdirSync(runs, { mode: 0o700 });
  const s = seededCentral();
  const logs: string[] = [];
  return { base, snap, runs, central: s.central, logs, deps: { env: { DATABASE_URL: LOCAL }, log: (l) => logs.push(l), isTty: true, openPort: async () => s.central, now: () => new Date(s.central.now()) } };
}
const done = (c: Ctx) => rmSync(c.base, { recursive: true, force: true });
const imp = (c: Ctx, runId: string, extra: string[] = []) => runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, "--apply", "--run-id", runId, ...extra], c.deps);
function answers(c: Ctx, lines: string[]): string {
  const f = path.join(c.base, `answers-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const rw = (c: Ctx, runId: string, file: string | null, extra: string[] = []) =>
  runRewriteLinks(["--run-id", runId, "--runs-dir", c.runs, "--snapshot", c.snap.dir, "--expect-sha256", c.snap.manifestSha256, ...(file ? ["--old-site-links-file", file] : []), ...extra], c.deps);
const bodyOf = (c: Ctx, slug: string) => JSON.stringify(c.central.rows("articles").find((x) => x.slug === slug)?.body);
const updates = (c: Ctx) => c.central.writes.filter((w) => w.op === "update");
function dirDigest(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    h.update(f);
    h.update(statSync(p).isFile() ? readFileSync(p) : "dir");
  }
  return h.digest("hex");
}

test("(1) missing --old-site-links-file is refused (no default)", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    await assert.rejects(() => rw(c, "A", null), /--old-site-links-file/);
  } finally {
    done(c);
  }
});

test("should accept an answer file outside the repo and refuse one inside it (E17)", async () => {
  const c = setup();
  const inside = path.join(repoRoot(), "scripts", "migrate", "out", `vowasia-unit-${process.pid}`);
  try {
    await imp(c, "A", ["--limit", "2"]);
    mkdirSync(inside, { recursive: true });
    const f = path.join(inside, "answers.txt");
    writeFileSync(f, ALL("keep").join("\n") + "\n");
    await assert.rejects(() => rw(c, "A", f), /inside the repository/);
    await assert.rejects(() => rw(c, "A", path.join(c.base, "does-not-exist.txt")), /regular file/);
    await assert.rejects(() => rw(c, "A", c.base), /regular file/);
    assert.equal(await rw(c, "A", answers(c, ALL("keep"))), 0);
  } finally {
    rmSync(inside, { recursive: true, force: true });
    done(c);
  }
});

test("should refuse when a found old-site-article link is missing from the answer file", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    await assert.rejects(() => rw(c, "A", answers(c, ALL().slice(0, 3)), ["--apply"]), /missing from the answer file.*rejected-one/);
    assert.equal(updates(c).length, 0);
    await assert.rejects(() => rw(c, "A", answers(c, [])), /missing/);
  } finally {
    done(c);
  }
});

test("should refuse an answer-file entry that is not in the verified snapshot", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    await assert.rejects(() => rw(c, "A", answers(c, [...ALL(), "links-post https://vowasia.com/article/invented keep"])), /not an old-site-article link of the snapshot/);
    await assert.rejects(() => rw(c, "A", answers(c, [...ALL(), `links-post ${EXT} rewrite`])), /not an old-site-article link of the snapshot/);
    assert.equal(updates(c).length, 0);
  } finally {
    done(c);
  }
});

test("should accept an answer-file entry whose article belongs to another run and ignore it", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "1"]); // body-images-post only (no links)
    assert.equal(await rw(c, "A", answers(c, ALL()), ["--apply"]), 0);
    assert.equal(updates(c).length, 0, "nothing of run A to rewrite");
  } finally {
    done(c);
  }
});

test("(5) malformed line, value other than rewrite|keep, duplicate link -> refused", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    await assert.rejects(() => rw(c, "A", answers(c, [...ALL().slice(0, 3), `links-post ${L4}`])), /malformed/);
    await assert.rejects(() => rw(c, "A", answers(c, [...ALL().slice(0, 3), `links-post ${L4} maybe`])), /malformed/);
    await assert.rejects(() => rw(c, "A", answers(c, [...ALL(), `links-post ${L1} keep`])), /twice/);
    assert.equal(updates(c).length, 0);
  } finally {
    done(c);
  }
});

test("should rewrite to /<pillar>/<slug> only when the target is published and created by the same run; (7)(8)(9)", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]); // body-images-post (published) + links-post
    const before = bodyOf(c, "links-post");
    assert.ok(before.includes(L1));
    const file = answers(c, [`links-post ${L1} rewrite`, `links-post ${L2} rewrite`, `links-post ${L3} keep`, `links-post ${L4} rewrite`]);
    assert.equal(await rw(c, "A", file), 0, "dry run");
    const out = c.logs.join("\n");
    assert.match(out, /slug=links-post url=https:\/\/vowasia\.com\/article\/body-images-post decision=rewrite -> "\/venues\/body-images-post"/);
    assert.match(out, /archived-target decision=unchanged \(rewrite asked; target not created by this run\)/);
    assert.match(out, /no-cover-published decision=unchanged \(keep\)/);
    assert.equal(updates(c).length, 0, "dry run writes nothing");
    assert.equal(await rw(c, "A", file, ["--apply"]), 0);
    const after = bodyOf(c, "links-post");
    assert.ok(after.includes("See /venues/body-images-post for the venue"));
    assert.ok(after.includes(L2) && after.includes(L3) && after.includes(L4), "unchanged links kept verbatim");
    assert.ok(after.includes(EXT) && after.includes("https://vowasia.com/about"), "external links never touched");
    const u = updates(c);
    assert.equal(u.length, 1);
    assert.deepEqual(u[0]?.options?.context, { disableRevalidate: true, skipTranslationEnqueue: true, systemWrite: true });
    assert.equal(c.central.rows("articles").find((x) => x.slug === "links-post")?.version, 1, "systemWrite: no version bump");
  } finally {
    done(c);
  }
});

test("rewrite target created by a DIFFERENT run, or not published, stays unchanged with a report line", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "1"]); // body-images-post in run A
    await imp(c, "B"); // links-post and the rest in run B
    assert.equal(await rw(c, "B", answers(c, ALL()), ["--apply"]), 0);
    const after = bodyOf(c, "links-post");
    assert.ok(after.includes(L1), "target of run A: unchanged");
    assert.ok(after.includes(L2), "archived target: unchanged");
    assert.ok(after.includes(L3), "draft (no cover) target: unchanged");
    assert.ok(after.includes(L4), "rejected target: unchanged");
    assert.equal(updates(c).length, 0);
    assert.match(c.logs.join("\n"), /rejected-one decision=unchanged \(rewrite asked; target not created by this run\)/);
  } finally {
    done(c);
  }
});

test("(10) dry-run writes nothing into the run dir; --apply takes the lock", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    const d = dirDigest(path.join(c.runs, "A"));
    assert.equal(await rw(c, "A", answers(c, ALL())), 0);
    assert.equal(dirDigest(path.join(c.runs, "A")), d);
    writeFileSync(path.join(c.runs, LOCK_NAME), JSON.stringify({ pid: 1, runId: "X", mode: "import", startedAt: "" }));
    await assert.rejects(() => rw(c, "A", answers(c, ALL()), ["--apply"]), /held by pid 1/);
  } finally {
    done(c);
  }
});

test("should still delete a rewritten row on rollback --apply of its run", async () => {
  const c = setup();
  try {
    await imp(c, "A", ["--limit", "2"]);
    assert.equal(await rw(c, "A", answers(c, ALL()), ["--apply"]), 0);
    assert.ok(bodyOf(c, "links-post").includes("/venues/body-images-post"));
    assert.equal(await runRollback(["--run-id", "A", "--runs-dir", c.runs, "--apply"], c.deps), 0);
    assert.equal(c.central.rows("articles").some((x) => x.slug === "links-post"), false, "rewritten row deleted");
  } finally {
    done(c);
  }
});
