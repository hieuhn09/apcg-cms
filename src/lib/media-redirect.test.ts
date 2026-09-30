/**
 * Unit tests for ./media-redirect (Node's built-in runner; no test framework).
 *
 *   npm run test:media-redirect   # = tsx --test src/lib/media-redirect.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mediaRedirectLocation,
  normalizeR2PublicBase,
  r2PublicUrl,
  resolveR2PublicBase,
} from "./media-redirect";

const BASE = "https://img.apcgmedia.com";
const CMS = "https://apcg-cms.vercel.app";
const PREFIXES = ["brief-asia", "dtw", "gcv", "wad", "world-travel-brief"];

/** Invisible characters, built from code points so none sits literally in this file. */
const NUL = String.fromCodePoint(0x0);
const ZWSP = String.fromCodePoint(0x200b); // zero-width space
const BOM = String.fromCodePoint(0xfeff); // byte-order mark (zero-width no-break space)
const RLO = String.fromCodePoint(0x202e); // right-to-left override

/**
 * PARITY ORACLE: the generateFileURL expression payload.config.ts used, verbatim,
 * before it called r2PublicUrl. `r2PublicBaseUrl` is the env value after
 * payload.config's own `.replace(/\/+$/, "")` (see configBase).
 */
const oldInline = (r2PublicBaseUrl: string, prefix: string | undefined, filename: string) =>
  `${r2PublicBaseUrl}/${prefix ? `${prefix}/` : ""}${encodeURIComponent(filename)}`;
const configBase = (raw: string) => raw.replace(/\/+$/, "");

/**
 * Redirect target for a request to the CMS at `pathAndQuery`. NB: an explicit
 * `undefined` base also means BASE here (default parameter); the unset-env
 * case calls mediaRedirectLocation directly.
 */
const loc = (pathAndQuery: string, base: string = BASE) =>
  mediaRedirectLocation(`${CMS}${pathAndQuery}`, base);

/** Printable test name: anything outside ASCII shown as [U+XXXX], long names cut. */
const label = (s: string) =>
  s
    .replace(/[^ -~]/gu, (c) => `[U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}]`)
    .slice(0, 70);

/** More shapes: upper-case extension, leading dot, 300 chars, `#`/`?`, emoji, invisible/bidi. */
const EXTRA_FILENAMES = [
  "PHOTO.JPG",
  "Building Exterior 1.JPG",
  ".hidden.jpg",
  ".jpg",
  `${"a".repeat(296)}.jpg`,
  "a#b.jpg",
  "a?b.jpg",
  "a#b?c=d.jpg",
  "city-🏙️-😀.jpg",
  `zero${ZWSP}width.jpg`,
  `rtl${RLO}gpj.png`,
];

/** Tricky real-world-shaped filenames (spaces, parens, derivatives, non-ASCII, URL metachars). */
const FILENAMES = [
  "photo.jpg",
  "Building exterior 1.jpg",
  "IMG_1511 (1).jpeg",
  "Pool C_0591_D-3.jpg",
  "Pool C_0591_D-3-400x267.jpg",
  "hero-1600x1067.webp",
  "a+b.jpg",
  "a&b=c.jpg",
  "100%.jpg",
  "semi;colon,comma@at$dollar.jpg",
  "hash#question?.jpg",
  "quote'bang!star*tilde~.jpg",
  "Ảnh đẹp Hà Nội.jpg",
  "東京タワー.png",
  "emoji-😀.jpg",
  "...jpg",
  "clip.mp4",
  ...EXTRA_FILENAMES,
];

describe("feature off: no redirect unless the base is an absolute http(s) URL", () => {
  const media = "/api/media/file/photo.jpg?prefix=gcv";
  for (const base of [undefined, "", "img.apcgmedia.com", "//img.apcgmedia.com", "ftp://img.apcgmedia.com", " https://img.apcgmedia.com"]) {
    it(`base ${JSON.stringify(base)} -> null`, () => {
      assert.equal(mediaRedirectLocation(`${CMS}${media}`, base), null);
    });
  }
  // A naive join of "https://" + "/evil.com/x.jpg" would be "https:/evil.com/x.jpg",
  // which a browser resolves to host evil.com. A base without a host must refuse.
  for (const base of ["https://", "https:///", "http://", "https:////"]) {
    it(`host-less base ${JSON.stringify(base)} -> null (no open redirect via prefix)`, () => {
      assert.equal(loc("/api/media/file/x.jpg?prefix=evil.com", base), null);
      assert.equal(loc(media, base), null);
    });
  }
});

