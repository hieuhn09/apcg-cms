import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral, type FakeCentral } from "../fixtures/vowasia-legacy/fake-central";
import { writeSnapshotFixture, type SnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { runImport, type ImportDeps } from "./import-vowasia-main";
import { runVerify } from "./verify-vowasia-main";

const LOCAL = "postgres://postgres:password@127.0.0.1:54399/vowasia_unit";
interface Ctx { base: string; snap: SnapshotFixture; runs: string; central: FakeCentral; otherTenantId: number | string; logs: string[]; deps: ImportDeps }
function setup(): Ctx {
  const base = mkdtempSync(path.join(os.tmpdir(), "vowasia-verify-test-"));
  const snap = writeSnapshotFixture(path.join(base, "snap"));
  const runs = path.join(base, "runs");
  mkdirSync(runs, { mode: 0o700 });
  const s = seededCentral();
  const logs: string[] = [];
  return { base, snap, runs, central: s.central, otherTenantId: s.otherTenantId, logs, deps: { env: { DATABASE_URL: LOCAL }, log: (l) => logs.push(l), isTty: true, openPort: async () => s.central, now: () => new Date(s.central.now()) } };
}
const done = (c: Ctx) => rmSync(c.base, { recursive: true, force: true });
const all = async (c: Ctx) => {
  assert.equal(await runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, "--apply", "--run-id", "A", "--limit", "7"], c.deps), 0);
  assert.equal(await runImport(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256, "--apply", "--run-id", "B"], c.deps), 0);
};
const verify = (c: Ctx) => runVerify(["--snapshot", c.snap.dir, "--runs-dir", c.runs, "--expect-sha256", c.snap.manifestSha256], c.deps);

test("verify passes after a complete import (counts, author, uploads, hosts, slug-map)", async () => {
  const c = setup();
  try {
    await all(c);
    assert.equal(await verify(c), 0, c.logs.slice(-15).join("\n"));
    assert.match(c.logs.join("\n"), /VERIFY OK/);
    assert.equal(c.central.writes.filter((w) => w.op !== "create").length, 0, "verify is read-only");
  } finally {
    done(c);
  }
});

test("should fail verify when an upload node points at a Media outside tenant vowasia", async () => {
  const c = setup();
  try {
    await all(c);
    const foreign = c.central.seed("media", { tenant: c.otherTenantId, filename: "x.jpg", prefix: "gtp" });
    const a = c.central.rows("articles").find((x) => x.slug === "body-images-post") as Record<string, unknown>;
    const s = JSON.parse(JSON.stringify(a.body));
    s.root.children.find((n: { type: string }) => n.type === "upload").value = foreign.id;
    a.body = s;
    assert.equal(await verify(c), 3);
    assert.match(c.logs.join("\n"), /upload node .* not a tenant-vowasia Media/);
  } finally {
    done(c);
  }
});

test("verify fails on an old image host in a body, a missing article, and a status mismatch", async () => {
  const c = setup();
  try {
    await all(c);
    const a = c.central.rows("articles").find((x) => x.slug === "escape-post") as Record<string, unknown>;
    const s = JSON.parse(JSON.stringify(a.body));
    s.root.children[1].children[0].text = "see https://img.vowasia-fixture.invalid/storage/v1/object/public/media/x.jpg";
    a.body = s;
    const gone = c.central.rows("articles").findIndex((x) => x.slug === "honeymoon-post");
    c.central.rows("articles").splice(gone, 1);
    const st = c.central.rows("articles").find((x) => x.slug === "ring-post") as Record<string, unknown>;
    st.workflowStatus = "archived";
    assert.equal(await verify(c), 3);
    const out = c.logs.join("\n");
    assert.match(out, /escape-post: old image host/);
    assert.match(out, /honeymoon-post: missing in Central/);
    assert.match(out, /ring-post: status archived, planned published/);
  } finally {
    done(c);
  }
});
