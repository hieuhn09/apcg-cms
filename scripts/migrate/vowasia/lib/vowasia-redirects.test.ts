import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededCentral } from "../fixtures/vowasia-legacy/fake-central";
import { fixImage, fixtureRows } from "../fixtures/vowasia-legacy/fixture-rows";
import { writeSnapshotFixture } from "../fixtures/vowasia-legacy/snapshot-fixture";
import { runImport } from "./import-vowasia-main";
import { runRedirects } from "./redirects-vowasia-main";
import { buildVowasiaRedirects, type RedirectSource } from "./vowasia-redirects";

const src = (slug: string, oldStatus: string, plan: RedirectSource["plan"]): RedirectSource => ({ legacyId: slug, slug, oldStatus, plan });
const imp = (pillar: string, draftReasons: ("noCover" | "storeFailure")[] = []) => ({ kind: "import" as const, pillar, draftReasons });

test("one case per rule (C3, Q1, Q9)", () => {
  const b = buildVowasiaRedirects(
    [
      src("pub", "published", imp("style")),
      src("arch", "archived", imp("venues")),
      src("nocover-pub", "published", imp("planning", ["noCover"])),
      src("nocover-arch", "archived", imp("planning", ["noCover"])),
      src("old-draft", "draft", imp("style")),
      src("sched", "scheduled", imp("style")),
      src("rej", "rejected", { kind: "skip" }),
      src("bad-shape", "published", { kind: "reject", reason: "titleShape" }),
    ],
    new Map([
      ["pub", "published"], ["arch", "archived"], ["nocover-pub", "draft"], ["nocover-arch", "draft"], ["old-draft", "draft"], ["sched", "draft"],
    ]),
  );
  assert.deepEqual(b.stops, []);
  assert.deepEqual(b.map, {
    "/article/arch": "/venues",
    "/article/nocover-arch": "/planning",
    "/article/nocover-pub": "/planning",
    "/article/pub": "/style/pub",
    "/article/rej": { status: 410 },
  });
  assert.deepEqual(b.noEntry.map((x) => [x.slug, x.reason]).sort(), [["bad-shape", "importerRejected:titleShape"], ["old-draft", "oldDraftOrScheduled"], ["sched", "oldDraftOrScheduled"]]);
  assert.deepEqual(Object.keys(b.map), Object.keys(b.map).sort(), "keys sorted");
});

test("should give an old draft with no cover no map entry", () => {
  const b = buildVowasiaRedirects([src("d", "draft", imp("style", ["noCover"]))], new Map([["d", "draft"]]));
  assert.deepEqual(b.map, {});
  assert.equal(b.noEntry[0]?.reason, "oldDraftOrScheduled");
});

test("should stop and list rows that were published and became draft by a stored-image failure", () => {
  const b = buildVowasiaRedirects([src("s", "published", imp("style", ["storeFailure"])), src("ok", "published", imp("style"))], new Map([["s", "draft"], ["ok", "published"]]));
  assert.deepEqual(b.stops, [{ slug: "s", legacyId: "s", reason: "O-B12" }]);
});

test("should fail coverage when one published row has no entry, however many archived entries exist", () => {
  const sources = [src("p1", "published", imp("style")), src("p2", "published", imp("style")), ...Array.from({ length: 50 }, (_, i) => src(`a${i}`, "archived", imp("venues")))];
  const central = new Map<string, string>([["p1", "published"], ...Array.from({ length: 50 }, (_, i) => [`a${i}`, "archived"] as [string, string])]);
  const b = buildVowasiaRedirects(sources, central);
  assert.deepEqual(b.coverage, { published: 2, publishedWithEntry: 1, ratio: 0.5 });
  assert.ok(b.coverage.ratio <= 1);
  assert.equal(b.counts.archivedToPillar, 50);
  assert.deepEqual(b.noEntry.map((x) => [x.slug, x.reason]), [["p2", "notInCentral"]]);
});