describe("normal media + videoMedia URLs, all 5 tenant prefixes", () => {
  for (const p of PREFIXES) {
    it(`media ?prefix=${p}`, () => {
      assert.equal(loc(`/api/media/file/photo.jpg?prefix=${p}`), `${BASE}/${p}/photo.jpg`);
    });
    it(`videoMedia ?prefix=${p}`, () => {
      assert.equal(loc(`/api/videoMedia/file/clip.mp4?prefix=${p}`), `${BASE}/${p}/clip.mp4`);
    });
  }
  it("derivative (imageSizes) filenames: thumbnail / card / hero", () => {
    assert.equal(loc("/api/media/file/photo-400x267.jpg?prefix=gcv"), `${BASE}/gcv/photo-400x267.jpg`);
    assert.equal(loc("/api/media/file/photo-800x534.jpg?prefix=wad"), `${BASE}/wad/photo-800x534.jpg`);
    assert.equal(
      loc("/api/media/file/Pool%20C_0591_D-3-1600x1067.jpg?prefix=world-travel-brief"),
      `${BASE}/world-travel-brief/Pool%20C_0591_D-3-1600x1067.jpg`,
    );
  });
});

describe("filename encoding", () => {
  it("spaces (%20-encoded input, as stored urls carry them)", () => {
    assert.equal(
      loc("/api/media/file/Building%20exterior%201.jpg?prefix=gcv"),
      `${BASE}/gcv/Building%20exterior%201.jpg`,
    );
  });
  it("parentheses, raw or %-encoded", () => {
    const want = `${BASE}/wad/IMG_1511%20(1).jpeg`;
    assert.equal(loc("/api/media/file/IMG_1511%20(1).jpeg?prefix=wad"), want);
    assert.equal(loc("/api/media/file/IMG_1511%20%281%29.jpeg?prefix=wad"), want);
  });
  it("non-ASCII, %-encoded or raw (the URL parser encodes raw input)", () => {
    const want = r2PublicUrl(BASE, "dtw", "Ảnh đẹp.jpg");
    assert.equal(want, `${BASE}/dtw/%E1%BA%A2nh%20%C4%91%E1%BA%B9p.jpg`);
    assert.equal(loc(`/api/media/file/${encodeURIComponent("Ảnh đẹp.jpg")}?prefix=dtw`), want);
    assert.equal(loc("/api/media/file/Ảnh đẹp.jpg?prefix=dtw"), want);
  });
  it("'+' is a literal plus in a path, never a space", () => {
    assert.equal(loc("/api/media/file/a+b.jpg?prefix=gcv"), `${BASE}/gcv/a%2Bb.jpg`);
    assert.equal(loc("/api/media/file/a%2Bb.jpg?prefix=gcv"), `${BASE}/gcv/a%2Bb.jpg`);
  });
  it("'&' raw or encoded", () => {
    assert.equal(loc("/api/media/file/a&b.jpg?prefix=gcv"), `${BASE}/gcv/a%26b.jpg`);
    assert.equal(loc("/api/media/file/a%26b.jpg?prefix=gcv"), `${BASE}/gcv/a%26b.jpg`);
  });
  it("a literal '%' in the filename", () => {
    assert.equal(loc("/api/media/file/100%25.jpg?prefix=gcv"), `${BASE}/gcv/100%25.jpg`);
  });
});

describe("more filename shapes: redirect === the OLD generateFileURL expression", () => {
  for (const filename of EXTRA_FILENAMES) {
    it(label(filename), () => {
      for (const prefix of ["gcv", "world-travel-brief"]) {
        const got = loc(`/api/media/file/${encodeURIComponent(filename)}?prefix=${prefix}`);
        assert.equal(got, oldInline(BASE, prefix, filename));
        assert.equal(got, r2PublicUrl(BASE, prefix, filename));
      }
    });
  }
  it("the 300-character filename really is 300 characters", () => {
    assert.ok(EXTRA_FILENAMES.some((f) => f.length === 300));
  });
});

