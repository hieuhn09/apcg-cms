/**
 * Old media links -> Cloudflare R2, for when media is served from R2 directly.
 *
 * Once R2 serving is on, payload.config.ts points every media and videoMedia
 * URL straight at R2 and Payload stops serving `/api/{media,videoMedia}/file/*`
 * (`disablePayloadAccessControl: true`): its file handler then answers an error
 * (500 from the local-disk fallback, or 403). Every link handed out before that
 * flip (reader ISR/data caches, sent newsletters, search and social image
 * indexes) would break. The catch-all API route answers those links with a 302
 * to the same object on R2 instead: plan
 * `process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md`,
 * Phase 3 step 2.
 *
 * `resolveR2PublicBase` is the ONE switch (the four R2 creds plus a valid base,
 * in canonical form) and `r2PublicUrl` the ONE URL formula. payload.config.ts
 * and the redirect route both use them, so they flip together and cannot drift.
 *
 * `mediaRedirectLocation` returns null ("do nothing, let Payload answer")
 * unless ALL of these hold:
 * - the base is an absolute http(s) URL with a host (unset/empty = feature off);
 * - the path is `/api/media/file/<name>` or `/api/videoMedia/file/<name>` with
 *   exactly ONE segment after `/file/` (derivative filenames included);
 * - `<name>` percent-decodes cleanly to a filename that is not empty, `.` or
 *   `..`, and has no `/`, `\` or control character (NUL included);
 * - the first `?prefix=` value, when non-empty, matches SAFE_PREFIX. Absent or
 *   empty means the bucket root, exactly like generateFileURL. Every other
 *   query parameter is ignored.
 * The Location always lands on the configured base's origin whatever the
 * request says, so this cannot become an open redirect, and it is never the
 * request URL itself (no self-redirect loop).
 *
 * No I/O and no Payload/Next imports; `process.env` is only a default argument
 * (`npm run test:media-redirect`).
 */

/** Exactly one path segment after `/file/`; group 2 is the still-encoded filename. */
const MEDIA_FILE_PATH = /^\/api\/(media|videoMedia)\/file\/([^/]+)$/;

/** A tenant key prefix as it appears in `?prefix=` (tenant slugs: `gcv`, `brief-asia`, ...). */
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Path separators and control characters (C0, DEL and C1, NUL included). */
const UNSAFE_FILENAME_CHAR = /[/\\\p{Cc}]/u;

/** Whitespace, control and invisible format characters (e.g. a pasted zero-width space). */
const INVALID_BASE_CHAR = /[\s\p{Cc}\p{Cf}]/u;

/**
 * `R2_PUBLIC_BASE_URL` in canonical form, or undefined (= feature off, media
 * stays on /api/media/file) unless it is a plain absolute http(s) URL. The
 * trimmed raw value must have no whitespace/control/format character and a host
 * right after `://`; the parsed URL must have no credentials, query or fragment.
 * Returns the URL parser's `href` minus trailing slashes, so Payload's URLs and
 * the redirect Location are built from the same bytes for EVERY accepted base.
 * A path segment (`https://x.example/media`) is kept. Never throws.
 */
export function normalizeR2PublicBase(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  // `[^/\\?#]` right after `://` refuses an empty host that the URL parser would
  // otherwise "repair" (`https:///x` and `https://\x` both parse as host `x`).
  if (!trimmed || INVALID_BASE_CHAR.test(trimmed) || !/^https?:\/\/[^/\\?#]/i.test(trimmed)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    /[?#]/.test(url.href) // a query or fragment, even an empty `?` / `#`
  ) {
    return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * THE switch for serving media straight from R2, used by BOTH payload.config.ts
 * (generateFileURL + disablePayloadAccessControl) and the redirect route: the
 * canonical base, but only when the four R2_* creds are set exactly as
 * payload.config.ts's `r2Configured` requires them for s3Storage; otherwise
 * undefined. Keeps the two from disagreeing, e.g. on an env with the base but
 * no creds, where Payload keeps /api/media/file but a redirect would lead to R2.
 */
export function resolveR2PublicBase(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const r2Configured = Boolean(
    env.R2_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY,
  );
  return r2Configured ? normalizeR2PublicBase(env.R2_PUBLIC_BASE_URL) : undefined;
}

/**
 * Public R2 URL of an object: `<base>/<prefix>/<filename>`, or
 * `<base>/<filename>` (bucket root) when there is no prefix. Trailing slashes
 * on `base` are ignored.
 */
export function r2PublicUrl(
  base: string,
  prefix: string | null | undefined,
  filename: string,
): string {
  return `${base.replace(/\/+$/, "")}/${prefix ? `${prefix}/` : ""}${encodeURIComponent(filename)}`;
}

/**
 * Where to 302 an old `/api/{media,videoMedia}/file/<name>?prefix=<t>` request,
 * or null to leave the request to Payload. Rules: see the top of this file.
 */
export function mediaRedirectLocation(
  requestUrl: string,
  publicBase: string | undefined,
): string | null {
  if (!publicBase || !/^https?:\/\//i.test(publicBase)) return null;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  const segment = MEDIA_FILE_PATH.exec(url.pathname)?.[2];
  if (!segment) return null;

  let filename: string;
  try {
    filename = decodeURIComponent(segment);
  } catch {
    return null; // malformed percent-encoding
  }
  if (!filename || filename === "." || filename === ".." || UNSAFE_FILENAME_CHAR.test(filename)) {
    return null;
  }

  const prefix = url.searchParams.get("prefix");
  if (prefix && !SAFE_PREFIX.test(prefix)) return null;

  // The target must sit on the configured base's origin. This also refuses a
  // base with no host ("https://" would let the prefix become the host), and
  // hands back the URL parser's serialization, which is always a legal header
  // value: a stray tab/newline pasted into the env var cannot make it throw.
  try {
    const target = new URL(r2PublicUrl(publicBase, prefix, filename));
    if (target.origin !== new URL(publicBase).origin) return null;
    // A base pointing at this very /api/media/file path would 302 to itself forever.
    return target.href === url.href ? null : target.href;
  } catch {
    return null;
  }
}
