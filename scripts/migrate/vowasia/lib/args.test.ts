import { test } from "node:test";
import assert from "node:assert/strict";
import { ARG_MESSAGES, CliError, intFlag, parseArgs } from "./args";

const SPEC = { "mapping-overlay": "value", out: "value", sample: "value", apply: "bool", "dry-run": "bool" } as const;

test("dry run by default; --x v and --x=v both parse", () => {
  const a = parseArgs(["--mapping-overlay", "/tmp/o.json", "--out=/tmp/x"], SPEC);
  assert.equal(a.apply, false);
  assert.equal(a.dryRun, true);
  assert.equal(a.get("mapping-overlay"), "/tmp/o.json");
  assert.equal(a.get("out"), "/tmp/x");
  assert.equal(a.has("sample"), false);
});

test("unknown flags, positionals, missing values and --apply with --dry-run are refused (exit 2)", () => {
  assert.throws(() => parseArgs(["--site"], SPEC), { message: ARG_MESSAGES.unknown("--site") });
  assert.throws(() => parseArgs(["x"], SPEC), { message: ARG_MESSAGES.positional });
  assert.throws(() => parseArgs(["--out"], SPEC), { message: ARG_MESSAGES.missingValue("--out") });
  assert.throws(() => parseArgs(["--out", "--sample"], SPEC), { message: ARG_MESSAGES.missingValue("--out") });
  assert.throws(() => parseArgs(["--out="], SPEC), { message: ARG_MESSAGES.missingValue("--out") });
  assert.throws(() => parseArgs(["--apply=1"], SPEC), { message: ARG_MESSAGES.unexpectedValue("--apply") });
  assert.throws(() => parseArgs(["--apply", "--dry-run"], SPEC), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

test("intFlag: positive integers only", () => {
  assert.equal(intFlag(parseArgs(["--sample", "7"], SPEC), "sample", 5), 7);
  assert.equal(intFlag(parseArgs([], SPEC), "sample", 5), 5);
  for (const v of ["0", "-1", "1.5", "x"]) assert.throws(() => intFlag(parseArgs(["--sample", v], SPEC), "sample"), CliError, v);
});