describe("base URL shapes", () => {
  it("trailing slash(es) on the base are ignored", () => {
    for (const base of [`${BASE}/`, `${BASE}///`]) {
      assert.equal(loc("/api/media/file/photo.jpg?prefix=gcv", base), `${BASE}/gcv/photo.jpg`);
      assert.equal(r2PublicUrl(base, "gcv", "photo.jpg"), `${BASE}/gcv/photo.jpg`);
    }
  });
  it("r2PublicUrl is idempotent on an already-stripped base", () => {
    assert.equal(r2PublicUrl(configBase(`${BASE}//`), "gcv", "a b.jpg"), r2PublicUrl(`${BASE}//`, "gcv", "a b.jpg"));
  });
  it("base with a path segment (and a port)", () => {
    assert.equal(
      loc("/api/media/file/photo.jpg?prefix=gcv", "https://cdn.example.com/apcg/"),
      "https://cdn.example.com/apcg/gcv/photo.jpg",
    );
    assert.equal(
      loc("/api/media/file/photo.jpg?prefix=gcv", "http://localhost:9000/central-media"),
      "http://localhost:9000/central-media/gcv/photo.jpg",
    );
  });
  it("upper-case scheme still counts as http(s)", () => {
    assert.equal(loc("/api/media/file/photo.jpg?prefix=gcv", "HTTPS://img.apcgmedia.com"), `${BASE}/gcv/photo.jpg`);
  });
  it("a stray newline/tab in the env value cannot produce an illegal Location header", () => {
    for (const base of [`${BASE}\n`, `${BASE}\t`, "https://img.apcgmedia\n.com"]) {
      const got = loc("/api/media/file/photo.jpg?prefix=gcv", base);
      assert.equal(got, `${BASE}/gcv/photo.jpg`);
      assert.doesNotThrow(() => new Headers({ Location: got ?? "" }));
    }
  });
  it("a base pointing at the CMS's own /api/media/file path never 302s a request to itself", () => {
    const selfBase = `${CMS}/api/media/file`;
    assert.equal(mediaRedirectLocation(`${CMS}/api/media/file/x.jpg`, selfBase), null);
    assert.equal(mediaRedirectLocation(`${CMS}/api/videoMedia/file/x.jpg`, `${CMS}/api/videoMedia/file`), null);
    // Only the exact self-target is refused. Another URL on that host is one hop at
    // most: its two-segment target path is never matched again, so no loop.
    const hop = mediaRedirectLocation(`${CMS}/api/media/file/x.jpg?prefix=gcv`, selfBase);
    assert.equal(hop, `${CMS}/api/media/file/gcv/x.jpg`);
    assert.equal(mediaRedirectLocation(hop ?? "", selfBase), null);
  });
});

describe("prefix handling", () => {
  it("missing or empty prefix -> bucket root, same as generateFileURL", () => {
    const want = `${BASE}/photo.jpg`;
    assert.equal(loc("/api/media/file/photo.jpg"), want);
    assert.equal(loc("/api/media/file/photo.jpg?prefix="), want);
    assert.equal(oldInline(BASE, undefined, "photo.jpg"), want);
    assert.equal(r2PublicUrl(BASE, null, "photo.jpg"), want);
    assert.equal(r2PublicUrl(BASE, "", "photo.jpg"), want);
  });
  for (const bad of ["gcv/x", "gcv%2Fx", "..", ".", "../gcv", ".gcv", "-gcv", "brief%20asia", "brief+asia", "%20gcv", "gcv%00", "gcv%5Cx", "%2F%2Fevil.com", "https://evil.com"]) {
    it(`?prefix=${bad} -> null`, () => {
      assert.equal(loc(`/api/media/file/photo.jpg?prefix=${bad}`), null);
    });
  }
  it("a dotted prefix stays a path segment on the configured host", () => {
    assert.equal(loc("/api/media/file/x.jpg?prefix=evil.com"), `${BASE}/evil.com/x.jpg`);
  });
  it("extra query params are ignored; the FIRST prefix wins", () => {
    assert.equal(
      loc("/api/media/file/photo.jpg?download=true&prefix=gcv&utm_source=x&prefix=wad"),
      `${BASE}/gcv/photo.jpg`,
    );
    assert.equal(loc("/api/media/file/photo.jpg?download=1"), `${BASE}/photo.jpg`);
  });
});

