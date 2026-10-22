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

test("G9 #4: redact masks the Supabase project ref (pooler login name, direct host)", () => {
  const msg = 'password authentication failed for user "vowasia_migrator.abcdefghijklmnopqrst" at db.abcdefghijklmnopqrst.supabase.co';
  const out = redact(msg, {});
  assert.ok(!out.includes("abcdefghijklmnopqrst"), out);
  assert.equal(out, 'password authentication failed for user "vowasia_migrator.<ref>" at db.<ref>.supabase.co');
  assert.ok(!failureOf("x", new Error(msg), {}).line.includes("abcdefghijklmnopqrst"));
});

test("discover flags: the URL is never a flag; defaults point at the repo", () => {
  assert.throws(() => parseDiscover(["--url", "x"]), CliError);
  assert.throws(() => parseDiscover(["--apply"]), CliError);
  assert.throws(() => parseDiscover(["--site-id", "1"]), CliError, "m9: the site id comes only from the overlay outside the repo");
  const a = parseDiscover(["--mapping-overlay", "/tmp/o.json", "--sample", "3"]);
  assert.equal(a.get("mapping-overlay"), "/tmp/o.json");
  assert.ok(existsSync(DEFAULT_SOURCE));
  assert.ok(DEFAULT_OUT.endsWith("scripts/migrate/out/vowasia"));
});

test("F-3: redact masks the Central DATABASE_URL password and the four R2 values when set", () => {
  const env = { DATABASE_URL: "postgres://owner:CentralFakePw123@central.example.invalid:5432/neondb", R2_BUCKET: "fake-bucket-xyz", R2_ENDPOINT: "https://acct.r2.example.invalid", R2_ACCESS_KEY_ID: "R2FAKEACCESSKEYID000", R2_SECRET_ACCESS_KEY: "r2FakeSecret/abc+def" };
  const out = redact("pw CentralFakePw123 b fake-bucket-xyz e acct.r2.example.invalid k R2FAKEACCESSKEYID000 s r2FakeSecret/abc+def", env);
  for (const s of ["CentralFakePw123", "fake-bucket-xyz", "acct.r2.example.invalid", "R2FAKEACCESSKEYID000", "r2FakeSecret/abc+def"]) assert.ok(!out.includes(s), out);
  assert.equal(redact("nothing here", {}), "nothing here");
});
