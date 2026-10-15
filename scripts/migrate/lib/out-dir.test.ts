import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertOutDirSafe, OUT_DIR_MESSAGES, repoRoot, writeFileSafe, FsyncJournal } from "./out-dir";

test("G32: scripts/migrate/out is git-ignored", () => {
  execFileSync("git", ["-C", repoRoot(), "check-ignore", "-q", "--", "scripts/migrate/out/x"]);
});

test("G32: an in-repo NON-ignored directory is refused before anything is written", () => {
  const dir = path.join(repoRoot(), "scripts", "migrate", "not-ignored-probe-dir");
  assert.throws(() => assertOutDirSafe(dir), { message: OUT_DIR_MESSAGES.notIgnored });
  assert.equal(existsSync(dir), false);
});

test("G32: an ignored in-repo dir and an outside dir are accepted, mode 700; files mode 600", () => {
  const inside = path.join(repoRoot(), "scripts", "migrate", "out", "unit-test-out-dir");
  const abs = assertOutDirSafe(inside);
  assert.equal(statSync(abs).mode & 0o777, 0o700);
  const f = path.join(abs, "x.json");
  writeFileSafe(f, "{}");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const j = new FsyncJournal(path.join(abs, "j.ndjson"));
  j.append({ a: 1 });
  j.close();
  assert.equal(statSync(path.join(abs, "j.ndjson")).mode & 0o777, 0o600);
  rmSync(abs, { recursive: true, force: true });
  const outside = mkdtempSync(path.join(os.tmpdir(), "gtp-out-"));
  assert.equal(statSync(assertOutDirSafe(outside)).mode & 0o777, 0o700);
  rmSync(outside, { recursive: true, force: true });
});
