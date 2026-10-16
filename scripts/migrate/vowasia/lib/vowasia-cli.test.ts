import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, DEFAULT_OUT, DEFAULT_SOURCE, failureOf, parseDiscover, redact, runMain } from "./vowasia-cli";
import { ConfigError, CONFIG_MESSAGES } from "./vowasia-config";
import { existsSync } from "node:fs";

const PW = "Zx9-very-secret-pw";
const ENV = { LEGACY_VOWASIA_DB_URL: `postgres://vowasia_migrator:${PW}@db.example.invalid:5432/legacy` };

async function run(fn: () => Promise<number | void>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let code = -1;
  await runMain("discover", fn, { exit: (c) => (code = c), error: (l) => lines.push(l), env: ENV });
  return { code, lines };
}

test("T6a: runMain exits 0 on success and passes an explicit code through", async () => {
  assert.deepEqual(await run(async () => {}), { code: 0, lines: [] });
  assert.equal((await run(async () => 0)).code, 0);
});

test("T6a: a deliberate refusal exits 2 with its fixed message", async () => {
  const r = await run(async () => {
    throw new ConfigError(CONFIG_MESSAGES.noSiteFilter);
  });
  assert.equal(r.code, 2);
  assert.deepEqual(r.lines, [`[discover] ${CONFIG_MESSAGES.noSiteFilter}`]);
  assert.equal((await run(async () => parseDiscover(["--nope"]) as never)).code, 2);
  assert.equal((await run(async () => { throw new CliError("cli: x", 2); })).code, 2);
});

test("T6a: any other error exits 1 and never prints the URL or the password", async () => {
  const r = await run(async () => {
    throw new Error(`connect failed for ${ENV.LEGACY_VOWASIA_DB_URL} (password ${PW})`);
  });
  assert.equal(r.code, 1);
  const out = r.lines.join("\n");
  assert.ok(out.startsWith("[discover] failed: "));
  assert.ok(!out.includes(PW), out);
  assert.ok(!out.includes("postgres://"), out);
  assert.ok(!out.includes("vowasia_migrator:"), out);
});

test("redact covers URL-like text, the env URL and an URL-encoded password", () => {
  const enc = { LEGACY_VOWASIA_DB_URL: "postgres://u:p%40ss%2Fword@h/db" };
  assert.equal(redact("x p@ss/word y", enc), "x <redacted> y");
  assert.equal(redact("see postgresql://a:b@c/d now", {}), "see <url> now");
  assert.equal(failureOf("x", new Error(`legacy: bad ${PW}`), ENV).line, "[x] legacy: bad <redacted>");
});

test("discover flags: the URL is never a flag; defaults point at the repo", () => {
  assert.throws(() => parseDiscover(["--url", "x"]), CliError);
  assert.throws(() => parseDiscover(["--apply"]), CliError);
  const a = parseDiscover(["--mapping-overlay", "/tmp/o.json", "--sample", "3"]);
  assert.equal(a.get("mapping-overlay"), "/tmp/o.json");
  assert.ok(existsSync(DEFAULT_SOURCE));
  assert.ok(DEFAULT_OUT.endsWith("scripts/migrate/out/vowasia"));
});
