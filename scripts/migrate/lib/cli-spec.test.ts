import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ARG_MESSAGES, CliError, parseArgs } from "./args";
import {
  CLI_MESSAGES, CLI_SPEC, FIXTURE_SITE_ID, HOOK_MESSAGE, STRUCTURAL_MAPPING_PATH, parseCommand, resolveEntity, resolveMappingPath,
  resolveReadToken, resolveRehearsal, resolveRequireFinal, resolveSiteFilter, resolveTestHooks, type Command,
} from "./cli-spec";
import { repoRoot } from "./out-dir";

const REAL_LIKE = "11111111-2222-4333-8444-555555555555";

test("C3/G30: parseArgs default is a dry run; --apply opts in; both = exit 2; unknown flag = exit 2", () => {
  const spec = { apply: "bool", "dry-run": "bool", limit: "value" } as const;
  assert.equal(parseArgs([], spec).apply, false);
  assert.equal(parseArgs([], spec).dryRun, true);
  assert.equal(parseArgs(["--apply"], spec).apply, true);
  assert.equal(parseArgs(["--dry-run"], spec).apply, false);
  assert.throws(() => parseArgs(["--apply", "--dry-run"], spec), (e: unknown) => e instanceof CliError && e.exitCode === 2 && e.message === ARG_MESSAGES.applyAndDry);
  assert.throws(() => parseArgs(["--nope"], spec), { message: ARG_MESSAGES.unknown("--nope") });
  assert.equal(parseArgs(["--limit=5"], spec).get("limit"), "5");
  assert.equal(parseArgs(["--limit", "6"], spec).get("limit"), "6");
  assert.throws(() => parseArgs(["--limit"], spec), CliError);
});

test("C3/G30: no new gtp migration script imports DRY_RUN from scripts/lib/env", () => {
  const dir = path.join(repoRoot(), "scripts/migrate");
  const files = [
    ...readdirSync(dir).filter((f) => /gtp|legacy-pg|discover/.test(f) && f.endsWith(".ts")).map((f) => path.join(dir, f)),
    ...readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, "lib", f)),
  ];
  assert.ok(files.length > 3);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (f.endsWith("cli-spec.test.ts")) continue;
    assert.doesNotMatch(src, /import\s*\{[^}]*\bDRY_RUN\b[^}]*\}\s*from\s*["'][./]*lib\/env["']/, f);
  }
});

type Case = { command: Command; argv: string[]; t: { centralLocal?: boolean; publicBaseLocal?: boolean; siteFilter?: string }; requireFinal: boolean; implied: boolean };
const CASES: Case[] = [
  { command: "import", argv: [], t: { centralLocal: false, siteFilter: REAL_LIKE }, requireFinal: true, implied: true },
  { command: "import", argv: [], t: { centralLocal: true, siteFilter: FIXTURE_SITE_ID }, requireFinal: false, implied: false },
  { command: "import", argv: ["--require-final"], t: { centralLocal: true, siteFilter: FIXTURE_SITE_ID }, requireFinal: true, implied: false },
  { command: "rewrite-links", argv: [], t: { centralLocal: false }, requireFinal: true, implied: true },
  { command: "rollback", argv: [], t: { centralLocal: false }, requireFinal: false, implied: false },
  { command: "redirects", argv: [], t: { siteFilter: REAL_LIKE }, requireFinal: true, implied: true },
  { command: "redirects", argv: ["--rehearsal"], t: { siteFilter: FIXTURE_SITE_ID }, requireFinal: false, implied: false },
  { command: "verify", argv: [], t: { centralLocal: true, publicBaseLocal: false }, requireFinal: true, implied: true },
  { command: "verify", argv: [], t: { centralLocal: true, publicBaseLocal: true }, requireFinal: false, implied: false },
  { command: "validate-mapping", argv: ["--require-final"], t: {}, requireFinal: true, implied: false },
  { command: "discover", argv: [], t: {}, requireFinal: false, implied: false },
  { command: "export", argv: [], t: {}, requireFinal: false, implied: false },
];

test("C2/G46 (A13-R02): implied or opt-in --require-final per command", () => {
  for (const c of CASES) {
    const r = resolveRequireFinal(c.command, parseCommand(c.command, c.argv), c.t);
    assert.deepEqual(r, { requireFinal: c.requireFinal, implied: c.implied }, `${c.command} ${c.argv.join(" ")}`);
  }
  // rollback is never blocked even when asked by a mistaken caller
  assert.throws(() => parseCommand("rollback", ["--require-final"]), CliError);
});

