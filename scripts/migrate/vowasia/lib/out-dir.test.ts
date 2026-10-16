import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertOutDirSafe, FsyncJournal, OUT_DIR_MESSAGES, repoRoot, writeFileSafe } from "./out-dir";

// Built from this file's own location, NOT from repoRoot(): scripts/migrate/vowasia/lib -> 4 levels up.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const TRUE_ROOT = path.resolve(HERE, "..", "..", "..", "..");

test("T1(a): repoRoot() is the directory holding both package.json and .git", () => {
  const r = repoRoot();
  assert.ok(existsSync(path.join(r, "package.json")), "package.json missing at repoRoot()");
  assert.ok(existsSync(path.join(r, ".git")), ".git missing at repoRoot()");
  assert.equal(r, TRUE_ROOT);
});

test("T1(b): an in-repo, non-ignored dir OUTSIDE scripts/ is refused before it is created", () => {
  const dir = path.resolve(HERE, "..", "..", "..", "..", "process", "vowasia-guard-probe");
  try {
    assert.throws(() => assertOutDirSafe(dir), { message: OUT_DIR_MESSAGES.notIgnored });
    assert.equal(existsSync(dir), false, "the guard must refuse BEFORE creating the directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T1(c): a dir under scripts/migrate/out/ is accepted, mode 700; files mode 600", () => {
  const inside = path.resolve(HERE, "..", "..", "out", "vowasia-unit-test-out-dir");
  try {
    const abs = assertOutDirSafe(inside);
    assert.equal(statSync(abs).mode & 0o777, 0o700);
    const f = path.join(abs, "x.json");
    writeFileSafe(f, "{}");
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const j = new FsyncJournal(path.join(abs, "j.ndjson"));
    j.append({ a: 1 });
    j.close();
    assert.equal(statSync(path.join(abs, "j.ndjson")).mode & 0o777, 0o600);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
  // The CLI default out dir is built from repoRoot(); it must be the real, git-ignored scripts/migrate/out.
  const viaRoot = path.join(repoRoot(), "scripts", "migrate", "out", "vowasia-unit-test-out-dir-2");
  try {
    assert.equal(path.dirname(viaRoot), path.resolve(HERE, "..", "..", "out"));
    assert.equal(statSync(assertOutDirSafe(viaRoot)).mode & 0o777, 0o700);
  } finally {
    rmSync(viaRoot, { recursive: true, force: true });
  }
});

test("an outside-repo dir is accepted, mode 700", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "vowasia-out-"));
  try {
    assert.equal(statSync(assertOutDirSafe(outside)).mode & 0o777, 0o700);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