describe("traversal and unsafe filenames -> null", () => {
  for (const seg of [
    "..%2Fsecret.jpg",
    "%2e%2e",
    "%2E%2E%2Fetc%2Fpasswd",
    ".%2e",
    "%2e",
    "a%2Fb.jpg",
    "%2F%2Fevil.com",
    "a%5Cb.jpg",
    "%5C%5Cevil.com",
    "a%00.jpg",
    "%00",
    "a%0A.jpg",
    "a%0D.jpg",
    "a%09.jpg",
    "a%7F.jpg",
    "a%C2%85.jpg",
    "%E0%A4%A",
    "%",
    "%zz.jpg",
    "%C3.jpg",
    "%ED%A0%80.jpg",
  ]) {
    it(`/api/media/file/${seg}`, () => {
      assert.equal(loc(`/api/media/file/${seg}?prefix=gcv`), null);
    });
  }
  it("literal dot segments are normalized away by the URL parser", () => {
    assert.equal(loc("/api/media/file/..?prefix=gcv"), null);
    assert.equal(loc("/api/media/file/.?prefix=gcv"), null);
  });
});

describe("non-matching paths -> null (fall through to Payload)", () => {
  for (const path of [
    "/api/articles",
    "/api/public/articles?limit=20",
    "/api/media",
    "/api/media/",
    "/api/media/123",
    "/api/media/file",
    "/api/media/file/",
    "/api/media/file/a/b",
    "/api/media/file/x.jpg/",
    "/api/media/files/x.jpg",
    "/api/users/file/x.jpg",
    "/api/MEDIA/file/x.jpg",
    "/api/videomedia/file/x.mp4",
    "/admin/api/media/file/x.jpg",
    "/api//media/file/x.jpg",
  ]) {
    it(path, () => {
      assert.equal(loc(path.includes("?") ? path : `${path}?prefix=gcv`), null);
    });
  }
  it("an unparseable request URL -> null", () => {
    assert.equal(mediaRedirectLocation("/api/media/file/x.jpg?prefix=gcv", BASE), null);
  });
});

describe("PARITY: r2PublicUrl === the old generateFileURL expression", () => {
  const bases = [BASE, `${BASE}/`, `${BASE}///`, "https://cdn.example.com/apcg", "https://cdn.example.com/apcg/"];
  for (const base of bases) {
    it(`base ${base}`, () => {
      for (const prefix of [...PREFIXES, undefined, ""]) {
        for (const filename of [...FILENAMES, "a/b.jpg", "a\\b.jpg", ""]) {
          const want = oldInline(configBase(base), prefix, filename);
          assert.equal(r2PublicUrl(configBase(base), prefix, filename), want);
          assert.equal(r2PublicUrl(base, prefix, filename), want);
        }
      }
    });
  }
});

describe("ROUND-TRIP: a stored /api/media/file url redirects to exactly r2PublicUrl", () => {
  for (const collection of ["media", "videoMedia"]) {
    it(collection, () => {
      for (const prefix of PREFIXES) {
        for (const filename of FILENAMES) {
          const stored = `/api/${collection}/file/${encodeURIComponent(filename)}?prefix=${encodeURIComponent(prefix)}`;
          const got = loc(stored);
          assert.equal(got, r2PublicUrl(BASE, prefix, filename), stored);
          assert.equal(got, oldInline(BASE, prefix, filename), stored);
          assert.doesNotThrow(() => new Headers({ Location: got ?? "" }));
        }
      }
    });
  }
});