test("C2/G46: --rehearsal accepted only for the fixture site id or a local Central", () => {
  assert.equal(resolveRehearsal("redirects", parseCommand("redirects", ["--rehearsal"]), { siteFilter: FIXTURE_SITE_ID }), true);
  assert.throws(() => resolveRehearsal("redirects", parseCommand("redirects", ["--rehearsal"]), { siteFilter: REAL_LIKE }), { message: CLI_MESSAGES.rehearsalRefused });
  assert.equal(resolveRehearsal("import", parseCommand("import", ["--rehearsal"]), { centralLocal: true, siteFilter: REAL_LIKE }), true);
  assert.throws(() => resolveRehearsal("import", parseCommand("import", ["--rehearsal"]), { centralLocal: false, siteFilter: REAL_LIKE }), { message: CLI_MESSAGES.rehearsalRefused });
  assert.equal(resolveRehearsal("rewrite-links", parseCommand("rewrite-links", ["--rehearsal"]), { centralLocal: true }), true);
  assert.equal(resolveRehearsal("verify", parseCommand("verify", ["--rehearsal"]), { centralLocal: false, siteFilter: FIXTURE_SITE_ID }), true);
  assert.throws(() => parseCommand("discover", ["--rehearsal"]), CliError);
  assert.throws(() => parseCommand("rollback", ["--rehearsal"]), CliError);
});

test("C2/G46: discover / export / snapshot-dir require a site filter source (uuid; equal when both)", () => {
  for (const cmd of ["discover", "export"] as const) {
    assert.throws(() => resolveSiteFilter(parseCommand(cmd, []), undefined), { message: CLI_MESSAGES.siteFilterMissing });
    assert.equal(resolveSiteFilter(parseCommand(cmd, ["--site-id", FIXTURE_SITE_ID]), undefined), FIXTURE_SITE_ID);
    assert.equal(resolveSiteFilter(parseCommand(cmd, []), FIXTURE_SITE_ID), FIXTURE_SITE_ID);
    assert.throws(() => resolveSiteFilter(parseCommand(cmd, ["--site-id", REAL_LIKE]), FIXTURE_SITE_ID), { message: CLI_MESSAGES.siteFilterMismatch });
    assert.throws(() => resolveSiteFilter(parseCommand(cmd, ["--site-id", "gtp"]), undefined), { message: CLI_MESSAGES.siteFilterNotUuid });
  }
  assert.ok("snapshot-dir" in CLI_SPEC.discover && "snapshot-dir" in CLI_SPEC.import);
});

test("C2/G46: --entity default is all; bad value refused", () => {
  assert.equal(resolveEntity(parseCommand("import", [])), "all");
  assert.equal(resolveEntity(parseCommand("import", ["--entity", "events"])), "events");
  assert.throws(() => resolveEntity(parseCommand("import", ["--entity", "subscribers"])), { message: CLI_MESSAGES.entityBad });
});

test("C2/G46: verify read token: env preferred; argv wins with a warning; neither with --public-base = exit 2", () => {
  const p = (argv: string[]) => parseCommand("verify", argv);
  assert.deepEqual(resolveReadToken(p(["--public-base", "http://localhost:3508"]), { GTP_READ_TOKEN: "e" }), { token: "e" });
  assert.deepEqual(resolveReadToken(p(["--public-base", "http://x", "--read-token", "a"]), { GTP_READ_TOKEN: "e" }), { token: "a", warning: CLI_MESSAGES.tokenArgvWarning });
  assert.throws(() => resolveReadToken(p(["--public-base", "http://x"]), {}), { message: CLI_MESSAGES.tokenMissing });
  assert.deepEqual(resolveReadToken(p([]), {}), { token: undefined });
});

test("E17: --mapping defaults to the committed structural file for discover, redirects and verify", () => {
  for (const c of ["discover", "redirects", "verify"] as const) assert.equal(resolveMappingPath(c, parseCommand(c, [])), STRUCTURAL_MAPPING_PATH);
  assert.equal(resolveMappingPath("rollback", parseCommand("rollback", [])), undefined);
});

test("C3/G48 (A13-R08): MIGRATE_TEST_KILL_* refused for a non-local Central and honoured locally", () => {
  assert.throws(() => resolveTestHooks({ MIGRATE_TEST_KILL_AFTER: "3" }, false), { message: HOOK_MESSAGE });
  assert.throws(() => resolveTestHooks({ MIGRATE_TEST_KILL_BEFORE_JOURNAL: "3" }, false), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  assert.deepEqual(resolveTestHooks({ MIGRATE_TEST_KILL_AFTER: "37" }, true), { killAfter: 37 });
  assert.throws(() => resolveTestHooks({ MIGRATE_TEST_KILL_AFTER_MEDIA_UPLOAD: "1" }, false), { message: HOOK_MESSAGE });
  assert.deepEqual(resolveTestHooks({}, false), {});
});