test("real-data shaped split: 12 x 410 + 337 x 308 = 349", () => {
  const sources: RedirectSource[] = [];
  const central = new Map<string, string>();
  for (let i = 0; i < 230; i++) {
    const noCover = i < 5;
    sources.push(src(`p${i}`, "published", imp("style", noCover ? ["noCover"] : [])));
    central.set(`p${i}`, noCover ? "draft" : "published");
  }
  for (let i = 0; i < 107; i++) {
    sources.push(src(`a${i}`, "archived", imp("venues", i < 2 ? ["noCover"] : [])));
    central.set(`a${i}`, i < 2 ? "draft" : "archived");
  }
  for (let i = 0; i < 21; i++) {
    sources.push(src(`d${i}`, "draft", imp("planning", i < 2 ? ["noCover"] : [])));
    central.set(`d${i}`, "draft");
  }
  for (let i = 0; i < 12; i++) sources.push(src(`r${i}`, "rejected", { kind: "skip" }));
  const b = buildVowasiaRedirects(sources, central);
  assert.equal(Object.keys(b.map).length, 349);
  assert.equal(b.counts.gone410, 12);
  assert.equal(b.counts.publishedToArticle + b.counts.archivedToPillar + b.counts.noCoverToPillar, 337);
  assert.deepEqual(b.coverage, { published: 230, publishedWithEntry: 230, ratio: 1 });
  assert.equal(b.noEntry.length, 21);
});

test("after an editor publishes a no-cover row the regenerated map points at the article", () => {
  const b = buildVowasiaRedirects([src("n", "published", imp("style", ["noCover"]))], new Map([["n", "published"]]));
  assert.deepEqual(b.map, { "/article/n": "/style/n" });
});

/* ── CLI part (Central state + snapshot plan) ─────────────────────────── */
async function cli(o: Parameters<typeof writeSnapshotFixture>[1] = {}, extra: string[] = []) {
  const base = mkdtempSync(path.join(os.tmpdir(), "vowasia-redirects-test-"));
  const snap = writeSnapshotFixture(path.join(base, "snap"), o);
  const runs = path.join(base, "runs");
  mkdirSync(runs);
  const s = seededCentral();
  const logs: string[] = [];
  const deps = { env: { DATABASE_URL: "postgres://postgres:password@127.0.0.1:54399/u" }, log: (l: string) => logs.push(l), isTty: true, openPort: async () => s.central, now: () => new Date(s.central.now()) };
  await runImport(["--snapshot", snap.dir, "--runs-dir", runs, "--expect-sha256", snap.manifestSha256, "--apply", "--run-id", "A"], deps);
  const out = path.join(base, "redirects");
  const code = await runRedirects(["--snapshot", snap.dir, "--expect-sha256", snap.manifestSha256, "--out", out, ...extra], deps);
  return { base, out, code, logs, snap, writes: s.central.writes.length };
}

test("CLI: builds the map from Central state after an import; read-only; fixture split printed", async () => {
  const r = await cli(undefined, ["--min-coverage", "100"]);
  try {
    assert.equal(r.code, 0, r.logs.join("\n"));
    const map = JSON.parse(readFileSync(path.join(r.out, "redirect-map.json"), "utf8"));
    const rows = r.snap.rows;
    const rejected = rows.filter((x) => x.status === "rejected").length;
    const pubArch = rows.filter((x) => x.status === "published" || x.status === "archived").length;
    assert.equal(Object.keys(map).length, rejected + pubArch);
    assert.deepEqual(map["/article/rejected-one"], { status: 410 });
    assert.equal(map["/article/no-cover-published"], "/style");
    assert.equal(map["/article/old-draft"], undefined);
    assert.equal(map["/article/no-cover-old-draft"], undefined);
    assert.equal(map["/article/body-images-post"], "/venues/body-images-post");
    assert.match(r.logs.join("\n"), /coverage .*published with an entry .*\(100%\)/);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("CLI: an O-B12 row stops the builder (exit 3) and writes no map", async () => {
  const r = await cli({ rows: fixtureRows({ bulk: 60 }), failUrls: [fixImage("cover-100.jpg")] });
  try {
    assert.equal(r.code, 3);
    assert.equal(existsSync(path.join(r.out, "redirect-map.json")), false);
    assert.match(r.logs.join("\n"), /O-B12/);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});