describe("normalizeR2PublicBase: R2_PUBLIC_BASE_URL in canonical form, or undefined", () => {
  // Invalid values: undefined = feature off, media stays on /api/media/file.
  const OFF: Array<string | undefined> = [
    undefined,
    "",
    "   ",
    "\n",
    "\t\r\n",
    "img.apcgmedia.com",
    "//img.apcgmedia.com",
    "https//img.apcgmedia.com",
    "https:/img.apcgmedia.com",
    "https://",
    "https:///",
    "https:///x",
    "https://\\host", // the URL parser would "repair" this to host `host`: refused instead
    "https://?x",
    "https://#x",
    "https://:443",
    "https://user@",
    "https://[",
    "ftp://x",
    "ftp://img.apcgmedia.com",
    "https://x.example?x=1",
    "https://x.example/#h",
    "https://x.example?",
    "https://x.example#",
    "https://user:pw@x.example",
    "https://user@x.example",
    "https://img.apcg media.com",
    "https://img.apcgmedia.com/a b",
    "https://img\t.apcgmedia.com",
    "https://img.apcg\nmedia.com",
    `https://img.apcgmedia.com${NUL}`,
    `https://img.apcgmedia.com/${ZWSP}`,
  ];
  // Valid values -> the canonical base both switches use.
  const ON: Array<[string, string]> = [
    [BASE, BASE],
    [`${BASE}/`, BASE],
    [`${BASE}///`, BASE],
    [` ${BASE}/\n`, BASE],
    [`\t${BASE}\r\n`, BASE],
    [`${BOM}${BASE}`, BASE],
    ["HTTPS://img.apcgmedia.com", BASE],
    ["HTTPS://Img.Apcgmedia.COM:443/", BASE],
    ["https://x.example/media", "https://x.example/media"],
    ["https://x.example/media/", "https://x.example/media"],
    ["https://x.example/a/../media/", "https://x.example/media"],
    ["https://x.example/%2e%2e/media", "https://x.example/media"],
    ["https://x.example/m%c3%a9/", "https://x.example/m%c3%a9"],
    ["http://localhost:9000/central-media", "http://localhost:9000/central-media"],
    ["http://[::1]:9000/", "http://[::1]:9000"],
    ["https://médias.example", "https://xn--mdias-bsa.example"], // IDN host: accepted, as punycode
  ];

  for (const raw of OFF) {
    it(`${label(JSON.stringify(raw) ?? "undefined")} -> undefined (off)`, () => {
      assert.equal(normalizeR2PublicBase(raw), undefined);
    });
  }
  for (const [raw, want] of ON) {
    it(`${label(JSON.stringify(raw))} -> ${want}`, () => {
      assert.equal(normalizeR2PublicBase(raw), want);
    });
  }
  it("never throws", () => {
    for (const raw of [...OFF, ...ON.map(([r]) => r), "https://%", "http://a b", NUL, "https://x.example/%zz"]) {
      assert.doesNotThrow(() => normalizeR2PublicBase(raw), JSON.stringify(raw));
    }
  });
  it("a canonical value that worked before is used byte-for-byte as before (old .replace(/\\/+$/, ''))", () => {
    for (const raw of [BASE, `${BASE}/`, `${BASE}///`, "https://x.example/media/", "http://localhost:9000/central-media"]) {
      assert.equal(normalizeR2PublicBase(raw), configBase(raw), raw);
    }
  });
  it("integration: a hand-pasted ' <base>/\\n' still redirects an old link to the direct R2 URL", () => {
    assert.equal(
      mediaRedirectLocation(
        `${CMS}/api/media/file/Building%20exterior%201.jpg?prefix=gcv`,
        normalizeR2PublicBase(" https://img.apcgmedia.com/\n"),
      ),
      `${BASE}/gcv/Building%20exterior%201.jpg`,
    );
  });
  it("both switches agree: Payload serves from R2 exactly when old links redirect", () => {
    const old = `${CMS}/api/media/file/photo.jpg?prefix=gcv`;
    for (const raw of [...OFF, ...ON.map(([r]) => r)]) {
      const base = normalizeR2PublicBase(raw);
      assert.equal(mediaRedirectLocation(old, base) !== null, base !== undefined, JSON.stringify(raw));
    }
  });
  it("PARITY for EVERY accepted base: Payload's URL (r2PublicUrl) === the redirect Location", () => {
    for (const [raw] of ON) {
      const base = normalizeR2PublicBase(raw);
      assert.ok(base, raw);
      for (const prefix of [...PREFIXES, ""]) {
        for (const filename of FILENAMES) {
          const old = `${CMS}/api/media/file/${encodeURIComponent(filename)}${prefix ? `?prefix=${prefix}` : ""}`;
          assert.equal(
            mediaRedirectLocation(old, base),
            r2PublicUrl(base, prefix, filename),
            `${label(raw)} | ${prefix} | ${label(filename)}`,
          );
        }
      }
    }
  });
});

