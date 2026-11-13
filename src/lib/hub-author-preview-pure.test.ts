/**
 * Unit tests for ./hub-author-preview-pure (APCGHub P5.6, chặng 1 — P01–P10).
 * Node's built-in runner; no database, no network. A throwaway signing secret is set
 * per test (random bytes, never a real secret).
 *
 *   npm run test:hub-p56
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  PREVIEW_TTL_SECONDS,
  buildPreviewUrl,
  checkFrontendUrl,
  hasPreviewSlug,
  parsePreviewBody,
  previewClaims,
  previewResponse,
} from "./hub-author-preview-pure";
import { parsePublishBody } from "./hub-author-input";
import { signPayload, verifySigned } from "./crypto";
import { isHubArticleId } from "./hub-article-id";

const ACTOR = { email: "ed@example.invalid", role: "editor" } as const;
const withSecret = <T>(fn: (secret: string) => T): T => {
  const prev = process.env.CENTRAL_SIGNING_SECRET;
  const s = randomBytes(24).toString("hex");
  process.env.CENTRAL_SIGNING_SECRET = s;
  try {
    return fn(s);
  } finally {
    if (prev === undefined) delete process.env.CENTRAL_SIGNING_SECRET;
    else process.env.CENTRAL_SIGNING_SECRET = prev;
  }
};

test("P01 TTL is 600 and the claims carry exactly {tenant, slug, draft:true, exp}", () => {
  assert.equal(PREVIEW_TTL_SECONDS, 600);
  const c = previewClaims("gcv", "a-slug", 1_000_000);
  assert.deepEqual(Object.keys(c).sort(), ["draft", "exp", "slug", "tenant"]);
  assert.deepEqual(c, { tenant: "gcv", slug: "a-slug", draft: true, exp: 1_000_600 });
});

test("P02 token round trip through the existing verifier", async (t) => {
  const now = 2_000_000;
  await t.test("accepted at now+599", () =>
    withSecret(() => {
      const tok = signPayload(previewClaims("gcv", "s", now));
      assert.deepEqual(verifySigned(tok, now + 599), { tenant: "gcv", slug: "s", draft: true, exp: now + 600 });
    }));
  await t.test("refused at now+601", () =>
    withSecret(() => assert.equal(verifySigned(signPayload(previewClaims("gcv", "s", now)), now + 601), null)));
  await t.test("refused with one signature byte flipped", () =>
    withSecret(() => {
      const tok = signPayload(previewClaims("gcv", "s", now));
      const last = tok.slice(-1);
      const bad = tok.slice(0, -1) + (last === "A" ? "B" : "A");
      assert.equal(verifySigned(bad, now), null);
    }));
  await t.test("refused under another secret", () => {
    const tok = withSecret(() => signPayload(previewClaims("gcv", "s", now)));
    withSecret(() => assert.equal(verifySigned(tok, now), null));
  });
});

test("P03 parsePreviewBody accepts exactly {tenant, actor}", async (t) => {
  await t.test("ok", () => {
    const r = parsePreviewBody({ tenant: " gcv ", actor: { ...ACTOR, id: "u1" } });
    assert.deepEqual(r, { ok: true, value: { tenant: "gcv", actor: { ...ACTOR, id: "u1" } } });
  });
  await t.test("unknown root key ⇒ 400", () => {
    const r = parsePreviewBody({ tenant: "gcv", actor: ACTOR, extra: 1 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
  });
  await t.test("unknown actor key ⇒ 400", () => {
    const r = parsePreviewBody({ tenant: "gcv", actor: { ...ACTOR, name: "x" } });
    assert.equal(!r.ok && r.status, 400);
    assert.match(String(!r.ok && r.body.reason), /actor\.name/);
  });
  await t.test("not an object / no tenant ⇒ 400", () => {
    for (const raw of [null, [], "x", 5, { actor: ACTOR }, { tenant: "  ", actor: ACTOR }, { tenant: 3, actor: ACTOR }]) {
      const r = parsePreviewBody(raw);
      assert.equal(!r.ok && r.status, 400, JSON.stringify(raw));
    }
  });
  await t.test("actor missing / wrong type / wrong shape ⇒ 422 fields.actor.*", () => {
    const cases: [unknown, string, string][] = [
      [undefined, "actor", "required"],
      ["x", "actor", "type"],
      [{ role: "editor" }, "actor.email", "required"],
      [{ email: "nope", role: "editor" }, "actor.email", "format"],
      [{ email: "a@b.c", role: "viewer" }, "actor.role", "format"],
      [{ email: "a@b.c", role: "editor", id: {} }, "actor.id", "type"],
    ];
    for (const [actor, field, code] of cases) {
      const raw: Record<string, unknown> = { tenant: "gcv" };
      if (actor !== undefined) raw.actor = actor;
      const r = parsePreviewBody(raw);
      assert.equal(!r.ok && r.status, 422, JSON.stringify(actor));
      assert.equal(r.ok ? undefined : (r.body.fields as Record<string, string>)[field], code);
    }
  });
  await t.test("slug / ttl in the body ⇒ 400", () => {
    for (const k of ["slug", "ttl"]) {
      const r = parsePreviewBody({ tenant: "gcv", actor: ACTOR, [k]: "abc" });
      assert.equal(!r.ok && r.status, 400);
    }
  });
});

test("P04 the actor block matches parsePublishBody on 14 samples", () => {
  const samples: unknown[] = [
    ACTOR,
    { email: "a@b.co", role: "admin" },
    { email: "a@b.co", role: "marketer", id: 7 },
    { email: "a@b.co", role: "editor", id: "x".repeat(64) },
    { email: "a@b.co", role: "editor", id: "x".repeat(65) },
    { email: "a@b.co", role: "editor", id: 12345678901234567890 },
    { email: "", role: "editor" },
    { email: "a b@c.d", role: "editor" },
    { email: `${"a".repeat(250)}@b.cd`, role: "editor" },
    { email: "a@b.c", role: "Editor" },
    { email: "a@b.c" },
    { email: 5, role: "editor" },
    "not-an-object",
    { email: "a\u0000@b.c", role: "editor" },
  ];
  assert.equal(samples.length, 14);
  const pick = (r: { ok: boolean; value?: { actor?: unknown }; body?: Record<string, unknown> }) => {
    if (r.ok) return { actor: r.value?.actor };
    const fields = (r.body?.fields ?? {}) as Record<string, string>;
    return { errors: Object.fromEntries(Object.entries(fields).filter(([k]) => k === "actor" || k.startsWith("actor."))) };
  };
  for (const actor of samples) {
    const a = pick(parsePreviewBody({ tenant: "gcv", actor }) as never);
    const p = pick(parsePublishBody({ tenant: "gcv", actor, expectedVersion: 1 }) as never);
    assert.deepEqual(a, p, JSON.stringify(actor));
  }
});

test("P05 buildPreviewUrl builds from the parsed URL", async (t) => {
  const u = (s: string) => new URL(s);
  await t.test("trailing slashes", () => {
    assert.equal(buildPreviewUrl(u("https://x.com"), "T", "s"), "https://x.com/preview?token=T&slug=s");
    assert.equal(buildPreviewUrl(u("https://x.com/"), "T", "s"), "https://x.com/preview?token=T&slug=s");
    assert.equal(buildPreviewUrl(u("https://x.com///"), "T", "s"), "https://x.com/preview?token=T&slug=s");
  });
  await t.test("keeps the frontend path", () => {
    assert.equal(buildPreviewUrl(u("https://x.com/en///"), "T", "s"), "https://x.com/en/preview?token=T&slug=s");
  });
  await t.test("percent-encodes token and slug", () => {
    const out = buildPreviewUrl(u("https://x.com"), "a.b+c/=", "a&b#c%d/é");
    assert.equal(out, `https://x.com/preview?token=${encodeURIComponent("a.b+c/=")}&slug=${encodeURIComponent("a&b#c%d/é")}`);
    const parsed = new URL(out);
    assert.deepEqual([...parsed.searchParams.keys()], ["token", "slug"]);
    assert.equal(parsed.searchParams.get("slug"), "a&b#c%d/é");
  });
  await t.test("no '?' before /preview", () => {
    const out = buildPreviewUrl(u("https://x.com/en"), "T", "s");
    assert.ok(out.indexOf("?") > out.indexOf("/preview"));
    assert.equal(out.split("?").length, 2);
  });
});

test("P06 checkFrontendUrl (D6)", async (t) => {
  await t.test("accepts https and local http", () => {
    for (const s of ["https://x.com", "https://x.com/en/", "http://localhost:3000", "http://127.0.0.1:1", "http://[::1]:1"]) {
      assert.equal(checkFrontendUrl(s).ok, true, s);
    }
  });
  await t.test("refuses foreign http, other schemes, credentials, non-URLs", () => {
    for (const s of ["http://evil.com", "javascript:alert(1)", "data:text/html,x", "//x.com", "https://u:p@x.com", "https://u@x.com", "not a url", "ftp://x.com"]) {
      const r = checkFrontendUrl(s);
      assert.deepEqual(r, { ok: false, reason: "bad_frontend_url" }, s);
    }
  });
  await t.test("refuses by STRING what URL.search/.hash miss", () => {
    for (const s of ["https://x.com?", "https://x.com/#", "https://x.com\\@evil.com", "https://x.com/a?b", "https://x.com/ a", "https://x.com/\ta", "https://x.com/\u0000"]) {
      assert.deepEqual(checkFrontendUrl(s), { ok: false, reason: "bad_frontend_url" }, JSON.stringify(s));
    }
    assert.equal(new URL("https://x.com?").search, "");
  });
  await t.test("empty / absent ⇒ no_frontend_url", () => {
    for (const s of [null, undefined, "", "   "]) assert.deepEqual(checkFrontendUrl(s), { ok: false, reason: "no_frontend_url" });
  });
});

test("P07 a missing / blank slug is no_slug", () => {
  for (const v of [null, undefined, "", "   ", 5, {}, []]) assert.equal(hasPreviewSlug(v), false, String(v));
  assert.equal(hasPreviewSlug("a"), true);
});

test("P08 ids outside the int4 shape are not ids", () => {
  for (const id of ["0", "-1", "2147483648", "1e3", " 5", "٣", "", "05"]) assert.equal(isHubArticleId(id), false, id);
  assert.equal(isHubArticleId("2147483647"), true);
});

test("P09 the 200 body has exactly five keys and never the secret", async () =>
  withSecret(async (secret) => {
    const tok = signPayload(previewClaims("gcv", "s", 1000));
    const res = previewResponse({ id: 5, tenant: "gcv", url: buildPreviewUrl(new URL("https://x.com"), tok, "s"), exp: 1600 });
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "id", "ok", "tenant", "url"]);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(text.includes(secret), false);
  }));

test("P10 expiresAt is the ISO form of exp", async () => {
  const res = previewResponse({ id: 1, tenant: "gcv", url: "https://x.com/preview?token=a&slug=b", exp: 1_760_000_000 });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.expiresAt, new Date(1_760_000_000 * 1000).toISOString());
});
