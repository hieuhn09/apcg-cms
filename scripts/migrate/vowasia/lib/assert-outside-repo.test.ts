import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
