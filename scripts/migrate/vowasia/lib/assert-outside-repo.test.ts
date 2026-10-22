import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertOutsideRepo, OUTSIDE_REPO_MESSAGES } from "./assert-outside-repo";
import { repoRoot } from "./out-dir";

const HERE = path.dirname(new URL(import.meta.url).pathname);

test("should refuse a snapshot --out inside the repo even when git-ignored", () => {
  // scripts/migrate/out/ is git-ignored (assertOutDirSafe accepts it); the strict guard must not.
  const ignored = path.resolve(HERE, "..", "..", "out", "vowasia-outside-repo-probe");
  try {
    assert.throws(() => assertOutsideRepo(ignored), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.equal(existsSync(ignored), false, "refused BEFORE creating anything");
  } finally {
    rmSync(ignored, { recursive: true, force: true });
  }
});

test("assertOutsideRepo refuses the repo root itself and a non-ignored in-repo dir", () => {
  assert.throws(() => assertOutsideRepo(repoRoot()), { message: OUTSIDE_REPO_MESSAGES.inside });
  assert.throws(() => assertOutsideRepo(path.join(repoRoot(), "process", "x")), { message: OUTSIDE_REPO_MESSAGES.inside });
});

test("assertOutsideRepo refuses a symlink outside the repo that points into the repo (and a path below it)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-"));
  try {
    const link = path.join(tmp, "link-into-repo");
    symlinkSync(path.join(repoRoot(), "scripts"), link);
    assert.throws(() => assertOutsideRepo(link), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.throws(() => assertOutsideRepo(path.join(link, "not", "yet", "there")), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.equal(existsSync(path.join(repoRoot(), "scripts", "not")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertOutsideRepo accepts a not-yet-existing dir outside the repo and creates it mode 700", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-"));
  try {
    const dir = path.join(tmp, "a", "b");
    const abs = assertOutsideRepo(dir);
    assert.equal(abs, path.resolve(dir));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(tmp, "a")).mode & 0o777, 0o700);
    // An existing dir keeps its own mode and is accepted again.
    mkdirSync(path.join(tmp, "c"), { mode: 0o755 });
    const before = statSync(path.join(tmp, "c")).mode & 0o777;
    assertOutsideRepo(path.join(tmp, "c"));
    assert.equal(statSync(path.join(tmp, "c")).mode & 0o777, before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertOutsideRepo refuses a relative path that resolves into the repo", () => {
  const prev = process.cwd();
  try {
    process.chdir(repoRoot());
    assert.throws(() => assertOutsideRepo("scripts/migrate/out/x"), { message: OUTSIDE_REPO_MESSAGES.inside });
  } finally {
    process.chdir(prev);
  }
});

/* ── Fix cycle 1 (G22 review M1-M3, N3) ────────────────────────────────── */

test("M1: a sibling dir of the repo whose name starts with '..' is not treated as outside", () => {
  // `<root>/..hidden/x` is INSIDE the root; a bare `rel.startsWith("..")` check let it through.
  const root = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-root-"));
  try {
    assert.throws(() => assertOutsideRepo(path.join(root, "..hidden", "x"), root), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.throws(() => assertOutsideRepo(path.join(root, "..x"), root), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.equal(existsSync(path.join(root, "..hidden")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M2: refuses by (dev, ino) of the ancestors even when the path string does not canonicalise (case-insensitive FS)", () => {
  // Simulate macOS: a realpath that keeps the spelling given (no canonical case), so only the
  // inode comparison of the ancestor chain can see that `alias` IS the repo root.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-"));
  try {
    const root = path.join(tmp, "Repo");
    mkdirSync(root);
    const alias = path.join(tmp, "alias");
    symlinkSync(root, alias);
    const opts = { realpath: (p: string) => p, git: () => ({ status: 128, stderr: "fatal: not a git repository" }) };
    assert.throws(() => assertOutsideRepo(path.join(alias, "out", "x"), root, opts), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.throws(() => assertOutsideRepo(alias, root, opts), { message: OUTSIDE_REPO_MESSAGES.inside });
    assert.equal(existsSync(path.join(root, "out")), false);
    // an unrelated dir is still accepted with the same options
    assert.equal(assertOutsideRepo(path.join(tmp, "other"), root, opts), path.join(tmp, "other"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("M3: refuses any git working tree (another checkout, a sibling worktree, a dotfiles repo)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-git-"));
  try {
    const other = path.join(tmp, "other-checkout");
    mkdirSync(other);
    const r = spawnSync("git", ["init", "-q", other], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.throws(() => assertOutsideRepo(path.join(other, "snap")), { message: OUTSIDE_REPO_MESSAGES.insideGit });
    assert.throws(() => assertOutsideRepo(path.join(other, "a", "b")), { message: OUTSIDE_REPO_MESSAGES.insideGit });
    assert.equal(existsSync(path.join(other, "snap")), false);
    assert.match(OUTSIDE_REPO_MESSAGES.insideGit, /dotfiles/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("M3: fails closed on a git error other than 'not a git repository'", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-"));
  const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-root-"));
  try {
    const dubious = { git: () => ({ status: 128, stderr: "fatal: detected dubious ownership in repository" }) };
    assert.throws(() => assertOutsideRepo(path.join(tmp, "x"), fakeRoot, dubious), { message: OUTSIDE_REPO_MESSAGES.gitError });
    const missing = { git: () => ({ status: null, stderr: "", error: new Error("spawn git ENOENT") }) };
    assert.throws(() => assertOutsideRepo(path.join(tmp, "x"), fakeRoot, missing), { message: OUTSIDE_REPO_MESSAGES.gitError });
    assert.equal(existsSync(path.join(tmp, "x")), false);
    const notRepo = { git: () => ({ status: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }) };
    assert.equal(assertOutsideRepo(path.join(tmp, "x"), fakeRoot, notRepo), path.join(tmp, "x"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("N3: { create: false } checks without creating anything", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vowasia-oor-"));
  try {
    const dir = path.join(tmp, "a", "b");
    assert.equal(assertOutsideRepo(dir, repoRoot(), { create: false }), dir);
    assert.equal(existsSync(path.join(tmp, "a")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
