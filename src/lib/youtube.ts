/**
 * YouTube URL → video ID extraction.
 *
 * Single source of truth for "what counts as a valid YouTube link" across the
 * CMS. The `Podcasts` collection derives and stores `youtubeId` once at save
 * time (`beforeValidate`) so every downstream consumer — admin preview, the
 * public API, the reader site's thumbnail/iframe URLs — is a plain string
 * interpolation and never re-runs this regex. Two copies of this parser in two
 * repos is exactly the drift this centralisation prevents.
 *
 * Handles the five real-world link shapes:
 *   https://www.youtube.com/watch?v=<id>          (+ &t=, &list=, tracking params)
 *   https://youtu.be/<id>                          (+ ?t=, ?si=)
 *   https://www.youtube.com/live/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://www.youtube.com/embed/<id>
 *
 * Returns `null` for anything else (including non-YouTube hosts) — a `null`
 * IS the validation failure, not a separate check.
 */

/** A YouTube video ID is exactly 11 URL-safe base64 characters. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Path prefixes that carry the video id as the next path segment. */
const PATH_PREFIXES = ["live", "shorts", "embed", "v"];

/**
 * Extract the 11-character video ID from a YouTube URL.
 *
 * @returns the video ID, or `null` when the input is not a parseable YouTube
 *          video link (empty, malformed, wrong host, or missing/invalid id).
 */
export function extractYoutubeId(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // Tolerate editors pasting a bare `youtube.com/...` with no scheme.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  // Non-empty path segments; query params (`?t=42`, `?list=`, `?si=`) are
  // parsed away by `URL` and deliberately ignored.
  const segments = parsed.pathname.split("/").filter((s) => s !== "");

  // youtu.be/<id>
  if (host === "youtu.be" || host === "www.youtu.be") {
    const candidate = segments[0];
    return candidate != null && VIDEO_ID.test(candidate) ? candidate : null;
  }

  // youtube.com/watch?v=<id>
  if (segments[0] === "watch") {
    const candidate = parsed.searchParams.get("v");
    return candidate != null && VIDEO_ID.test(candidate) ? candidate : null;
  }

  // youtube.com/{live,shorts,embed,v}/<id>
  const prefix = segments[0];
  if (prefix != null && PATH_PREFIXES.includes(prefix)) {
    const candidate = segments[1];
    return candidate != null && VIDEO_ID.test(candidate) ? candidate : null;
  }

  return null;
}