describe("resolveR2PublicBase: ONE switch = the four R2 creds + a valid base", () => {
  const CREDS: Record<string, string | undefined> = {
    R2_BUCKET: "central-media",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "key-id",
    R2_SECRET_ACCESS_KEY: "secret",
  };
  const CRED_KEYS = Object.keys(CREDS);
  /** payload.config.ts's `r2Configured` expression, verbatim (the creds oracle). */
  const literalR2Configured = (env: Record<string, string | undefined>) =>
    Boolean(env.R2_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
  const CRED_SETS: Array<[string, Record<string, string | undefined>]> = [
    ["all 4 creds", { ...CREDS }],
    ...CRED_KEYS.map((k): [string, Record<string, string | undefined>] => [`${k} missing`, { ...CREDS, [k]: undefined }]),
    ...CRED_KEYS.map((k): [string, Record<string, string | undefined>] => [`${k} blank`, { ...CREDS, [k]: "" }]),
    ["whitespace-only secret (non-empty, so the literal check counts it)", { ...CREDS, R2_SECRET_ACCESS_KEY: " " }],
    ["no creds at all", {}],
  ];
  const BASES: Array<string | undefined> = [
    undefined,
    "",
    BASE,
    " HTTPS://Img.Apcgmedia.COM/\n",
    "img.apcgmedia.com",
    "https://x.example?x=1",
  ];
  const old = `${CMS}/api/media/file/photo.jpg?prefix=gcv`;

  for (const [name, creds] of CRED_SETS) {
    it(`${name}: Payload switch === redirect switch; creds part === the literal check`, () => {
      for (const base of BASES) {
        const env = { ...creds, R2_PUBLIC_BASE_URL: base };
        const why = `${name} / ${JSON.stringify(base)}`;
        const resolved = resolveR2PublicBase(env);
        assert.equal(resolved, literalR2Configured(env) ? normalizeR2PublicBase(base) : undefined, why);
        // payload.config.ts applies generateFileURL + disablePayloadAccessControl
        // iff `r2Configured && r2PublicBaseUrl`; the route redirects iff non-null.
        const payloadSwitch = literalR2Configured(env) && resolved !== undefined;
        const redirectSwitch = mediaRedirectLocation(old, resolved) !== null;
        assert.equal(payloadSwitch, redirectSwitch, why);
      }
    });
  }
  it("all 4 creds + a valid base -> the canonical base; any missing or blank cred -> undefined", () => {
    assert.equal(resolveR2PublicBase({ ...CREDS, R2_PUBLIC_BASE_URL: `${BASE}/` }), BASE);
    for (const k of CRED_KEYS) {
      assert.equal(resolveR2PublicBase({ ...CREDS, [k]: undefined, R2_PUBLIC_BASE_URL: BASE }), undefined, k);
      assert.equal(resolveR2PublicBase({ ...CREDS, [k]: "", R2_PUBLIC_BASE_URL: BASE }), undefined, k);
    }
  });
  it("reads process.env by default", () => {
    const keys = [...CRED_KEYS, "R2_PUBLIC_BASE_URL"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      Object.assign(process.env, CREDS, { R2_PUBLIC_BASE_URL: `${BASE}/` });
      assert.equal(resolveR2PublicBase(), BASE);
      delete process.env.R2_BUCKET;
      assert.equal(resolveR2PublicBase(), undefined);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
